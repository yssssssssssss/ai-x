import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import { resolveExplicitDirectInvoke } from '../apps/orchestrator-runtime/src/planners/research-planning-service.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';

const task: ResearchTaskV2 = {
  version: 'research-task-v2', task_type: 'research_synthesis', outcome_mode: 'answer',
  requested_artifacts: ['strategy_map', 'mind_model', 'design_principles', 'opportunity_backlog', 'prioritized_actions'],
  business_domain: 'pet food', research_goal: 'directly answer pet mind strategy',
  target_audience: ['pet owners'], scope: ['purchase journey'], constraints: [],
  success_criteria: [{ id: 'SC1', statement: 'direct answers and actions' }],
  expected_deliverables: ['research_strategy_report'], assumptions: [], ambiguities: [],
  clarification_questions: [], blocking_issues: [], sensitivity: 'internal', pii_detected: false,
};

test('ordinary research synthesis is routed and only explicit $skill syntax uses direct invoke', () => {
  assert.equal(resolveExplicitDirectInvoke(task.research_goal), null);
  assert.deepEqual(
    resolveExplicitDirectInvoke(`$research-strategy-synthesis ${task.research_goal}`),
    { skillName: 'research-strategy-synthesis', rest: task.research_goal },
  );
});

test('research strategy Skill freezes one native package invocation without hidden compiled stages', () => {
  const runSpec = new SkillLoader().loadNativeRunSpec('research-strategy-synthesis');
  assert.equal(runSpec.skill_id, 'research-strategy-synthesis');
  assert.match(runSpec.package_hash, /^sha256:/u);
  assert.match(runSpec.body, /Research Strategy Synthesis/u);
  assert.equal(runSpec.files.some(({ path }) => path === 'SKILL.md'), true);
  assert.equal(runSpec.report_policy.kind, 'default_llm');
});
