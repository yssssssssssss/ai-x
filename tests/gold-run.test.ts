import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlanCandidate } from '../packages/api-contract/plan.ts';
import type { Report } from '../packages/api-contract/http.ts';
import {
  forceRealEnv,
  assertNoApprovalStep,
  writeRunAudit,
  pausedFailureIsInfra,
  pausedFailureIsOptionalTool,
  pausedFailureMsg,
  optionalToolIdSet,
} from '../apps/orchestrator-runtime/src/gold-run.ts';
import type { GoldRunRecord } from '../apps/orchestrator-runtime/src/audit/audit-package.ts';

function candidate(steps: PlanCandidate['steps']): PlanCandidate {
  return { id: 'depth', title: 't', rationale: 'r', tradeoffs: 'x', steps, assumptions: [], activated_nodes: [] };
}

test('ADR-0002:forceRealEnv 强制 gateway+real,不读 .env', () => {
  process.env.LLM_PROVIDER = 'mock';
  process.env.TOOL_ADAPTER = 'fake';
  forceRealEnv();
  assert.equal(process.env.LLM_PROVIDER, 'gateway');
  assert.equal(process.env.TOOL_ADAPTER, 'real');
});

test('ADR-0001:无审批步的计划自动放行', () => {
  const c = candidate([
    { step_no: 1, step_name: '检索', actor_type: 'tool', actor_id: 'tavily-web-search' },
    { step_no: 2, step_name: '分析', actor_type: 'skill', actor_id: 'competitive-analysis' },
  ]);
  assert.doesNotThrow(() => assertNoApprovalStep(c));
});

test('ADR-0001:命中审批步立即停(保留 HITL 闸门语义)', () => {
  const c = candidate([
    { step_no: 1, step_name: '检索', actor_type: 'tool', actor_id: 'tavily-web-search' },
    { step_no: 2, step_name: '敏感数据授权', actor_type: 'reviewer', actor_id: 'approval', requires_approval: true },
  ]);
  assert.throws(() => assertNoApprovalStep(c), /GOLD_APPROVAL_GATE/);
});

