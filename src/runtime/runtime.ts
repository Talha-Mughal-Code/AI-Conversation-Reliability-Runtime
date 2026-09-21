import type { IdFactory } from '../domain/ids.js';
import { Run } from '../domain/run.js';
import type { TerminalState } from '../domain/states.js';
import type {
  PolicyDecision,
  TerminationDetail,
  TransitionRecord,
  TurnRequest,
} from '../domain/types.js';
import type { PolicyEngine } from '../policy/policy.js';
import { ProviderError, type ModelProvider } from '../provider/provider.js';
import type { ConversationStore, StoredRun } from '../store/store.js';
import { TraceRecorder, type TraceEvent } from '../trace/trace.js';
import { redactString } from '../trace/redact.js';
import type { Clock } from './clock.js';

export interface TurnRuntimeOptions {
  readonly policy: PolicyEngine;
  readonly provider: ModelProvider;
  readonly store: ConversationStore;
  readonly clock: Clock;
  readonly ids: IdFactory;
  /** Whole-turn deadline, measured from acceptance and covering the policy gate. */
  readonly timeoutMs: number;
}

export interface ExecuteOptions {
  /** External cancellation, e.g. an HTTP client disconnecting or Ctrl-C. */
  readonly signal?: AbortSignal;
  /** Presentation hook. Called once per accepted chunk, in order. */
  readonly onChunk?: (text: string) => void;
}

export interface TurnResult {
  readonly runId: string;
  readonly conversationId: string;
  readonly terminalState: TerminalState;
  readonly decision: PolicyDecision;
  readonly outputText: string;
  readonly outputIsPartial: boolean;
  readonly chunkCount: number;
  readonly providerInvoked: boolean;
  readonly termination: TerminationDetail | null;
  /**
   * The domain's own transition log. Exposed because the trace seals itself at
   * the terminal event, so asserting on the trace alone cannot tell a working
   * latch from a broken one.
   */
  readonly transitions: readonly TransitionRecord[];
  readonly trace: readonly TraceEvent[];
}

/**
 * Executes exactly one conversational turn.
 *
 * Sequence: gate -> commit user message -> stream -> settle -> commit outcome.
 *
 * Three racers can end a turn -- the provider finishing, the deadline firing,
 * and the caller cancelling. Each of them goes through `settle()`, which claims
 * the terminal state synchronously before doing any I/O. That ordering is the
 * whole safety argument: by the time a racer awaits anything, it already knows
 * whether it won.
 */
export class TurnRuntime {
  constructor(private readonly options: TurnRuntimeOptions) {}

