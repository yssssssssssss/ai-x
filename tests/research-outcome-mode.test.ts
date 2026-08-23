import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import { normalizeOutcomeRequirement } from '../apps/orchestrator-runtime/src/control/requirement-refinement-service.ts';

function requirement(): ResearchTaskV2 {
  return { version: 'research-task-v2', task_type: 'user_research_planning', business_domain: 'pets', research_goal: 'pet strategy', target_audience: ['team'], scope: ['pets'], constraints: [], success_criteria: [{ id: 'SC1', statement: 'useful result' }], expected_deliverables: ['research_plan'], assumptions: [], ambiguities: [], clarification_questions: [], blocking_issues: [], sensitivity: 'internal', pii_detected: false };
}

test('ambiguous plan plus answer request requires an explicit outcome choice', () => {
  const value = normalizeOutcomeRequirement(requirement(), '创建一个调研任务，输出策略地图、心智模型和机会点', null);
  assert.equal(value.outcome_mode, undefined);
  assert.equal(value.clarification_questions[0]?.key, 'outcome_mode');
  assert.deepEqual(value.requested_artifacts, ['strategy_map', 'mind_model', 'opportunity_backlog']);
});

test('answer selection freezes research_synthesis and strategy-report artifacts', () => {
  const value = normalizeOutcomeRequirement(requirement(), '创建一个调研任务，输出策略地图和设计原则', { outcome_mode: 'answer' });
  assert.equal(value.task_type, 'research_synthesis');
  assert.equal(value.outcome_mode, 'answer');
  assert.deepEqual(value.expected_deliverables, ['research_strategy_report']);
  assert.deepEqual(value.requested_artifacts, ['strategy_map', 'design_principles']);
  assert.equal(value.clarification_questions.some(({ key }) => key === 'outcome_mode'), false);
});

test('planning request remains a research plan', () => {
  const value = normalizeOutcomeRequirement(requirement(), '帮我制定研究方案和访谈样本排期', null);
  assert.equal(value.task_type, 'user_research_planning');
  assert.equal(value.outcome_mode, 'plan');
  assert.deepEqual(value.expected_deliverables, ['research_plan']);
});
