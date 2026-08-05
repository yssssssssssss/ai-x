import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildOrchestrator } from './orchestrator.ts';
import { RunWorkspace } from './run-workspace.ts';
import { createConversation, getResearchTask, listExecutionLog } from '../../../database/repository.ts';
import { closePool } from '../../../database/db.ts';
import type { PlanStep, PlanCandidate, ExecuteResult } from './plan-types.ts';
import type { Report } from '../../../packages/api-contract/http.ts';
import {
  buildReviewForm,
  buildReportMarkdown,
  type GoldRunRecord,
  type RunModelMeta,
} from './audit/audit-package.ts';
import { buildBatchSummary, type BatchRunLine } from './audit/batch-summary.ts';
import { classifyError, isInfraFailure } from './audit/failure-classify.ts';
import { loadToolRegistry } from './runtime/config-loader.ts';

// gold:run —— 金标批次真实闭环运行器(ADR-0001 / ADR-0002 / CONTEXT「金标真实运行」)。
// 用法: pnpm gold:run [batch_id]
//   固定金标输入,连跑三次能力样本(全真:gateway + real Tavily),按需重试 infra 失败,
//   每次落裁剪审计包(报告 md/json、plan、执行日志、模型元数据、来源核验清单、评审表单),
//   批次根写 batch.md。评审判定与 P0 结论留空,交独立研究员填写。

const SEED_USER_ID = '00000000-0000-0000-0000-000000000001';

// 金标场景:输入与人工评审标准预先确定(CONTEXT「金标场景」)。首个金标场景。
const SCENARIO = '直播场域数字人竞品研究';
const SCENARIO_INPUT = '我要为直播场域做一次数字人竞品研究,了解各家能力与体验差异';
const SCENARIO_SLUG = 'live-digital-human';

const TARGET_CAPABILITY_RUNS = 3;
const MAX_INFRA_RETRIES = 3; // 单个名额位因 infra 失败最多重试次数,防无限烧配额

const AUDIT_ROOT = process.env.GOLD_AUDIT_ROOT ?? './audit/gold-runs';

interface PlanShape {
  steps: PlanStep[];
  task_id: string;
}

// ADR-0002:强制全真,不读 .env 的 provider/adapter 值(.env 的 fake 供离线测试)。
export function forceRealEnv(): void {
  process.env.LLM_PROVIDER = 'gateway';
  process.env.TOOL_ADAPTER = 'real';
}

// ADR-0001:HITL 闸门折中 —— 仅当计划不含 requires_approval 步才自动确认,命中审批步立即停。
export function assertNoApprovalStep(candidate: PlanCandidate): void {
  const approval = candidate.steps.filter((s) => s.requires_approval);
  if (approval.length > 0) {
    const names = approval.map((s) => `step ${s.step_no} ${s.step_name}`).join(', ');
    throw new Error(
      `GOLD_APPROVAL_GATE: 计划含需审批步骤(${names}),gold:run 拒绝自动确认。` +
      `金标场景应为已知安全(仅公开信息、无 PII)。请人工介入。`,
    );
  }
}

function readModelMeta(ws: RunWorkspace): RunModelMeta {
  const p = join(ws.uri, 'context_manifest.json');
  if (existsSync(p)) {
    const m = JSON.parse(readFileSync(p, 'utf8')) as {
      model_name?: string; model_version?: string; trace_id?: string;
    };
    return {
      model_name: m.model_name ?? process.env.LLM_MODEL_NAME ?? 'unknown',
      model_version: m.model_version ?? process.env.LLM_MODEL_VERSION ?? 'unknown',
      trace_id: m.trace_id,
    };
  }
  return {
    model_name: process.env.LLM_MODEL_NAME ?? 'unknown',
    model_version: process.env.LLM_MODEL_VERSION ?? 'unknown',
  };
}

interface OneRunResult {
  outcome: 'capability_run' | 'infra_failed';
  status: string;
  schema_valid: boolean;
  note?: string;
  record: GoldRunRecord | null;
}

// paused 断点的最小投影。完整契约见 orchestrator RunState;这里只取判定所需字段。
export interface PausedFailure {
  message?: string;
  actorType?: string;
  actorId?: string;
}
export interface PausedRunState {
  stepFailures?: PausedFailure[];
}

// 当前 pause 对应"最近失败步"= stepFailures 末元素(resume 续跑会追加新失败)。
function latestFailure(state: PausedRunState): PausedFailure | undefined {
  const arr = state.stepFailures ?? [];
  return arr[arr.length - 1];
}

// 失败步的 message 拼接(留痕用:含历史所有失败步)。
export function pausedFailureMsg(state: PausedRunState): string {
  return (state.stepFailures ?? []).map((f) => f.message ?? '').join(' | ');
}

// 最近失败步是否 infra 特征(工具 fetch failed / 网关 5xx 等)→ 重试不占名额。
// 只看最近一步:历史失败步可能已被 skip 成缺口,不应据其误判整轮为 infra。
export function pausedFailureIsInfra(state: PausedRunState): boolean {
  const msg = latestFailure(state)?.message ?? '';
  return msg !== '' && isInfraFailure(new Error(msg));
}

