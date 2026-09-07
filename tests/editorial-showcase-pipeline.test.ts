import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EditorialShowcaseIntentV1, EditorialShowcaseManifestV1 } from '../packages/api-contract/editorial-showcase.ts';
import {
  canonicalJsonBytes,
  canonicalSha256,
  type EditorialSourceVerifier,
  type FrozenEditorialSource,
} from '../apps/orchestrator-runtime/src/report/editorial-report-contract.ts';
import {
  EditorialShowcasePipeline,
  EditorialShowcasePipelineError,
} from '../apps/orchestrator-runtime/src/report/editorial-showcase-pipeline.ts';
import type { EditorialShowcaseStoredPublication } from '../apps/orchestrator-runtime/src/report/editorial-showcase-store.ts';
import { showcaseFixture } from './editorial-showcase-fixture.ts';

function sourceForFixture(): FrozenEditorialSource {
  const fixture = showcaseFixture();
  return {
    binding: {
      taskId: fixture.material.taskId, taskState: 'completed', taskStateVersion: 3,
      planVersionId: fixture.material.planVersionId, attemptId: fixture.material.attemptId,
      reportPackageArtifactId: fixture.material.sourceReportPackage.artifactId,
      reportPackageContentSha256: fixture.material.sourceReportPackage.contentSha256,
    },
    reportPackage: { artifact: {} as never, value: {} as never },
    current: {} as never,
    sourceArtifacts: fixture.material.sourceArtifacts,
    sourcePolicyMetadata: [{
      artifactId: fixture.material.sourceReportPackage.artifactId,
      contentSha256: fixture.material.sourceReportPackage.contentSha256,
      sensitivity: 'internal', redactionPolicyVersion: 'v1',
    }],
    verifiedVisualAssets: [],
  };
}

function materialization(
  deliverableType: ReturnType<typeof showcaseFixture>['material']['deliverableType'] = 'research_plan',
) {
  const fixture = showcaseFixture();
  const material = { ...fixture.material, deliverableType };
  const materialBytes = canonicalJsonBytes(material);
  return {
    material,
    materialBytes,
    materialHash: canonicalSha256(material),
    modelContext: {} as never,
    modelContextBytes: Buffer.from('{}'),
    modelContextHash: canonicalSha256({}),
    modelContextByteSize: 2,
    sourcePolicyMetadata: sourceForFixture().sourcePolicyMetadata,
    warnings: [],
  };
}

class MemoryStore {
  value: EditorialShowcaseStoredPublication | null = null;
  async read(): Promise<EditorialShowcaseStoredPublication | null> { return this.value; }
  async publish(input: {
    htmlBytes: Uint8Array; materialBytes: Uint8Array; sourcePacketBytes: Uint8Array; intentBytes: Uint8Array;
    specBytes: Uint8Array; renderManifestBytes: Uint8Array; validationBytes: Uint8Array; manifestBytes: Uint8Array;
    assertStillCurrent(): Promise<void>;
  }): Promise<EditorialShowcaseStoredPublication> {
    await input.assertStillCurrent();
    const manifest = JSON.parse(Buffer.from(input.manifestBytes).toString('utf8')) as EditorialShowcaseManifestV1;
    this.value = {
      slotPath: '/tmp/showcase-ready', reportPath: '/tmp/showcase-ready/editorial-showcase.html',
      manifestPath: '/tmp/showcase-ready/manifest.json', manifest,
      htmlBytes: Buffer.from(input.htmlBytes), materialBytes: Buffer.from(input.materialBytes),
      sourcePacketBytes: Buffer.from(input.sourcePacketBytes), intentBytes: Buffer.from(input.intentBytes),
      specBytes: Buffer.from(input.specBytes), renderManifestBytes: Buffer.from(input.renderManifestBytes),
      validationBytes: Buffer.from(input.validationBytes), manifestBytes: Buffer.from(input.manifestBytes),
    };
    return this.value;
  }
}

function modelIntent(): EditorialShowcaseIntentV1 {
  return {
    version: 'universal-editorial-showcase-intent-v1', profileId: 'universal-editorial-showcase-v1',
    sections: [{ id: 'overview', role: 'decision', title: '核心判断', componentIds: ['showcase-hero'] }],
  };
}

function harness(
  mode: 'model' | 'fallback',
  deliverableType: ReturnType<typeof showcaseFixture>['material']['deliverableType'] = 'research_plan',
) {
  const source = sourceForFixture();
  const store = new MemoryStore();
  let fences = 0;
  const pipeline = new EditorialShowcasePipeline({
    source: {
      readCurrent: async () => source,
      assertStillCurrent: async () => { fences += 1; },
    } as EditorialSourceVerifier,
    materialize: () => materialization(deliverableType),
    planner: {
      plan: async () => mode === 'model'
        ? { mode: 'model_intent' as const, intent: modelIntent(), intentHash: canonicalSha256(modelIntent()), reasonCode: 'SHOWCASE_INTENT_ACCEPTED' as const }
        : { mode: 'deterministic_showcase' as const, intent: null, intentHash: null, reasonCode: 'SHOWCASE_MODEL_UNAVAILABLE' as const },
    },
    store,
    lockStore: { acquire: async () => ({ release: async () => true }) },
    now: () => new Date('2026-08-30T00:00:00.000Z'),
  });
  return { pipeline, store, fences: () => fences };
}

test('does not substitute the legacy report when Universal Showcase generation fails', async () => {
  const source = sourceForFixture();
  const pipeline = new EditorialShowcasePipeline({
    source: {
      readCurrent: async () => source,
      assertStillCurrent: async () => undefined,
    } as EditorialSourceVerifier,
    materialize: () => { throw new Error('invalid canonical material'); },
    planner: { plan: async () => { throw new Error('must not reach planner'); } },
    store: new MemoryStore(),
    lockStore: { acquire: async () => ({ release: async () => true }) },
  });

  await assert.rejects(
    () => pipeline.generate({ taskId: showcaseFixture().material.taskId }),
    (error: unknown) => error instanceof Error && /invalid canonical material/u.test(error.message),
  );
});

test('publishes model Intent and deterministic fallback through the same Showcase pipeline', async () => {
  const model = harness('model');
  const modelResult = await model.pipeline.generate({ taskId: showcaseFixture().material.taskId });
  assert.equal(modelResult.status, 'ready');
  assert.equal(modelResult.generationMode, 'model_intent');
  assert.equal(model.store.value?.manifest.generationMode, 'model_intent');
  assert.ok(model.fences() >= 2);

  const deterministic = harness('fallback');
  const fallbackResult = await deterministic.pipeline.generate({ taskId: showcaseFixture().material.taskId });
  assert.equal(fallbackResult.status, 'ready');
  assert.equal(fallbackResult.generationMode, 'deterministic_showcase');
  assert.equal(deterministic.store.value?.manifest.generationMode, 'deterministic_showcase');
});

test('publishes every active Deliverable without falling back to the legacy report pipeline', async () => {
  const deliverableTypes: Array<ReturnType<typeof showcaseFixture>['material']['deliverableType']> = [
    'research_plan',
    'research_strategy_report',
    'competitive_analysis_report',
    'voc_diagnosis_report',
    'design_audit_report',
    'accessibility_audit_report',
  ];
  for (const deliverableType of deliverableTypes) {
    const current = harness('fallback', deliverableType);
    const result = await current.pipeline.generate({ taskId: showcaseFixture().material.taskId });
    assert.equal(result.status, 'ready', deliverableType);
    assert.equal(result.generationMode, 'deterministic_showcase', deliverableType);
  }
});
