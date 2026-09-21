import type { Clock } from '../runtime/clock.js';
import { redact } from './redact.js';

/**
 * `lifecycle` events describe what happened to the run and are subject to the
 * terminal-ordering rule. `diagnostic` events explain the runtime's own
 * behaviour -- most importantly a terminal transition that arrived too late and
 * was refused.
 *
 * Diagnostics are deliberately allowed to follow the terminal lifecycle event.
 * A losing racer is exactly the thing AC6 asks to be observable, and dropping
 * its record to satisfy a literal "nothing after terminal" reading would hide
 * it. The benchmark therefore asserts the precise invariant: exactly one
 * terminal lifecycle event, and no lifecycle event after it.
 */
export type TraceEventKind = 'lifecycle' | 'diagnostic';

export interface TraceEvent {
  readonly seq: number;
  readonly at: number;
  readonly kind: TraceEventKind;
  /** Dotted, machine-readable, e.g. `policy.evaluated`, `provider.chunk`. */
  readonly type: string;
  readonly data: Record<string, unknown>;
}

const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'run.completed',
  'run.rejected',
  'run.cancelled',
  'run.timed_out',
  'run.failed',
]);

export function isTerminalEventType(type: string): boolean {
  return TERMINAL_EVENT_TYPES.has(type);
}

/**
 * Ordered operational log for one run.
 *
 * Every value written here passes through `redact` first, so a caller cannot
 * leak a secret by handing the recorder an unexpected field.
 */
export class TraceRecorder {
  private readonly events: TraceEvent[] = [];
  private sealed = false;

  constructor(
    readonly runId: string,
    private readonly clock: Clock,
  ) {}

  /** Appends a lifecycle event. Refused once a terminal event has been recorded. */
  lifecycle(type: string, data: Record<string, unknown> = {}): boolean {
    if (this.sealed) {
      this.append('diagnostic', 'trace.after_terminal_suppressed', { suppressedType: type });
      return false;
    }
    this.append('lifecycle', type, data);
    if (isTerminalEventType(type)) this.sealed = true;
    return true;
  }

  /** Appends a diagnostic. Permitted after the terminal event; see the note above. */
  diagnostic(type: string, data: Record<string, unknown> = {}): void {
    this.append('diagnostic', type, data);
  }

  private append(kind: TraceEventKind, type: string, data: Record<string, unknown>): void {
    this.events.push({
      seq: this.events.length,
      at: this.clock.now(),
      kind,
      type,
      data: redact(data) as Record<string, unknown>,
    });
  }

  snapshot(): readonly TraceEvent[] {
    return [...this.events];
  }

  get lifecycleEvents(): readonly TraceEvent[] {
    return this.events.filter((e) => e.kind === 'lifecycle');
  }
}
