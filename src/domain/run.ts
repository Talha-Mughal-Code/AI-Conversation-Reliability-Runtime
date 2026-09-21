import { isTerminal, isTransitionAllowed, type RunState, type TerminalState } from './states.js';
import type {
  RunSnapshot,
  TerminationDetail,
  TransitionRecord,
  TransitionResult,
} from './types.js';

export interface RunInit {
  readonly runId: string;
  readonly conversationId: string;
  readonly input: string;
  /** Injected so tests and the benchmark can drive time without sleeping. */
  readonly now: () => number;
}

/**
 * A single conversational turn.
 *
 * This class is the terminal latch. Completion, cancellation, timeout and
 * provider failure all race for the same run, and all of them go through
 * `transition()`. The first terminal transition to arrive wins; every later one
 * is refused and handed back to the caller so the refusal can be traced instead
 * of disappearing.
 *
 * The class is deliberately free of I/O, clocks, logging and provider types so
 * the state rules can be tested on their own.
 */
export class Run {
  readonly id: string;
  readonly conversationId: string;
  readonly input: string;
  readonly startedAt: number;

  private readonly now: () => number;
  private currentState: RunState = 'pending';
  private terminal: TerminalState | null = null;
  private termination: TerminationDetail | null = null;
  private endedAt: number | null = null;
  private readonly chunks: string[] = [];
  private readonly transitionLog: TransitionRecord[] = [];

  constructor(init: RunInit) {
    this.id = init.runId;
    this.conversationId = init.conversationId;
    this.input = init.input;
    this.now = init.now;
    this.startedAt = init.now();
  }

  get state(): RunState {
    return this.currentState;
  }

  get terminalState(): TerminalState | null {
    return this.terminal;
  }

  get settled(): boolean {
    return this.terminal !== null;
  }

  /** Text assembled from provider chunks so far. Partial unless the run completed. */
  get outputText(): string {
    return this.chunks.join('');
  }

  get chunkCount(): number {
    return this.chunks.length;
  }

  /**
   * Attempt to move the run to `to`.
   *
   * Refused in exactly two cases, both reported rather than thrown:
   *  - the run already holds a terminal state (`already_terminal`)
   *  - the edge is not in the transition table (`illegal_transition`)
   */
  transition(to: RunState, detail?: TerminationDetail): TransitionResult {
    const previous = this.currentState;

    if (this.terminal !== null) {
      return { accepted: false, state: previous, previous, refusal: 'already_terminal' };
    }
    if (!isTransitionAllowed(previous, to)) {
      return { accepted: false, state: previous, previous, refusal: 'illegal_transition' };
    }

    this.currentState = to;
    const at = this.now();
    this.transitionLog.push({ seq: this.transitionLog.length, from: previous, to, at, detail });

    if (isTerminal(to)) {
      this.terminal = to;
      this.termination = detail ?? null;
      this.endedAt = at;
    }
    return { accepted: true, state: to, previous };
  }

  /**
   * Append streamed text.
   *
   * Refused once the run is settled. A provider that keeps yielding after a
   * timeout or cancellation cannot extend the recorded output, so the stored
   * text always matches what the terminal state claims happened.
   */
  appendChunk(text: string): boolean {
    if (this.terminal !== null) return false;
    if (this.currentState !== 'streaming') return false;
    this.chunks.push(text);
    return true;
  }

  snapshot(): RunSnapshot {
    return {
      runId: this.id,
      conversationId: this.conversationId,
      state: this.currentState,
      terminalState: this.terminal,
      input: this.input,
      outputText: this.outputText,
      outputIsPartial: this.terminal !== 'completed',
      chunkCount: this.chunks.length,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      termination: this.termination,
      transitions: [...this.transitionLog],
    };
  }
}