// 最近失败步是否 optional(增强)tool:金标仅公开信息,其缺失可跳过成缺口、不阻断报告。
// 数据驱动:optionalToolIds 来自 tool-registry 的 tier 字段,非硬编码 id。
export function pausedFailureIsOptionalTool(state: PausedRunState, optionalToolIds: ReadonlySet<string>): boolean {
  const f = latestFailure(state);
  return f?.actorType === 'tool' && f.actorId != null && optionalToolIds.has(f.actorId);
}

// 从 tool-registry 取 tier=optional 的 active tool id 集合(缺省 tier 视为 optional:增强,保守)。
export function optionalToolIdSet(): Set<string> {
  return new Set(
    loadToolRegistry().tools
      .filter((t) => t.status === 'active' && (t.tier ?? 'optional') === 'optional')
      .map((t) => t.id),
  );
}

// 发起一次真跑:plan → 断言无审批步 → 自动确认 depth 候选 → execute。
// 抛错按 infra / capability 分类:infra 无报告 → 上层重试;capability 计入样本。
async function runOnce(runId: string, batchId: string): Promise<OneRunResult> {
  const startedAt = new Date().toISOString();
  const orch = buildOrchestrator();
  const conv = await createConversation({ ownerUserId: SEED_USER_ID, title: `gold ${runId}` });

  let taskId = '';
  try {
    const plan = await orch.planPhase({
      originalInput: SCENARIO_INPUT,
      conversationId: conv.id,
      ownerUserId: SEED_USER_ID,
    });
    taskId = plan.taskId;

    // depth 候选优先(更完整);无则取第一个。
    const candidate = plan.candidates.find((c) => c.id === 'depth') ?? plan.candidates[0];
    if (!candidate) throw new Error('规划未产出任何候选计划');
    assertNoApprovalStep(candidate); // 命中审批步在此抛 GOLD_APPROVAL_GATE(不归类 infra,直接冒泡停批次)

    await orch.selectPlan({ taskId, candidateId: candidate.id });
    let exec: ExecuteResult = await orch.executePhase({ taskId, conversationId: conv.id });

    const ws = new RunWorkspace(taskId);

    // 执行阶段 step 失败不抛异常(orchestrator 挂起落 run_state)。按最近失败步分三类处置(优先级从上到下):
    //  1. optional(增强)tool 失败(如截图库后端未启动)→ resume(skip) 跳过成缺口续跑。
    //     金标仅公开信息,增强能力缺失不得阻断报告(方案 B 根因修复);缺口透明进 risks_and_open_issues。
    //     优先于 infra 判定:optional 后端 down 常呈 fetch failed(infra 文本特征),但按能力分层应跳过而非重试。
    //  2. infra 失败(网关 5xx / core 检索 fetch failed 等)→ 判 infra,上层重试不占名额。
    //  3. core 能力失败(公开检索/合成本身失败)→ 不跳过,保留 paused 样本让评审看到真实缺陷。
    const optionalToolIds = optionalToolIdSet();
    let skipGuard = 0;
    while (exec.status === 'paused') {
      const state = ws.readRunState<PausedRunState>();
      if (pausedFailureIsOptionalTool(state, optionalToolIds)) {
        if (skipGuard++ > candidate.steps.length) {
          throw new Error(`resume(skip) 超过步数上限仍未终态(taskId=${taskId}),疑似死循环`);
        }
        exec = await orch.resumePhase({ taskId, conversationId: conv.id, action: 'skip' });
        continue;
      }
      if (pausedFailureIsInfra(state)) {
        return { outcome: 'infra_failed', status: 'paused', schema_valid: false, note: pausedFailureMsg(state), record: null };
      }
      break; // core 能力失败:留 paused,下方按无报告能力样本计入
    }

    const report = ws.readReport<Report>();
    const finishedAt = new Date().toISOString();
    const log = await listExecutionLog(taskId);

    // 有报告即能力样本(哪怕 completed_with_gaps / 报告差 —— 真实结果,必须计入)。
    // 无报告(paused 且未合成)视为能力失败样本:仍计入,评审判"不可用"。
    const model = readModelMeta(ws);
    const record: GoldRunRecord = {
      run_id: runId, task_id: taskId, batch_id: batchId,
      scenario_input: SCENARIO_INPUT,
      status: exec.status, report, model,
      schema_valid: report != null, // 报告已过 validateOrThrow 才落盘,故存在即 schema 合法
      exec_log: log.map((l) => ({ step_no: l.step_no, actor_type: l.actor_type, actor_id: l.actor_id, status: l.status })),
      started_at: startedAt, finished_at: finishedAt,
    };
    return { outcome: 'capability_run', status: exec.status, schema_valid: report != null, record };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('GOLD_APPROVAL_GATE')) throw err; // 闸门命中:停批次

    const { kind, message } = classifyError(err);
    if (kind === 'infra_failed') {
      return { outcome: 'infra_failed', status: 'failed', schema_valid: false, note: message, record: null };
    }
    // 能力失败但抛了异常(如 schema 不过):产出可能不完整,仍计入为能力样本(报告可能缺)。
    const finishedAt = new Date().toISOString();
    const ws = taskId ? new RunWorkspace(taskId) : null;
    const report = ws ? ws.readReport<Report>() : null;
    const record: GoldRunRecord = {
      run_id: runId, task_id: taskId, batch_id: batchId,
      scenario_input: SCENARIO_INPUT,
      status: 'failed', report, model: readModelMeta(ws ?? new RunWorkspace('__none__')),
      schema_valid: false,
      exec_log: taskId ? (await listExecutionLog(taskId)).map((l) => ({ step_no: l.step_no, actor_type: l.actor_type, actor_id: l.actor_id, status: l.status })) : [],
      started_at: startedAt, finished_at: finishedAt,
    };
    return { outcome: 'capability_run', status: `failed: ${message}`, schema_valid: false, note: message, record };
  }
}

