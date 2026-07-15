import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedTagsGuideStage, seedSkillTaskTypes } from '../apps/orchestrator-runtime/src/knowledge/seed.ts';
import { loadTaxonomy } from '../apps/orchestrator-runtime/src/knowledge/taxonomy.ts';

test('persona 文件种出 persona tag', () => {
  const r = seedTagsGuideStage('toolbox-collection', 'persona', '用户画像');
  assert.ok(r.tags.includes('persona'), `应含 persona, 实际 ${r.tags}`);
});

test('competitive 文件种出竞品 tag', () => {
  const r = seedTagsGuideStage('toolbox-analysis', 'competitive-analysis', '竞品分析');
  assert.ok(r.tags.includes('business-competitive') || r.tags.includes('ui-competitive'));
});

test('种出的 tags 全部在 taxonomy 内(归一)', () => {
  const { tags } = loadTaxonomy();
  const tagSet = new Set(tags);
  const r = seedTagsGuideStage('model', 'jtbd', 'JTBD');
  for (const t of r.tags) assert.ok(tagSet.has(t), `越界 tag: ${t}`);
});

test('model 落 need-discovery 阶段', () => {
  assert.deepEqual(seedTagsGuideStage('model', 'jtbd', 'JTBD').guide_stage, ['need-discovery']);
});

test('skill task_types 种子: competitive → competitive_research', () => {
  assert.deepEqual(seedSkillTaskTypes('competitive-analysis', '竞品分析'), ['competitive_research']);
});

test('skill task_types 兜底: generate-research-plan → user_research_planning', () => {
  assert.deepEqual(seedSkillTaskTypes('generate-research-plan', '生成研究方案'), ['user_research_planning']);
});
