import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

// P0-03 验收:样例过校验;非法结构被拒。
const v = new SchemaValidator();

test('ResearchTask 合法样例通过校验', () => {
  const valid = {
    task_type: 'competitive_research',
    business_domain: 'live_commerce',
    research_goal: '了解直播场域数字人竞品的能力与体验差异',
    assumptions: [{ key: 'competitors', value: '默认头部 3 家', editable: true }],
    confirmations: [{ key: 'sample_size', question: '样本规模?', suggestion: '5-8 家' }],
    blocking_issues: [],
    sensitivity: 'internal',
    pii_detected: false,
  };
  assert.deepEqual(v.validate('research-task', valid), []);
});

test('ResearchTask 非法 task_type 被拒', () => {
  const bad = {
    task_type: 'not_a_real_type',
    business_domain: 'x',
    research_goal: 'y',
    assumptions: [], confirmations: [], blocking_issues: [],
    sensitivity: 'internal', pii_detected: false,
  };
  assert.ok(v.validate('research-task', bad).length > 0);
});

test('DecisionState 6 态枚举生效', () => {
  const ok = { node_key: 'D5_competitive', state: 'need_execute', reason: '用户提到竞品', final_state: 'need_execute' };
  assert.deepEqual(v.validate('decision-state', ok), []);
  const bad = { ...ok, state: 'unknown_state' };
  assert.ok(v.validate('decision-state', bad).length > 0);
});

test('ExecutionPlan 至少一步且步骤字段完整', () => {
  const ok = {
    task_id: 't1', task_type: 'competitive_research',
    steps: [{ step_no: 1, step_name: '竞品检索', actor_type: 'tool', actor_id: 'o2-web-search' }],
    activated_nodes: ['D1_research_goal'],
    assumptions: [],
  };
  assert.deepEqual(v.validate('execution-plan', ok), []);
  const noSteps = { ...ok, steps: [] };
  assert.ok(v.validate('execution-plan', noSteps).length > 0);
});

test('ResearchReport 新结构:子问题 + 带 id 发现 + based_on 分析通过校验', () => {
  const ok = {
    task_id: 't1', research_goal: 'g', method_summary: '通过公开检索 + 竞品分析方法综合',
    findings: [
      { id: 'F1', statement: '结论A', source: 'tool_result', source_ref: 'run/x' },
      { id: 'F2', statement: '结论B', source: 'knowledge_base', source_ref: 'kb/y' },
    ],
    sub_questions: [
      {
        question: '竞品实时互动能力如何?',
        finding_ids: ['F1'],
        analysis: [{ statement: '实时性普遍是短板', based_on: ['F1', 'F2'] }],
        summary: '实时互动待突破',
      },
    ],
    overall_conclusion: ['建议优先补齐实时互动'],
    timeline: [{ phase: 'W28', activity: '竞品检索' }],
    deliverables: ['研究报告'],
    capability_orchestration: [{ capability_id: 'o2-web-search', capability_type: 'tool', purpose: '检索' }],
  };
  assert.deepEqual(v.validate('research-report', ok), []);
  // 缺 source 的 finding 被拒(回归)
  const badSource = { ...ok, findings: [{ id: 'F1', statement: '无来源结论' }] };
  assert.ok(v.validate('research-report', badSource).length > 0);
  // 缺 id 的 finding 被拒
  const badNoId = { ...ok, findings: [{ statement: '无 id 结论', source: 'tool_result' }] };
  assert.ok(v.validate('research-report', badNoId).length > 0);
});

test('ResearchReport based_on 引用不存在的发现 id 被拒(引用完整性)', () => {
  const bad = {
    task_id: 't1', research_goal: 'g', method_summary: 'm',
    findings: [{ id: 'F1', statement: '结论A', source: 'tool_result' }],
    sub_questions: [
      { question: 'q', finding_ids: ['F1'], analysis: [{ statement: 'a', based_on: ['F9'] }], summary: 's' },
    ],
    overall_conclusion: ['c'],
    timeline: [{ phase: 'W28', activity: '检索' }],
    deliverables: ['报告'],
    capability_orchestration: [{ capability_id: 't', capability_type: 'tool', purpose: 'p' }],
  };
  const errs = v.validate('research-report', bad);
  assert.ok(errs.some((e) => e.includes('F9')), `应报告 F9 引用不存在,实得: ${errs.join('; ')}`);
});

test('ResearchReport finding_ids 引用不存在的发现 id 被拒(引用完整性)', () => {
  const bad = {
    task_id: 't1', research_goal: 'g', method_summary: 'm',
    findings: [{ id: 'F1', statement: '结论A', source: 'tool_result' }],
    sub_questions: [
      { question: 'q', finding_ids: ['F2'], analysis: [{ statement: 'a', based_on: ['F1'] }], summary: 's' },
    ],
    overall_conclusion: ['c'],
    timeline: [{ phase: 'W28', activity: '检索' }],
    deliverables: ['报告'],
    capability_orchestration: [{ capability_id: 't', capability_type: 'tool', purpose: 'p' }],
  };
  assert.ok(v.validate('research-report', bad).some((e) => e.includes('F2')));
});

test('validateOrThrow 不合规时抛 SchemaValidationError', () => {
  assert.throws(() => v.validateOrThrow('research-task', {}), /validation failed/);
});
