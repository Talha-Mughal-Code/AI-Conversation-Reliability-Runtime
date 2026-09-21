import type { ProviderEvent } from '../domain/types.js';
import {
  ProviderAbortedError,
  ProviderError,
  type ModelProvider,
  type ProviderRequest,
} from './provider.js';

/**
 * One instruction in a fake provider's script.
 *
 *  - `emit`  yield a text chunk
 *  - `fail`  throw a ProviderError at this point in the stream
 *  - `stall` stop producing and wait forever, until the caller aborts
 *  - `think` produce hidden reasoning that must never leave the adapter
 */
export type ScriptStep =
  | { readonly emit: string }
  | { readonly fail: string }
  | { readonly stall: true }
  | { readonly think: string };

export const emit = (text: string): ScriptStep => ({ emit: text });
export const fail = (message: string): ScriptStep => ({ fail: message });
export const stall = (): ScriptStep => ({ stall: true });
export const think = (text: string): ScriptStep => ({ think: text });

/**
 * Splits `text` into exactly `count` non-empty chunks.
 *
 * Exactness is the point: the benchmark asserts chunk counts, so a sizing rule
 * that overshoots (ceil) and silently yields `count - 1` chunks would make the
 * benchmark's expectations wrong rather than the runtime's behaviour.
 */
export function chunked(text: string, count: number): ScriptStep[] {
  const parts = Math.max(1, Math.min(count, text.length));
  const base = Math.floor(text.length / parts);
  let remainder = text.length % parts;
  const steps: ScriptStep[] = [];
  let at = 0;

  for (let i = 0; i < parts; i++) {
    const size = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    steps.push(emit(text.slice(at, at + size)));
    at += size;
  }
  return steps;
}

/**
 * Deterministic fake provider.
 *
 * Records enough to prove behaviour rather than infer it:
 *  - `callCount`    proves a rejected turn never reached the provider
 *  - `chunksEmitted` proves cancellation stopped *production*, not just display
 *  - `abortObserved` proves the signal actually reached the adapter
 *  - `hiddenReasoning` is what the adapter saw and deliberately did not yield
 */
export class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted';

  callCount = 0;
  chunksEmitted = 0;
  abortObserved = false;
  readonly hiddenReasoning: string[] = [];

  constructor(private readonly script: readonly ScriptStep[]) {}

  async *stream(_request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    this.callCount += 1;

    if (signal.aborted) {
      this.abortObserved = true;
      throw new ProviderAbortedError();
    }

    for (const step of this.script) {
      // Checked between every step: a real adapter gets the same opportunity
      // each time it reads from the socket.
      if (signal.aborted) {
        this.abortObserved = true;
        throw new ProviderAbortedError();
      }

      if ('emit' in step) {
        this.chunksEmitted += 1;
        yield { type: 'chunk', text: step.emit };
        // Yielding suspends here until the consumer asks for the next value,
        // which is where a cancellation between chunks lands.
        continue;
      }

      if ('think' in step) {
        // Hidden reasoning stays inside the adapter. There is no ProviderEvent
        // variant that could carry it outward.
        this.hiddenReasoning.push(step.think);
        continue;
      }

      if ('fail' in step) {
        throw new ProviderError('provider.stream_error', step.fail);
      }

      await this.waitForAbort(signal);
      this.abortObserved = true;
      throw new ProviderAbortedError('Provider stalled and was aborted.');
    }

    yield { type: 'done' };
  }

  /** Resolves only when the signal aborts. Models a provider that stops responding. */
  private waitForAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }
}
