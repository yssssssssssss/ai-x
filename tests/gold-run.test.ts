import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertGoldSmokeReceipt,
  buildGoldPins,
  parseGoldCommand,
} from '../apps/orchestrator-runtime/src/gold-run.ts';
import type { SmokeReceipt } from '../scripts/current-real-smoke.ts';

function receipt(overrides: Partial<SmokeReceipt> = {}): SmokeReceipt {
  return {
    scenarioId: 'competitive-pet-food',
    profile: 'competitive_research',
    taskType: 'competitive_research',
    deliverableType: 'competitive_analysis_report',
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    reportPackageId: 'package-1',
    visualAssetCount: 0,
    gapCount: 0,
    toolArtifactIds: ['tool-1'],
    visualAssetIds: [],
    visualAssetManifestIds: [],
    browserCaptureCount: 0,
    browserCaptureIds: [],
    browserCaptureHosts: [],
    screenshotEvidenceCount: 0,
    screenshotEvidenceIds: [],
    chartRenderCount: 0,
    chartRenderIds: [],
    browserToolVerified: false,
    historyRereadVerified: true,
    evidenceCount: 3,
    provider: 'gateway',
    requestedModel: 'route-a',
    actualModel: 'model-a',
    coreTool: 'tavily-web-search',
    packageSealed: true,
    review: { artifactId: 'review-1', automated: true, verdict: 'pass' },
    deliverableArtifactId: 'deliverable-1',
    evidenceManifestArtifactId: 'evidence-manifest-1',
    evidenceArtifactIds: ['evidence-1'],
    toolReceipt: {
      actorId: 'tavily-web-search',
      declaredAdapterType: 'tavily',
      resolvedAdapterType: 'tavily',
      implementationId: 'tavily-rest-v1',
      executionMode: 'real',
      endpointHost: 'api.tavily.com',
      status: 'ok',
      latencyMs: 1,
    },
    counts: { evidence: 3, findings: 1, recommendations: 1 },
    sources: ['https://example.test/source'],
    ...overrides,
  };
}

test('Gold CLI separates collection, asynchronous review, and final decision', () => {
  assert.deepEqual(parseGoldCommand([]), { kind: 'collect' });
  assert.deepEqual(parseGoldCommand(['batch-1']), { kind: 'collect', batchId: 'batch-1' });
  assert.deepEqual(parseGoldCommand(['collect', 'batch-1']), { kind: 'collect', batchId: 'batch-1' });
  assert.deepEqual(parseGoldCommand(['review', 'batch-1', 'attempt-1', 'usable']), {
    kind: 'review',
    batchId: 'batch-1',
    attemptId: 'attempt-1',
    verdict: 'usable',
  });
  assert.deepEqual(parseGoldCommand(['decide', 'batch-1']), { kind: 'decide', batchId: 'batch-1' });
  assert.throws(() => parseGoldCommand(['review', 'batch-1', 'attempt-1', 'pass']), /usage/u);
});

test('Gold pins freeze the real provider, model route, scenario, build, registry, schema, and review policy', () => {
  const pins = buildGoldPins({
    scenarioId: 'competitive-pet-food',
    scenarioInput: 'fixed scenario input',
    endpoint: 'https://llm-gw.test/v1?token=must-not-leak',
    requestedModel: 'route-a',
    expectedActualModel: 'model-a',
    buildId: 'commit-a',
  });

  assert.equal(pins.provider, 'gateway');
  assert.equal(pins.endpoint, 'llm-gw.test');
  assert.equal(pins.coreTool, 'tavily-web-search');
  assert.equal(pins.requestedModel, 'route-a');
  assert.equal(pins.expectedActualModel, 'model-a');
  for (const value of [
    pins.scenarioInputHash,
    pins.policyHash,
    pins.buildHash,
    pins.registryHash,
    pins.schemaHash,
    pins.reviewPolicyHash,
  ]) assert.match(value, /^sha256:[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(pins), /must-not-leak/u);
});

test('Gold collection accepts only sealed full-real Current receipts with an automated pass Review Artifact', () => {
  assert.doesNotThrow(() => assertGoldSmokeReceipt(receipt(), 'competitive-pet-food'));
  assert.throws(
    () => assertGoldSmokeReceipt(receipt(), 'competitive-ai-shopping-assistant'),
    /non-qualifying/u,
  );
  assert.throws(
    () => assertGoldSmokeReceipt(receipt({ provider: 'mock' }), 'competitive-pet-food'),
    /non-qualifying/u,
  );
  assert.throws(
    () => assertGoldSmokeReceipt(receipt({ packageSealed: false }), 'competitive-pet-food'),
    /non-qualifying/u,
  );
  assert.throws(() => assertGoldSmokeReceipt(receipt({
    review: { artifactId: 'review-1', automated: true, verdict: 'revise' as never },
  }), 'competitive-pet-food'), /non-qualifying/u);
});