  async execute(request: TurnRequest, execOptions: ExecuteOptions = {}): Promise<TurnResult> {
    const { policy, provider, store, clock, ids, timeoutMs } = this.options;

    const runId = ids('run');
    const run = new Run({
      runId,
      conversationId: request.conversationId,
      input: request.input,
      now: () => clock.now(),
    });
    const trace = new TraceRecorder(runId, clock);
    const controller = new AbortController();

    let providerInvoked = false;
    let decision: PolicyDecision = { allowed: false, ruleId: 'allow.pending', message: '' };

    /**
     * The single terminal path. Claims the state synchronously; every caller
     * learns immediately whether it won, and the loser records why it lost.
     */
    const settle = (state: TerminalState, detail: TerminationDetail): boolean => {
      const claim = run.transition(state, detail);
      if (!claim.accepted) {
        trace.diagnostic('terminal.refused', {
          attempted: state,
          held: claim.state,
          reason: claim.refusal,
          detail: detail.code,
        });
        return false;
      }
      trace.lifecycle(`run.${state}`, { code: detail.code, message: detail.message });
      return true;
    };

    trace.lifecycle('run.started', {
      runId,
      conversationId: request.conversationId,
      inputChars: request.input.length,
      timeoutMs,
      provider: provider.name,
      policy: policy.name,
    });

    // The deadline covers the entire turn, including the policy gate, so a slow
    // gate cannot extend the turn past its configured bound.
    const cancelDeadline = clock.setTimer(timeoutMs, () => {
      const won = settle('timed_out', {
        code: 'deadline.exceeded',
        message: `Turn exceeded ${timeoutMs}ms.`,
      });
      if (won) controller.abort();
    });

    const onExternalAbort = () => {
      const won = settle('cancelled', {
        code: 'client.cancelled',
        message: 'Cancellation requested by caller.',
      });
      if (won) controller.abort();
    };
    execOptions.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      if (execOptions.signal?.aborted) onExternalAbort();

      if (!run.settled) {
        run.transition('screening');
        decision = policy.evaluate(request);
        trace.lifecycle('policy.evaluated', {
          allowed: decision.allowed,
          ruleId: decision.ruleId,
        });

        if (!decision.allowed) {
          settle('rejected', { code: decision.ruleId, message: decision.message });
        }
      }

      if (!run.settled) {
        // Commit rule 1: the user message is durable before the provider is
        // invoked, and only for input the gate allowed.
        await store.appendMessage({
          id: ids('msg'),
          conversationId: request.conversationId,
          runId,
          role: 'user',
          text: request.input,
          createdAt: clock.now(),
        });
        trace.lifecycle('message.persisted', { role: 'user' });

        run.transition('streaming');
        await this.consumeProvider(run, trace, controller, execOptions, settle, () => {
          providerInvoked = true;
        });
      }
    } catch (error) {
      // Anything unexpected outside the stream loop still has to land on a
      // terminal state rather than escaping as a rejected promise.
      settle('failed', {
        code: 'runtime.unexpected_error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      cancelDeadline();
      execOptions.signal?.removeEventListener('abort', onExternalAbort);
      // Ensure a stalled provider is released even on an unexpected exit path.
      if (!controller.signal.aborted) controller.abort();
    }

    if (!run.settled) {
      settle('failed', {
        code: 'runtime.unsettled',
        message: 'Run finished execution without reaching a terminal state.',
      });
    }

    return this.commit(run, trace, decision, providerInvoked);
  }

  /**
   * Drains the provider stream into the run.
   *
   * The loop re-checks `run.settled` on every iteration so a deadline or
   * cancellation that fired between chunks stops consumption immediately,
   * rather than merely suppressing output.
   */
  private async consumeProvider(
    run: Run,
    trace: TraceRecorder,
    controller: AbortController,
    execOptions: ExecuteOptions,
    settle: (state: TerminalState, detail: TerminationDetail) => boolean,
    markInvoked: () => void,
  ): Promise<void> {
    const { provider } = this.options;
    trace.lifecycle('provider.invoked', { provider: provider.name });
    markInvoked();

    try {
      const stream = provider.stream(
        { runId: run.id, conversationId: run.conversationId, input: run.input },
        controller.signal,
      );

      for await (const event of stream) {
        if (run.settled) {
          trace.diagnostic('provider.event_after_terminal', { type: event.type });
          break;
        }

        if (event.type === 'chunk') {
          if (!run.appendChunk(event.text)) {
            trace.diagnostic('provider.chunk_dropped', { chars: event.text.length });
            break;
          }
          trace.lifecycle('provider.chunk', { index: run.chunkCount - 1, chars: event.text.length });
          execOptions.onChunk?.(event.text);
          continue;
        }

        trace.lifecycle('provider.stream_end', { chunks: run.chunkCount });
        settle('completed', {
          code: 'provider.done',
          message: 'Provider stream completed.',
        });
        break;
      }

      // A provider that ends without a `done` event is a protocol violation, not
      // a success: the run must not complete on an assumption.
      if (!run.settled) {
        settle('failed', {
          code: 'provider.truncated_stream',
          message: 'Provider stream ended without a completion event.',
        });
      }
    } catch (error) {
      // If a racer already settled the run, this error is the provider
      // unwinding in response to our own abort -- expected, not a new outcome.
      if (run.settled) {
        trace.diagnostic('provider.unwound', {
          heldState: run.terminalState,
          code: error instanceof ProviderError ? error.code : 'unknown',
        });
        return;
      }

      const code = error instanceof ProviderError ? error.code : 'provider.unknown_error';
      const message = error instanceof Error ? error.message : String(error);
      trace.lifecycle('provider.error', { code, chunksBefore: run.chunkCount });
      settle('failed', { code, message });
    }
  }

  /** Writes the outcome according to the commit rules documented on ConversationStore. */
  private async commit(
    run: Run,
    trace: TraceRecorder,
    decision: PolicyDecision,
    providerInvoked: boolean,
  ): Promise<TurnResult> {
    const { store, ids, clock } = this.options;
    const snapshot = run.snapshot();
    const terminalState = snapshot.terminalState as TerminalState;

    // Commit rule 2: an assistant message exists only for a completed run.
    if (terminalState === 'completed') {
      await store.appendMessage({
        id: ids('msg'),
        conversationId: snapshot.conversationId,
        runId: snapshot.runId,
        role: 'assistant',
        text: snapshot.outputText,
        createdAt: clock.now(),
      });
      trace.diagnostic('commit.assistant_message', { chars: snapshot.outputText.length });
    } else if (snapshot.outputText.length > 0) {
      // Commit rule 3: partial output is retained on the run record only.
      trace.diagnostic('commit.partial_retained', {
        chars: snapshot.outputText.length,
        terminalState,
      });
    }

    const storedRun: StoredRun = {
      runId: snapshot.runId,
      conversationId: snapshot.conversationId,
      terminalState,
      input: redactString(snapshot.input),
      outputText: snapshot.outputText,
      outputIsPartial: snapshot.outputIsPartial,
      chunkCount: snapshot.chunkCount,
      policyRuleId: decision.ruleId,
      providerInvoked,
      startedAt: snapshot.startedAt,
      endedAt: snapshot.endedAt,
      termination: snapshot.termination,
      trace: trace.snapshot(),
    };
    await store.saveRun(storedRun);

    return {
      runId: snapshot.runId,
      conversationId: snapshot.conversationId,
      terminalState,
      decision,
      outputText: snapshot.outputText,
      outputIsPartial: snapshot.outputIsPartial,
      chunkCount: snapshot.chunkCount,
      providerInvoked,
      termination: snapshot.termination,
      transitions: snapshot.transitions,
      trace: trace.snapshot(),
    };
  }
}
