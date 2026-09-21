import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ScriptedProvider, chunked, emit, stall } from '../src/provider/scripted.js';
import { InMemoryConversationStore } from '../src/store/store.js';
import { createRuntimeServer } from '../src/http/server.js';
import type { ScriptStep } from '../src/provider/scripted.js';

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    // `close` alone waits out Node's 5s keep-alive timeout on idle sockets, which
    // would add five seconds per test for no signal. Drop them explicitly.
    server.closeAllConnections();
    await new Promise((resolve) => server!.close(resolve));
  }
  server = undefined;
});

async function start(script: readonly ScriptStep[], timeoutMs = 5_000) {
  const store = new InMemoryConversationStore();
  const provider = new ScriptedProvider(script);
  server = createRuntimeServer({ store, provider, timeoutMs });
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, store, provider };
}

/** Polls `read` until `done` is satisfied, or fails fast rather than hanging. */
async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was not met within 1s');
}

/** Minimal SSE parser: returns events in arrival order. */
function parseEvents(raw: string): { event: string; data: unknown }[] {
  return raw
    .split('\n\n')
    .filter((block) => block.includes('event:'))
    .map((block) => {
      const event = /event: (.+)/.exec(block)?.[1] ?? '';
      const data = /data: (.+)/.exec(block)?.[1] ?? '{}';
      return { event, data: JSON.parse(data) as unknown };
    });
}

describe('http/sse front end', () => {
  it('streams chunks then a terminal event, and persists the turn', async () => {
    const { base, store } = await start(chunked('streamed over sse', 4));

    const response = await fetch(`${base}/turns`, {
      method: 'POST',
      body: JSON.stringify({ conversationId: 'conv_http', input: 'hello' }),
    });
    const events = parseEvents(await response.text());

    const chunks = events.filter((e) => e.event === 'chunk');
    const terminal = events.find((e) => e.event === 'terminal')?.data as { state: string };

    expect(chunks).toHaveLength(4);
    expect(terminal.state).toBe('completed');
    // Terminal is the last thing before the trace dump, never mid-stream.
    expect(events.at(-1)?.event).toBe('trace');

    const messages = await store.listMessages('conv_http');
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('reports a policy rejection without invoking the provider', async () => {
    const { base, provider, store } = await start([emit('never')]);

    const response = await fetch(`${base}/turns`, {
      method: 'POST',
      body: JSON.stringify({ conversationId: 'conv_http', input: '  ' }),
    });
    const events = parseEvents(await response.text());
    const terminal = events.find((e) => e.event === 'terminal')?.data as {
      state: string;
      policyRuleId: string;
    };

    expect(terminal.state).toBe('rejected');
    expect(terminal.policyRuleId).toBe('block.empty_input');
    expect(provider.callCount).toBe(0);
    expect(await store.listMessages('conv_http')).toEqual([]);
  });

  it('treats a dropped client connection as a cancellation', async () => {
    const { base, store, provider } = await start([emit('first '), emit('second '), stall()], 2_000);

    const controller = new AbortController();
    const response = await fetch(`${base}/turns`, {
      method: 'POST',
      body: JSON.stringify({ conversationId: 'conv_http', input: 'long answer please' }),
      signal: controller.signal,
    });

    // Read until the stream has produced chunks, then hang up like a closed tab.
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();

    // Poll rather than sleep a fixed amount: neither flaky nor slow.
    const runs = await waitFor(
      () => store.listRuns('conv_http'),
      (found) => found.length === 1,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.terminalState).toBe('cancelled');
    expect(runs[0]?.outputIsPartial).toBe(true);
    expect(provider.abortObserved).toBe(true);

    // The partial text is on the run record and never in the transcript.
    expect((await store.listMessages('conv_http')).map((m) => m.role)).toEqual(['user']);
  });

  it('serves the demo page and lists runs newest first', async () => {
    const { base } = await start(chunked('one', 2));

    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('Reliable AI Conversation Runtime');

    for (const input of ['first', 'second']) {
      await (
        await fetch(`${base}/turns`, {
          method: 'POST',
          body: JSON.stringify({ conversationId: 'conv_http', input }),
        })
      ).text();
    }

    const { runs } = (await (await fetch(`${base}/conversations/conv_http/runs`)).json()) as {
      runs: { startedAt: number }[];
    };
    expect(runs).toHaveLength(2);
    // Newest first: the page reads [0] to learn the outcome of a turn it cancelled.
    expect(runs[0]!.startedAt).toBeGreaterThanOrEqual(runs[1]!.startedAt);
  });

  it('runs a named scenario with its own provider and deadline', async () => {
    // The scenario parameter must supply the script and the timeout, not just the
    // input -- otherwise `?scenario=timeout` would complete successfully.
    const { base } = await start([emit('unused default')]);

    const events = parseEvents(
      await (
        await fetch(`${base}/turns?scenario=timeout`, {
          method: 'POST',
          body: JSON.stringify({ conversationId: 'conv_scenario' }),
        })
      ).text(),
    );
    const terminal = events.find((e) => e.event === 'terminal')?.data as {
      state: string;
      chunkCount: number;
    };

    expect(terminal.state).toBe('timed_out');
    expect(terminal.chunkCount).toBe(2);
  });

  it('exposes a stored run and its trace', async () => {
    const { base } = await start(chunked('inspectable', 2));

    const created = parseEvents(
      await (
        await fetch(`${base}/turns`, {
          method: 'POST',
          body: JSON.stringify({ conversationId: 'conv_http', input: 'hello' }),
        })
      ).text(),
    );
    const runId = (created.find((e) => e.event === 'terminal')?.data as { runId: string }).runId;

    const run = (await (await fetch(`${base}/runs/${runId}`)).json()) as {
      terminalState: string;
      trace: unknown[];
    };

    expect(run.terminalState).toBe('completed');
    expect(run.trace.length).toBeGreaterThan(0);
    expect((await fetch(`${base}/runs/run_missing`)).status).toBe(404);
  });
});
