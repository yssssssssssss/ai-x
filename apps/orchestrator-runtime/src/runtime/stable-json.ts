import { createHash } from 'node:crypto';

function canonicalize(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new Error('stable JSON value contains a cycle');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item, seen)]),
    );
  } finally {
    seen.delete(value);
  }
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set<object>()));
}

export function stableJsonHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJsonStringify(value)).digest('hex')}`;
}
