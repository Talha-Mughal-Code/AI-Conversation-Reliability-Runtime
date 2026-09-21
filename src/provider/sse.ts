/**
 * Yields the payload of each `data:` line from an SSE response body.
 *
 * Shared by the Groq and Gemini adapters: both speak SSE, they differ only in
 * the JSON inside each frame.
 */
export async function* sseData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      if (signal.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
  } finally {
    // Releases the socket when the consumer stops early, e.g. on cancellation.
    await reader.cancel().catch(() => undefined);
  }
}
