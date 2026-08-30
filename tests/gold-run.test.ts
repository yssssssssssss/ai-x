import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  assertGoldSmokeReceipt,
  buildGoldPins,
  GOLD_SCENARIO_ID,
  parseGoldCommand,
  selectGoldScenario,
} from '../apps/orchestrator-runtime/src/gold-run.ts';
import type {
  SemanticGoldFixture,
  SmokeReceipt,
} from '../scripts/current-real-smoke.ts';

function receipt(overrides: Partial<SmokeReceipt> = {}): SmokeReceipt {
  return {
    scenarioId: GOLD_SCENARIO_ID,
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

function semanticFixture(): SemanticGoldFixture {
  return JSON.parse(
    readFileSync(join(process.cwd(), 'tests/fixtures/current-semantic-gold.json'), 'utf8'),
  ) as SemanticGoldFixture;
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

test('Gold selects the JD crowdfunding channel scenario by exact ID regardless of fixture order', () => {
  const fixture = semanticFixture();
  const selected = selectGoldScenario(fixture);
  const reversed = selectGoldScenario({ ...fixture, scenarios: [...fixture.scenarios].reverse() });
  const targetLast = selectGoldScenario({
    ...fixture,
    scenarios: [
      ...fixture.scenarios.filter(({ id }) => id !== GOLD_SCENARIO_ID),
      ...fixture.scenarios.filter(({ id }) => id === GOLD_SCENARIO_ID),
    ],
  });

  assert.equal(selected.id, GOLD_SCENARIO_ID);
  assert.equal(reversed.id, GOLD_SCENARIO_ID);
  assert.equal(targetLast.id, GOLD_SCENARIO_ID);
  assert.equal(reversed.input, selected.input);
  assert.equal(targetLast.input, selected.input);
});

test('Gold keeps the ambiguous digital-human regression scenario separate from the crowdfunding target', () => {
  const fixture = semanticFixture();
  const ambiguous = fixture.scenarios.find(({ id }) => id === 'competitive-digital-human') as
    | (typeof fixture.scenarios)[number] & { clarificationKeys?: string[] }
    | undefined;
  const gold = selectGoldScenario(fixture) as (typeof fixture.scenarios)[number] & {
    clarificationKeys?: string[];
  };

  assert.ok(ambiguous);
  assert.equal(ambiguous.variant, 'ambiguous');
  assert.equal(ambiguous.piiDetected, false);
  assert.deepEqual(ambiguous.clarificationKeys, ['scope', 'audience']);
  assert.equal(gold.variant, 'clear');
  assert.equal(gold.businessDomain, 'jd_crowdfunding');
  assert.match(gold.input, /京东众筹/u);
  assert.match(gold.input, /五个问题/u);
  assert.equal(gold.piiDetected, false);
  assert.deepEqual(gold.clarificationKeys, []);
});

test('Gold exact target selection fails closed on identity and safety drift', () => {
  const fixture = semanticFixture();
  const target = fixture.scenarios.find(({ id }) => id === GOLD_SCENARIO_ID)!;
  const withoutTarget = fixture.scenarios.filter(({ id }) => id !== GOLD_SCENARIO_ID);
  assert.throws(
    () => selectGoldScenario({ ...fixture, scenarios: withoutTarget }),
    /exactly one.*competitive-jd-crowdfunding-channel-gold/u,
  );
  assert.throws(
    () => selectGoldScenario({ ...fixture, scenarios: [...fixture.scenarios, target] }),
    /exactly one.*competitive-jd-crowdfunding-channel-gold/u,
  );
  for (const mutation of [
    { profile: 'voc_diagnosis' },
    { variant: 'ambiguous' },
    { piiDetected: true },
    { input: '   ' },
  ]) {
    assert.throws(() => selectGoldScenario({
      ...fixture,
      scenarios: fixture.scenarios.map((scenario) => (
        scenario.id === GOLD_SCENARIO_ID ? { ...scenario, ...mutation } : scenario
      )),
    } as SemanticGoldFixture), /safe clear competitive scenario/u);
  }
});

test('Gold pins freeze the real provider, model route, scenario, build, registry, schema, and review policy', () => {
  const pins = buildGoldPins({
    scenarioId: GOLD_SCENARIO_ID,
    scenarioInput: 'fixed scenario input',
    endpoint: 'https://llm-gw.test/v1?token=must-not-leak',
    requestedModel: 'route-a',
    expectedActualModel: 'model-a',
    buildId: 'commit-a',
  });

  assert.equal(pins.scenarioId, GOLD_SCENARIO_ID);
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

test('Gold collection accepts only sealed Gateway and real Tavily Current receipts', () => {
  assert.doesNotThrow(() => assertGoldSmokeReceipt(receipt(), GOLD_SCENARIO_ID));
  assert.throws(
    () => assertGoldSmokeReceipt(receipt(), 'competitive-digital-human'),
    /non-qualifying/u,
  );
  assert.throws(
    () => assertGoldSmokeReceipt(receipt({ provider: 'mock' }), GOLD_SCENARIO_ID),
    /non-qualifying/u,
  );
  assert.throws(
    () => assertGoldSmokeReceipt(receipt({ packageSealed: false }), GOLD_SCENARIO_ID),
    /non-qualifying/u,
  );
  for (const toolReceipt of [
    { ...receipt().toolReceipt, executionMode: 'mock' },
    { ...receipt().toolReceipt, declaredAdapterType: 'fake' },
    { ...receipt().toolReceipt, resolvedAdapterType: 'fake' },
    { ...receipt().toolReceipt, actorId: 'fake-search' },
  ]) {
    assert.throws(
      () => assertGoldSmokeReceipt(receipt({ toolReceipt }), GOLD_SCENARIO_ID),
      /non-qualifying/u,
    );
  }
  assert.throws(() => assertGoldSmokeReceipt(receipt({
    review: { artifactId: 'review-1', automated: true, verdict: 'revise' as never },
  }), GOLD_SCENARIO_ID), /non-qualifying/u);
});
