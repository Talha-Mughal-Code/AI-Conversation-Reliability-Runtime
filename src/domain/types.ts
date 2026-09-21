import type { RunState, TerminalState } from './states.js';

/** Why a run left the non-terminal world. Free-form detail is deliberately shallow. */
export interface TerminationDetail {
  /** Short machine-readable cause, e.g. `policy.blocked_topic`, `provider.stream_error`. */
  readonly code: string;
  /** One line a human can read in a trace. Never contains secrets or model reasoning. */
  readonly message: string;
}

export interface TransitionRecord {
  readonly seq: number;
  readonly from: RunState;
  readonly to: RunState;
  readonly at: number;
  readonly detail?: TerminationDetail;
}

/**
 * Outcome of an attempted transition.
 *
 * `accepted: false` is a normal, expected result -- it is how a losing racer
 * (a timeout that fired just after completion) learns it lost. Callers are
 * expected to record the refusal rather than treat it as an error.
 */
export interface TransitionResult {
  readonly accepted: boolean;
  /** State of the run after the attempt: the new state if accepted, otherwise the unchanged one. */
  readonly state: RunState;
  readonly previous: RunState;
  readonly refusal?: 'already_terminal' | 'illegal_transition';
}

export interface PolicyDecision {
  readonly allowed: boolean;
  /** Identifier of the rule that decided, e.g. `allow.default` or `block.self_harm`. */
  readonly ruleId: string;
  /** User-facing explanation. Safe to display. */
  readonly message: string;
}

export type ProviderEvent =
  | { readonly type: 'chunk'; readonly text: string }
  | { readonly type: 'done' };

export interface TurnRequest {
  readonly conversationId: string;
  readonly input: string;
}

export interface RunSnapshot {
  readonly runId: string;
  readonly conversationId: string;
  readonly state: RunState;
  readonly terminalState: TerminalState | null;
  readonly input: string;
  /** Text accumulated from provider chunks. Present for successful AND unsuccessful runs. */
  readonly outputText: string;
  /** True when `outputText` is a partial fragment that must never be shown as a finished reply. */
  readonly outputIsPartial: boolean;
  readonly chunkCount: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly termination: TerminationDetail | null;
  readonly transitions: readonly TransitionRecord[];
}
