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

test('explicit answer signals recover an incorrectly competitive model classification', () => {
  const misclassified: ResearchTaskV2 = {
    ...requirement(),
    task_type: 'competitive_research',
    expected_deliverables: ['competitive_analysis_report'],
    blocking_issues: [{
      key: 'public-access',
      kind: 'data_access_and_reproducibility_risk',
      reason: '公开页面可能变化或需要登录，从而影响复现。',
    }, {
      key: 'platform-terms',
      kind: 'compliance_and_authorization_risk',
      reason: '若需自动化抓取或访问登录后内容，可能存在授权风险。',
    }],
  };
  const value = normalizeOutcomeRequirement(
    misclassified,
    '请直接基于2025—2026年公开可访问资料回答，并输出策略地图、心智模型和优先行动。',
    null,
  );
  assert.equal(value.task_type, 'research_synthesis');
  assert.equal(value.outcome_mode, 'answer');
  assert.deepEqual(value.expected_deliverables, ['research_strategy_report']);
  assert.deepEqual(value.requested_artifacts, ['strategy_map', 'mind_model', 'prioritized_actions']);
  assert.deepEqual(value.blocking_issues, []);
  assert.deepEqual(value.clarification_questions, []);
});

test('public-only normalization keeps real access blockers instead of hiding them', () => {
  const blocked: ResearchTaskV2 = {
    ...requirement(),
    task_type: 'competitive_research',
    expected_deliverables: ['competitive_analysis_report'],
    pii_detected: false,
    blocking_issues: [{
      key: 'actual-private-data',
      kind: 'authorization_compliance',
      reason: '当前需求明确包含未授权的内部交易明细，不能执行。',
    }],
  };
  const value = normalizeOutcomeRequirement(
    blocked,
    '请直接基于公开可访问资料回答并输出策略地图。',
    null,
  );
  assert.equal(value.task_type, 'research_synthesis');
  assert.equal(value.blocking_issues.length, 1);
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
