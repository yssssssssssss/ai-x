import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChartSpec } from '../packages/api-contract/research-deliverable.ts';

import {
  assertCompetitiveWeightChartBinding,
  COMPETITIVE_WEIGHT_CHART_DATA_VERSION,
  COMPETITIVE_WEIGHT_CHART_ID,
  COMPETITIVE_WEIGHT_SERIES_KEY,
  COMPETITIVE_WEIGHT_SERIES_LABEL,
  COMPETITIVE_WEIGHT_TITLE,
  extractCompetitiveScoringWeights,
  parseCompetitiveWeightChartData,
  type CompetitiveWeightEvidenceEntry,
} from '../apps/orchestrator-runtime/src/report/competitive-weight-chart.ts';

const expected = [
  { dimension: '需求理解', percentage: 20 },
  { dimension: '推荐可解释性', percentage: 20 },
  { dimension: '商品信息组织', percentage: 20 },
  { dimension: '价格呈现', percentage: 15 },
  { dimension: '内容可信度', percentage: 15 },
  { dimension: '转化入口', percentage: 10 },
];

test('extracts an exact six-dimension scoring weight object from a frozen plan', () => {
  assert.deepEqual(extractCompetitiveScoringWeights({
    steps: [
      {
        actor_type: 'llm',
        actor_id: 'comparison-summary',
        input: { scoring_weights: { 诱饵一: 0.5, 诱饵二: 0.5 } },
      },
      {
        actor_type: 'skill',
        actor_id: 'competitive-web-research',
        input: {
          scoring_weights: Object.fromEntries(expected.map(({ dimension, percentage }) => [
            dimension,
            percentage / 100,
          ])),
        },
      },
    ],
  }), expected);
});

test('uses the frozen dimensions array after persisted weight keys are canonically reordered', () => {
  assert.deepEqual(extractCompetitiveScoringWeights({
    steps: [{
      actor_type: 'skill',
      actor_id: 'competitive-web-research',
      input: {
        dimensions: ['需求理解', '推荐可解释性', '内容可信度'],
        scoring_weights: {
          内容可信度: 0.2,
          推荐可解释性: 0.3,
          需求理解: 0.5,
        },
      },
    }],
  }), [
    { dimension: '需求理解', percentage: 50 },
    { dimension: '推荐可解释性', percentage: 30 },
    { dimension: '内容可信度', percentage: 20 },
  ]);
});

test('rejects a persisted dimensions and weight-key set mismatch', () => {
  assert.deepEqual(extractCompetitiveScoringWeights({
    steps: [{
      actor_type: 'skill',
      actor_id: 'competitive-web-research',
      input: {
        dimensions: ['需求理解', '内容可信度'],
        scoring_weights: { 需求理解: 0.5, 价格对比: 0.5 },
      },
    }],
  }), []);
});

test('does not fall back to nested, sampling, structured, or textual weights', () => {
  assert.deepEqual(extractCompetitiveScoringWeights({
    scoring_weights: Object.fromEntries(expected.map(({ dimension, percentage }) => [dimension, percentage])),
    structured_task: {
      scoring_weights: Object.fromEntries(expected.map(({ dimension, percentage }) => [dimension, percentage])),
      statement: '需求理解20%、推荐可解释性20%、商品信息组织20%、价格呈现15%、内容可信度15%、转化入口10%。',
    },
    steps: [{
      actor_type: 'skill',
      actor_id: 'competitive-web-research',
      input: {
        sampling_weights: Object.fromEntries(expected.map(({ dimension, percentage }) => [dimension, percentage])),
        config: {
          scoring_weights: Object.fromEntries(expected.map(({ dimension, percentage }) => [dimension, percentage])),
        },
      },
    }],
  }), []);
});

test('rejects duplicate competitive web research steps', () => {
  const targetStep = {
    actor_type: 'skill',
    actor_id: 'competitive-web-research',
    input: { scoring_weights: { 需求理解: 0.5, 内容可信度: 0.5 } },
  };
  assert.deepEqual(extractCompetitiveScoringWeights({ steps: [targetStep, targetStep] }), []);
});

test('rejects missing, mistyped, and malformed competitive weight inputs', () => {
  const invalidPlans = [
    {},
    { steps: 'not-an-array' },
    { steps: [{ actor_type: 'tool', actor_id: 'competitive-web-research', input: { scoring_weights: { a: 0.5, b: 0.5 } } }] },
    { steps: [{ actor_type: 'skill', actor_id: 'competitive-web-research', input: null }] },
    { steps: [{ actor_type: 'skill', actor_id: 'competitive-web-research', input: { scoring_weights: ['a', 'b'] } }] },
    { steps: [{ actor_type: 'skill', actor_id: 'competitive-web-research', input: { scoring_weights: { a: 0.6, b: 0.6 } } }] },
  ];
  for (const plan of invalidPlans) {
    assert.deepEqual(extractCompetitiveScoringWeights(plan), []);
  }
});

test('exports the comparison-dimension weight title', () => {
  assert.equal(COMPETITIVE_WEIGHT_TITLE, '对比维度评分权重 / Comparison-dimension Weights (%)');
});

