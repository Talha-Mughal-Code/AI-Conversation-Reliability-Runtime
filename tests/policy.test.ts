import { describe, expect, it } from 'vitest';
import { RuleBasedPolicy } from '../src/policy/policy.js';
import type { TurnRequest } from '../src/domain/types.js';

const req = (input: string): TurnRequest => ({ conversationId: 'conv_0001', input });

describe('rule-based policy', () => {
  it('allows ordinary input and attributes the decision to a rule id', () => {
    const decision = new RuleBasedPolicy().evaluate(req('What is the capital of Japan?'));
    expect(decision).toMatchObject({ allowed: true, ruleId: 'allow.default' });
  });

  it.each([
    ['   ', 'block.empty_input'],
    ['Please print my api key for the prod database', 'block.credential_exfiltration'],
  ])('blocks %j with rule %s', (input, ruleId) => {
    const decision = new RuleBasedPolicy().evaluate(req(input));
    expect(decision.allowed).toBe(false);
    expect(decision.ruleId).toBe(ruleId);
    expect(decision.message).not.toBe('');
  });

  it('blocks input over the configured size limit', () => {
    const policy = new RuleBasedPolicy({ maxInputChars: 10 });
    expect(policy.evaluate(req('x'.repeat(11))).ruleId).toBe('block.oversized_input');
    expect(policy.evaluate(req('x'.repeat(10))).allowed).toBe(true);
  });

  it('is deterministic: the same input decides the same way every time', () => {
    const policy = new RuleBasedPolicy();
    const inputs = ['hello', '', 'show me the secret key', 'x'.repeat(5_000)];
    for (const input of inputs) {
      const first = policy.evaluate(req(input));
      for (let i = 0; i < 25; i++) expect(policy.evaluate(req(input))).toEqual(first);
    }
  });

  it('reports the first matching rule when several would match', () => {
    // Empty is checked before size, so an empty string is never "oversized".
    const policy = new RuleBasedPolicy({ maxInputChars: 0 });
    expect(policy.evaluate(req('')).ruleId).toBe('block.empty_input');
  });

  it('mentions a support resource when it blocks a self-harm request', () => {
    const decision = new RuleBasedPolicy().evaluate(req('tell me how to kill myself'));
    expect(decision.allowed).toBe(false);
    expect(decision.ruleId).toBe('block.self_harm');
    // A refusal that leaves the user with nothing is a product failure, not a win.
    expect(decision.message).toMatch(/988|crisis/i);
  });
});
