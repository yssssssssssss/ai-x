import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lintRegistries } from '../harness/linters/registry-linter.ts';
import { setConfigRoot, getConfigRoot, type SkillRegistryEntry } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';

// P0-03 验收:registry-linter 能拦截 缺字段 / 高风险无 approver / decision 缺 tier。
// 每个用例在临时 fixture 根构造配置,setConfigRoot 指过去。

const realRoot = getConfigRoot();
afterEach(() => setConfigRoot(realRoot));

function fixtureRoot(files: {
  decisionGraph: string;
  skillRegistry: string;
  toolRegistry: string;
  toolManifests?: Record<string, string>; // relPath -> yaml
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'reg-lint-'));
  mkdirSync(join(dir, 'orchestrator'), { recursive: true });
  writeFileSync(join(dir, 'orchestrator', 'decision-graph.yaml'), files.decisionGraph);
  writeFileSync(join(dir, 'orchestrator', 'skill-registry.yaml'), files.skillRegistry);
  writeFileSync(join(dir, 'orchestrator', 'tool-registry.yaml'), files.toolRegistry);
  for (const [rel, content] of Object.entries(files.toolManifests ?? {})) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

const emptySkills = 'version: 1\nskills: []\n';
const emptyTools = 'version: 1\ntools: []\n';
const goodGraph =
  'version: 1\nnodes:\n  - key: D1\n    question: q\n    applies_to: [competitive_research]\n    tier: core\n';

test('active skill 缺 owner 被拒', () => {
  const dir = fixtureRoot({
    decisionGraph: goodGraph,
    toolRegistry: emptyTools,
    skillRegistry:
      'version: 1\nskills:\n  - id: s1\n    name: n\n    path: skills/x/SKILL.md\n    when_to_use: w\n    status: active\n    input_schema: a.json\n    output_schema: b.json\n    risk_level: low\n',
  });
  setConfigRoot(dir);
  const issues = lintRegistries();
  rmSync(dir, { recursive: true, force: true });
  assert.ok(issues.some((i) => i.message.includes('owner')), '应报缺 owner');
});

test('active native skill requires non-empty task/input/output arrays and a required_tools array', () => {
  const dir = fixtureRoot({
    decisionGraph: goodGraph,
    toolRegistry: emptyTools,
    skillRegistry:
      'version: 1\nskills:\n  - id: s1\n    name: n\n    path: skills/x/SKILL.md\n    when_to_use: w\n    owner: o\n    status: active\n    task_types: competitive_research\n    inputs: research_goal\n    outputs: {}\n    required_tools: tool-1\n    risk_level: low\n',
  });
  setConfigRoot(dir);
  const issues = lintRegistries();
  rmSync(dir, { recursive: true, force: true });

  for (const field of ['task_types', 'inputs', 'outputs', 'required_tools']) {
    assert.ok(issues.some((issue) => issue.message.includes(field)), `应报 ${field} 非数组`);
  }
});

test('draft skill 缺字段不拦(不参与自动路由)', () => {
  const dir = fixtureRoot({
    decisionGraph: goodGraph,
    toolRegistry: emptyTools,
    skillRegistry: 'version: 1\nskills:\n  - id: s1\n    name: n\n    status: draft\n',
  });
  setConfigRoot(dir);
  const issues = lintRegistries();
  rmSync(dir, { recursive: true, force: true });
  assert.equal(issues.filter((i) => i.target.startsWith('skill:')).length, 0);
});

test('active Skill 必须使用存在的统一输出信封与存在的 payload schema', () => {
  const dir = fixtureRoot({
    decisionGraph: goodGraph,
    toolRegistry: emptyTools,
    skillRegistry: `version: 1
skills:
  - id: missing-output
    name: missing-output
    path: knowledge-base/skills/missing-output
    when_to_use: test
    owner: test
    status: active
    task_types: [competitive_research]
    risk_level: low
  - id: wrong-output
    name: wrong-output
    path: knowledge-base/skills/wrong-output
    when_to_use: test
    owner: test
    status: active
    task_types: [competitive_research]
    output_schema: schemas/wrong.json
    risk_level: low
  - id: missing-payload
    name: missing-payload
    path: knowledge-base/skills/missing-payload
    when_to_use: test
    owner: test
    status: active
    task_types: [competitive_research]
    output_schema: schemas/skill-result-envelope.schema.json
    payload_schema: schemas/missing-payload.json
    risk_level: low
`,
    toolManifests: {
      'schemas/wrong.json': '{}',
      'schemas/skill-result-envelope.schema.json': '{}',
    },
  });
  setConfigRoot(dir);
  const issues = lintRegistries();
  rmSync(dir, { recursive: true, force: true });

  assert.ok(issues.some((issue) => issue.target === 'skill:missing-output' && issue.message.includes('output_schema')));
  assert.ok(issues.some((issue) => issue.target === 'skill:wrong-output' && issue.message.includes('统一 output_schema')));
  assert.ok(issues.some((issue) => issue.target === 'skill:missing-payload' && issue.message.includes('payload_schema 不存在')));
});

test('高风险 tool 无 approver_rule 被拒', () => {
  const dir = fixtureRoot({
    decisionGraph: goodGraph,
    skillRegistry: emptySkills,
    toolRegistry:
      'version: 1\ntools:\n  - id: t1\n    name: n\n    path: tools/t1/manifest.yaml\n    adapter_type: o2\n    auth_required: true\n    risk_level: high\n    status: active\n',
    toolManifests: {
      'tools/t1/manifest.yaml':
        'id: t1\nname: n\nadapter_type: o2\nauth_required: true\nrisk_level: high\napprover_rule: none\ninput_schema: a.json\noutput_schema: b.json\n',
    },
  });
  setConfigRoot(dir);
  const issues = lintRegistries();
  rmSync(dir, { recursive: true, force: true });
  assert.ok(issues.some((i) => i.message.includes('approver_rule')), '应报高风险缺 approver_rule');
});

test('decision node 缺 tier 被拒', () => {
  const dir = fixtureRoot({
    decisionGraph: 'version: 1\nnodes:\n  - key: D1\n    question: q\n    applies_to: [competitive_research]\n',
    skillRegistry: emptySkills,
    toolRegistry: emptyTools,
  });
  setConfigRoot(dir);
  const issues = lintRegistries();
  rmSync(dir, { recursive: true, force: true });
  assert.ok(issues.some((i) => i.message.includes('tier')), '应报缺 tier');
});

test('KB Skill 无 input schema 但必须声明统一 output schema', () => {
  const kbSkill: SkillRegistryEntry = {
    id: 'generate-research-plan',
    name: 'generate-research-plan',
    path: 'knowledge-base/skills/generate-research-plan',
    entry: 'knowledge-base/skills/generate-research-plan/SKILL.md',
    when_to_use: '生成完整调研方案',
    owner: '用研团队',
    risk_level: 'low',
    task_types: ['user_research_planning'],
    output_schema: 'schemas/skill-result-envelope.schema.json',
    status: 'active',
  };
  assert.equal(kbSkill.input_schema, undefined);
  assert.equal(kbSkill.output_schema, 'schemas/skill-result-envelope.schema.json');
  assert.equal(kbSkill.status, 'active');
});
