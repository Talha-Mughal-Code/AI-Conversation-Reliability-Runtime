import type { ProviderEvent } from '../domain/types.js';
import {
  ProviderAbortedError,
  ProviderError,
  type ModelProvider,
  type ProviderRequest,
} from './provider.js';
import { sseData } from './sse.js';

export interface GroqProviderOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
}

/**
 * Groq adapter (OpenAI-compatible streaming API).
 *
 * The translation boundary: Groq's delta may carry `reasoning` alongside
 * `content`. Only `content` becomes a ProviderEvent. The reasoning field is
 * read and discarded here, and there is no ProviderEvent variant that could
 * carry it onward, so it cannot reach the trace or the store.
 */
export class GroqProvider implements ModelProvider {
  readonly name = 'groq';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: GroqProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'openai/gpt-oss-20b';
    this.baseUrl = options.baseUrl ?? 'https://api.groq.com/openai/v1';
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        messages: [{ role: 'user', content: request.input }],
      }),
    }).catch((error: unknown) => {
      if (signal.aborted) throw new ProviderAbortedError();
      throw new ProviderError('provider.transport_error', describe(error));
    });

    if (!response.ok || !response.body) {
      // The status is safe to record; the body may echo the request, so it is not.
      // Model ids get retired regularly, and a bare 404 sends the operator digging,
      // so this one names the likely cause and the fix.
      const hint =
        response.status === 404
          ? ` Model "${this.model}" was not found -- it may have been retired. Set MODEL to a current id from https://api.groq.com/openai/v1/models.`
          : '';
      throw new ProviderError('provider.http_error', `Groq returned HTTP ${response.status}.${hint}`);
    }

    for await (const payload of sseData(response.body, signal)) {
      if (payload === '[DONE]') {
        yield { type: 'done' };
        return;
      }

      let frame: GroqFrame;
      try {
        frame = JSON.parse(payload) as GroqFrame;
      } catch {
        throw new ProviderError('provider.malformed_frame', 'Groq sent an unparseable SSE frame.');
      }

      const delta = frame.choices?.[0]?.delta;
      // `delta.reasoning` is deliberately not read into any outgoing value.
      const text = delta?.content;
      if (typeof text === 'string' && text.length > 0) yield { type: 'chunk', text };
    }

    if (signal.aborted) throw new ProviderAbortedError();
  }
}

interface GroqFrame {
  readonly choices?: readonly { readonly delta?: { readonly content?: string } }[];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
