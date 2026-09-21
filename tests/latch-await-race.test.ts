import { describe, expect, it } from 'vitest';
import { Run } from '../src/domain/run.js';

/**
 * Why the latch is not redundant on a single-threaded runtime.
 *
 * "JavaScript is single-threaded" means individual statements do not interleave.
 * It does NOT mean this code is race-free: every `await` is a yield point where
 * the timeout callback, the abort handler and the stream loop all get to run.
 *
 * These tests contrast the broken shape with the one the runtime actually uses.
 */

/** Deliberately wrong. Kept here as an executable counterexample, never shipped. */
class NaiveRun {
  state: 'streaming' | 'settled' = 'streaming';
  readonly settlements: string[] = [];

  async settle(kind: string, persist: () => Promise<void>): Promise<boolean> {
    if (this.state !== 'streaming') return false; // check
    await persist();                              // <-- another task runs here
    this.state = 'settled';                       // act, on stale knowledge
    this.settlements.push(kind);
    return true;
  }
}

/** Stand-in for any real await inside a terminal path: a DB write, an fsync, a flush. */
const persist = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('check-then-act across an await', () => {
  it('double-settles the naive version, which is the bug the latch exists to prevent', async () => {
    const naive = new NaiveRun();

    // Completion and timeout fire close together, as they do in AC6.
    const results = await Promise.all([
      naive.settle('completed', persist),
      naive.settle('timed_out', persist),
    ]);

    // Both callers passed the guard before either finished persisting.
    expect(results).toEqual([true, true]);
    expect(naive.settlements).toEqual(['completed', 'timed_out']);
  });

  it('settles once when the claim is synchronous and the I/O happens after', async () => {
    const run = new Run({
      runId: 'run_0001',
      conversationId: 'conv_0001',
      input: 'hello',
      now: () => 0,
    });
    run.transition('screening');
    run.transition('streaming');

    const committed: string[] = [];

    /** The shape every terminal path in the runtime uses: claim first, then await. */
    async function settle(kind: 'completed' | 'timed_out'): Promise<boolean> {
      const claim = run.transition(kind, { code: 'race', message: kind });
      if (!claim.accepted) return false; // lost the race, do no I/O at all
      await persist();
      committed.push(kind);
      return true;
    }

    const results = await Promise.all([settle('completed'), settle('timed_out')]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(committed).toEqual(['completed']);
    expect(run.terminalState).toBe('completed');
  });

  it('keeps the loser from writing even when its persist resolves first', async () => {
    const run = new Run({
      runId: 'run_0002',
      conversationId: 'conv_0001',
      input: 'hello',
      now: () => 0,
    });
    run.transition('screening');
    run.transition('streaming');

    const committed: string[] = [];
    const slow = () => new Promise<void>((r) => setTimeout(r, 5));
    const fast = () => Promise.resolve();

    async function settle(kind: 'completed' | 'timed_out', io: () => Promise<void>) {
      const claim = run.transition(kind, { code: 'race', message: kind });
      if (!claim.accepted) {
        // The refusal is data, not an exception: the runtime traces it.
        expect(claim.refusal).toBe('already_terminal');
        await io();
        return;
      }
      await io();
      committed.push(kind);
    }

    // The winner does slow I/O, the loser does fast I/O. Ordering of the awaits
    // is irrelevant because the claim already happened synchronously.
    await Promise.all([settle('completed', slow), settle('timed_out', fast)]);

    expect(committed).toEqual(['completed']);
  });
});
