import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../database/db.ts';
import { buildEvidenceLedger, factualEvidenceReferenceIds, type EvidenceLedger } from '../apps/orchestrator-runtime/src/evidence-ledger.ts';
import { getReportBlueprint } from '../apps/orchestrator-runtime/src/report-blueprint.ts';
import { renderReportHtml } from '../apps/orchestrator-runtime/src/report-renderer.ts';
import { ReportSynthesisAgent } from '../apps/orchestrator-runtime/src/report-synthesis-agent.ts';
import { buildRuntime, type AgentRuntime } from '../apps/orchestrator-runtime/src/runtime/agent-runtime.ts';
import { buildEvidenceContext, type ContextToolOutput } from '../apps/orchestrator-runtime/src/runtime/context-builder.ts';

interface HistoricalPlanStep {
  step_no: number;
  step_name: string;
  actor_type: 'skill' | 'tool' | 'llm' | 'reviewer';
  actor_id: string;
  purpose?: string;
}

interface HistoricalPlan {
  task_id: string;
  task_type: string;
  steps: HistoricalPlanStep[];
}

interface StepFailure {
  stepNo: number;
  stepName: string;
  actorType: HistoricalPlanStep['actor_type'];
  actorId: string;
  message: string;
}

type Report = Record<string, unknown>;

interface ReportCoverage {
  findings_total: number;
  tool_result_findings: number;
  inference_findings: number;
  evidence_ledger_sources: number | null;
  factual_evidence_sources: number | null;
  evidence_ledger_entries: number | null;
  cited_evidence: number | null;
  has_executive_summary: boolean;
  has_core_issues: boolean;
  has_dimension_analyses: boolean;
  has_recommendations: boolean;
  generation_mode: string | null;
  is_mock_demo: boolean;
}

export interface ReplayResult {
  taskId: string;
  generationMode: string;
  paths: {
    report: string;
    html: string;
    evidenceLedger: string;
    comparisonJson: string;
    comparisonMarkdown: string;
  };
}

// 仅基于已保存的步骤产物回放最终报告，禁止在这里重新执行 Tool 或 Skill。
export async function replayReportV2(input: {
  taskId: string;
  workspaceRoot?: string;
  runtime?: AgentRuntime;
}): Promise<ReplayResult> {
  assertTaskId(input.taskId);
  const workspace = resolve(input.workspaceRoot ?? join(process.cwd(), 'run-workspaces', input.taskId));
  const plan = await readJson<HistoricalPlan>(join(workspace, 'plan.json'));
  const v1 = await readJson<Report>(join(workspace, 'artifacts', 'report.json'));
  const { toolOutputs, reviewNotes, stepFailures, usedCapabilities } = await loadHistoricalSteps(workspace, plan);
  if (toolOutputs.length === 0) throw new Error('历史任务没有可用于回放的成功步骤输出。');

  const ledger = buildEvidenceLedger(toolOutputs);
  const blueprint = getReportBlueprint(plan.task_type);
  const researchGoal = readText(v1.research_goal) ?? `历史任务 ${input.taskId} 的研究报告`;
  const built = buildEvidenceContext({
    callId: 'historical-replay-v2',
    base: {
      task_id: input.taskId,
      task_type: plan.task_type,
      research_goal: researchGoal,
      report_blueprint: blueprint,
      evidence_ledger: ledger,
      step_failures: stepFailures,
      review_notes: reviewNotes,
      replay_mode: 'historical_outputs_only',
    },
    toolOutputs: [],
  });
  const runtime = input.runtime ?? buildRuntime();
  const synthesis = await new ReportSynthesisAgent(runtime.deps.llm, runtime.deps.validator).synthesize({
    taskId: input.taskId,
    taskType: plan.task_type,
    researchGoal,
    evidenceContext: built.context,
    evidenceRefs: factualEvidenceReferenceIds(ledger),
    evidenceLedger: ledger,
    blueprint,
    capabilityOrchestration: buildCapabilities(plan.steps, usedCapabilities),
    stepFailures,
    reviewNotes,
  });
  const report = synthesis.report;
  const artifacts = join(workspace, 'artifacts');
  const paths = {
    report: join(artifacts, 'report-v2.json'),
    html: join(artifacts, 'report-v2.html'),
    evidenceLedger: join(artifacts, 'evidence-ledger.json'),
    comparisonJson: join(artifacts, 'report-v1-v2-comparison.json'),
    comparisonMarkdown: join(artifacts, 'report-v1-v2-comparison.md'),
  };
  const comparison = buildReportComparison({ taskId: input.taskId, v1, v2: report, ledger });

  await Promise.all([
    writeFile(paths.report, JSON.stringify(report, null, 2)),
    writeFile(paths.html, renderReportHtml({ report: report as any }), 'utf8'),
    writeFile(paths.evidenceLedger, JSON.stringify(ledger, null, 2)),
    writeFile(paths.comparisonJson, JSON.stringify(comparison, null, 2)),
    writeFile(paths.comparisonMarkdown, renderComparisonMarkdown(comparison), 'utf8'),
  ]);

  return {
    taskId: input.taskId,
    generationMode: readMetadata(report).generation_mode ?? 'unknown',
    paths,
  };
}

