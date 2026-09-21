import type { PolicyDecision, TurnRequest } from '../domain/types.js';

/**
 * The pre-response gate.
 *
 * Deliberately has no reference to any provider type. The gate cannot invoke a
 * model even by accident, which is what makes AC2 ("the provider is never
 * called") a property of the design rather than of the call order in the
 * orchestrator.
 *
 * Implementations must be synchronous and deterministic: the same input always
 * yields the same decision, so the benchmark can assert on it.
 */
export interface PolicyEngine {
  readonly name: string;
  evaluate(request: TurnRequest): PolicyDecision;
}

export interface PolicyRule {
  /** Stable id recorded in the decision and the trace, e.g. `block.oversized_input`. */
  readonly id: string;
  /** Shown to the user when this rule fires. Must not reveal the rule's internals. */
  readonly message: string;
  matches(input: string): boolean;
}

export interface RuleBasedPolicyOptions {
  readonly maxInputChars?: number;
  /** Replaces the defaults entirely. Useful for tests that need one predictable rule. */
  readonly rules?: readonly PolicyRule[];
}

const DEFAULT_MAX_INPUT_CHARS = 4_000;

/**
 * Rules are ordered and the first match wins, so a decision is always
 * attributable to exactly one rule id.
 *
 * This is a plausible stand-in for a safety classifier, not a real one. A
 * production gate would combine a classifier with these cheap deterministic
 * checks; the interface is the part that matters here.
 */
export function defaultRules(maxInputChars: number): readonly PolicyRule[] {
  return [
    {
      id: 'block.empty_input',
      message: 'Message is empty.',
      matches: (input) => input.trim().length === 0,
    },
    {
      id: 'block.oversized_input',
      message: `Message exceeds the ${maxInputChars}-character limit.`,
      matches: (input) => input.length > maxInputChars,
    },
    {
      id: 'block.credential_exfiltration',
      message: 'This assistant cannot repeat or reveal credentials.',
      matches: (input) =>
        /\b(api[_\s-]?key|secret[_\s-]?key|password|private[_\s-]?key|access[_\s-]?token)\b/i.test(
          input,
        ) && /\b(reveal|show|print|leak|dump|exfiltrate|send me|what is (my|the))\b/i.test(input),
    },
    {
      id: 'block.self_harm',
      message: 'This assistant cannot help with this request. Support is available at 988 (US) or your local crisis line.',
      matches: (input) => /\b(kill myself|end my life|suicide method|how to self.?harm)\b/i.test(input),
    },
  ];
}

export class RuleBasedPolicy implements PolicyEngine {
  readonly name = 'rule-based';
  private readonly rules: readonly PolicyRule[];

  constructor(options: RuleBasedPolicyOptions = {}) {
    const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
    this.rules = options.rules ?? defaultRules(maxInputChars);
  }

  evaluate(request: TurnRequest): PolicyDecision {
    for (const rule of this.rules) {
      if (rule.matches(request.input)) {
        return { allowed: false, ruleId: rule.id, message: rule.message };
      }
    }
    return { allowed: true, ruleId: 'allow.default', message: 'No rule matched.' };
  }
}