test('competitive Chart Data fails closed on body marker, binding, dimension, and value drift', () => {
  const validData: Record<string, unknown> = {
    version: COMPETITIVE_WEIGHT_CHART_DATA_VERSION,
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    unit: 'percent',
    weights: [
      { dimension: '需求理解', percentage: 60 },
      { dimension: '内容可信度', percentage: 40 },
    ],
  };
  const binding = {
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
  };

  assert.deepEqual(parseCompetitiveWeightChartData(validData, binding), validData);

  const invalidBodies: Array<{
    name: string;
    mutate: (candidate: Record<string, unknown>) => void;
  }> = [
    { name: 'version marker', mutate: (candidate) => { candidate.version = 'other-chart-data-v1'; } },
    { name: 'task binding', mutate: (candidate) => { candidate.taskId = 'other-task'; } },
    { name: 'plan binding', mutate: (candidate) => { candidate.planVersionId = 'other-plan'; } },
    { name: 'attempt binding', mutate: (candidate) => { candidate.attemptId = 'other-attempt'; } },
    {
      name: 'dimension',
      mutate: (candidate) => {
        candidate.weights = [
          { dimension: ' 需求理解', percentage: 60 },
          { dimension: '内容可信度', percentage: 40 },
        ];
      },
    },
    {
      name: 'value',
      mutate: (candidate) => {
        candidate.weights = [
          { dimension: '需求理解', percentage: 59 },
          { dimension: '内容可信度', percentage: 40 },
        ];
      },
    },
  ];

  for (const { name, mutate } of invalidBodies) {
    const candidate = structuredClone(validData);
    mutate(candidate);
    assert.throws(
      () => parseCompetitiveWeightChartData(candidate, binding),
      /competitive weight Chart Data/i,
      name,
    );
  }
});

test('competitive Chart binding fails closed on label, value, and Evidence lineage drift', () => {
  const data = parseCompetitiveWeightChartData({
    version: COMPETITIVE_WEIGHT_CHART_DATA_VERSION,
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    unit: 'percent',
    weights: [
      { dimension: '需求理解', percentage: 60 },
      { dimension: '内容可信度', percentage: 40 },
    ],
  }, {
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
  });
  const spec: ChartSpec = {
    version: 'chart-spec-v1',
    chartId: COMPETITIVE_WEIGHT_CHART_ID,
    type: 'comparison',
    title: COMPETITIVE_WEIGHT_TITLE,
    categories: ['需求理解', '内容可信度'],
    series: [{
      key: COMPETITIVE_WEIGHT_SERIES_KEY,
      label: COMPETITIVE_WEIGHT_SERIES_LABEL,
      values: [60, 40],
      evidenceIds: [['W-1'], ['W-2']],
    }],
    yAxis: { min: 0 },
  };
  const dataArtifactRef = {
    artifactId: 'chart-data-1',
    contentSha256: `sha256:${'d'.repeat(64)}`,
  };
  const evidenceEntries: CompetitiveWeightEvidenceEntry[] = data.weights.map((_, index) => ({
    id: `W-${index + 1}`,
    kind: 'user_constraint',
    evidenceClass: 'user_input',
    artifactId: dataArtifactRef.artifactId,
    artifactContentSha256: dataArtifactRef.contentSha256,
    jsonPointer: `/weights/${index}/percentage`,
  }));

  assert.doesNotThrow(() => assertCompetitiveWeightChartBinding({
    data,
    spec,
    dataArtifactRef,
    evidenceEntries,
  }));

  type BindingCandidate = {
    spec: ChartSpec;
    evidenceEntries: CompetitiveWeightEvidenceEntry[];
  };
  const driftCases: Array<{
    name: string;
    mutate: (candidate: BindingCandidate) => void;
    error: RegExp;
  }> = [
    {
      name: 'dimension label',
      mutate: ({ spec: candidate }) => { candidate.categories[0] = '需求识别'; },
      error: /labels or values/i,
    },
    {
      name: 'numeric value',
      mutate: ({ spec: candidate }) => { candidate.series[0]!.values[0] = 59; },
      error: /labels or values/i,
    },
    {
      name: 'Evidence kind',
      mutate: ({ evidenceEntries: entries }) => { entries[0]!.kind = 'public_source'; },
      error: /Evidence.*lineage/i,
    },
    {
      name: 'Evidence class',
      mutate: ({ evidenceEntries: entries }) => { entries[0]!.evidenceClass = 'external_public'; },
      error: /Evidence.*lineage/i,
    },
    {
      name: 'Evidence artifact id',
      mutate: ({ evidenceEntries: entries }) => { entries[0]!.artifactId = 'other-chart-data'; },
      error: /Evidence.*lineage/i,
    },
    {
      name: 'Evidence artifact hash',
      mutate: ({ evidenceEntries: entries }) => {
        entries[0]!.artifactContentSha256 = `sha256:${'e'.repeat(64)}`;
      },
      error: /Evidence.*lineage/i,
    },
    {
      name: 'Evidence JSON pointer',
      mutate: ({ evidenceEntries: entries }) => { entries[0]!.jsonPointer = '/weights/1/percentage'; },
      error: /Evidence.*lineage/i,
    },
  ];

  for (const { name, mutate, error } of driftCases) {
    const candidate: BindingCandidate = {
      spec: structuredClone(spec),
      evidenceEntries: structuredClone(evidenceEntries),
    };
    mutate(candidate);
    assert.throws(
      () => assertCompetitiveWeightChartBinding({
        data,
        spec: candidate.spec,
        dataArtifactRef,
        evidenceEntries: candidate.evidenceEntries,
      }),
      error,
      name,
    );
  }
});
