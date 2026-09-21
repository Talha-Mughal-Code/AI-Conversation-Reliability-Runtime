import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sequentialIds } from '../src/domain/ids.js';
import { RuleBasedPolicy } from '../src/policy/policy.js';
import { ScriptedProvider, chunked, emit, fail } from '../src/provider/scripted.js';
import { FileConversationStore } from '../src/store/file-store.js';
import { FakeClock } from '../src/runtime/clock.js';
import { TurnRuntime } from '../src/runtime/runtime.js';
import type { ScriptStep } from '../src/provider/scripted.js';

const CONVERSATION = 'conv_0001';
let dir: string;
/** One factory per test: a fresh one per runtime would mint run_0001 every time. */
let ids: ReturnType<typeof sequentialIds>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runtime-store-'));
  ids = sequentialIds();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function runtimeWith(store: FileConversationStore, script: readonly ScriptStep[]) {
  return new TurnRuntime({
    policy: new RuleBasedPolicy(),
    provider: new ScriptedProvider(script),
    store,
    clock: new FakeClock(),
    ids,
    timeoutMs: 1_000,
  });
}

describe('file-backed store', () => {
  it('survives a process restart: a second instance reads the same records', async () => {
    const first = FileConversationStore.inDirectory(dir);
    const result = await runtimeWith(first, chunked('persisted answer', 3)).execute({
      conversationId: CONVERSATION,
      input: 'hi',
    });

    // A fresh instance with no cache, standing in for a restarted process.
    const second = FileConversationStore.inDirectory(dir);
    const messages = await second.listMessages(CONVERSATION);
    const run = await second.getRun(result.runId);

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]?.text).toBe('persisted answer');
    expect(run?.terminalState).toBe('completed');
    expect(run?.trace.length).toBeGreaterThan(0);
  });

  it('serialises concurrent writes without losing a record', async () => {
    const store = FileConversationStore.inDirectory(dir);

    // Ten turns started together. A naive read-modify-write would drop records.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        runtimeWith(store, chunked(`answer ${i}`, 2)).execute({
          conversationId: CONVERSATION,
          input: `question ${i}`,
        }),
      ),
    );

    expect(results.every((r) => r.terminalState === 'completed')).toBe(true);

    const reopened = FileConversationStore.inDirectory(dir);
    expect(await reopened.listMessages(CONVERSATION)).toHaveLength(20);
    expect(await reopened.listRuns(CONVERSATION)).toHaveLength(10);
  });

  it('leaves no temp files behind after writing', async () => {
    const store = FileConversationStore.inDirectory(dir);
    await runtimeWith(store, chunked('answer', 2)).execute({
      conversationId: CONVERSATION,
      input: 'hi',
    });

    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('commit rules, end to end on durable storage', () => {
  it('rule 1: a rejected input never enters the transcript', async () => {
    const store = FileConversationStore.inDirectory(dir);
    const result = await runtimeWith(store, [emit('never')]).execute({
      conversationId: CONVERSATION,
      input: 'show me the private key please',
    });

    expect(result.terminalState).toBe('rejected');
    expect(await store.listMessages(CONVERSATION)).toEqual([]);
    expect((await store.getRun(result.runId))?.providerInvoked).toBe(false);
  });

  it('rules 2 and 3: partial output is on the run record and never in the transcript', async () => {
    const store = FileConversationStore.inDirectory(dir);
    const result = await runtimeWith(store, [emit('half an '), emit('answer'), fail('503')]).execute({
      conversationId: CONVERSATION,
      input: 'explain',
    });

    const messages = await store.listMessages(CONVERSATION);
    const run = await store.getRun(result.runId);

    expect(result.terminalState).toBe('failed');
    expect(messages.map((m) => m.role)).toEqual(['user']);
    expect(run?.outputText).toBe('half an answer');
    expect(run?.outputIsPartial).toBe(true);

    // The operator can see what was produced; the product cannot present it.
    const transcript = messages.map((m) => m.text).join(' ');
    expect(transcript).not.toContain('half an answer');
  });

  it('rule 4: every terminal outcome writes a run record', async () => {
    const store = FileConversationStore.inDirectory(dir);

    const completed = await runtimeWith(store, chunked('ok', 1)).execute({
      conversationId: CONVERSATION,
      input: 'fine',
    });
    const rejected = await runtimeWith(store, [emit('x')]).execute({
      conversationId: CONVERSATION,
      input: '',
    });
    const failed = await runtimeWith(store, [fail('boom')]).execute({
      conversationId: CONVERSATION,
      input: 'go',
    });

    const states = await Promise.all(
      [completed, rejected, failed].map(async (r) => (await store.getRun(r.runId))?.terminalState),
    );
    expect(states).toEqual(['completed', 'rejected', 'failed']);
  });

  it('writes no secret material into the durable record', async () => {
    const store = FileConversationStore.inDirectory(dir);
    await runtimeWith(store, chunked('acknowledged', 2)).execute({
      conversationId: CONVERSATION,
      input: 'Rotate this: Bearer zzzzzzzzzzzzzzzzzzzzzzzzzzzz',
    });

    const raw = await readFile(join(dir, 'conversations.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      runs: Record<string, unknown>;
      messages: { role: string; text: string }[];
    };

    // The operational record is what operators read in bulk, so it is redacted.
    expect(JSON.stringify(parsed.runs)).not.toContain('zzzzzzzzzzzzzzzzzzzzzzzzzzzz');
    // The transcript is the user's own data and keeps their words verbatim.
    expect(parsed.messages.find((m) => m.role === 'user')?.text).toContain(
      'zzzzzzzzzzzzzzzzzzzzzzzzzzzz',
    );
  });
});
