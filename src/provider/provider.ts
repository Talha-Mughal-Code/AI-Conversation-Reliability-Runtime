import type { ProviderEvent } from '../domain/types.js';

export interface ProviderRequest {
  readonly runId: string;
  readonly conversationId: string;
  readonly input: string;
}

/**
 * The model port.
 *
 * Note what the event type does NOT carry: there is no channel for hidden
 * reasoning, no raw provider payload and no credentials. Adapters translate
 * their vendor's wire format into `chunk` / `done` and drop everything else at
 * this boundary, so private model reasoning cannot reach the trace or the
 * store -- the type system prevents it rather than a redaction pass catching it
 * later.
 *
 * `signal` is the only cancellation mechanism. Implementations must stop
 * consuming upstream when it aborts; the orchestrator does not "ignore" late
 * chunks as a substitute for real cancellation.
 */
export interface ModelProvider {
  readonly name: string;
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

/** Errors a provider raises. `code` is safe to put in a trace; secrets never are. */
export class ProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderError';
    this.code = code;
  }
}

/** Raised by adapters when the caller's AbortSignal fires mid-stream. */
export class ProviderAbortedError extends ProviderError {
  constructor(message = 'Provider stream aborted by caller.') {
    super('provider.aborted', message);
    this.name = 'ProviderAbortedError';
  }
}
