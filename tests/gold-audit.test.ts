import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Report } from '../packages/api-contract/http.ts';
import {
  buildReviewForm,
  toolResultSourceRefs,
  type GoldRunRecord,
} from '../apps/orchestrator-runtime/src/audit/audit-package.ts';
import {
  buildBatchSummary,
  countBatch,
  type BatchInput,
} from '../apps/orchestrator-runtime/src/audit/batch-summary.ts';
import { classifyError, isInfraFailure } from '../apps/orchestrator-runtime/src/audit/failure-classify.ts';

const report: Report = {
  research_goal: '了解直播数字人竞品能力差异',
  method_summary: '公开检索 + 竞品分析',
  findings: [
    { id: 'F1', statement: '实时互动是短板', source: 'tool_result', source_ref: 'https://a.example.com/x' },
    { id: 'F2', statement: '低延迟是差异化方向', source: 'llm_inference' },
    { id: 'F3', statement: '竞品官网列出三档套餐', source: 'tool_result', source_ref: 'https://b.example.com/pricing' },
  ],
  sub_questions: [],
  overall_conclusion: ['先补实时互动'],
  timeline: [{ phase: 'W1', activity: '检索' }],
  deliverables: ['竞品对比'],
  capability_orchestration: [],
  risks_and_open_issues: ['样本仅 3 家'],
};

function rec(over: Partial<GoldRunRecord> = {}): GoldRunRecord {
  return {
    run_id: 'run-1', task_id: 't1', batch_id: '20260730-live-digital-human',
    scenario_input: '为直播场域做数字人竞品研究',
    status: 'completed', report, model: { model_name: 'GPT-5.4-joybuilder', model_version: 'v0', trace_id: 'tr-1' },
    schema_valid: true,
    exec_log: [{ step_no: 1, actor_type: 'tool', actor_id: 'tavily-web-search', status: 'succeeded' }],
    started_at: '2026-07-30T00:00:00Z', finished_at: '2026-07-30T00:01:00Z',
    ...over,
  };
}

test('来源核验矩阵只收 tool_result 结论', () => {
  const rows = toolResultSourceRefs(report);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.finding_id), ['F1', 'F3']);
});

test('tool_result 缺 source_ref 时标记为不可核验而非丢弃', () => {
  const bad: Report = { ...report, findings: [{ id: 'FX', statement: '无引用结论', source: 'tool_result' }] };
  const rows = toolResultSourceRefs(bad);
  assert.equal(rows.length, 1);
  assert.match(rows[0].source_ref, /不可核验/);
});

test('评审表单预填客观字段但判定与结论留空', () => {
  const md = buildReviewForm(rec());
  // 客观字段已填
  assert.match(md, /GPT-5\.4-joybuilder @ v0/);
  assert.match(md, /schema 校验: 通过/);
  assert.match(md, /已声明 1 条/);
  // 来源矩阵含两条 tool_result 的 URL
  assert.match(md, /https:\/\/a\.example\.com\/x/);
  assert.match(md, /https:\/\/b\.example\.com\/pricing/);
  // 判定项留空(未预先勾选)
  assert.match(md, /- \[ \] 关键竞品事实可核验/);
  assert.doesNotMatch(md, /- \[x\]/i);
  // 总判定字段存在且空置
  assert.match(md, /判定（可用 \/ 需重大修改 \/ 不可用）: *$/m);
});

test('无报告运行的评审表单说明不可评审可用性', () => {
  const md = buildReviewForm(rec({ report: null, status: 'failed' }));
  assert.match(md, /无报告产出/);
  assert.doesNotMatch(md, /来源核验矩阵/);
});

test('全真闭环下报告无 tool_result 会被标注可疑', () => {
  const noTool: Report = { ...report, findings: [{ id: 'F1', statement: 'x', source: 'llm_inference' }] };
  const md = buildReviewForm(rec({ report: noTool }));
  assert.match(md, /检索是否真的被使用/);
});

