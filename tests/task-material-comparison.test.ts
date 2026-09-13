import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  materialComparisonReferences,
  normalizeTaskMaterialComparison,
  TaskMaterialComparisonError,
} from '../apps/orchestrator-runtime/src/control/task-material-comparison.ts';

const requests = [
  { id: 'ours', role: 'primaryScreens', multiple: true },
  { id: 'theirs', role: 'comparisonScreens', multiple: true },
];

function bindings(primaryCount: number, comparisonCount: number) {
  return [
    { requestId: 'ours', materialIds: Array.from({ length: primaryCount }, (_, index) => `ours-${index + 1}`) },
    { requestId: 'theirs', materialIds: Array.from({ length: comparisonCount }, (_, index) => `theirs-${index + 1}`) },
  ];
}

test('grouped visual comparison accepts dynamic unequal upload counts without inventing pairs', () => {
  const comparison = normalizeTaskMaterialComparison({
    value: {
      mode: 'grouped',
      primaryRequestId: 'ours',
      comparisonRequestId: 'theirs',
      pairs: [],
    },
    requests,
    bindings: bindings(3, 7),
  });

  assert.deepEqual(comparison, {
    mode: 'grouped',
    primaryRequestId: 'ours',
    comparisonRequestId: 'theirs',
    pairs: [],
  });
  assert.equal(materialComparisonReferences(comparison).size, 0);
});

test('grouped visual comparison accepts a single populated optional side', () => {
  const comparison = normalizeTaskMaterialComparison({
    value: {
      mode: 'grouped',
      primaryRequestId: 'ours',
      comparisonRequestId: 'theirs',
      pairs: [],
    },
    requests,
    bindings: bindings(4, 0),
  });

  assert.equal(comparison?.mode, 'grouped');
  assert.deepEqual(comparison?.pairs, []);
});

test('paired visual comparison assigns stable pair ids to explicitly selected artifacts', () => {
  const comparison = normalizeTaskMaterialComparison({
    value: {
      mode: 'paired',
      primaryRequestId: 'ours',
      comparisonRequestId: 'theirs',
      pairs: [
        { label: '首屏', primaryMaterialId: 'ours-2', comparisonMaterialId: 'theirs-1' },
        { label: '评价区', primaryMaterialId: 'ours-1', comparisonMaterialId: 'theirs-2' },
      ],
    },
    requests,
    bindings: bindings(2, 2),
  });

  assert.deepEqual([...materialComparisonReferences(comparison)], [
    ['ours-2', { pairId: 'PAIR-001', label: '首屏', side: 'primary', sequence: 1 }],
    ['theirs-1', { pairId: 'PAIR-001', label: '首屏', side: 'comparison', sequence: 1 }],
    ['ours-1', { pairId: 'PAIR-002', label: '评价区', side: 'primary', sequence: 2 }],
    ['theirs-2', { pairId: 'PAIR-002', label: '评价区', side: 'comparison', sequence: 2 }],
  ]);
});

test('paired visual comparison rejects omitted or repeated uploaded artifacts', () => {
  assert.throws(() => normalizeTaskMaterialComparison({
    value: {
      mode: 'paired',
      primaryRequestId: 'ours',
      comparisonRequestId: 'theirs',
      pairs: [
        { label: '首屏', primaryMaterialId: 'ours-1', comparisonMaterialId: 'theirs-1' },
        { label: '评价区', primaryMaterialId: 'ours-1', comparisonMaterialId: 'theirs-2' },
      ],
    },
    requests,
    bindings: bindings(2, 2),
  }), TaskMaterialComparisonError);
});
