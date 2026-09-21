import { beforeEach, describe, expect, it } from 'vitest';
import { sequentialIds } from '../src/domain/ids.js';
import { RuleBasedPolicy } from '../src/policy/policy.js';
import { ScriptedProvider, chunked, emit, fail, stall, think } from '../src/provider/scripted.js';
import { InMemoryConversationStore } from '../src/store/store.js';
import { FakeClock, flush } from '../src/runtime/clock.js';
import { TurnRuntime } from '../src/runtime/runtime.js';
import type { ScriptStep } from '../src/provider/scripted.js';
import type { TraceEvent } from '../src/trace/trace.js';

const CONVERSATION = 'conv_0001';
const TIMEOUT_MS = 1_000;

function harness(script: readonly ScriptStep[], timeoutMs = TIMEOUT_MS) {
  const clock = new FakeClock();
  const provider = new ScriptedProvider(script);
  const store = new InMemoryConversationStore();
  const runtime = new TurnRuntime({
    policy: new RuleBasedPolicy(),
    provider,
    store,
    clock,
    ids: sequentialIds(),
    timeoutMs,
  });
  return { clock, provider, store, runtime };
}

const types = (trace: readonly TraceEvent[]) => trace.map((e) => e.type);
const lifecycle = (trace: readonly TraceEvent[]) => trace.filter((e) => e.kind === 'lifecycle');

describe('AC1 successful streamed turn', () => {
  it('streams in order, completes once, and persists both messages', async () => {
    const { runtime, store, provider } = harness([emit('Tokyo'), emit(' is'), emit(' the capital.')]);
    const seen: string[] = [];

    const result = await runtime.execute(
      { conversationId: CONVERSATION, input: 'Capital of Japan?' },
      { onChunk: (text) => seen.push(text) },
    );

    expect(result.terminalState).toBe('completed');
    expect(seen).toEqual(['Tokyo', ' is', ' the capital.']);
    expect(result.outputText).toBe('Tokyo is the capital.');
    expect(result.outputIsPartial).toBe(false);
    expect(provider.callCount).toBe(1);

    const messages = await store.listMessages(CONVERSATION);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]?.text).toBe('Tokyo is the capital.');

    const stored = await store.getRun(result.runId);
    expect(stored?.terminalState).toBe('completed');
    expect(stored?.outputIsPartial).toBe(false);
  });

  it('emits exactly one terminal lifecycle event, and it is last', async () => {
    const { runtime } = harness(chunked('hello world', 4));
    const result = await runtime.execute({ conversationId: CONVERSATION, input: 'hi' });

    const life = lifecycle(result.trace);
    const terminals = life.filter((e) => e.type.startsWith('run.') && e.type !== 'run.started');
    expect(terminals).toHaveLength(1);
    expect(life.at(-1)).toBe(terminals[0]);
    expect(types(life)).toContain('provider.chunk');
  });
});

describe('AC2 pre-response rejection', () => {
  it('never invokes the provider and persists no messages', async () => {
    const { runtime, store, provider } = harness([emit('should never run')]);

    const result = await runtime.execute({ conversationId: CONVERSATION, input: '   ' });

    expect(result.terminalState).toBe('rejected');
    expect(result.decision.ruleId).toBe('block.empty_input');
    // The strongest form of the assertion: the provider was not merely ignored.
    expect(provider.callCount).toBe(0);
    expect(result.providerInvoked).toBe(false);
    expect(types(result.trace)).not.toContain('provider.invoked');

    // Commit rule 1: a refused input never enters the transcript at all.
    expect(await store.listMessages(CONVERSATION)).toEqual([]);
    const stored = await store.getRun(result.runId);
    expect(stored?.terminalState).toBe('rejected');
    expect(stored?.outputText).toBe('');
  });
});

