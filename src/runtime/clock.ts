/** Cancels a pending timer. Safe to call more than once. */
export type CancelTimer = () => void;

/**
 * Time, as a dependency.
 *
 * The runtime never calls `Date.now` or `setTimeout` directly, so timeout
 * behaviour can be driven instantly and deterministically in tests. No test in
 * this repository waits for real milliseconds to elapse.
 */
export interface Clock {
  now(): number;
  setTimer(delayMs: number, callback: () => void): CancelTimer;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  setTimer(delayMs: number, callback: () => void): CancelTimer {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  }
}

interface FakeTimer {
  readonly id: number;
  readonly at: number;
  readonly callback: () => void;
  cancelled: boolean;
}

/**
 * Manually advanced clock.
 *
 * `advance` fires due timers in time order, then flushes the microtask and
 * macrotask queues so any promise chain the callback started (an abort
 * listener, a provider unwinding) has settled before it returns.
 */
export class FakeClock implements Clock {
  private current: number;
  private nextId = 1;
  private timers: FakeTimer[] = [];

  constructor(startAt = 0) {
    this.current = startAt;
  }

  now(): number {
    return this.current;
  }

  setTimer(delayMs: number, callback: () => void): CancelTimer {
    const timer: FakeTimer = { id: this.nextId++, at: this.current + delayMs, callback, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  /** Number of timers still pending. A leaked timer is a bug tests can catch. */
  get pendingTimers(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }

  async advance(byMs: number): Promise<void> {
    const target = this.current + byMs;

    for (;;) {
      const pending = this.timers
        .filter((t) => !t.cancelled && t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id);
      if (pending.length === 0) break;

      // Everything scheduled for the same instant fires in one synchronous
      // batch, as real timers do. Flushing between them would hand the runtime
      // a turn of the event loop it would not get in production, and would hide
      // races between callbacks that genuinely arrive together.
      const instant = pending[0]!.at;
      const batch = pending.filter((t) => t.at === instant);

      this.timers = this.timers.filter((t) => !batch.includes(t));
      this.current = instant;
      for (const timer of batch) timer.callback();
      await flush();
    }

    this.current = target;
    await flush();
  }
}

/** Drains pending microtasks and one macrotask turn. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