test('审计包落盘:报告 md/json + 模型元数据 + 评审表单;裁剪不含原始材料', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gold-audit-'));
  try {
    const report: Report = {
      research_goal: 'g', method_summary: 'm',
      findings: [{ id: 'F1', statement: '竞品 A 延迟 2s', source: 'tool_result', source_ref: 'https://a.example.com' }],
      sub_questions: [], overall_conclusion: ['c'], timeline: [], deliverables: [],
      capability_orchestration: [], risks_and_open_issues: [],
    };
    const rec: GoldRunRecord = {
      run_id: 'run-1', task_id: 't1', batch_id: 'b1', scenario_input: '固定输入',
      status: 'completed', report, model: { model_name: 'GPT-5.4-joybuilder', model_version: 'v0', trace_id: 'tr' },
      schema_valid: true, exec_log: [{ step_no: 1, actor_type: 'tool', actor_id: 'tavily-web-search', status: 'succeeded' }],
      started_at: 's', finished_at: 'f',
    };
    const runDir = join(dir, 'run-1');
    writeRunAudit(runDir, rec);

    assert.ok(existsSync(join(runDir, 'report.json')));
    assert.ok(existsSync(join(runDir, 'report.md')));
    assert.ok(existsSync(join(runDir, 'exec-log.json')));
    assert.ok(existsSync(join(runDir, 'model-meta.json')));
    assert.ok(existsSync(join(runDir, 'review-form.md')));

    const model = JSON.parse(readFileSync(join(runDir, 'model-meta.json'), 'utf8'));
    assert.equal(model.model_name, 'GPT-5.4-joybuilder');
    const form = readFileSync(join(runDir, 'review-form.md'), 'utf8');
    assert.match(form, /https:\/\/a\.example\.com/); // 来源核验矩阵含 URL
    assert.match(form, /- \[ \] 关键竞品事实可核验/); // 判定留空
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('无报告的运行也落审计包(评审表单说明不可评审)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gold-audit-'));
  try {
    const rec: GoldRunRecord = {
      run_id: 'run-2', task_id: 't2', batch_id: 'b1', scenario_input: '固定输入',
      status: 'failed', report: null, model: { model_name: 'GPT-5.4-joybuilder', model_version: 'v0' },
      schema_valid: false, exec_log: [], started_at: 's', finished_at: 'f',
    };
    const runDir = join(dir, 'run-2');
    writeRunAudit(runDir, rec);
    assert.ok(!existsSync(join(runDir, 'report.json'))); // 无报告不落
    assert.ok(existsSync(join(runDir, 'review-form.md')));
    assert.match(readFileSync(join(runDir, 'review-form.md'), 'utf8'), /无报告产出/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('optional tool 失败(ai-spider fetch failed)判为可跳过增强,不占 infra 重试名额', () => {
  // 方案 B 根因:ai-spider-search 是 optional(增强)tool,其后端 down 常呈 fetch failed。
  // 按能力分层应 skip 成缺口(报告仍产出),优先于 infra 文本判定。
  const optional = optionalToolIdSet();
  assert.ok(optional.has('ai-spider-search'), 'ai-spider-search 应为 optional tier');
  assert.ok(!optional.has('o2-web-search'), 'o2-web-search 应为 core tier');
  assert.ok(!optional.has('tavily-web-search'), 'tavily-web-search 应为 core tier');

  const state = { stepFailures: [{ stepNo: 6, actorType: 'tool', actorId: 'ai-spider-search', message: 'tool "ai-spider-search" 调用失败: fetch failed' }] };
  assert.equal(pausedFailureIsOptionalTool(state, optional), true, 'optional tool 失败应可跳过');
  assert.match(pausedFailureMsg(state), /fetch failed/);
});

test('core tool 失败(o2 fetch failed)判 infra、非可跳过:重试不占名额', () => {
  const optional = optionalToolIdSet();
  const state = { stepFailures: [{ stepNo: 3, actorType: 'tool', actorId: 'o2-web-search', message: 'tool "o2-web-search" 调用失败: fetch failed' }] };
  assert.equal(pausedFailureIsOptionalTool(state, optional), false, 'core tool 失败不可跳过');
  assert.equal(pausedFailureIsInfra(state), true, 'core 检索 fetch failed 判 infra 重试');
});

test('执行阶段 step 失败(网关 5xx)判 infra', () => {
  assert.equal(pausedFailureIsInfra({ stepFailures: [{ message: '网关返回 HTTP 503: upstream' }] }), true);
});

test('执行阶段能力失败(schema 不过)不判 infra:计入批次样本', () => {
  assert.equal(pausedFailureIsInfra({ stepFailures: [{ message: 'research-report 校验失败: findings 至少 1 条' }] }), false);
});

test('无失败记录不判 infra(空 stepFailures / 缺字段安全)', () => {
  assert.equal(pausedFailureIsInfra({ stepFailures: [] }), false);
  assert.equal(pausedFailureIsInfra({}), false);
  assert.equal(pausedFailureIsInfra({ stepFailures: [{}] }), false);
});

test('infra 判定只看最近失败步:历史 optional 缺口已 skip 不误判整轮', () => {
  // 先 ai-spider(optional, fetch failed)被 skip 成缺口,续跑后 core 步 schema 不过 → 最近步非 infra。
  const state = {
    stepFailures: [
      { stepNo: 6, actorType: 'tool', actorId: 'ai-spider-search', message: 'fetch failed' },
      { stepNo: 7, actorType: 'llm', actorId: 'synthesis', message: 'research-report 校验失败' },
    ],
  };
  assert.equal(pausedFailureIsInfra(state), false, '最近步(合成校验失败)非 infra');
  assert.equal(pausedFailureIsOptionalTool(state, optionalToolIdSet()), false, '最近步非 optional tool');
});
