import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import type { EditorialShowcaseManifestV1 } from '../packages/api-contract/editorial-showcase.ts';
import { canonicalJsonBytes, hashBytes } from '../apps/orchestrator-runtime/src/report/editorial-report-contract.ts';
import { compileEditorialShowcase } from '../apps/orchestrator-runtime/src/report/editorial-showcase-compiler.ts';
import { loadEditorialShowcaseProfile } from '../apps/orchestrator-runtime/src/report/editorial-showcase-profile.ts';
import { renderEditorialShowcase } from '../apps/orchestrator-runtime/src/report/editorial-showcase-renderer.ts';
import {
  EditorialShowcaseStore,
  EditorialShowcaseStoreError,
} from '../apps/orchestrator-runtime/src/report/editorial-showcase-store.ts';
import { validateEditorialShowcase } from '../apps/orchestrator-runtime/src/report/editorial-showcase-validator.ts';
import { showcaseFixture } from './editorial-showcase-fixture.ts';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'editorial-showcase-store-'));
  roots.push(root);
  return root;
}

function bundle() {
  const fixture = showcaseFixture();
  const materialBytes = canonicalJsonBytes(fixture.material);
  const sourcePacketBytes = canonicalJsonBytes(fixture.sourcePacket);
  const intentBytes = canonicalJsonBytes(null);
  const compiled = compileEditorialShowcase({ material: fixture.material, sourcePacket: fixture.sourcePacket, intent: null });
  const rendered = renderEditorialShowcase({ spec: compiled.spec });
  const validation = validateEditorialShowcase({
    material: fixture.material, sourcePacket: fixture.sourcePacket, spec: compiled.spec, renderResult: rendered,
  });
  const validationBytes = canonicalJsonBytes(validation);
  const requestKey = `esq_${'a'.repeat(64)}`;
  const publicationId = `esh_${'b'.repeat(64)}`;
  const manifest: EditorialShowcaseManifestV1 = {
    version: 'universal-editorial-showcase-publication-v1', authority: 'derived', status: 'ready',
    generationMode: 'deterministic_showcase',
    taskId: fixture.material.taskId, planVersionId: fixture.material.planVersionId, attemptId: fixture.material.attemptId,
    requestKey, publicationId, profileId: 'universal-editorial-showcase-v1',
    sourceReportPackage: fixture.material.sourceReportPackage,
    materialHash: hashBytes(materialBytes), sourcePacketHash: hashBytes(sourcePacketBytes), intentHash: hashBytes(intentBytes),
    specHash: compiled.hash, profileHash: loadEditorialShowcaseProfile().hash, htmlHash: rendered.htmlHash,
    renderManifestHash: rendered.renderManifestHash, validationHash: hashBytes(validationBytes),
    generatedAt: '2026-08-30T00:00:00.000Z',
  };
  return {
    taskId: fixture.material.taskId,
    attemptId: fixture.material.attemptId,
    requestKey,
    htmlBytes: rendered.htmlBytes,
    materialBytes,
    sourcePacketBytes,
    intentBytes,
    specBytes: compiled.bytes,
    renderManifestBytes: rendered.renderManifestBytes,
    validationBytes,
    manifestBytes: canonicalJsonBytes(manifest),
  };
}

test('atomically stores and rebuilds an immutable Showcase publication', async () => {
  const root = await temporaryRoot();
  const store = new EditorialShowcaseStore(root);
  let fences = 0;
  const stored = await store.publish({
    ...bundle(), assertStillCurrent: async () => { fences += 1; },
  });

  assert.equal(fences, 1);
  assert.equal(stored.manifest.version, 'universal-editorial-showcase-publication-v1');
  assert.equal(stored.manifest.generationMode, 'deterministic_showcase');
  assert.equal((await stat(stored.slotPath)).mode & 0o777, 0o700);
  assert.equal((await stat(stored.reportPath)).mode & 0o777, 0o600);
  const reread = await store.read({
    taskId: stored.manifest.taskId,
    attemptId: stored.manifest.attemptId,
    requestKey: stored.manifest.requestKey,
  });
  assert.deepEqual(reread?.htmlBytes, stored.htmlBytes);
  assert.deepEqual(reread?.specBytes, stored.specBytes);

  await writeFile(stored.reportPath, Buffer.from(stored.htmlBytes.toString('utf8').replace('宠物食品心智设计表达研究', '协同篡改')), { mode: 0o600 });
  await assert.rejects(
    () => store.read({ taskId: stored.manifest.taskId, attemptId: stored.manifest.attemptId, requestKey: stored.manifest.requestKey }),
    (error: unknown) => error instanceof EditorialShowcaseStoreError && error.code === 'SHOWCASE_STORE_INVALID',
  );
});
