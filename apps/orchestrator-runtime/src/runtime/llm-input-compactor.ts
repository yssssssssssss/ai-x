import { createHash } from 'node:crypto';
import type { LLMImageInput } from './llm-client.ts';

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

export function collectLlmImageInputs(value: unknown): LLMImageInput[] {
  const images: LLMImageInput[] = [];
  const seen = new Set<string>();
  const visit = (candidate: unknown, path: string): void => {
    if (typeof candidate === 'string') {
      if (!IMAGE_DATA_URL.test(candidate)) return;
      const hash = createHash('sha256').update(candidate).digest('hex');
      if (seen.has(hash)) return;
      if (images.length >= 12) throw new Error('LLM image input exceeds the 12-image limit');
      seen.add(hash);
      images.push({ dataUrl: candidate, label: path });
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${path}[${index + 1}]`));
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      visit(child, path ? `${path}.${key}` : key);
    }
  };
  visit(value, 'input');
  return images;
}

export function compactLlmInput(value: unknown): unknown {
  return compact(value);
}
