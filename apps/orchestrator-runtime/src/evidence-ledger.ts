import type { ContextToolOutput } from './runtime/context-builder.ts';

export type EvidenceSourceType =
  | 'tool_result'
  | 'knowledge_base'
  | 'user_input'
  | 'llm_inference'
  | 'pending_human_review';

export interface EvidenceLedgerEntry {
  id: string;
  source_ref: string;
  source_type: EvidenceSourceType;
  step_no: number;
  capability_id: string;
  kind: 'finding' | 'evidence' | 'summary';
  statement: string;
  dimensions: string[];
  limitations: string[];
}

export interface EvidenceLedgerSource {
  ref: string;
  step_no: number;
  capability_id: string;
  status: string;
  entry_ids: string[];
  omitted_entry_count: number;
  limitations: string[];
}

export interface EvidenceLedger {
  version: 1;
  sources: EvidenceLedgerSource[];
  entries: EvidenceLedgerEntry[];
  limitations: string[];
}

const MAX_ENTRIES_PER_SOURCE = 8;
const MAX_TOTAL_ENTRIES = 40;
const MAX_TEXT_CHARS = 500;
const MAX_LIMITATIONS_PER_SOURCE = 5;
const MAX_DIMENSIONS = 6;

// 将每个已落盘的步骤输出转换为统一、可引用的证据索引。原始输出仍在 tool_outputs 中，
// 台账只保留汇总所需的短文本和来源，避免把媒体或无关大字段带入报告上下文。
export function buildEvidenceLedger(outputs: ContextToolOutput[]): EvidenceLedger {
  const sources: EvidenceLedgerSource[] = [];
  const entries: EvidenceLedgerEntry[] = [];

  for (const [index, item] of outputs.entries()) {
    const stepNo = item.stepNo ?? index + 1;
    const sourceRef = `tool:${stepNo}:${item.toolId}`;
    const record = asRecord(item.output);
    const limitations = collectLimitations(record);
    const sourceEntries = collectEntries({
      record,
      sourceRef,
      stepNo,
      capabilityId: item.toolId,
      limitations,
      defaultSourceType: item.sourceType ?? inferSourceType(item.toolId),
    });
    const remaining = Math.max(0, MAX_TOTAL_ENTRIES - entries.length);
    const included = sourceEntries.slice(0, Math.min(MAX_ENTRIES_PER_SOURCE, remaining));
    entries.push(...included);
    sources.push({
      ref: sourceRef,
      step_no: stepNo,
      capability_id: item.toolId,
      status: readText(record.status) ?? 'succeeded',
      entry_ids: included.map((entry) => entry.id),
      omitted_entry_count: Math.max(0, sourceEntries.length - included.length),
      limitations,
    });
  }

  return {
    version: 1,
    sources,
    entries,
    limitations: unique(sources.flatMap((source) => source.limitations)),
  };
}

export function evidenceReferenceIds(ledger: EvidenceLedger): string[] {
  return [...new Set([
    ...ledger.entries.map((entry) => entry.id),
    ...ledger.sources.map((source) => source.ref),
  ])];
}

// LLM 中间小结仍保留在台账中用于审计，但不能反过来作为“外部事实”的证据引用。
export function factualEvidenceReferenceIds(ledger: EvidenceLedger): string[] {
  const factualEntries = ledger.entries.filter((entry) => (
    entry.source_type === 'tool_result'
    || entry.source_type === 'knowledge_base'
    || entry.source_type === 'user_input'
  ));
  const factualIds = new Set(factualEntries.map((entry) => entry.id));
  return [...new Set([
    ...factualIds,
    ...ledger.sources
      .filter((source) => source.entry_ids.some((id) => factualIds.has(id)))
      .map((source) => source.ref),
  ])];
}

