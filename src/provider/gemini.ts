import type { ProviderEvent } from '../domain/types.js';
import {
  ProviderAbortedError,
  ProviderError,
  type ModelProvider,
  type ProviderRequest,
} from './provider.js';
import { sseData } from './sse.js';

export interface GeminiProviderOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
}

/**
 * Gemini adapter (`streamGenerateContent` with `alt=sse`).
 *
 * The translation boundary: Gemini marks reasoning parts with `thought: true`.
 * Those parts are skipped here and have no route outward, which is the same
 * guarantee the Groq adapter makes about `delta.reasoning`.
 *
 * The API key travels in the `x-goog-api-key` header rather than the documented
 * `?key=` query parameter, so it cannot end up in a proxy or access log.
 */
export class GeminiProvider implements ModelProvider {
  readonly name = 'gemini';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: GeminiProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'gemini-2.0-flash';
    this.baseUrl = options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const url = `${this.baseUrl}/models/${this.model}:streamGenerateContent?alt=sse`;
    const response = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'x-goog-api-key': this.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: request.input }] }],
      }),
    }).catch((error: unknown) => {
      if (signal.aborted) throw new ProviderAbortedError();
      throw new ProviderError('provider.transport_error', describe(error));
    });

    if (!response.ok || !response.body) {
      const hint =
        response.status === 404
          ? ` Model "${this.model}" was not found -- it may have been retired. Set MODEL to a current id.`
          : '';
      throw new ProviderError('provider.http_error', `Gemini returned HTTP ${response.status}.${hint}`);
    }

    let sawContent = false;

    for await (const payload of sseData(response.body, signal)) {
      let frame: GeminiFrame;
      try {
        frame = JSON.parse(payload) as GeminiFrame;
      } catch {
        throw new ProviderError('provider.malformed_frame', 'Gemini sent an unparseable SSE frame.');
      }

      const candidate = frame.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.thought === true) continue; // hidden reasoning stops here
        if (typeof part.text === 'string' && part.text.length > 0) {
          sawContent = true;
          yield { type: 'chunk', text: part.text };
        }
      }

      if (candidate?.finishReason) {
        if (candidate.finishReason !== 'STOP') {
          throw new ProviderError(
            'provider.stopped_early',
            `Gemini stopped with reason ${candidate.finishReason}.`,
          );
        }
        yield { type: 'done' };
        return;
      }
    }

    if (signal.aborted) throw new ProviderAbortedError();
    if (!sawContent) {
      throw new ProviderError('provider.empty_stream', 'Gemini produced no content.');
    }
    // Reaching here means the body closed without a finishReason. The runtime
    // treats a missing completion event as failure rather than success.
  }
}

interface GeminiFrame {
  readonly candidates?: readonly {
    readonly finishReason?: string;
    readonly content?: { readonly parts?: readonly { readonly text?: string; readonly thought?: boolean }[] };
  }[];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
