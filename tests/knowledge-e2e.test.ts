import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchKnowledge, resolveSkill, listSkills } from '../apps/orchestrator-runtime/src/knowledge/index.ts';
import { loadDecisionGraph } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';

// 前置:已跑 npm run kb:import && npm run kb:build
test('每个决策节点的 related_tags 都能经 guide_tags 召回到条目', () => {
  const { nodes } = loadDecisionGraph();
  const empty: string[] = [];
  for (const n of nodes) {
    const tags = n.related_tags ?? [];
    if (tags.length === 0) continue;
    if (searchKnowledge({ guide_tags: tags }).length === 0) empty.push(n.key);
  }
  assert.deepEqual(empty, [], `这些节点召回为空(需补种子 guide_tag 或知识条目): ${empty.join(', ')}`);
});

test('resolveSkill 能定位 generate-research-plan', () => {
  const r = resolveSkill('generate-research-plan');
  assert.ok(r, 'generate-research-plan 应可定位');
  assert.match(r!.path, /generate-research-plan/);
});

// registry 合并两类能力:18 个 wiki KB skill(v16 快照 user-research/skills/*/SKILL.md)
// + 2 个编排器原生 skill(skills/*, 带 JSON schema)= 20 active。
// brief 预估的 21 为估算值(knowledge 亦估 ~114 实为 104);此处以实际全量数作为下限。
test('listSkills 覆盖 KB + 原生全部 skill(≥20 active)', () => {
  assert.ok(listSkills().length >= 20, `实际 ${listSkills().length}`);
});

test('每个 active skill 的 task_types 非空(router 可路由)', () => {
  const bad = listSkills().filter((s) => !(s.task_types ?? []).length).map((s) => s.name);
  assert.deepEqual(bad, [], `这些 skill task_types 为空: ${bad.join(', ')}`);
});
