import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from '../apps/orchestrator-runtime/src/knowledge/indexer.ts';

const modelMd = [
  '---', 'id: model_jtbd', 'type: model', 'title: JTBD', 'domain: general',
  'tags: [framework]', 'guide_stage: [need-discovery]', 'summary: 需求框架',
  'source: xingyun_wiki', 'source_path: models/jtbd.md',
  'content_hash: sha256:x', 'status: approved', 'updated_at: 2026-07-15', '---', '', '# JTBD',
].join('\n');

const skillMd = [
  '---', 'name: generate-research-plan', 'description: 生成完整调研方案',
  'type: skill', 'domain: general', 'tags: [method, output]',
  'task_types: [user_research_planning]', 'inputs: [research_goal]', 'outputs: [research_plan]',
  'content_hash: sha256:y', 'status: approved', '---', '', '# 生成研究方案',
].join('\n');

test('知识条目进 knowledge 索引,skill 进 skills', () => {
  const { knowledge, skills } = buildIndex([
    { relPath: 'models/jtbd.md', md: modelMd },
    { relPath: 'skills/generate-research-plan/SKILL.md', md: skillMd },
  ]);
  assert.equal(knowledge.length, 1);
  assert.equal(knowledge[0].id, 'model_jtbd');
  assert.deepEqual(knowledge[0].guide_stage, ['need-discovery']);

  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'generate-research-plan');
  assert.equal(skills[0].when_to_use, '生成完整调研方案', 'when_to_use ← description');
  assert.equal(skills[0].entry, 'knowledge-base/skills/generate-research-plan/SKILL.md');
  assert.deepEqual(skills[0].task_types, ['user_research_planning']);
  assert.equal(skills[0].status, 'active', 'approved → active');
});