function collectEntries(input: {
  record: Record<string, unknown>;
  sourceRef: string;
  stepNo: number;
  capabilityId: string;
  limitations: string[];
  defaultSourceType: EvidenceSourceType;
}): EvidenceLedgerEntry[] {
  const { record, sourceRef, stepNo, capabilityId, limitations, defaultSourceType } = input;
  const entries: EvidenceLedgerEntry[] = [];
  const usedIds = new Set<string>();
  const append = (kind: EvidenceLedgerEntry['kind'], statement: string, sourceType: EvidenceSourceType, dimensions: string[], hint: string) => {
    const id = uniqueId(`evidence:${stepNo}:${capabilityId}:${hint}`, usedIds);
    entries.push({
      id,
      source_ref: sourceRef,
      source_type: sourceType,
      step_no: stepNo,
      capability_id: capabilityId,
      kind,
      statement: truncate(statement),
      dimensions,
      limitations,
    });
  };

  collectListEntries({
    items: Array.isArray(record.findings) ? record.findings : [],
    kind: 'finding', prefix: 'finding', defaultSourceType, append,
  });
  // 兼容上线前生成的竞品 Skill 产物。它们已保存了有效结论，但尚未采用统一结果信封。
  collectListEntries({
    items: nestedArray(record, 'key_findings', 'findings'),
    kind: 'finding', prefix: 'key-finding', defaultSourceType, append,
  });
  collectListEntries({
    items: nestedArray(record, 'opportunities_and_risks', 'opportunities'),
    kind: 'finding', prefix: 'opportunity', defaultSourceType, append,
  });
  collectListEntries({
    items: nestedArray(record, 'opportunities_and_risks', 'risks'),
    kind: 'finding', prefix: 'risk', defaultSourceType, append,
  });
  collectListEntries({
    items: nestedArray(record, 'capability_boundaries', 'key_boundaries'),
    kind: 'finding', prefix: 'boundary', defaultSourceType, append,
  });
  collectListEntries({
    items: Array.isArray(record.evidence) ? record.evidence : [],
    kind: 'evidence', prefix: 'evidence', defaultSourceType, append,
  });

  if (entries.length === 0) {
    const summary = readText(record.summary) ?? readText(record.note) ?? readText(record.answer) ?? statusSummary(record);
    if (summary) append('summary', summary, defaultSourceType, readDimensions(record), 'summary');
  }
  return entries;
}

function collectListEntries(input: {
  items: unknown[];
  kind: EvidenceLedgerEntry['kind'];
  prefix: string;
  defaultSourceType: EvidenceSourceType;
  append: (kind: EvidenceLedgerEntry['kind'], statement: string, sourceType: EvidenceSourceType, dimensions: string[], hint: string) => void;
}): void {
  for (const [index, value] of input.items.entries()) {
    const item = asRecord(value);
    const directStatement = readText(value)
      ?? readText(item.statement)
      ?? readText(item.summary)
      ?? readText(item.finding)
      ?? readText(item.what_it_means)
      ?? readText(item.description)
      ?? readText(item.excerpt);
    const title = readText(item.title);
    const rationale = readText(item.why);
    const statement = directStatement
      ?? (title && rationale ? `${title}: ${rationale}` : undefined)
      ?? title
      ?? rationale;
    if (!statement) continue;
    input.append(
      input.kind,
      statement,
      readSourceType(item.source_type) ?? input.defaultSourceType,
      readDimensions(item),
      readText(item.id) ?? `${input.prefix}-${index + 1}`,
    );
  }
}

function nestedArray(record: Record<string, unknown>, parent: string, child: string): unknown[] {
  const value = asRecord(record[parent])[child];
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || /^data:(?:image\/|application\/pdf)/i.test(trimmed)) return undefined;
  return trimmed;
}

function readSourceType(value: unknown): EvidenceSourceType | undefined {
  return ['tool_result', 'knowledge_base', 'user_input', 'llm_inference', 'pending_human_review'].includes(String(value))
    ? value as EvidenceSourceType
    : undefined;
}

function readDimensions(value: Record<string, unknown>): string[] {
  const values = [value.dimension, value.category, ...(Array.isArray(value.tags) ? value.tags : [])];
  return unique(values.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => truncate(item.trim(), 80))).slice(0, MAX_DIMENSIONS);
}

function collectLimitations(record: Record<string, unknown>): string[] {
  const values = [
    ...(Array.isArray(record.limitations) ? record.limitations : limitationValues(record.limitations)),
    ...(Array.isArray(record.warnings) ? record.warnings : []),
    ...nestedArray(record, 'evidence_gaps_and_next_search_plan', 'gaps').map((gap) => readText(asRecord(gap).description)),
  ].filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => truncate(item.trim()));
  if (record.degraded === true || readText(record.status) === 'degraded') values.push('该步骤已降级，结论需结合限制解释。');
  return unique(values).slice(0, MAX_LIMITATIONS_PER_SOURCE);
}

function limitationValues(value: unknown): unknown[] {
  const record = asRecord(value);
  return [record.statement, ...(Array.isArray(record.items) ? record.items : [])];
}

function inferSourceType(capabilityId: string): EvidenceSourceType {
  return capabilityId === 'llm' ? 'llm_inference' : 'tool_result';
}

function statusSummary(record: Record<string, unknown>): string | undefined {
  const status = readText(record.status);
  if (!status) return undefined;
  const reason = readText(record.reason) ?? readText(record.reasonCode);
  return reason ? `步骤状态: ${status} (${reason})` : `步骤状态: ${status}`;
}

function uniqueId(base: string, used: Set<string>): string {
  const normalized = base.replace(/[^a-zA-Z0-9:_-]/g, '_');
  let id = normalized;
  let suffix = 2;
  while (used.has(id)) id = `${normalized}-${suffix++}`;
  used.add(id);
  return id;
}

function truncate(value: string, limit = MAX_TEXT_CHARS): string {
  return value.length > limit ? `${value.slice(0, limit)}...[已截断]` : value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
