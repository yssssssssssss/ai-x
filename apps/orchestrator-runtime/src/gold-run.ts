import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConversation } from '../../../database/repository.ts';
import { closePool, pool } from '../../../database/db.ts';
import { ControlPlaneRepository } from '../../../database/control-plane.ts';
import { TaskWorkflowService } from './control/task-workflow.ts';
import type { PlanCandidate } from './plan-types.ts';
import {
  buildReviewForm,
  buildReportMarkdown,
  type GoldRunRecord,
} from './audit/audit-package.ts';
import { buildBatchSummary, type BatchRunLine } from './audit/batch-summary.ts';
import { isInfraFailure } from './audit/failure-classify.ts';
import { loadToolRegistry } from './runtime/config-loader.ts';
import { assertTrustedGoldEnabled, loadGoldPolicy } from './audit/gold-policy.ts';
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


// Retained for ADR compatibility tests. #32's CLI path does not call real providers.
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


interface OneRunResult {
  outcome: 'disabled_workflow' | 'infra_failed';
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
  const conversation = await createConversation({ ownerUserId: SEED_USER_ID, title: `gold disabled ${runId}` });
  const repository = new ControlPlaneRepository(pool);
  const workflow = new TaskWorkflowService(repository);
  const created = await repository.createTaskWithCandidates({
    conversationId: conversation.id,
    ownerUserId: SEED_USER_ID,
    originalInput: SCENARIO_INPUT,
    taskType: 'gold_workflow_probe',
    structuredTask: {
      confirmations: [],
      blocking_issues: [{ key: 'gold-service', required_authority: 'gold' }],
    },
    candidates: [{
      candidateId: 'speed',
      plan: {
        task_id: '',
        deliverable_type: 'research_plan',
        evidence_requirements: [{
          id: 'gold-disabled-public-source',
          acceptedClasses: ['public_source'],
          minimumCount: 1,
          required: true,
        }],
        problem_graph: {
          version: 'problem-graph-v1',
          questions: [{
            id: 'gold-disabled-question',
            statement: '为什么金标服务当前不可执行？',
            rationale: '记录基础设施阻断原因。',
            priority: 'required',
            success_criterion_ids: ['gold-disabled'],
            evidence_requirements: [{
              id: 'gold-disabled-public-source',
              acceptedClasses: ['public_source'],
              minimumCount: 1,
              required: true,
            }],
            acceptance_criteria: ['明确记录阻断原因'],
            depends_on: [],
          }],
        },
        capability_decisions: { eligible: [], rejected: [] },
        steps: [{
          step_no: 1,
          step_name: '记录金标服务阻断',
          actor_type: 'llm',
          actor_id: 'gold-disabled-recorder',
          question_ids: ['gold-disabled-question'],
          depends_on: [],
          input: {},
          input_bindings: [],
          expected_outputs: [{ pointer: '/reason', description: '阻断原因' }],
          acceptance_criteria: ['输出阻断原因'],
          requires_approval: false,
          fallback_actor_ids: [],
        }],
        candidate_metadata: {
          title: '金标服务禁用',
          rationale: '保留可审计的禁用探针。',
          tradeoffs: '不执行真实研究。',
        },
        activated_nodes: [],
      },
      pendingInputs: [],
    }],
  });
  const task = created.task;
  const owner = { userId: SEED_USER_ID, role: 'owner' as const };
  const selected = await workflow.select({
    taskId: task.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: `gold-select:${runId}`,
    actor: owner,
    planVersionId: created.candidates[0]!.id,
  });
  const confirmed = await workflow.confirm({
    taskId: task.id,
    planVersionId: selected.planVersionId,
    expectedVersion: selected.stateVersion,
    idempotencyKey: `gold-confirm:${runId}`,
    actor: owner,
    confirmationAnswers: {},
    inputRoles: [],
  });
  const approved = await workflow.approve({
    taskId: task.id,
    planVersionId: selected.planVersionId,
    expectedVersion: confirmed.stateVersion,
    idempotencyKey: `gold-approve:${runId}`,
    actor: { userId: SEED_USER_ID, role: 'gold', service: 'gold' },
    gateKey: 'gold-service',
    decision: 'approved',
  });
  const execution = await workflow.execute({
    taskId: task.id,
    planVersionId: selected.planVersionId,
    expectedVersion: approved.stateVersion,
    idempotencyKey: `gold-execute:${runId}`,
    actor: owner,
  });
  const record: GoldRunRecord = {
    run_id: runId,
    task_id: task.id,
    batch_id: batchId,
    scenario_input: SCENARIO_INPUT,
    status: 'paused',
    report: null,
    model: { model_name: 'disabled-workflow-gate', model_version: 'trusted-p0-v1' },
    schema_valid: false,
    exec_log: [],
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
  return {
    outcome: 'disabled_workflow',
    status: execution.state,
    schema_valid: false,
    note: 'execution disabled by Workflow Gate; this is not a P0 capability sample',
    record,
  };
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
  assertTrustedGoldEnabled();
  forceRealEnv();
  const argBatch = process.argv[2]?.trim();
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const batchId = argBatch || `${today}-${SCENARIO_SLUG}`;
  const batchDir = join(AUDIT_ROOT, batchId);

  console.log(`\n===== gold:run 金标批次 =====`);
  console.log(`batch_id : ${batchId}`);
  console.log(`场景     : ${SCENARIO}`);
  console.log('执行边界 : TaskWorkflowService disabled execution, 不调用 LLM 或 Tool');
  console.log(`目标     : ${TARGET_CAPABILITY_RUNS} 次命令流验证,不构成 P0 能力样本\n`);

  const runLines: BatchRunLine[] = [];

  for (let slot = 1; slot <= TARGET_CAPABILITY_RUNS; slot++) {
    let infraRetries = 0;
    let done = false;
    while (!done) {
      const isRetry = infraRetries > 0;
      const runId = isRetry ? `run-${slot}-retry${infraRetries}` : `run-${slot}`;
      console.log(`--- ${runId} 验证 Gold Workflow Gate disabled command flow...`);
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

      // Disabled command sample: persist evidence, but never present it as a real capability run.
      const finalRunId = `run-${slot}`;
      if (r.record) {
        r.record.run_id = finalRunId;
        writeRunAudit(join(batchDir, finalRunId), r.record);
      }
      runLines.push({ run_id: finalRunId, outcome: r.outcome, status: r.status, schema_valid: r.schema_valid, infra_retries: infraRetries, note: r.note });
      console.log(`    [disabled_workflow] status=${r.status} → 审计包 ${join(batchDir, finalRunId)}`);
      done = true;
    }
  }

  // 批次聚合:机器填计数,P0 结论留研究员。
  const summary = buildBatchSummary({ batch_id: batchId, scenario: SCENARIO, scenario_input: SCENARIO_INPUT, runs: runLines }, loadGoldPolicy());
  mkdirSync(batchDir, { recursive: true });
  writeFileSync(join(batchDir, 'batch.md'), summary);

  console.log(`\n===== 批次完成 =====`);
  console.log(`审计包: ${batchDir}`);
  console.log(`  batch.md — 客观计数已填,P0 通过结论待独立研究员评审后填写。`);
  console.log(`  各 run-*/review-form.md — 逐条来源核验矩阵待研究员打开确认。`);
  console.log(`\n⚠️ 最终 P0 判定 = 待人评审,非"通过"。`);
}

// Only auto-run as a CLI entry, tests import pure helpers without DB or provider calls.
const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  main()
    .catch((err) => {
      console.error('gold:run 失败:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(closePool);
}
