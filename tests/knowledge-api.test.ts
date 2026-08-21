import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterEvaluationKnowledge,
  filterKnowledge,
  getEntry,
  loadEvaluationKnowledgeIndex,
  loadRuntimeKnowledgeIndex,
} from '../apps/orchestrator-runtime/src/knowledge/index.ts';
import type { KnowledgeIndexItem } from '../apps/orchestrator-runtime/src/knowledge/indexer.ts';

const items: KnowledgeIndexItem[] = [
  { id: 'model_jtbd', type: 'model', title: 'JTBD', domain: ['general'], tags: ['需求框架'], guide_tags: ['persona', 'framework'], guide_stage: ['need-discovery'], summary: '需求框架', source_path: 'models/jtbd.md', content_hash: 'sha256:x', status: 'approved' },
  { id: 'std_report', type: 'standard', title: '报告规范', domain: ['通用'], tags: ['报告'], guide_tags: ['report', 'output'], guide_stage: ['output-standard'], summary: '', source_path: 'methods/standards/research-report-writing.md', content_hash: 'sha256:y', status: 'approved' },
  { id: 'dep_x', type: 'model', title: '弃用', domain: ['general'], tags: ['画像'], guide_tags: ['persona'], guide_stage: [], summary: '', source_path: 'models/x.md', content_hash: 'sha256:z', status: 'deprecated' },
  { id: 'candidate_x', type: 'analysis', title: '候选', domain: ['general'], tags: ['候选'], guide_tags: ['method'], guide_stage: ['method-selection'], summary: '', source_path: 'methods/toolbox/analysis/design-strategy/x.md', content_hash: 'sha256:c', status: 'candidate' },
];

test('按 guide_tags 召回(决策节点 related_tags)', () => {
  const r = filterKnowledge(items, { guide_tags: ['persona'] });
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

test('生产与 Evaluation 使用不可切换的独立 candidate 可见性接口', () => {
  assert.deepEqual(filterKnowledge(items, {}).map(({ id }) => id), ['model_jtbd', 'std_report']);
  assert.deepEqual(filterEvaluationKnowledge(items, {}).map(({ id }) => id), ['model_jtbd', 'std_report', 'candidate_x']);

  const runtime = loadRuntimeKnowledgeIndex();
  const evaluation = loadEvaluationKnowledgeIndex();
  assert.equal(runtime.some(({ status }) => status === 'candidate'), false);
  assert.equal(evaluation.filter(({ status }) => status === 'candidate').length, 30);
  assert.equal(getEntry('ds-method-strategy-02-strategy-map'), null, '生产 getEntry 不得读取 candidate');
});

test('生产过滤只允许 approved/draft，未知状态不能因黑名单遗漏而进入', () => {
  const malformed = { ...items[0]!, id: 'malformed', status: 'typo' } as unknown as KnowledgeIndexItem;
  assert.deepEqual(filterKnowledge([...items, malformed], {}).map(({ id }) => id), ['model_jtbd', 'std_report']);
});

test('按 domain 召回(domain 为数组, includes 匹配)', () => {
  const hit = filterKnowledge(items, { domain: 'general' });
  assert.deepEqual(hit.map((i) => i.id), ['model_jtbd'], 'general 命中数组含 general 的条目, 排除 deprecated');
  const empty = filterKnowledge(items, { domain: '不存在的域' });
  assert.equal(empty.length, 0, '不存在的 domain 返回空集');
});
