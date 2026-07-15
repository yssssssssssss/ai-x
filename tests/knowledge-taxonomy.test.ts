import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTaxonomy } from '../apps/orchestrator-runtime/src/knowledge/taxonomy.ts';
import { loadDecisionGraph } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';

test('taxonomy 覆盖 decision-graph 全部 related_tags', () => {
  const { tags } = loadTaxonomy();
  const tagSet = new Set(tags);
  const { nodes } = loadDecisionGraph();
  const missing: string[] = [];
  for (const n of nodes) {
    for (const t of n.related_tags ?? []) {
      if (!tagSet.has(t)) missing.push(`${n.key}:${t}`);
    }
  }
  assert.deepEqual(missing, [], `taxonomy 缺 related_tags: ${missing.join(', ')}`);
});

test('guide_stages 五阶段齐全', () => {
  const { guide_stages } = loadTaxonomy();
  assert.deepEqual(
    guide_stages,
    ['intent', 'goal-definition', 'need-discovery', 'method-selection', 'output-standard'],
  );
});