export function buildReportComparison(input: { taskId: string; v1: Report; v2: Report; ledger: EvidenceLedger }): Record<string, unknown> {
  const v1 = summarizeReport(input.v1);
  const v2 = summarizeReport(input.v2, input.ledger);
  return {
    task_id: input.taskId,
    comparison_version: '1.0',
    scope: '仅比较同一历史任务的 V1 报告与基于原始步骤产物重新合成的 V2 报告。',
    v1,
    v2,
    changes: {
      executive_summary_added: !v1.has_executive_summary && v2.has_executive_summary,
      core_issues_added: !v1.has_core_issues && v2.has_core_issues,
      dimension_analyses_added: !v1.has_dimension_analyses && v2.has_dimension_analyses,
      recommendations_added: !v1.has_recommendations && v2.has_recommendations,
      evidence_ledger_added: v1.evidence_ledger_sources === null && v2.evidence_ledger_sources !== null,
      findings_delta: v2.findings_total - v1.findings_total,
      tool_result_findings_delta: v2.tool_result_findings - v1.tool_result_findings,
      inference_findings_delta: v2.inference_findings - v1.inference_findings,
    },
  };
}

function summarizeReport(report: Report, ledger?: EvidenceLedger): ReportCoverage {
  const findings = readRecords(report.findings);
  const evidenceSummary = asRecord(report.evidence_summary);
  const metadata = readMetadata(report);
  const factualSourceCount = ledger
    ? ledger.sources.filter((source) => source.entry_ids.some((id) => factualEvidenceReferenceIds(ledger).includes(id))).length
    : readNumber(evidenceSummary.source_count);
  return {
    findings_total: findings.length,
    tool_result_findings: findings.filter((finding) => finding.source === 'tool_result').length,
    inference_findings: findings.filter((finding) => finding.source === 'llm_inference').length,
    evidence_ledger_sources: ledger?.sources.length ?? readNumber(evidenceSummary.source_count),
    factual_evidence_sources: factualSourceCount,
    evidence_ledger_entries: ledger?.entries.length ?? readNumber(evidenceSummary.ledger_entry_count),
    cited_evidence: readNumber(evidenceSummary.cited_evidence_count),
    has_executive_summary: Boolean(readText(report.executive_summary)),
    has_core_issues: readRecords(report.core_issues).length > 0,
    has_dimension_analyses: readRecords(report.dimension_analyses).length > 0,
    has_recommendations: readRecords(report.recommendations).length > 0,
    generation_mode: metadata.generation_mode,
    is_mock_demo: metadata.generation_mode === 'mock_demo',
  };
}

function renderComparisonMarkdown(comparison: Record<string, unknown>): string {
  const v1 = comparison.v1 as ReportCoverage;
  const v2 = comparison.v2 as ReportCoverage;
  const rows: Array<[string, string | number | boolean | null, string | number | boolean | null]> = [
    ['关键结论数', v1.findings_total, v2.findings_total],
    ['工具证据结论数', v1.tool_result_findings, v2.tool_result_findings],
    ['推断结论数', v1.inference_findings, v2.inference_findings],
    ['台账来源总数（含推断）', v1.evidence_ledger_sources, v2.evidence_ledger_sources],
    ['事实证据来源数', v1.factual_evidence_sources, v2.factual_evidence_sources],
    ['证据台账条目数', v1.evidence_ledger_entries, v2.evidence_ledger_entries],
    ['已引用证据数', v1.cited_evidence, v2.cited_evidence],
    ['执行摘要', v1.has_executive_summary, v2.has_executive_summary],
    ['核心问题', v1.has_core_issues, v2.has_core_issues],
    ['维度分析', v1.has_dimension_analyses, v2.has_dimension_analyses],
    ['优先行动', v1.has_recommendations, v2.has_recommendations],
    ['Mock 演示标记', v1.is_mock_demo, v2.is_mock_demo],
  ];
  const cell = (value: string | number | boolean | null) => value === null ? '无' : typeof value === 'boolean' ? (value ? '有' : '无') : String(value);
  return [
    '# 历史报告 V1 / V2 对比',
    '',
    String(comparison.scope),
    '',
    '| 指标 | V1 | V2 |',
    '| --- | ---: | ---: |',
    ...rows.map(([label, before, after]) => `| ${label} | ${cell(before)} | ${cell(after)} |`),
    '',
    `V2 生成模式：${v2.generation_mode ?? '未知'}。若标记为 mock_demo，仅用于结构与链路验证。`,
  ].join('\n');
}

