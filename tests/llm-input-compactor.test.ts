import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

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

test('compacted Design Review image metadata remains valid Skill input', async () => {
  const { compactLlmInput } = await import(modulePath);
  const bytes = Buffer.from('real-image-bytes');
  const compacted = compactLlmInput({
    designImage: { dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` },
    instruction: 'Review the supplied design image.',
    visual_analysis: {
      status: 'available', samples: [], visualReviewBatches: [], comparisonFindings: [], warnings: [], boundaryNotes: [],
    },
  });

  assert.doesNotThrow(() => new SchemaValidator().validateFileOrThrow(
    join(process.cwd(), 'skills/design-review/input.schema.json'),
    compacted,
  ));
});
