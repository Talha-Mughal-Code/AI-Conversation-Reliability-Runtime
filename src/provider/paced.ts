import type { ProviderEvent } from '../domain/types.js';
import { ProviderAbortedError, type ModelProvider, type ProviderRequest } from './provider.js';

/**
 * Wraps a provider and spaces its chunks out in real time.
 *
 * Presentation only. A scripted stream finishes in about five milliseconds,
 * which is correct but shows a viewer nothing: text appears all at once and a
 * human cannot cancel part-way through. This decorator makes streaming visible
 * in the browser demo.
 *
 * It is deliberately NOT used by the tests or the benchmark -- both must stay
 * deterministic and free of real waiting -- and it adds no behaviour beyond the
 * delay. The abort signal is honoured during the delay, so pacing can never
 * postpone a cancellation.
 */
export class PacedProvider implements ModelProvider {
  readonly name: string;

  constructor(
    private readonly inner: ModelProvider,
    private readonly delayMs: number,
  ) {
    this.name = inner.name;
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    for await (const event of this.inner.stream(request, signal)) {
      if (event.type === 'chunk' && this.delayMs > 0) await this.pause(signal);
      yield event;
    }
  }

  /** Resolves after the delay, or immediately when the caller aborts. */
  private pause(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new ProviderAbortedError();
    return new Promise((resolve) => {
      const timer = setTimeout(done, this.delayMs);
      signal.addEventListener('abort', done, { once: true });
      function done() {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
    });
  }
}
