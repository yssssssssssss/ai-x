import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EditorialSummaryManifestV1 } from '../packages/api-contract/editorial-summary.ts';
import {
  canonicalJsonBytes,
  canonicalSha256,
  hashBytes,
  type EditorialSourceVerifier,
  type FrozenEditorialSource,
} from '../apps/orchestrator-runtime/src/report/editorial-report-contract.ts';
import {
  EditorialSummaryPipeline,
  EditorialSummaryPipelineError,
} from '../apps/orchestrator-runtime/src/report/editorial-summary-pipeline.ts';
import { buildEditorialSummarySource } from '../apps/orchestrator-runtime/src/report/editorial-summary-source.ts';
import type { EditorialSummaryStoredPublication } from '../apps/orchestrator-runtime/src/report/editorial-summary-store.ts';
import { showcaseFixture } from './editorial-showcase-fixture.ts';

function sourceForFixture(): FrozenEditorialSource {
  const fixture = showcaseFixture();
  return {
    binding: {
      taskId: fixture.material.taskId,
      taskState: 'completed',
      taskStateVersion: 3,
      planVersionId: fixture.material.planVersionId,
      attemptId: fixture.material.attemptId,
      reportPackageArtifactId: fixture.material.sourceReportPackage.artifactId,
      reportPackageContentSha256: fixture.material.sourceReportPackage.contentSha256,
    },
    reportPackage: { artifact: {} as never, value: {} as never },
    current: { reportReview: { verdict: 'pass' } } as never,
    sourceArtifacts: fixture.material.sourceArtifacts,
    sourcePolicyMetadata: [{
      artifactId: fixture.material.sourceReportPackage.artifactId,
      contentSha256: fixture.material.sourceReportPackage.contentSha256,
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
    }],
    verifiedVisualAssets: [],
  };
}

function materialization() {
  const { material } = showcaseFixture();
  const materialBytes = canonicalJsonBytes(material);
  return {
    material,
    materialBytes,
    materialHash: hashBytes(materialBytes),
    modelContext: {} as never,
    modelContextBytes: Buffer.from('{}'),
    modelContextHash: canonicalSha256({}),
    modelContextByteSize: 2,
    sourcePolicyMetadata: sourceForFixture().sourcePolicyMetadata,
    warnings: [],
  };
}

class MemoryStore {
  value: EditorialSummaryStoredPublication | null = null;
  async read(): Promise<EditorialSummaryStoredPublication | null> { return this.value; }
  async publish(input: {
    sourceBytes: Uint8Array;
    planBytes: Uint8Array;
    htmlBytes: Uint8Array;
    validationBytes: Uint8Array;
    fidelityBytes: Uint8Array;
    manifestBytes: Uint8Array;
    assertStillCurrent(): Promise<void>;
  }): Promise<EditorialSummaryStoredPublication> {
    await input.assertStillCurrent();
    const manifest = JSON.parse(Buffer.from(input.manifestBytes).toString('utf8')) as EditorialSummaryManifestV1;
    this.value = {
      slotPath: '/tmp/summary-ready',
      reportPath: '/tmp/summary-ready/report.html',
      manifestPath: '/tmp/summary-ready/manifest.json',
      manifest,
      sourceBytes: Buffer.from(input.sourceBytes),
      planBytes: Buffer.from(input.planBytes),
      htmlBytes: Buffer.from(input.htmlBytes),
      validationBytes: Buffer.from(input.validationBytes),
      fidelityBytes: Buffer.from(input.fidelityBytes),
      manifestBytes: Buffer.from(input.manifestBytes),
    };
    return this.value;
  }
}

function generated() {
  const htmlBytes = Buffer.from('<!doctype html><html><body>summary</body></html>');
  const planBytes = canonicalJsonBytes({ version: 'editorial-summary-plan-v1' });
  const validationBytes = canonicalJsonBytes({ version: 'editorial-summary-validation-v1', verdict: 'pass' });
  const fidelityBytes = canonicalJsonBytes({ version: 'editorial-summary-fidelity-v1', verdict: 'pass', issues: [] });
  return {
    plan: {} as never,
    planBytes,
    planHash: hashBytes(planBytes),
    htmlBytes,
    htmlHash: hashBytes(htmlBytes),
    validation: { verdict: 'pass' } as never,
    validationBytes,
    fidelity: { verdict: 'pass', issues: [] } as never,
    fidelityBytes,
    modelCalls: [],
  };
}

