import { describe, expect, it } from 'vitest';
import { Run } from '../src/domain/run.js';
import { TERMINAL_STATES, isTerminal, isTransitionAllowed } from '../src/domain/states.js';
import type { TerminalState } from '../src/domain/states.js';

/** Monotonic fake clock: every read advances one tick, so ordering is checkable. */
function tickingClock() {
  let t = 0;
  return () => ++t;
}

function newRun(): Run {
  return new Run({
    runId: 'run_0001',
    conversationId: 'conv_0001',
    input: 'hello',
    now: tickingClock(),
  });
}

describe('run state machine', () => {
  it('walks the happy path and records every transition in order', () => {
    const run = newRun();
    expect(run.state).toBe('pending');

    expect(run.transition('screening').accepted).toBe(true);
    expect(run.transition('streaming').accepted).toBe(true);
    run.appendChunk('Hel');
    run.appendChunk('lo.');
    expect(run.transition('completed').accepted).toBe(true);

    const snap = run.snapshot();
    expect(snap.terminalState).toBe('completed');
    expect(snap.outputText).toBe('Hello.');
    expect(snap.outputIsPartial).toBe(false);
    expect(snap.transitions.map((t) => t.to)).toEqual(['screening', 'streaming', 'completed']);
    expect(snap.transitions.map((t) => t.seq)).toEqual([0, 1, 2]);
  });

  it('refuses to complete a run that never streamed', () => {
    const run = newRun();
    run.transition('screening');

    const result = run.transition('completed');

    expect(result.accepted).toBe(false);
    expect(result.refusal).toBe('illegal_transition');
    expect(run.state).toBe('screening');
    expect(run.settled).toBe(false);
  });

  it('refuses to reject a run that already reached the provider', () => {
    const run = newRun();
    run.transition('screening');
    run.transition('streaming');

    // `rejected` means the policy gate blocked the input. Once we are streaming
    // that claim would be a lie, so the edge does not exist.
    expect(run.transition('rejected').refusal).toBe('illegal_transition');
    expect(run.state).toBe('streaming');
  });
});

describe('terminal latch', () => {
  it('lets exactly one of three racing terminal transitions win', () => {
    const run = newRun();
    run.transition('screening');
    run.transition('streaming');

    // Completion, timeout and cancellation all fire for the same run.
    const attempts = [
      run.transition('completed', { code: 'provider.done', message: 'stream ended' }),
      run.transition('timed_out', { code: 'deadline.exceeded', message: 'deadline hit' }),
      run.transition('cancelled', { code: 'client.cancel', message: 'user cancelled' }),
    ];

    const accepted = attempts.filter((a) => a.accepted);
    expect(accepted).toHaveLength(1);
    expect(run.terminalState).toBe('completed');

    // The losers are told they lost, so the runtime can trace the refusal
    // instead of silently dropping it.
    for (const loser of attempts.filter((a) => !a.accepted)) {
      expect(loser.refusal).toBe('already_terminal');
      expect(loser.state).toBe('completed');
    }
  });

  it('holds the latch across interleaved async callers', async () => {
    const run = newRun();
    run.transition('screening');
    run.transition('streaming');

    const racers: TerminalState[] = ['timed_out', 'cancelled', 'failed', 'completed'];
    const results = await Promise.all(
      racers.map(async (state, i) => {
        // Stagger onto different microtask ticks so the calls genuinely interleave.
        for (let j = 0; j <= i; j++) await Promise.resolve();
        return run.transition(state, { code: 'race', message: state });
      }),
    );

    expect(results.filter((r) => r.accepted)).toHaveLength(1);
    expect(run.terminalState).toBe('timed_out');
    expect(run.snapshot().transitions.filter((t) => isTerminal(t.to))).toHaveLength(1);
  });

  it.each(TERMINAL_STATES)('freezes the run once it is %s', (terminal) => {
    const run = newRun();
    run.transition('screening');
    if (isTransitionAllowed('screening', terminal)) {
      run.transition(terminal, { code: 'test', message: terminal });
    } else {
      run.transition('streaming');
      run.transition(terminal, { code: 'test', message: terminal });
    }

    expect(run.settled).toBe(true);
    const settledAt = run.snapshot();

    for (const other of TERMINAL_STATES) {
      expect(run.transition(other).refusal).toBe('already_terminal');
    }
    expect(run.snapshot().transitions).toEqual(settledAt.transitions);
  });
});

describe('chunk accumulation', () => {
  it('ignores chunks that arrive after a terminal state', () => {
    const run = newRun();
    run.transition('screening');
    run.transition('streaming');
    run.appendChunk('kept');

    run.transition('cancelled', { code: 'client.cancel', message: 'user cancelled' });

    // A provider that is slow to notice the abort must not extend the record.
    expect(run.appendChunk('late')).toBe(false);
    expect(run.snapshot().outputText).toBe('kept');
    expect(run.snapshot().chunkCount).toBe(1);
  });

  it('marks retained output as partial for every non-completed terminal state', () => {
    const run = newRun();
    run.transition('screening');
    run.transition('streaming');
    run.appendChunk('half a sen');
    run.transition('timed_out', { code: 'deadline.exceeded', message: 'deadline hit' });

    const snap = run.snapshot();
    expect(snap.outputText).toBe('half a sen');
    expect(snap.outputIsPartial).toBe(true);
  });

  it('ignores chunks before streaming starts', () => {
    const run = newRun();
    expect(run.appendChunk('too early')).toBe(false);
    run.transition('screening');
    expect(run.appendChunk('still too early')).toBe(false);
    expect(run.snapshot().outputText).toBe('');
  });
});
