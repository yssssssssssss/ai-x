import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieveGuidance } from '../apps/orchestrator-runtime/src/orchestrator.ts';
import { loadDecisionGraph, type DecisionNode } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';

// Task B 单测:retrieveGuidance 用节点 related_tags 从真实 .index 召回方法论条目。
// 前置:knowledge-base/.index/knowledge.json 已由 kb:build 生成。

test('retrieveGuidance:D5_competitive 节点召回带溯源的方法论条目', () => {
  const graph = loadDecisionGraph();
  const d5 = graph.nodes.find((n) => n.key === 'D5_competitive');
  assert.ok(d5, '决策图应含 D5_competitive 节点');
  assert.ok((d5!.related_tags ?? []).length > 0, 'D5 应有 related_tags');

  const refs = retrieveGuidance([d5!]);
  assert.ok(refs.length > 0, 'D5 应召回非空方法论条目');
  for (const r of refs) {
    assert.equal(r.node, 'D5_competitive', 'node 字段应等于节点 key');
    assert.ok(r.id, '应含 id');
    assert.ok(r.source_path, '应含 source_path 溯源');
    assert.ok(r.content_hash, '应含 content_hash 溯源');
  }
});

test('retrieveGuidance:related_tags 为空的节点返回 []', () => {
  const empty: DecisionNode = {
    key: 'D_no_tags',
    question: 'x',
    applies_to: ['competitive_research'],
    tier: 'optional',
  };
  assert.deepEqual(retrieveGuidance([empty]), []);
});

test('retrieveGuidance:每节点最多 top-3', () => {
  const graph = loadDecisionGraph();
  const d3 = graph.nodes.find((n) => n.key === 'D3_method_selection');
  assert.ok(d3, '决策图应含 D3_method_selection');
  const refs = retrieveGuidance([d3!]);
  assert.ok(refs.length <= 3, '单节点召回不超过 top-3');
  assert.ok(refs.length > 0, 'method 标签应召回条目');
});
