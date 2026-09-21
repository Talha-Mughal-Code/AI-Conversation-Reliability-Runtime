import { describe, expect, it } from 'vitest';
import {
  ScriptedProvider,
  chunked,
  emit,
  fail,
  stall,
  think,
} from '../src/provider/scripted.js';
import { ProviderError } from '../src/provider/provider.js';
import type { ProviderEvent } from '../src/domain/types.js';

const request = { runId: 'run_0001', conversationId: 'conv_0001', input: 'hi' };

async function drain(
  provider: ScriptedProvider,
  signal: AbortSignal,
): Promise<{ events: ProviderEvent[]; error: unknown }> {
  const events: ProviderEvent[] = [];
  try {
    for await (const event of provider.stream(request, signal)) events.push(event);
    return { events, error: null };
  } catch (error) {
    return { events, error };
  }
}

describe('scripted provider', () => {
  it('emits chunks in script order and ends with done', async () => {
    const provider = new ScriptedProvider([emit('Hel'), emit('lo'), emit('!')]);
    const { events, error } = await drain(provider, new AbortController().signal);

    expect(error).toBeNull();
    expect(events).toEqual([
      { type: 'chunk', text: 'Hel' },
      { type: 'chunk', text: 'lo' },
      { type: 'chunk', text: '!' },
      { type: 'done' },
    ]);
    expect(provider.chunksEmitted).toBe(3);
  });

  it('throws after partial output when the script fails', async () => {
    const provider = new ScriptedProvider([emit('partial '), fail('upstream 503')]);
    const { events, error } = await drain(provider, new AbortController().signal);

    expect(events).toEqual([{ type: 'chunk', text: 'partial ' }]);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe('provider.stream_error');
  });

  it('stops producing once the signal aborts mid-stream', async () => {
    const provider = new ScriptedProvider(chunked('abcdefghij', 10));
    const controller = new AbortController();

    const received: string[] = [];
    try {
      for await (const event of provider.stream(request, controller.signal)) {
        if (event.type === 'chunk') received.push(event.text);
        if (received.length === 3) controller.abort();
      }
    } catch {
      // ProviderAbortedError is the expected exit.
    }

    // The point of the assertion: production stopped, it was not merely ignored.
    expect(received).toHaveLength(3);
    expect(provider.chunksEmitted).toBe(3);
    expect(provider.abortObserved).toBe(true);
  });

  it('never invokes the stream body when the signal is already aborted', async () => {
    const provider = new ScriptedProvider([emit('should not appear')]);
    const { events, error } = await drain(provider, AbortSignal.abort());

    expect(events).toEqual([]);
    expect(provider.chunksEmitted).toBe(0);
    expect(error).toBeInstanceOf(ProviderError);
  });

  it('stalls indefinitely until aborted, without a timer', async () => {
    const provider = new ScriptedProvider([emit('thinking'), stall()]);
    const controller = new AbortController();

    const settled = drain(provider, controller.signal);
    // Nothing resolves this except the abort; no sleep is involved.
    await Promise.resolve();
    controller.abort();
    const { events, error } = await settled;

    expect(events).toEqual([{ type: 'chunk', text: 'thinking' }]);
    expect(error).toBeInstanceOf(ProviderError);
    expect(provider.abortObserved).toBe(true);
  });

  it('keeps hidden reasoning inside the adapter', async () => {
    const secretThought = 'the user is probably testing me';
    const provider = new ScriptedProvider([think(secretThought), emit('Sure!')]);
    const { events } = await drain(provider, new AbortController().signal);

    expect(provider.hiddenReasoning).toEqual([secretThought]);
    expect(JSON.stringify(events)).not.toContain(secretThought);
  });

  it('counts invocations so a rejected turn can prove it never called the provider', async () => {
    const provider = new ScriptedProvider([emit('x')]);
    expect(provider.callCount).toBe(0);
    await drain(provider, new AbortController().signal);
    expect(provider.callCount).toBe(1);
  });
});
