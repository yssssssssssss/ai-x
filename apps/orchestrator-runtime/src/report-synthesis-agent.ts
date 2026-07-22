import { factualEvidenceReferenceIds, type EvidenceLedger } from './evidence-ledger.ts';
import { getReportBlueprint, formatReportBlueprint, type ReportBlueprint } from './report-blueprint.ts';
import type { LLMClient, LLMResult } from './runtime/llm-client.ts';
import { SchemaValidator } from './schema/validator.ts';

export interface ReportCapability {
  capability_id: string;
  capability_type: 'skill' | 'tool';
  purpose: string;
}

export interface ReportSynthesisInput {
  taskId: string;
  taskType?: string;
  researchGoal: string;
  evidenceContext: Record<string, unknown>;
  evidenceRefs: string[];
  evidenceLedger?: EvidenceLedger;
  blueprint?: ReportBlueprint;
  capabilityOrchestration?: ReportCapability[];
  stepFailures: Array<{ stepNo: number; stepName: string; actorType: string; actorId: string; message: string }>;
  reviewNotes: string[];
}

export interface ReportSynthesisResult {
  report: Record<string, unknown>;
  generation: LLMResult<Record<string, unknown>>;
  integrityIssues: string[];
}

interface ReportFinding {
  statement?: unknown;
  source?: unknown;
  source_ref?: unknown;
}

interface EvidenceBoundSection {
  evidence_basis?: unknown;
  evidence_refs?: unknown;
}

// 最终汇总是独立角色边界，而不是第二个任务编排器。
// 它只接收调用方投影好的台账和报告蓝图，避免原始对话、媒体二进制和任意工具日志污染结论。
export class ReportSynthesisAgent {
  constructor(private readonly llm: LLMClient, private readonly validator: SchemaValidator) {}

  async synthesize(input: ReportSynthesisInput): Promise<ReportSynthesisResult> {
    if (containsRawMedia(input.evidenceContext)) {
      throw new Error('ReportSynthesisAgent 只接受证据投影，禁止传入原始媒体 Data URL');
    }
    const blueprint = input.blueprint ?? getReportBlueprint(input.taskType);
    const factualEvidenceRefs = input.evidenceLedger
      ? factualEvidenceReferenceIds(input.evidenceLedger)
      : input.evidenceRefs;
    const projectedIssues = inspectProjectedEvidence(input.evidenceContext);
    const gapNote = input.stepFailures.length > 0
      ? `\n以下步骤失败或被跳过，必须在 risks_and_open_issues 中如实说明，不得假装有数据：${input.stepFailures.map((failure) => `[step ${failure.stepNo} ${failure.actorType}:${failure.actorId} - ${failure.message}]`).join('; ')}`
      : '';
    const reviewNote = input.reviewNotes.length > 0
      ? `\n以下为质量复核意见，未解决项写入 risks_and_open_issues：${input.reviewNotes.map((note, index) => `[复核${index + 1}] ${note}`).join('; ')}`
      : '';
    const integrityNote = projectedIssues.length > 0
      ? `\n上游结构化证据存在以下缺口，必须作为限制说明，不能补写为事实：${projectedIssues.join('; ')}`
      : '';

    const generation = await this.llm.generateStructured<Record<string, unknown>>({
      prompt:
        `你是 ReportSynthesisAgent。研究目标：${input.researchGoal}。基于受限证据台账生成完整、可执行的研究报告，不得使用台账外信息。\n` +
        `${formatReportBlueprint(blueprint)}\n` +
        '报告必须形成“结论 -> 论据 -> 影响 -> 行动”的闭环，而不是逐条摘抄。\n' +
        '必填内容：executive_summary、findings、core_issues、dimension_analyses、recommendations、timeline、deliverables、risks_and_open_issues。\n' +
        'findings 的 source=tool_result 时，source_ref 必须精确使用一个已知证据引用。' +
        `已知证据引用：${factualEvidenceRefs.join(', ') || '（没有可引用的证据）'}。\n` +
        'core_issues 与 recommendations 必须有 evidence_basis：有证据时写 evidence 并在 evidence_refs 中列出已知引用；无证据时写 inference，不得伪装成事实。\n' +
        'recommendations 必须说明优先级、具体行动、预期影响和验证方式。' +
        '所有工具/模型降级、假设、来源缺口与未解决复核意见必须写入 risks_and_open_issues。' +
        gapNote + reviewNote + integrityNote,
      schema: {},
      schemaName: 'research-report',
      context: input.evidenceContext,
    });

    const report: Record<string, unknown> = { ...generation.data, task_id: input.taskId };
    const integrityIssues = [
      ...projectedIssues,
      ...normalizeReportEvidence(report, factualEvidenceRefs),
      ...normalizeNarrativeEvidence(report, factualEvidenceRefs),
    ];
    if (input.capabilityOrchestration) report.capability_orchestration = input.capabilityOrchestration;
    const risks = readStringArray(report.risks_and_open_issues);
    if (isMockGeneration(generation)) risks.push('当前报告由 MockLLMClient 生成，仅用于测试或演示，不得作为业务结论。');
    report.risks_and_open_issues = unique([...risks, ...integrityIssues]);
    report.report_metadata = {
      version: '2.0',
      task_type: blueprint.taskType,
      blueprint_id: blueprint.id,
      generation_mode: isMockGeneration(generation) ? 'mock_demo' : 'production',
      evidence_ledger_ref: 'artifacts/evidence-ledger.json',
    };
    report.evidence_summary = buildEvidenceSummary(report, input.evidenceLedger, factualEvidenceRefs);

    this.validator.validateOrThrow('research-report', report);
    return { report, generation, integrityIssues };
  }
}

