import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTaxonomy } from '../apps/orchestrator-runtime/src/knowledge/taxonomy.ts';

test('taxonomy exposes a non-empty controlled tag vocabulary', () => {
  assert.ok(loadTaxonomy().tags.length > 0);
});

test('candidate 生命周期状态与生产隔离状态齐全', () => {
  const { knowledge_statuses } = loadTaxonomy();
  assert.deepEqual(knowledge_statuses, ['approved', 'draft', 'candidate', 'deprecated']);
});

test('guide_stages 五阶段齐全', () => {
  const { guide_stages } = loadTaxonomy();
  assert.deepEqual(
    guide_stages,
    ['intent', 'goal-definition', 'need-discovery', 'method-selection', 'output-standard'],
  );
});