describe('AC3 cancellation during streaming', () => {
  it('stops provider production and cannot later complete', async () => {
    const { runtime, provider, store } = harness(chunked('abcdefghijklmnop', 8));
    const controller = new AbortController();
    const seen: string[] = [];

    const result = await runtime.execute(
      { conversationId: CONVERSATION, input: 'stream please' },
      {
        signal: controller.signal,
        onChunk: (text) => {
          seen.push(text);
          if (seen.length === 3) controller.abort();
        },
      },
    );

    expect(result.terminalState).toBe('cancelled');
    // Production stopped, rather than the output merely being hidden.
    expect(provider.chunksEmitted).toBe(3);
    expect(provider.abortObserved).toBe(true);
    expect(result.chunkCount).toBe(3);
    expect(result.outputIsPartial).toBe(true);

    // Commit rules 2 and 3: user message kept, no assistant message, partial on the run.
    const messages = await store.listMessages(CONVERSATION);
    expect(messages.map((m) => m.role)).toEqual(['user']);
    const stored = await store.getRun(result.runId);
    expect(stored?.outputText).toBe('abcdef');
    expect(stored?.outputIsPartial).toBe(true);
  });

  it('rejects a cancellation that arrives after completion, observably', async () => {
    const { runtime } = harness([emit('done already')]);
    const controller = new AbortController();

    const result = await runtime.execute(
      { conversationId: CONVERSATION, input: 'hi' },
      { signal: controller.signal },
    );
    expect(result.terminalState).toBe('completed');

    controller.abort();
    await flush();

    // The run holds its terminal state; nothing reopens it.
    expect(result.terminalState).toBe('completed');
  });

  it('settles as cancelled when the signal is already aborted on entry', async () => {
    const { runtime, provider } = harness([emit('never')]);

    const result = await runtime.execute(
      { conversationId: CONVERSATION, input: 'hi' },
      { signal: AbortSignal.abort() },
    );

    expect(result.terminalState).toBe('cancelled');
    expect(provider.callCount).toBe(0);
  });
});

describe('AC4 timeout', () => {
  it('times out a stalled provider using the injected clock, with no real waiting', async () => {
    const { runtime, clock, provider, store } = harness([emit('partial answer'), stall()], 500);

    const pending = runtime.execute({ conversationId: CONVERSATION, input: 'slow one' });
    await flush();

    await clock.advance(500);
    const result = await pending;

    expect(result.terminalState).toBe('timed_out');
    expect(result.termination?.code).toBe('deadline.exceeded');
    expect(provider.abortObserved).toBe(true);
    expect(result.outputText).toBe('partial answer');
    expect(result.outputIsPartial).toBe(true);

    expect((await store.listMessages(CONVERSATION)).map((m) => m.role)).toEqual(['user']);
  });

  it('does not fire the deadline for a turn that finished in time', async () => {
    const { runtime, clock } = harness([emit('fast')], 500);
    const result = await runtime.execute({ conversationId: CONVERSATION, input: 'hi' });

    await clock.advance(10_000);

    expect(result.terminalState).toBe('completed');
    // The timer was cancelled on the way out rather than left to leak.
    expect(clock.pendingTimers).toBe(0);
  });
});

describe('AC5 provider failure after partial output', () => {
  it('fails the run, keeps the partial text traceable, and persists no assistant message', async () => {
    const { runtime, store } = harness([emit('Here is '), emit('half an ans'), fail('upstream 503')]);

    const result = await runtime.execute({ conversationId: CONVERSATION, input: 'explain' });

    expect(result.terminalState).toBe('failed');
    expect(result.termination?.code).toBe('provider.stream_error');
    expect(result.outputText).toBe('Here is half an ans');
    expect(result.outputIsPartial).toBe(true);

    expect(types(result.trace)).toContain('provider.error');
    const stored = await store.getRun(result.runId);
    expect(stored?.chunkCount).toBe(2);
    expect((await store.listMessages(CONVERSATION)).map((m) => m.role)).toEqual(['user']);
  });

  it('treats a stream that ends without a completion event as failed, not completed', async () => {
    // A provider yielding chunks then closing without `done` is a protocol
    // violation; completing on that assumption would be a silent lie.
    const provider = new ScriptedProvider([]);
    const clock = new FakeClock();
    const store = new InMemoryConversationStore();
    const runtime = new TurnRuntime({
      policy: new RuleBasedPolicy(),
      provider: {
        name: 'truncating',
        async *stream() {
          yield { type: 'chunk', text: 'cut off' } as const;
        },
      },
      store,
      clock,
      ids: sequentialIds(),
      timeoutMs: TIMEOUT_MS,
    });

    const result = await runtime.execute({ conversationId: CONVERSATION, input: 'hi' });

    expect(result.terminalState).toBe('failed');
    expect(result.termination?.code).toBe('provider.truncated_stream');
    expect(provider.callCount).toBe(0);
  });
});