// 裁剪审计包落盘(CONTEXT「批次审计包」清单:报告、plan、执行日志、模型元数据、来源清单、评审表单)。
export function writeRunAudit(dir: string, rec: GoldRunRecord): void {
  mkdirSync(dir, { recursive: true });
  if (rec.report) {
    writeFileSync(join(dir, 'report.json'), JSON.stringify(rec.report, null, 2));
    writeFileSync(join(dir, 'report.md'), buildReportMarkdown(rec.report));
  }
  writeFileSync(join(dir, 'exec-log.json'), JSON.stringify(rec.exec_log, null, 2));
  writeFileSync(join(dir, 'model-meta.json'), JSON.stringify(rec.model, null, 2));
  writeFileSync(join(dir, 'review-form.md'), buildReviewForm(rec));
}

async function main(): Promise<void> {
  forceRealEnv();
  const argBatch = process.argv[2]?.trim();
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const batchId = argBatch || `${today}-${SCENARIO_SLUG}`;
  const batchDir = join(AUDIT_ROOT, batchId);

  console.log(`\n===== gold:run 金标批次 =====`);
  console.log(`batch_id : ${batchId}`);
  console.log(`场景     : ${SCENARIO}`);
  console.log(`真实边界 : LLM_PROVIDER=gateway (${process.env.LLM_MODEL_NAME}) + TOOL_ADAPTER=real`);
  console.log(`目标     : ${TARGET_CAPABILITY_RUNS} 次能力样本(infra 失败重试,不占名额)\n`);

  const runLines: BatchRunLine[] = [];

  for (let slot = 1; slot <= TARGET_CAPABILITY_RUNS; slot++) {
    let infraRetries = 0;
    let done = false;
    while (!done) {
      const isRetry = infraRetries > 0;
      const runId = isRetry ? `run-${slot}-retry${infraRetries}` : `run-${slot}`;
      console.log(`--- ${runId} 发起真跑(消耗 gateway token + Tavily 配额)...`);
      const r = await runOnce(runId, batchId);

      if (r.outcome === 'infra_failed') {
        // 透明留痕:infra 失败记一行,不占名额,重试补齐(有上限)。
        console.log(`    [infra_failed] ${r.note} — 不占名额,重试`);
        runLines.push({ run_id: runId, outcome: 'infra_failed', status: r.status, schema_valid: false, infra_retries: 0, note: r.note });
        infraRetries++;
        if (infraRetries > MAX_INFRA_RETRIES) {
          throw new Error(`名额位 ${slot} 连续 ${MAX_INFRA_RETRIES} 次 infra 失败,停止(检查网关/Tavily/网络)。`);
        }
        continue;
      }

      // 能力样本:落审计包,计入批次。
      const finalRunId = `run-${slot}`;
      if (r.record) {
        r.record.run_id = finalRunId;
        writeRunAudit(join(batchDir, finalRunId), r.record);
      }
      runLines.push({ run_id: finalRunId, outcome: 'capability_run', status: r.status, schema_valid: r.schema_valid, infra_retries: infraRetries, note: r.note });
      console.log(`    [capability_run] status=${r.status} schema=${r.schema_valid ? 'ok' : 'fail'} → 审计包 ${join(batchDir, finalRunId)}`);
      done = true;
    }
  }

  // 批次聚合:机器填计数,P0 结论留研究员。
  const summary = buildBatchSummary({ batch_id: batchId, scenario: SCENARIO, scenario_input: SCENARIO_INPUT, runs: runLines });
  mkdirSync(batchDir, { recursive: true });
  writeFileSync(join(batchDir, 'batch.md'), summary);

  console.log(`\n===== 批次完成 =====`);
  console.log(`审计包: ${batchDir}`);
  console.log(`  batch.md — 客观计数已填,P0 通过结论待独立研究员评审后填写。`);
  console.log(`  各 run-*/review-form.md — 逐条来源核验矩阵待研究员打开确认。`);
  console.log(`\n⚠️ 最终 P0 判定 = 待人评审,非"通过"。`);
}

// 仅作为 CLI 入口时自动运行;被测试 import 时不触发(避免连 DB / 打真实网关)。
const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  main()
    .catch((err) => {
      console.error('gold:run 失败:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(closePool);
}
