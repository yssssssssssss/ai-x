import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generateEditorialShowcase } from '../scripts/report-editorial-showcase.ts';
import {
  showcaseEvidenceManifestFixture,
  showcaseMaterialFixture,
} from './fixtures/report-editorial/showcase-fixtures.ts';

test('portable Showcase CLI generates from generic Material without a case workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'showcase-cli-'));
  try {
    const materialPath = join(root, 'material.json');
    const evidencePath = join(root, 'evidence.json');
    const outputPath = join(root, 'output', 'showcase.html');
    await writeFile(materialPath, JSON.stringify(showcaseMaterialFixture()), 'utf8');
    await writeFile(evidencePath, JSON.stringify(showcaseEvidenceManifestFixture()), 'utf8');

    const result = await generateEditorialShowcase({ materialPath, evidencePath, outputPath });

    assert.equal(result.generationMode, 'fallback');
    assert.match(result.outlineSignature, /^sha256:[a-f0-9]{64}$/u);
    assert.match(await readFile(outputPath, 'utf8'), /data-showcase-profile="editorial-showcase-v1"/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