describe('AC6 competing terminal transitions', () => {
  it('lets the deadline win when it fires before the provider finishes', async () => {
    const { runtime, clock } = harness([emit('one'), stall()], 100);

    const pending = runtime.execute({ conversationId: CONVERSATION, input: 'hi' });
    await flush();
    await clock.advance(100);
    const result = await pending;

    const life = lifecycle(result.trace);
    expect(life.filter((e) => e.type.startsWith('run.') && e.type !== 'run.started')).toHaveLength(1);
    expect(result.terminalState).toBe('timed_out');
  });

  it('records a refusal when cancellation loses to the deadline', async () => {
    const { runtime, clock } = harness([emit('one'), stall()], 100);
    const controller = new AbortController();

    const pending = runtime.execute(
      { conversationId: CONVERSATION, input: 'hi' },
      { signal: controller.signal },
    );
    await flush();

    // Both racers are scheduled for the same instant. The deadline was
    // registered first, so it claims the latch; the cancellation arrives in the
    // same synchronous batch, while the run is still in flight, and loses.
    clock.setTimer(100, () => controller.abort());
    await clock.advance(100);
    const result = await pending;

    expect(result.terminalState).toBe('timed_out');
    const refusals = result.trace.filter((e) => e.type === 'terminal.refused');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.data).toMatchObject({ attempted: 'cancelled', held: 'timed_out' });
  });
});

describe('AC7 safe operational trace', () => {
  let secretInput: string;

  beforeEach(() => {
    secretInput = 'Summarise this log: Bearer abcdefghijklmnopqrstuvwxyz012345';
  });

  it('redacts secret-shaped values that arrive inside ordinary text', async () => {
    const { runtime } = harness([emit('ok')]);
    const result = await runtime.execute({ conversationId: CONVERSATION, input: secretInput });

    const serialised = JSON.stringify(result.trace);
    expect(serialised).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
  });

  it('never carries hidden model reasoning into the trace or the store', async () => {
    const thought = 'internal deliberation the user must not see';
    const { runtime, store, provider } = harness([think(thought), emit('Sure.')]);

    const result = await runtime.execute({ conversationId: CONVERSATION, input: 'hi' });
    const stored = await store.getRun(result.runId);

    expect(provider.hiddenReasoning).toEqual([thought]);
    expect(JSON.stringify(result.trace)).not.toContain(thought);
    expect(JSON.stringify(stored)).not.toContain(thought);
    expect(stored?.outputText).toBe('Sure.');
  });

  it('orders the trace and explains the run without raw payloads', async () => {
    const { runtime } = harness([emit('a'), emit('b')]);
    const result = await runtime.execute({ conversationId: CONVERSATION, input: 'hi' });

    expect(result.trace.map((e) => e.seq)).toEqual(result.trace.map((_, i) => i));
    expect(types(lifecycle(result.trace))).toEqual([
      'run.started',
      'policy.evaluated',
      'message.persisted',
      'provider.invoked',
      'provider.chunk',
      'provider.chunk',
      'provider.stream_end',
      'run.completed',
    ]);
  });
});
