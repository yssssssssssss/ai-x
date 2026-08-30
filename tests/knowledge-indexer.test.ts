import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeDerivedSkillRegistryEntries } from '../apps/orchestrator-runtime/src/knowledge/build.ts';
import { buildIndex } from '../apps/orchestrator-runtime/src/knowledge/indexer.ts';
import {
  getConfigRoot,
  type SkillRegistryEntry,
} from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';

const modelMd = [
  '---', 'id: model_jtbd', 'type: model', 'title: JTBD', 'domain: general',
  'tags: [需求框架, 用户目标]', 'guide_tags: [framework]', 'research_type: [定性]',
  'guide_stage: [need-discovery]', 'summary: 需求框架',
  'source: xingyun_wiki', 'source_path: models/jtbd.md',
  'content_hash: sha256:x', 'status: approved', 'updated_at: 2026-07-15', '---', '', '# JTBD',
].join('\n');

const assetMd = [
  '---', 'id: asset_logo', 'type: asset', 'title: Logo', 'domain: general',
  'source_path: assets/logo.md', 'content_hash: sha256:a', 'status: approved', '---', '', '# Logo',
].join('\n');

const skillMd = [
  '---', 'name: generate-research-plan', 'description: 生成完整调研方案',
  'type: skill', 'domain: general', 'tags: [method, output]',
  'task_types: [user_research_planning]', 'inputs: [research_goal]', 'outputs: [research_plan]',
  'required_tools: [tavily-web-search]',
  'content_hash: sha256:y', 'status: approved', '---', '', '# 生成研究方案',
].join('\n');

test('candidate 状态保留在 Evaluation index，Skill candidate 只派生 draft', () => {
  const candidateKnowledge = modelMd
    .replace('id: model_jtbd', 'id: method_candidate')
    .replace('source_path: models/jtbd.md', 'source_path: methods/toolbox/analysis/design-strategy/candidate.md')
    .replace('status: approved', 'status: candidate');
  const candidateSkill = skillMd
    .replace('name: generate-research-plan', 'name: strategy-map-generation')
    .replace('status: approved', 'status: candidate');
  const { knowledge, skills } = buildIndex([
    { relPath: 'methods/toolbox/analysis/design-strategy/candidate.md', md: candidateKnowledge },
    { relPath: 'skills/strategy-map-generation/SKILL.md', md: candidateSkill },
  ]);

  assert.equal(knowledge[0]?.status, 'candidate');
  assert.equal(skills[0]?.status, 'draft');
});

test('知识索引拒绝缺失或未知状态，而不是默认批准', () => {
  const missingStatus = modelMd.replace('status: approved', '');
  const unknownStatus = modelMd.replace('status: approved', 'status: typo');
  assert.throws(
    () => buildIndex([{ relPath: 'models/jtbd.md', md: missingStatus }]),
    /invalid or missing status/u,
  );
  assert.throws(
    () => buildIndex([{ relPath: 'models/jtbd.md', md: unknownStatus }]),
    /invalid or missing status/u,
  );
});

test('知识条目进 knowledge 索引,skill 进 skills,asset 被排除', () => {
  const { knowledge, skills } = buildIndex([
    { relPath: 'models/jtbd.md', md: modelMd },
    { relPath: 'assets/logo.md', md: assetMd },
    { relPath: 'skills/generate-research-plan/SKILL.md', md: skillMd },
  ]);
  assert.equal(knowledge.length, 1, 'asset 不进 knowledge 索引');
  assert.equal(knowledge[0].id, 'model_jtbd');
  assert.deepEqual(knowledge[0].domain, ['general'], 'domain 规整为 string[]');
  assert.deepEqual(knowledge[0].guide_stage, ['need-discovery']);
  assert.deepEqual(knowledge[0].guide_tags, ['framework'], '受控 guide_tags 入索引');
  assert.deepEqual(knowledge[0].tags, ['需求框架', '用户目标'], 'wiki 原生 tags 保留');
  assert.deepEqual(knowledge[0].research_type, ['定性'], 'research_type 入索引');
  assert.ok(!knowledge.some((k) => k.id === 'asset_logo'), 'asset 被排除');

  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'generate-research-plan');
  assert.equal(skills[0].when_to_use, '生成完整调研方案', 'when_to_use ← description');
  assert.equal(skills[0].entry, 'knowledge-base/skills/generate-research-plan/SKILL.md');
  assert.deepEqual(skills[0].task_types, ['user_research_planning']);
  assert.deepEqual(skills[0].required_tools, ['tavily-web-search']);
  assert.equal(skills[0].status, 'active', 'approved → active');
});

test('compiled Contributor metadata is generated from each Skill frontmatter', () => {
  const fixtures = [
    ['generate-persona', 'orchestrator/skill-executions/generate-persona.yaml', 'persona'],
    ['jobs-to-be-done', 'orchestrator/skill-executions/jobs-to-be-done.yaml', 'jobs_to_be_done'],
    ['build-experience-metrics', 'orchestrator/skill-executions/build-experience-metrics.yaml', 'metrics'],
  ] as const;

  for (const [skillId, executionContract, contributionType] of fixtures) {
    const relPath = `skills/${skillId}/SKILL.md`;
    const { skills } = buildIndex([{
      relPath,
      md: readFileSync(join(getConfigRoot(), 'knowledge-base', relPath), 'utf8'),
    }]);
    assert.equal(skills[0]?.execution_mode, 'compiled', skillId);
    assert.equal(skills[0]?.execution_contract, executionContract, skillId);
    assert.deepEqual(skills[0]?.required_tools, ['tavily-web-search'], skillId);
    assert.deepEqual(skills[0]?.composition?.contribution_types, [contributionType], skillId);
    assert.deepEqual(skills[0]?.composition?.shareable_prerequisites, ['tavily-web-search'], skillId);
  }
});

test('KB build preserves registry-only runtime metadata as a durable overlay', () => {
  const generated = buildIndex([{
    relPath: 'skills/generate-research-plan/SKILL.md',
    md: skillMd,
  }]).skills;
  const existing: SkillRegistryEntry[] = [{
    ...generated[0]!,
    composition: {
      modes: ['standalone', 'contributor'],
      supported_outcomes: ['plan'],
      compatible_deliverables: ['research_plan'],
      required_input_roles: ['research_goal'],
      optional_input_roles: [],
    },
  }];

  const merged = mergeDerivedSkillRegistryEntries(generated, existing);
  assert.deepEqual(merged[0]?.composition, existing[0]?.composition);
  assert.equal(merged[0]?.when_to_use, '生成完整调研方案');
});
