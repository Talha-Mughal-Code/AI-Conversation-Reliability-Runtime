/**
 * Keys whose values are never safe to record, regardless of where they came from.
 */
const SECRET_KEY_PATTERN =
  /(api[_-]?key|secret|password|passwd|token|authorization|auth|credential|bearer|cookie|session[_-]?id)/i;

/**
 * Value shapes that are secrets even when the key looks innocent -- for example
 * a provider key pasted into a message body.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style
  /\bgsk_[A-Za-z0-9]{20,}\b/g, // Groq
  /\bAIza[A-Za-z0-9_-]{30,}\b/g, // Google / Gemini
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi,
];

export const REDACTED = '[redacted]';

export function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/**
 * Recursively scrubs a value destined for the trace.
 *
 * Two layers, because either alone is insufficient: key-based redaction catches
 * a well-named field holding a secret, and value-based redaction catches a
 * secret that arrived inside ordinary prose.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(inner, depth + 1);
  }
  return out;
}