async function loadHistoricalSteps(workspace: string, plan: HistoricalPlan): Promise<{
  toolOutputs: ContextToolOutput[];
  reviewNotes: string[];
  stepFailures: StepFailure[];
  usedCapabilities: Array<{ id: string; type: 'tool' | 'skill' }>;
}> {
  const toolOutputs: ContextToolOutput[] = [];
  const reviewNotes: string[] = [];
  const stepFailures: StepFailure[] = [];
  const usedCapabilities: Array<{ id: string; type: 'tool' | 'skill' }> = [];

  for (const step of plan.steps) {
    const outputPath = join(workspace, 'tool_outputs', `step${step.step_no}.json`);
    let output: unknown;
    try {
      output = await readJson(outputPath);
    } catch (error) {
      stepFailures.push({ ...toStepFailure(step), message: `未找到历史输出: ${errorMessage(error)}` });
      continue;
    }
    if (isFailedOutput(output)) {
      stepFailures.push({ ...toStepFailure(step), message: `历史步骤状态为 ${readText(asRecord(output).status) ?? 'failed'}` });
      continue;
    }
    if (step.actor_type === 'reviewer') {
      const review = readText(asRecord(output).review);
      if (review) reviewNotes.push(review);
      else stepFailures.push({ ...toStepFailure(step), message: '历史 reviewer 输出不含 review 文本。' });
      continue;
    }
    toolOutputs.push({
      toolId: step.actor_id,
      stepNo: step.step_no,
      outputRef: `tool_outputs/step${step.step_no}.json`,
      sourceType: step.actor_type === 'llm' ? 'llm_inference' : 'tool_result',
      output,
    });
    if (step.actor_type === 'tool' || step.actor_type === 'skill') {
      usedCapabilities.push({ id: step.actor_id, type: step.actor_type });
    }
  }
  return { toolOutputs, reviewNotes, stepFailures, usedCapabilities };
}

function buildCapabilities(steps: HistoricalPlanStep[], used: Array<{ id: string; type: 'tool' | 'skill' }>) {
  const executed = new Set(used.map((item) => `${item.type}:${item.id}`));
  const seen = new Set<string>();
  return steps.flatMap((step) => {
    if (step.actor_type !== 'tool' && step.actor_type !== 'skill') return [];
    const key = `${step.actor_type}:${step.actor_id}`;
    if (!executed.has(key) || seen.has(key)) return [];
    seen.add(key);
    return [{ capability_id: step.actor_id, capability_type: step.actor_type, purpose: step.purpose ?? step.step_name }];
  });
}

function toStepFailure(step: HistoricalPlanStep): Omit<StepFailure, 'message'> {
  return { stepNo: step.step_no, stepName: step.step_name, actorType: step.actor_type, actorId: step.actor_id };
}

function isFailedOutput(value: unknown): boolean {
  return ['failed', 'skipped', 'cancelled'].includes((readText(asRecord(value).status) ?? '').toLowerCase());
}

function readMetadata(report: Report): { generation_mode: string | null } {
  const mode = readText(asRecord(report.report_metadata).generation_mode);
  return { generation_mode: mode ?? null };
}

function readRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord).filter((value) => Object.keys(value).length > 0) : [];
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertTaskId(taskId: string): void {
  if (!/^[a-zA-Z0-9-]+$/.test(taskId)) throw new Error('任务 ID 只能包含字母、数字和连字符。');
}

async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function main(): Promise<void> {
  const taskId = process.argv[2];
  if (!taskId) throw new Error('用法: tsx scripts/replay-report-v2.ts <task-id>');
  loadEnv();
  const result = await replayReportV2({ taskId });
  process.stdout.write(`已生成 V2 回放报告 (${result.generationMode}):\n${Object.values(result.paths).join('\n')}\n`);
}

const scriptPath = resolve(fileURLToPath(import.meta.url));
if (process.argv.some((argument) => resolve(argument) === scriptPath)) {
  main().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
