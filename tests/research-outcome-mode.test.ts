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

test('mixed intent is gated independently of an incorrect model task type', () => {
  const misclassified: ResearchTaskV2 = {
    ...requirement(),
    task_type: 'competitive_research',
    expected_deliverables: ['competitive_analysis_report'],
  };
  const value = normalizeOutcomeRequirement(
    misclassified,
    'Create a research plan and give direct answers with a strategy map.',
    null,
  );
  assert.equal(value.outcome_mode, undefined);
  assert.equal(value.clarification_questions[0]?.key, 'outcome_mode');

  const selected = normalizeOutcomeRequirement(misclassified, '创建调研任务并给出策略地图', { outcome_mode: 'plan' });
  assert.equal(selected.task_type, 'user_research_planning');
  assert.deepEqual(selected.expected_deliverables, ['research_plan']);
});

test('English plan and direct-answer signals normalize deterministically', () => {
  const plan = normalizeOutcomeRequirement(requirement(), 'Design a research plan and interview schedule.', null);
  assert.equal(plan.outcome_mode, 'plan');
  const answer = normalizeOutcomeRequirement(requirement(), 'Give a direct answer, strategy map, and prioritized actions.', null);
  assert.equal(answer.outcome_mode, 'answer');
  assert.equal(answer.task_type, 'research_synthesis');
  assert.deepEqual(answer.requested_artifacts, ['strategy_map', 'prioritized_actions']);
});

test('answer mode converts unresolved scope questions into provisional-answer obligations', () => {
  const unresolved = requirement();
  unresolved.ambiguities = [{ id: 'audience', statement: 'Audience detail is unavailable', blocking: true }];
  unresolved.clarification_questions = [{ key: 'audience', question: 'Which audience?', rationale: 'Scope precision' }];
  const answer = normalizeOutcomeRequirement(unresolved, 'Give direct findings and prioritized actions.', null);
  assert.equal(answer.outcome_mode, 'answer');
  assert.deepEqual(answer.clarification_questions, []);
  assert.deepEqual(answer.ambiguities, [{ id: 'audience', statement: 'Audience detail is unavailable', blocking: false }]);
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
