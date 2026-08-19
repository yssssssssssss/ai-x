import assert from 'node:assert/strict';
import test from 'node:test';

import { extractCompetitiveScoringWeights } from '../apps/orchestrator-runtime/src/report/competitive-weight-chart.ts';

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
    plan: {
      steps: [{
        input: {
          scoring_weights: Object.fromEntries(expected.map(({ dimension, percentage }) => [
            dimension,
            percentage / 100,
          ])),
        },
      }],
    },
    structuredTask: {},
  }), expected);
});

test('falls back to the finalized weighted-dimension constraint without mistaking KPI targets for weights', () => {
  assert.deepEqual(extractCompetitiveScoringWeights({
    plan: {},
    structuredTask: {
      constraints: [
        { statement: '任务完成率提升10%，点击/加购率提升5%，任务时长下降15%，信任度提升10%。' },
        { statement: '六维度加权评分分别为：需求理解20%、推荐可解释性20%、商品信息组织20%、价格呈现15%、内容可信度15%、转化入口10%。' },
      ],
    },
  }), expected);
});

test('does not emit a chart configuration for malformed or incomplete weights', () => {
  assert.deepEqual(extractCompetitiveScoringWeights({
    plan: { weights: { a: 0.6, b: 0.6 } },
    structuredTask: { scope: ['指标提升10%、效率提升5%'] },
  }), []);
});
