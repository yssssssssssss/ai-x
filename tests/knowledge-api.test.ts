import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterKnowledge } from '../apps/orchestrator-runtime/src/knowledge/index.ts';
import type { KnowledgeIndexItem } from '../apps/orchestrator-runtime/src/knowledge/indexer.ts';

const items: KnowledgeIndexItem[] = [
  { id: 'model_jtbd', type: 'model', title: 'JTBD', domain: 'general', tags: ['persona', 'framework'], guide_stage: ['need-discovery'], summary: '需求框架', source_path: 'models/jtbd.md', content_hash: 'sha256:x', status: 'approved' },
  { id: 'std_report', type: 'standard', title: '报告规范', domain: 'general', tags: ['report', 'output'], guide_stage: ['output-standard'], summary: '', source_path: 'methods/standards/research-report-writing.md', content_hash: 'sha256:y', status: 'approved' },
  { id: 'dep_x', type: 'model', title: '弃用', domain: 'general', tags: ['persona'], guide_stage: [], summary: '', source_path: 'models/x.md', content_hash: 'sha256:z', status: 'deprecated' },
];

test('按 tags 召回(决策节点 related_tags)', () => {
  const r = filterKnowledge(items, { tags: ['persona'] });
  const ids = r.map((i) => i.id);
  assert.ok(ids.includes('model_jtbd'));
  assert.ok(!ids.includes('dep_x'), 'deprecated 不召回');
});

test('按 guide_stage 召回', () => {
  const r = filterKnowledge(items, { guide_stage: ['output-standard'] });
  assert.deepEqual(r.map((i) => i.id), ['std_report']);
});

test('关键词命中 title/summary', () => {
  const r = filterKnowledge(items, { query: '框架' });
  assert.deepEqual(r.map((i) => i.id), ['model_jtbd']);
});