function harness() {
  const source = sourceForFixture();
  const store = new MemoryStore();
  let fences = 0;
  let generations = 0;
  const pipeline = new EditorialSummaryPipeline({
    source: {
      readCurrent: async () => source,
      assertStillCurrent: async () => { fences += 1; },
    } as EditorialSourceVerifier,
    materialize: () => materialization(),
    generator: {
      generate: async ({ beforeModelCall }) => {
        generations += 1;
        await beforeModelCall?.();
        return generated();
      },
    },
    store,
    lockStore: { acquire: async () => ({ release: async () => true }) },
    generationIdentity: canonicalSha256({ model: 'summary-model-v1' }),
    modelAllowed: () => true,
    now: () => new Date('2026-09-01T00:00:00.000Z'),
  });
  return { pipeline, store, fences: () => fences, generations: () => generations };
}

test('publishes and reuses one LLM Editorial Summary without replacing the Detail Report', async () => {
  const current = harness();
  const first = await current.pipeline.generate({ taskId: showcaseFixture().material.taskId });
  const second = await current.pipeline.generate({ taskId: showcaseFixture().material.taskId });

  assert.equal(first.status, 'ready');
  assert.equal(first.generationMode, 'llm_html');
  assert.equal(second.publicationId, first.publicationId);
  assert.equal(current.generations(), 1);
  assert.ok(current.fences() >= 3);
  assert.equal(current.store.value?.manifest.version, 'editorial-summary-publication-v1');
  assert.equal(current.store.value?.manifest.sourceReportPackage.artifactId, materialization().material.sourceReportPackage.artifactId);
});

test('allows Summary model generation for confidential or PII-marked task context', async () => {
  for (const taskContext of [
    { sensitivity: 'confidential' as const, piiDetected: false },
    { sensitivity: 'internal' as const, piiDetected: true },
  ]) {
    const base = sourceForFixture();
    const source = {
      ...base,
      taskContext: {
        originalRequest: 'sensitive request', researchGoal: 'sensitive goal', targetAudience: [], scope: [],
        constraints: [], successCriteria: [], expectedDeliverables: [], requestedArtifacts: [],
        ...taskContext,
      },
    };
    let generatorCalled = false;
    const pipeline = new EditorialSummaryPipeline({
      source: { readCurrent: async () => source, assertStillCurrent: async () => undefined } as EditorialSourceVerifier,
      materialize: () => materialization(),
      generator: { generate: async () => { generatorCalled = true; return generated(); } },
      store: new MemoryStore(),
      lockStore: { acquire: async () => ({ release: async () => true }) },
      generationIdentity: canonicalSha256(taskContext),
      modelAllowed: () => true,
    });
    const result = await pipeline.generate({ taskId: showcaseFixture().material.taskId });
    assert.equal(result.status, 'ready');
    assert.equal(generatorCalled, true);
  }
});

test('fails the Summary independently when a real model is unavailable and has no deterministic template fallback', async () => {
  const source = sourceForFixture();
  let generatorCalled = false;
  const pipeline = new EditorialSummaryPipeline({
    source: { readCurrent: async () => source, assertStillCurrent: async () => undefined } as EditorialSourceVerifier,
    materialize: () => materialization(),
    generator: { generate: async () => { generatorCalled = true; return generated(); } },
    store: new MemoryStore(),
    lockStore: { acquire: async () => ({ release: async () => true }) },
    generationIdentity: canonicalSha256({ model: 'unavailable' }),
    modelAllowed: () => false,
  });

  await assert.rejects(
    () => pipeline.generate({ taskId: showcaseFixture().material.taskId }),
    (error: unknown) => error instanceof EditorialSummaryPipelineError
      && error.code === 'SUMMARY_MODEL_UNAVAILABLE',
  );
  assert.equal(generatorCalled, false);
});
