import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

const modulePath = '../apps/orchestrator-runtime/src/runtime/llm-input-compactor.ts';
const moduleFile = new URL(modulePath, import.meta.url);

test('compacts image data URLs into deterministic metadata before LLM context serialization', async () => {
  assert.equal(existsSync(moduleFile), true, 'LLM input compactor module must exist');
  const { compactLlmInput } = await import(modulePath);
  const bytes = Buffer.from('real-image-bytes');
  const dataUrl = `data:image/jpeg;base64,${bytes.toString('base64')}`;

  const compacted = compactLlmInput({
    competitor_screenshots: [{ dataUrl }],
    research_goal: 'compare interfaces',
  });

  assert.deepEqual(compacted, {
    competitor_screenshots: [{
      dataUrl: {
        kind: 'uploaded_image',
        mediaType: 'image/jpeg',
        byteSize: bytes.byteLength,
        contentSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      },
    }],
    research_goal: 'compare interfaces',
  });
  assert.doesNotMatch(JSON.stringify(compacted), /cmVhbC1pbWFnZS1ieXRlcw/);
});
