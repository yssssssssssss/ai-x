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
  assert.equal(value.task_type, 'user_research_planning');
  assert.deepEqual(value.expected_deliverables, ['research_plan']);
  assert.equal(value.clarification_questions[0]?.key, 'outcome_mode');
  assert.deepEqual(value.requested_artifacts, ['strategy_map', 'mind_model', 'opportunity_backlog']);
});

test('ambiguous outcome repairs an inconsistent model task and deliverable before persistence', () => {
  const inconsistent: ResearchTaskV2 = {
    ...requirement(),
    task_type: 'research_synthesis',
    expected_deliverables: ['competitive_analysis_report'],
    requested_artifacts: ['strategy_map', 'mind_model', 'design_principles', 'opportunity_backlog', 'prioritized_actions'],
  };
  const value = normalizeOutcomeRequirement(
    inconsistent,
    '创建一个调研任务，核心解决宠物心智的设计表达策略全景，包含全链路业务品牌心智、品类特色心智、场域心智策略。',
    null,
  );
  assert.equal(value.outcome_mode, undefined);
  assert.equal(value.task_type, 'user_research_planning');
  assert.deepEqual(value.expected_deliverables, ['research_plan']);
  assert.equal(value.clarification_questions[0]?.key, 'outcome_mode');
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
  assert.equal(value.task_type, 'user_research_planning');
  assert.deepEqual(value.expected_deliverables, ['research_plan']);
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

test('a generic direct-answer request is not trapped by an unsupported competitive model guess', () => {
  const misclassified: ResearchTaskV2 = {
    ...requirement(),
    task_type: 'competitive_research',
    expected_deliverables: ['宠物食品电商推广调研报告'],
  };
  const value = normalizeOutcomeRequirement(
    misclassified,
    '我想做一个关于“宠物食品在电商应该怎么做推广的调研”',
    null,
  );
  assert.equal(value.task_type, 'research_synthesis');
  assert.equal(value.outcome_mode, 'answer');
  assert.deepEqual(value.expected_deliverables, ['research_strategy_report']);
});

test('a direct-answer signal does not override an explicit competitive research request', () => {
  const competitive: ResearchTaskV2 = {
    ...requirement(),
    task_type: 'competitive_research',
    expected_deliverables: ['宠物品牌推广研究'],
  };
  const value = normalizeOutcomeRequirement(
    competitive,
    '请对比皇家和渴望的电商推广打法，并告诉我应该怎么做差异化推广。',
    null,
  );
  assert.equal(value.task_type, 'competitive_research');
  assert.equal(value.outcome_mode, 'answer');
});

test('conflicting competitive and strategy-report signals require a deliverable choice', () => {
  const competitive: ResearchTaskV2 = {
    ...requirement(),
    task_type: 'competitive_research',
    expected_deliverables: ['competitive_analysis_report'],
  };
  const unresolved = normalizeOutcomeRequirement(
    competitive,
    '请对比皇家和渴望两个品牌，并输出策略地图和心智模型。',
    null,
  );
  assert.equal(unresolved.task_type, 'competitive_research');
  assert.equal(unresolved.outcome_mode, 'answer');
  assert.equal(unresolved.clarification_questions[0]?.key, 'deliverable_intent');

  const selected = normalizeOutcomeRequirement(
    competitive,
    '请对比皇家和渴望两个品牌，并输出策略地图和心智模型。',
    { deliverable_intent: 'research_strategy_report' },
  );
  assert.equal(selected.task_type, 'research_synthesis');
  assert.equal(selected.outcome_mode, 'answer');
  assert.deepEqual(selected.expected_deliverables, ['research_strategy_report']);
  assert.equal(selected.clarification_questions.some(({ key }) => key === 'deliverable_intent'), false);
});

test('a deliverable choice resolves only outcome ambiguity and preserves unrelated blockers', () => {
  const generated: ResearchTaskV2 = {
    ...requirement(),
    task_type: 'competitive_research',
    expected_deliverables: ['competitive_analysis_report'],
    ambiguities: [{
      id: 'outcome-mode',
      statement: '未明确需要研究方案（plan）还是直接研究结论（answer）。',
      blocking: true,
    }, {
      id: 'market-scope',
      statement: '未明确对比中国市场还是全球市场。',
      blocking: true,
    }],
    clarification_questions: [{
      key: 'outcome_mode',
      question: '需要方案还是结论？',
      rationale: '决定交付类型。',
    }, {
      key: 'market_scope',
      question: '对比哪个市场？',
      rationale: '决定证据范围。',
    }],
  };

  const selected = normalizeOutcomeRequirement(
    generated,
    '请对比皇家和渴望两个品牌，并输出策略地图和心智模型。',
    { deliverable_intent: 'research_strategy_report' },
  );

  assert.equal(selected.ambiguities[0]?.blocking, false);
  assert.equal(selected.ambiguities[1]?.blocking, true);
  assert.deepEqual(selected.clarification_questions.map(({ key }) => key), ['market_scope']);
});

test('strategy artifact words do not turn other explicit specialist audits into competitor choices', () => {
  for (const specialist of [
    { taskType: 'voc_diagnosis', input: '请分析用户反馈并输出策略地图。' },
    { taskType: 'design_audit', input: '请做一次设计走查并输出策略地图。' },
    { taskType: 'a11y_audit', input: '请做一次无障碍审计并输出策略地图。' },
  ] as const) {
    const normalized = normalizeOutcomeRequirement(
      {
        ...requirement(),
        task_type: specialist.taskType,
      },
      specialist.input,
      null,
    );

    assert.equal(normalized.task_type, specialist.taskType);
    assert.equal(
      normalized.clarification_questions.some(({ key }) => key === 'deliverable_intent'),
      false,
    );
  }
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
