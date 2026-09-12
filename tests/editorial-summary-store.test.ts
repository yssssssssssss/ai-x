import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import type { EditorialSummaryManifestV1 } from '../packages/api-contract/editorial-summary.ts';
import {
  canonicalJsonBytes,
  canonicalSha256,
  hashBytes,
} from '../apps/orchestrator-runtime/src/report/editorial-report-contract.ts';
import {
  EditorialSummaryStore,
  EditorialSummaryStoreError,
} from '../apps/orchestrator-runtime/src/report/editorial-summary-store.ts';
import { validateEditorialSummaryHtml } from '../apps/orchestrator-runtime/src/report/editorial-summary-generator.ts';
import { buildEditorialSummarySource } from '../apps/orchestrator-runtime/src/report/editorial-summary-source.ts';
import { showcaseFixture } from './editorial-showcase-fixture.ts';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'editorial-summary-store-'));
  roots.push(root);
  return root;
}

function bundle() {
  const { material } = showcaseFixture();
  const summarySource = buildEditorialSummarySource({ material, reportReview: { verdict: 'pass' } });
  const requestKey = `esrq_${'a'.repeat(64)}`;
  const planBytes = canonicalJsonBytes({ version: 'editorial-summary-plan-v1', title: '摘要' });
  const sourceIds = summarySource.source.atoms.map(({ id }) => id).join(' ');
  const detailIds = summarySource.source.groups.map(({ id }) => id).join(' ');
  const htmlBytes = Buffer.from(`<!doctype html><html lang="${summarySource.source.report.language}"><head><title>摘要</title><style>body{color:#111}</style></head><body><main><section data-summary-section-id="summary" data-source-ids="${sourceIds}" data-detail-section-ids="${detailIds}"><h1>摘要</h1></section></main></body></html>`);
  const validationBytes = canonicalJsonBytes(validateEditorialSummaryHtml({
    source: summarySource.source,
    html: htmlBytes.toString('utf8'),
  }));
  const fidelityBytes = canonicalJsonBytes({ version: 'editorial-summary-fidelity-v1', verdict: 'pass', issues: [] });
  const planHash = hashBytes(planBytes);
  const htmlHash = hashBytes(htmlBytes);
  const validationHash = hashBytes(validationBytes);
  const fidelityHash = hashBytes(fidelityBytes);
  const publicationId = `esrp_${canonicalSha256({
    requestKey, planHash, htmlHash, validationHash, fidelityHash,
  }).slice('sha256:'.length)}`;
  const manifest: EditorialSummaryManifestV1 = {
    version: 'editorial-summary-publication-v1',
    authority: 'derived',
    status: 'ready',
    generationMode: 'llm_html',
    taskId: material.taskId,
    planVersionId: material.planVersionId,
    attemptId: material.attemptId,
    requestKey,
    publicationId,
    sourceReportPackage: material.sourceReportPackage,
    sourceHash: summarySource.hash,
    planHash,
    htmlHash,
    validationHash,
    fidelityHash,
    modelCalls: [],
    generatedAt: '2026-09-01T00:00:00.000Z',
  };
  return {
    taskId: material.taskId,
    attemptId: material.attemptId,
    requestKey,
    sourceBytes: summarySource.bytes,
    planBytes,
    htmlBytes,
    validationBytes,
    fidelityBytes,
    manifestBytes: canonicalJsonBytes(manifest),
  };
}

test('reclaims an orphaned Summary request lock without weakening an active lock', async () => {
  const root = await temporaryRoot();
  const input = bundle();
  const lockPath = join(
    root,
    'tasks', input.taskId,
    'attempts', input.attemptId,
    'summary-requests', input.requestKey,
    '.summary-lock',
  );
  await mkdir(lockPath, { recursive: true, mode: 0o700 });
  await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: 99_999_999 }), { mode: 0o600 });

  const store = new EditorialSummaryStore(root);
  const lease = await store.acquire(input);
  await assert.rejects(
    () => store.acquire(input),
    (error: unknown) => error instanceof EditorialSummaryStoreError
      && error.code === 'SUMMARY_STORE_WRITE_FAILED',
  );
  assert.equal(await lease.release(), true);
});

test('atomically stores and verifies one immutable Editorial Summary publication', async () => {
  const store = new EditorialSummaryStore(await temporaryRoot());
  let fences = 0;
  const stored = await store.publish({
    ...bundle(),
    assertStillCurrent: async () => { fences += 1; },
  });

  assert.equal(fences, 1);
  assert.equal(stored.manifest.version, 'editorial-summary-publication-v1');
  assert.equal(stored.manifest.generationMode, 'llm_html');
  assert.equal((await stat(stored.slotPath)).mode & 0o777, 0o700);
  assert.equal((await stat(stored.reportPath)).mode & 0o777, 0o600);
  const reread = await store.read({
    taskId: stored.manifest.taskId,
    attemptId: stored.manifest.attemptId,
    requestKey: stored.manifest.requestKey,
    expected: {
      planVersionId: stored.manifest.planVersionId,
      sourceReportPackageId: stored.manifest.sourceReportPackage.artifactId,
      sourceReportPackageHash: stored.manifest.sourceReportPackage.contentSha256 as `sha256:${string}`,
      sourceHash: stored.manifest.sourceHash as `sha256:${string}`,
    },
  });
  assert.deepEqual(reread?.htmlBytes, stored.htmlBytes);

  await writeFile(stored.reportPath, '<!doctype html><html><body>tampered</body></html>', { mode: 0o600 });
  await assert.rejects(
    () => store.read({
      taskId: stored.manifest.taskId,
      attemptId: stored.manifest.attemptId,
      requestKey: stored.manifest.requestKey,
    }),
    (error: unknown) => error instanceof EditorialSummaryStoreError
      && error.code === 'SUMMARY_STORE_INVALID',
  );
});