function containsRawMedia(value: unknown): boolean {
  if (typeof value === 'string') return /^data:(?:image\/|application\/pdf)/i.test(value);
  if (Array.isArray(value)) return value.some(containsRawMedia);
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(containsRawMedia);
  return false;
}

// 只检查已投影的统一 Skill 信封；原生工具有各自 Schema，不在这里猜测其字段语义。
export function inspectProjectedEvidence(context: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const outputs = context.tool_outputs;
  if (Array.isArray(outputs)) {
    for (const item of outputs) {
      if (!item || typeof item !== 'object') continue;
      const record = item as { toolId?: unknown; output?: unknown };
      const output = record.output;
      if (!output || typeof output !== 'object' || Array.isArray(output)) continue;
      const value = output as { findings?: unknown; evidence?: unknown };
      if (!Array.isArray(value.findings) || !Array.isArray(value.evidence)) continue;
      const evidenceIds = new Set(value.evidence
        .filter((e): e is { id?: unknown } => Boolean(e) && typeof e === 'object')
        .map((e) => e.id)
        .filter((id): id is string => typeof id === 'string'));
      for (const finding of value.findings) {
        if (!finding || typeof finding !== 'object') continue;
        const refs = (finding as { evidence_refs?: unknown }).evidence_refs;
        if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== 'string' || !evidenceIds.has(ref))) {
          issues.push(`${String(record.toolId ?? 'unknown')} 存在无法回链 evidence 的 finding`);
        }
      }
    }
  }
  const ledger = context.evidence_ledger;
  if (ledger && typeof ledger === 'object') {
    const value = ledger as { sources?: unknown; entries?: unknown };
    if (!Array.isArray(value.sources) || !Array.isArray(value.entries)) issues.push('证据台账结构不完整');
  }
  return unique(issues);
}

function normalizeReportEvidence(report: Record<string, unknown>, evidenceRefs: string[]): string[] {
  const issues: string[] = [];
  const findings = report.findings;
  if (!Array.isArray(findings)) return issues;
  const knownRefs = new Set(evidenceRefs);
  for (const item of findings) {
    if (!item || typeof item !== 'object') continue;
    const finding = item as ReportFinding & Record<string, unknown>;
    if (finding.source !== 'tool_result') continue;
    if (typeof finding.source_ref === 'string' && knownRefs.has(finding.source_ref)) continue;
    finding.source = 'llm_inference';
    delete finding.source_ref;
    issues.push(`发现「${typeof finding.statement === 'string' ? finding.statement.slice(0, 80) : '未知结论'}」缺少有效工具证据引用，已降级为 llm_inference`);
  }
  return issues;
}

function normalizeNarrativeEvidence(report: Record<string, unknown>, evidenceRefs: string[]): string[] {
  const issues: string[] = [];
  const knownRefs = new Set(evidenceRefs);
  for (const field of ['core_issues', 'recommendations']) {
    const sections = report[field];
    if (!Array.isArray(sections)) continue;
    for (const item of sections) {
      if (!item || typeof item !== 'object') continue;
      const section = item as EvidenceBoundSection & Record<string, unknown>;
      const refs = Array.isArray(section.evidence_refs)
        ? section.evidence_refs.filter((ref): ref is string => typeof ref === 'string' && knownRefs.has(ref))
        : [];
      if (section.evidence_basis === 'evidence' && refs.length > 0) {
        section.evidence_refs = refs;
        continue;
      }
      if (section.evidence_basis === 'evidence') {
        issues.push(`${field} 中存在无法回链的证据主张，已降级为 inference`);
      }
      section.evidence_basis = 'inference';
      delete section.evidence_refs;
    }
  }
  return issues;
}

function buildEvidenceSummary(report: Record<string, unknown>, ledger: EvidenceLedger | undefined, fallbackRefs: string[]) {
  const knownRefs = new Set(ledger ? factualEvidenceReferenceIds(ledger) : fallbackRefs);
  const citedRefs = collectCitedReferences(report).filter((ref) => knownRefs.has(ref));
  return {
    ledger_entry_count: ledger?.entries.length ?? fallbackRefs.length,
    source_count: ledger
      ? ledger.sources.filter((source) => source.entry_ids.some((id) => knownRefs.has(id))).length
      : 0,
    cited_evidence_count: new Set(citedRefs).size,
    limitations: ledger?.limitations ?? [],
  };
}

function collectCitedReferences(report: Record<string, unknown>): string[] {
  const refs: string[] = [];
  for (const finding of Array.isArray(report.findings) ? report.findings : []) {
    if (finding && typeof finding === 'object' && typeof (finding as ReportFinding).source_ref === 'string') refs.push((finding as ReportFinding).source_ref as string);
  }
  for (const field of ['core_issues', 'recommendations']) {
    const sections = report[field];
    if (!Array.isArray(sections)) continue;
    for (const section of sections) {
      if (!section || typeof section !== 'object') continue;
      const value = (section as EvidenceBoundSection).evidence_refs;
      if (Array.isArray(value)) refs.push(...value.filter((ref): ref is string => typeof ref === 'string'));
    }
  }
  return refs;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isMockGeneration(generation: LLMResult<unknown>): boolean {
  return generation.isMock === true || generation.modelName.toLowerCase().includes('mock');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
