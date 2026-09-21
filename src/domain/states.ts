/**
 * The run state machine.
 *
 * A turn is always in exactly one state. Five of those states are terminal, and
 * a run reaches exactly one of them exactly once. Everything the product claims
 * about a turn -- "it completed", "it was blocked", "it timed out" -- is read
 * from this single value, never from a scattered boolean flag.
 */

export const NON_TERMINAL_STATES = ['pending', 'screening', 'streaming'] as const;

export const TERMINAL_STATES = [
  'completed',
  'rejected',
  'cancelled',
  'timed_out',
  'failed',
] as const;

export type NonTerminalState = (typeof NON_TERMINAL_STATES)[number];
export type TerminalState = (typeof TERMINAL_STATES)[number];
export type RunState = NonTerminalState | TerminalState;

const TERMINAL_SET: ReadonlySet<string> = new Set(TERMINAL_STATES);

export function isTerminal(state: RunState): state is TerminalState {
  return TERMINAL_SET.has(state);
}

/**
 * Legal forward edges.
 *
 * Two rules are encoded here and nowhere else:
 *
 *  1. `completed` is reachable only from `streaming`. A run cannot complete
 *     without having actually streamed, which is what stops a rejected or
 *     timed-out turn from being dressed up as a success.
 *  2. `rejected` is reachable only from `screening`. Rejection means the policy
 *     gate refused the input, so by construction it cannot be reported for a
 *     turn that already reached the provider.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  pending: ['screening', 'cancelled', 'timed_out', 'failed'],
  screening: ['streaming', 'rejected', 'cancelled', 'timed_out', 'failed'],
  streaming: ['completed', 'cancelled', 'timed_out', 'failed'],
  completed: [],
  rejected: [],
  cancelled: [],
  timed_out: [],
  failed: [],
};

export function isTransitionAllowed(from: RunState, to: RunState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Terminal states in which the product must NOT present an assistant reply as delivered. */
export function isSuccessful(state: TerminalState): boolean {
  return state === 'completed';
}
