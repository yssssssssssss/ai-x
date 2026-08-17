import { createHash } from 'node:crypto';

const IMAGE_DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/u;

function compact(value: unknown): unknown {
  if (typeof value === 'string') {
    const match = IMAGE_DATA_URL.exec(value);
    if (!match) return value;
    const bytes = Buffer.from(match[2], 'base64');
    return {
      kind: 'uploaded_image',
      mediaType: match[1],
      byteSize: bytes.byteLength,
      contentSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    };
  }
  if (Array.isArray(value)) return value.map(compact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, compact(child)]),
  );
}

export function compactLlmInput(value: unknown): unknown {
  return compact(value);
}