const batch: BatchInput = {
  batch_id: '20260730-live-digital-human',
  scenario: '直播场域数字人竞品研究',
  scenario_input: '为直播场域做数字人竞品研究',
  runs: [
    { run_id: 'run-1', outcome: 'capability_run', status: 'completed', schema_valid: true, infra_retries: 0 },
    { run_id: 'run-2', outcome: 'infra_failed', status: 'failed', schema_valid: false, infra_retries: 1, note: 'gateway 超时' },
    { run_id: 'run-2b', outcome: 'capability_run', status: 'completed_with_gaps', schema_valid: true, infra_retries: 0 },
    { run_id: 'run-3', outcome: 'capability_run', status: 'completed', schema_valid: true, infra_retries: 0 },
  ],
};

test('批次计数:infra 失败不占能力名额', () => {
  const c = countBatch(batch);
  assert.equal(c.capabilityRuns, 3);
  assert.equal(c.infraFailures, 1);
  assert.equal(c.totalInfraRetries, 1);
  assert.equal(c.schemaPassed, 3);
});

test('disabled workflow command 不计入 P0 能力样本', () => {
  const disabled: BatchInput = {
    ...batch,
    runs: [{ run_id: 'workflow-gate', outcome: 'disabled_workflow', status: 'paused', schema_valid: false, infra_retries: 0 }],
  };
  const counts = countBatch(disabled);
  assert.equal(counts.capabilityRuns, 0);
  assert.equal(counts.disabledWorkflows, 1);
  assert.match(buildBatchSummary(disabled), /disabled Workflow 命令验证（不计入 P0）: 1/);
  assert.match(buildBatchSummary(disabled), /能力样本不足 3（当前 0）/);
});

test('批次摘要:就绪状态由能力样本数决定,P0 结论留给研究员', () => {
  const md = buildBatchSummary(batch);
  assert.match(md, /能力样本已齐，待评审/);
  assert.match(md, /\*\*本批次是否 P0 通过（研究员结论）\*\*: *$/m);
  // infra 重试透明留痕
  assert.match(md, /gateway 超时/);
});

test('批次摘要:备注含竖线时转义,不破坏 Markdown 表格列', () => {
  const withPipe: BatchInput = {
    ...batch,
    runs: [{ run_id: 'run-x', outcome: 'infra_failed', status: 'paused', schema_valid: false, infra_retries: 0, note: 'tool "ai-spider-search" 调用失败: fetch failed | 网关限流 HTTP 429' }],
  };
  const md = buildBatchSummary(withPipe);
  const row = md.split('\n').find((l) => l.includes('run-x'))!;
  const colDelims = (row.match(/(?<!\\)\|/g) ?? []).length; // 只数未转义竖线 = 真实列分隔符
  assert.equal(colDelims, 7, '6 列表格行应恰有 7 个未转义分隔符(首尾各一 + 列间五)');
  assert.match(row, /fetch failed \\\| 网关限流/, '备注内竖线应被转义');
});

test('能力样本不足 3 时就绪状态提示补齐', () => {
  const short: BatchInput = { ...batch, runs: batch.runs.slice(0, 2) };
  const md = buildBatchSummary(short);
  assert.match(md, /能力样本不足 3（当前 1）/);
});

test('infra 失败特征:网关 5xx / 超时 / 限流 / 网络', () => {
  assert.ok(isInfraFailure(new Error('网关返回 HTTP 503: upstream')));
  assert.ok(isInfraFailure(new Error('tool "tavily-web-search" 调用失败: HTTP 502')));
  assert.ok(isInfraFailure(new Error('The operation was aborted')));
  assert.ok(isInfraFailure(new Error('fetch failed')));
  assert.ok(isInfraFailure(new Error('HTTP 429')));
});

test('能力失败不误判为 infra:schema 不过 / 空检索', () => {
  assert.ok(!isInfraFailure(new Error('research-report 校验失败: findings 至少 1 条')));
  assert.ok(!isInfraFailure(new Error('MockLLMClient: 没有为 schemaName 预置 fixture')));
  assert.equal(classifyError(new Error('schema 不过')).kind, 'capability_failed');
  assert.equal(classifyError(new Error('网关返回 HTTP 500')).kind, 'infra_failed');
});
