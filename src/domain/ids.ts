import { randomUUID } from 'node:crypto';

export type IdFactory = (prefix: string) => string;

export const randomIds: IdFactory = (prefix) => `${prefix}_${randomUUID()}`;

/** Deterministic ids so benchmark output and test assertions stay stable. */
export function sequentialIds(): IdFactory {
  const counters = new Map<string, number>();
  return (prefix) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${String(next).padStart(4, '0')}`;
  };
}
