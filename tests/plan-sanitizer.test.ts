import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCandidateToPlan } from '../apps/orchestrator-runtime/src/planners/plan-sanitizer.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import type { PlanCandidate } from '../apps/orchestrator-runtime/src/plan-types.ts';

// sanitizeCandidateToPlan 是 LLM 漂移防线:候选阶段 schema 不严格,真实 LLM 输出常带脏字段。
// 每条 test 钉死一种漂移形态 → 干净 plan 的映射契约。脏候选用 as unknown 构造(违反 TS 类型正是被测场景)。
const dirty = (steps: unknown[], assumptions: unknown[] = []): PlanCandidate =>
  ({ id: 'depth', title: 't', rationale: 'r', tradeoffs: 'tr', activated_nodes: ['D1'], steps, assumptions } as unknown as PlanCandidate);

// --- cleanStep 6 条分支 ---

test('step_no 一律用数组顺序,覆盖 LLM 给的乱序/重复编号', () => {
  const plan = sanitizeCandidateToPlan(
    dirty([
      { step_no: 99, step_name: 'a', actor_type: 'tool', actor_id: 'x' },
      { step_no: 99, step_name: 'b', actor_type: 'tool', actor_id: 'y' },
    ]),
    't1', 'competitive_research',
  );
  assert.deepEqual(plan.steps.map((s) => s.step_no), [1, 2]);
});

test('step_name 缺失时回落 actor_id', () => {
  const plan = sanitizeCandidateToPlan(
    dirty([{ actor_type: 'tool', actor_id: 'o2-web-search' }]),
    't1', 'x',
  );
  assert.equal(plan.steps[0].step_name, 'o2-web-search');
});

test('step_name 与 actor_id 双缺时回落「步骤 N」', () => {
  const plan = sanitizeCandidateToPlan(
    dirty([{ actor_type: 'tool', actor_id: '' }]),
    't1', 'x',
  );
  assert.equal(plan.steps[0].step_name, '步骤 1');
});

test('input 非纯对象(字符串/数组/null)一律丢弃', () => {
  const plan = sanitizeCandidateToPlan(
    dirty([
      { step_name: 'a', actor_type: 'tool', actor_id: 'x', input: 'not-an-object' },
      { step_name: 'b', actor_type: 'tool', actor_id: 'y', input: ['arr'] },
      { step_name: 'c', actor_type: 'tool', actor_id: 'z', input: null },
      { step_name: 'd', actor_type: 'tool', actor_id: 'w', input: { query: 'ok' } },
    ]),
    't1', 'x',
  );
  assert.equal('input' in plan.steps[0], false);
  assert.equal('input' in plan.steps[1], false);
  assert.equal('input' in plan.steps[2], false);
  assert.deepEqual(plan.steps[3].input, { query: 'ok' });
});

test('requires_approval 非 boolean 丢弃,boolean 保留', () => {
  const plan = sanitizeCandidateToPlan(
    dirty([
      { step_name: 'a', actor_type: 'tool', actor_id: 'x', requires_approval: 'yes' },
      { step_name: 'b', actor_type: 'tool', actor_id: 'y', requires_approval: true },
    ]),
    't1', 'x',
  );
  assert.equal('requires_approval' in plan.steps[0], false);
  assert.equal(plan.steps[1].requires_approval, true);
});

test('purpose 非 string 丢弃,string 保留', () => {
  const plan = sanitizeCandidateToPlan(
    dirty([
      { step_name: 'a', actor_type: 'tool', actor_id: 'x', purpose: 123 },
      { step_name: 'b', actor_type: 'tool', actor_id: 'y', purpose: '检索竞品' },
    ]),
    't1', 'x',
  );
  assert.equal('purpose' in plan.steps[0], false);
  assert.equal(plan.steps[1].purpose, '检索竞品');
});

test('step_id 等 schema 外非法字段被丢弃(否则 additionalProperties:false 炸)', () => {
  const plan = sanitizeCandidateToPlan(
    dirty([{ step_id: 'abc', step_name: 'a', actor_type: 'tool', actor_id: 'x', extra: 1 }]),
    't1', 'x',
  );
  assert.deepEqual(Object.keys(plan.steps[0]).sort(), ['actor_id', 'actor_type', 'step_name', 'step_no']);
});

// --- cleanAssumption 3 态 ---

test('assumption 为 string 时归一为 {key:假设N, value, editable:true}', () => {
  const plan = sanitizeCandidateToPlan(
    dirty([{ step_name: 'a', actor_type: 'tool', actor_id: 'x' }], ['默认头部 3 家竞品']),
    't1', 'x',
  );
  assert.deepEqual(plan.assumptions[0], { key: '假设 1', value: '默认头部 3 家竞品', editable: true });
});

test('assumption 对象别名归一(name→key, description/assumption→value)', () => {
  const plan = sanitizeCandidateToPlan(
    dirty([{ step_name: 'a', actor_type: 'tool', actor_id: 'x' }], [
      { name: '样本量', description: '5-8 家' },
      { assumption: '仅国内市场' },
    ]),
    't1', 'x',
  );
  assert.deepEqual(plan.assumptions[0], { key: '样本量', value: '5-8 家', editable: true });
  assert.deepEqual(plan.assumptions[1], { key: '假设 2', value: '仅国内市场', editable: true });
});

test('assumption 全缺 key/value 时 value 回落 JSON.stringify', () => {
  const plan = sanitizeCandidateToPlan(
    dirty([{ step_name: 'a', actor_type: 'tool', actor_id: 'x' }], [{ foo: 'bar' }]),
    't1', 'x',
  );
  assert.equal(plan.assumptions[0].key, '假设 1');
  assert.equal(plan.assumptions[0].value, JSON.stringify({ foo: 'bar' }));
  assert.equal(plan.assumptions[0].editable, true);
});

// --- happy path + schema 契约 ---

test('happy path:规整候选转换后逐字段等价', () => {
  const plan = sanitizeCandidateToPlan(
    dirty([{ step_no: 1, step_name: '竞品检索', actor_type: 'tool', actor_id: 'o2-web-search', purpose: 'p', input: { query: 'q' }, requires_approval: false }]),
    't1', 'competitive_research',
  );
  assert.deepEqual(plan, {
    task_id: 't1',
    task_type: 'competitive_research',
    steps: [{ step_no: 1, step_name: '竞品检索', actor_type: 'tool', actor_id: 'o2-web-search', purpose: 'p', input: { query: 'q' }, requires_approval: false }],
    activated_nodes: ['D1'],
    assumptions: [],
  });
});

test('产出必过 execution-plan schema(即便输入全是脏数据)', () => {
  const v = new SchemaValidator();
  const plan = sanitizeCandidateToPlan(
    dirty([
      { step_id: 'x', step_no: 42, actor_type: 'tool', actor_id: 'o2-web-search', input: 'bad', purpose: 9 },
    ], ['字符串假设', { name: 'k', description: 'v' }]),
    't1', 'competitive_research',
  );
  assert.deepEqual(v.validate('execution-plan', plan), []);
});
