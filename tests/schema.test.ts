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
    steps: [{ step_no: 1, step_name: '竞品检索', actor_type: 'tool', actor_id: 'tavily-web-search' }],
    activated_nodes: ['D1_research_goal'],
    assumptions: [],
  };
  assert.deepEqual(v.validate('execution-plan', ok), []);
  const noSteps = { ...ok, steps: [] };
  assert.ok(v.validate('execution-plan', noSteps).length > 0);
});

test('ResearchReport finding 必须带来源标注', () => {
  const ok = {
    task_id: 't1', research_goal: 'g',
    findings: [{ statement: '结论A', source: 'tool_result', source_ref: 'run/x' }],
    timeline: [{ phase: 'W28', activity: '竞品检索' }],
    deliverables: ['竞品对比报告'],
    capability_orchestration: [{ capability_id: 'tavily-web-search', capability_type: 'tool', purpose: '检索' }],
  };
  assert.deepEqual(v.validate('research-report', ok), []);
  // 缺 source 的 finding 被拒
  const bad = { ...ok, findings: [{ statement: '无来源结论' }] };
  assert.ok(v.validate('research-report', bad).length > 0);
});

test('validateOrThrow 不合规时抛 SchemaValidationError', () => {
  assert.throws(() => v.validateOrThrow('research-task', {}), /validation failed/);
});
