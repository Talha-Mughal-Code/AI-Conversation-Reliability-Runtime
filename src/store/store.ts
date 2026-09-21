import type { TerminalState } from '../domain/states.js';
import type { RunSnapshot } from '../domain/types.js';
import type { TraceEvent } from '../trace/trace.js';

export type MessageRole = 'user' | 'assistant';

/**
 * A message in the conversation transcript.
 *
 * This collection is the product's answer to "what was said". Nothing partial
 * or unsuccessful is ever written here -- see the commit rules on
 * `ConversationStore`.
 */
export interface StoredMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly role: MessageRole;
  readonly text: string;
  readonly createdAt: number;
}

/**
 * The operational record of a run. Written for every outcome, including the
 * unsuccessful ones, and the only place partial output is retained.
 */
export interface StoredRun {
  readonly runId: string;
  readonly conversationId: string;
  readonly terminalState: TerminalState;
  /**
   * The user's input, redacted. Operators read run records in bulk, so this is
   * an operational surface rather than user data; `StoredMessage.text` keeps the
   * verbatim wording for the product's own transcript.
   */
  readonly input: string;
  /** Text produced before the run settled. Partial unless `terminalState` is `completed`. */
  readonly outputText: string;
  readonly outputIsPartial: boolean;
  readonly chunkCount: number;
  readonly policyRuleId: string;
  readonly providerInvoked: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly termination: RunSnapshot['termination'];
  readonly trace: readonly TraceEvent[];
}

/**
 * Persistence port.
 *
 * Commit rules, enforced by the runtime and asserted by the tests:
 *
 *  1. The user message is appended only after the policy gate ALLOWS the input,
 *     and before the provider is invoked. A rejected input never enters the
 *     transcript, so the transcript cannot show a turn the product refused.
 *  2. The assistant message is appended only on the `completed` transition, and
 *     only by the caller that won the terminal latch.
 *  3. Partial output from a cancelled, timed-out or failed run is retained on
 *     the StoredRun and never appended as a message. The operator can see what
 *     was produced; the product never presents it as a delivered reply.
 *  4. A StoredRun is written for every terminal outcome, including rejection.
 */
export interface ConversationStore {
  appendMessage(message: StoredMessage): Promise<void>;
  saveRun(run: StoredRun): Promise<void>;
  listMessages(conversationId: string): Promise<readonly StoredMessage[]>;
  getRun(runId: string): Promise<StoredRun | null>;
  listRuns(conversationId: string): Promise<readonly StoredRun[]>;
}

export class InMemoryConversationStore implements ConversationStore {
  private readonly messages: StoredMessage[] = [];
  private readonly runs = new Map<string, StoredRun>();

  async appendMessage(message: StoredMessage): Promise<void> {
    this.messages.push(message);
  }

  async saveRun(run: StoredRun): Promise<void> {
    this.runs.set(run.runId, run);
  }

  async listMessages(conversationId: string): Promise<readonly StoredMessage[]> {
    return this.messages.filter((m) => m.conversationId === conversationId);
  }

  async getRun(runId: string): Promise<StoredRun | null> {
    return this.runs.get(runId) ?? null;
  }

  async listRuns(conversationId: string): Promise<readonly StoredRun[]> {
    return [...this.runs.values()].filter((r) => r.conversationId === conversationId);
  }
}
