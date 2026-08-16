import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EvidenceService,
  type EvidenceArtifactResolver,
  type EvidenceEntry,
} from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import {
  ChartSpecValidationError,
  validateChartSpec,
  type ChartEvidenceResolver,
  type ChartSpec,
} from '../apps/orchestrator-runtime/src/report/chart-spec-validator.ts';

const ARTIFACT_ID = 'artifact-chart-evidence-1';
const ARTIFACT_HASH = `sha256:${'c'.repeat(64)}`;
const evidenceValue = {
  metrics: {
    actorRevenue: 12,
    competitorRevenue: 10,
    actorRetention: 87,
    competitorRetention: 81,
    january: 2,
    march: 5,
    discoverability: 4,
    usability: 3,
    trust: 5,
  },
};

const artifactResolver: EvidenceArtifactResolver = {
  resolveArtifact: (artifactId) => artifactId === ARTIFACT_ID
    ? {
        artifact: { id: ARTIFACT_ID, contentSha256: ARTIFACT_HASH },
        value: evidenceValue,
      }
    : null,
};
const evidenceService = new EvidenceService();
const evidencePointers = {
  'E-actor-revenue': '/metrics/actorRevenue',
  'E-competitor-revenue': '/metrics/competitorRevenue',
  'E-actor-retention': '/metrics/actorRetention',
  'E-competitor-retention': '/metrics/competitorRetention',
  'E-january': '/metrics/january',
  'E-march': '/metrics/march',
  'E-discoverability': '/metrics/discoverability',
  'E-usability': '/metrics/usability',
  'E-trust': '/metrics/trust',
} as const;

const manifest = evidenceService.createManifest({
  taskId: 'task-chart-1',
  planVersionId: 'plan-chart-1',
  attemptId: 'attempt-chart-1',
  collectedAt: '2026-08-16T00:00:00.000Z',
  entries: Object.entries(evidencePointers).map(([id, jsonPointer]) => ({
    id,
    kind: 'knowledge_excerpt',
    evidenceClass: 'dataset',
    artifactId: ARTIFACT_ID,
    artifactContentSha256: ARTIFACT_HASH,
    jsonPointer,
    sensitivity: 'internal',
    redaction: 'none',
  })) as EvidenceEntry[],
}, artifactResolver);

const evidenceById = new Map(manifest.entries.map((entry) => [entry.id, entry]));
const evidenceResolver: ChartEvidenceResolver = (evidenceId) => {
  const entry = evidenceById.get(evidenceId);
  return entry ? evidenceService.resolveEvidenceValue(entry, artifactResolver) : undefined;
};

function comparisonSpec(): ChartSpec {
  return {
    version: 'chart-spec-v1',
    chartId: 'chart-comparison-1',
    type: 'comparison',
    title: 'Actor and competitor comparison',
    categories: ['Revenue', 'Retention'],
    series: [
      {
        key: 'actor:primary',
        label: 'Actor',
        values: [12, 87],
        evidenceIds: [['E-actor-revenue'], ['E-actor-retention']],
      },
      {
        key: 'competitor:acme',
        label: 'Acme',
        values: [10, 81],
        evidenceIds: [['E-competitor-revenue'], ['E-competitor-retention']],
      },
    ],
    yAxis: { min: 0 },
  };
}

function trendSpec(): ChartSpec {
  return {
    version: 'chart-spec-v1',
    chartId: 'chart-trend-1',
    type: 'trend',
    title: 'Monthly verified trend',
    categories: ['January', 'February', 'March'],
    series: [{
      key: 'actor:primary',
      label: 'Actor',
      values: [2, null, 5],
      evidenceIds: [['E-january'], [], ['E-march']],
    }],
    yAxis: { min: 0 },
  };
}

function heatmapSpec(): ChartSpec {
  return {
    version: 'chart-spec-v1',
    chartId: 'chart-heatmap-1',
    type: 'heatmap',
    title: 'Experience score heatmap',
    categories: ['Discoverability', 'Usability', 'Trust'],
    series: [{
      key: 'actor:primary',
      label: 'Actor',
      values: [4, 3, 5],
      evidenceIds: [['E-discoverability'], ['E-usability'], ['E-trust']],
    }],
  };
}

function expectInvalid(spec: unknown, message: RegExp): void {
  assert.throws(
    () => validateChartSpec(spec, evidenceResolver),
    (error: unknown) => error instanceof ChartSpecValidationError && message.test(error.message),
  );
}

test('rejects unsupported chart types', () => {
  expectInvalid({ ...comparisonSpec(), type: 'pie' }, /unsupported|type/i);
});

test('rejects series values or Evidence bindings whose length differs from categories', () => {
  const shortValues = comparisonSpec();
  shortValues.series[0]!.values.pop();
  expectInvalid(shortValues, /series|categor|length/i);

  const shortEvidence = comparisonSpec();
  shortEvidence.series[0]!.evidenceIds.pop();
  expectInvalid(shortEvidence, /evidence|categor|length/i);
});

test('rejects every non-null data point that has no Evidence', () => {
  const spec = comparisonSpec();
  spec.series[0]!.evidenceIds[0] = [];
  expectInvalid(spec, /evidence|required|missing/i);
});

test('rejects a dangling Evidence id', () => {
  const spec = comparisonSpec();
  spec.series[0]!.evidenceIds[0] = ['E-does-not-exist'];
  expectInvalid(spec, /E-does-not-exist|dangling|resolve/i);
});

test('rejects a data value that is not present in its resolved Evidence value', () => {
  const spec = comparisonSpec();
  spec.series[0]!.values[0] = 99;
  expectInvalid(spec, /value|evidence|match/i);
});

test('preserves a missing value as null and never coerces it to zero', () => {
  const validated = validateChartSpec(trendSpec(), evidenceResolver);
  assert.equal(validated.series[0]!.values[1], null);
  assert.notEqual(validated.series[0]!.values[1], 0);
  assert.deepEqual(validated.series[0]!.evidenceIds[1], []);
});

test('rejects a misleading non-zero baseline for comparison and trend charts', () => {
  for (const spec of [comparisonSpec(), trendSpec()]) {
    spec.yAxis = { min: 1 };
    expectInvalid(spec, /baseline|zero|yAxis|min/i);
  }
});

for (const [type, build] of [
  ['comparison', comparisonSpec],
  ['trend', trendSpec],
  ['heatmap', heatmapSpec],
] as const) {
  test(`accepts an Evidence-bound ${type} chart`, () => {
    const spec = build();
    assert.deepEqual(validateChartSpec(spec, evidenceResolver), spec);
  });
}
