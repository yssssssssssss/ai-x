import { createHash } from 'node:crypto';

export interface ContextToolOutput {
  toolId: string;
  stepNo?: number;
  outputRef?: string;
  // 旧任务回放可显式传入来源等级；常规运行时缺省，由证据台账按能力类型判定。
  sourceType?: 'tool_result' | 'knowledge_base' | 'user_input' | 'llm_inference' | 'pending_human_review';
  output: unknown;
}

interface Omission {
  field: string;
  reason: 'not_projected' | 'binary' | 'budget_exhausted';
}

export interface ContextBuildResult {
  context: Record<string, unknown>;
  manifest: {
    version: 1;
    callId: string;
    budgetChars: number;
    usedChars: number;
    omittedBaseFields: string[];
    sources: Array<{
      toolId: string;
      stepNo?: number;
      outputRef?: string;
      outputHash: string;
      includedFields: string[];
      omitted: Omission[];
    }>;
  };
}

const DEFAULT_BUDGET = Number(process.env.LLM_CONTEXT_MAX_CHARS ?? 48_000);
const MEDIA_DATA_URL = /^data:(?:image\/|application\/pdf)/i;
const MAX_STRING_CHARS = 1_200;
const GENERIC_FIELDS = ['status', 'engine', 'degraded', 'reasonCode', 'model', 'attempts', 'summary', 'findings', 'evidence', 'assumptions', 'limitations', 'recommendations', 'warnings'];
const TOOL_FIELDS: Record<string, string[]> = {
  'tavily-web-search': ['query', 'answer', 'results'],
  'ai-spider-search': ['query', 'results'],
  'joyspace-search': ['results'],
  'jd-product-search': ['products'],
  'experience-model-lab': ['status', 'summary', 'selectedModels', 'rejectedModels', 'frameworkSummary', 'modelRationale', 'questionTemplates', 'evidenceChunks', 'warnings'],
  'virtual-user-lab': ['status', 'isSimulated', 'summary', 'digitalPersonas', 'reviews', 'aggregate', 'recommendations', 'warnings'],
};

// 只把可审计的证据投影送入模型。预算按最终 JSON 实测，绝不依赖 token 猜测。
export function buildEvidenceContext(input: {
  callId: string;
  base: Record<string, unknown>;
  toolOutputs?: ContextToolOutput[];
  budgetChars?: number;
}): ContextBuildResult {
  const budgetChars = Math.max(256, input.budgetChars ?? DEFAULT_BUDGET);
  const context: Record<string, unknown> = { tool_outputs: [] };
  const omittedBaseFields: string[] = [];
  const sources: ContextBuildResult['manifest']['sources'] = [];

  for (const [field, raw] of Object.entries(input.base)) {
    const value = sanitizeValue(raw);
    if (fits({ ...context, [field]: value }, budgetChars)) context[field] = value;
    else omittedBaseFields.push(field);
  }

  const projected = context.tool_outputs as Array<Record<string, unknown>>;
  for (const item of input.toolOutputs ?? []) {
    const projection = projectOutput(item.toolId, item.output);
    const output: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(projection.value)) {
      const candidate = {
        toolId: item.toolId,
        ...(item.stepNo === undefined ? {} : { stepNo: item.stepNo }),
        output: { ...output, [field]: value },
      };
      if (fits({ ...context, tool_outputs: [...projected, candidate] }, budgetChars)) output[field] = value;
      else projection.omitted.push({ field, reason: 'budget_exhausted' });
    }
    if (Object.keys(output).length > 0) {
      projected.push({
        toolId: item.toolId,
        ...(item.stepNo === undefined ? {} : { stepNo: item.stepNo }),
        output,
      });
    }
    sources.push({
      toolId: item.toolId,
      ...(item.stepNo === undefined ? {} : { stepNo: item.stepNo }),
      ...(item.outputRef ? { outputRef: item.outputRef } : {}),
      outputHash: hash(item.output),
      includedFields: Object.keys(output),
      omitted: projection.omitted,
    });
  }

  const usedChars = JSON.stringify(context).length;
  return {
    context,
    manifest: { version: 1, callId: input.callId, budgetChars, usedChars, omittedBaseFields, sources },
  };
}

function projectOutput(toolId: string, output: unknown): { value: Record<string, unknown>; omitted: Omission[] } {
  const record = output && typeof output === 'object' && !Array.isArray(output)
    ? output as Record<string, unknown>
    : { value: output };
  const fields = toolId === 'attention-analysis-lab'
    ? ['status', 'engine', 'degraded', 'reasonCode', 'model', 'attempts', 'summary', 'hotspots', 'peakAttentionScore', 'focusBalanceScore', 'distractionRiskScore', 'roiAttentionRanking', 'warnings']
    : toolId === 'vision-brand-lab'
      ? ['status', 'engine', 'degraded', 'reasonCode', 'model', 'attempts', 'summary', 'findings', 'recommendations', 'visualReview', 'brandAssociation', 'warnings']
      : toolId === 'aesthetic-quant-lab'
        ? ['status', 'summary', 'overallScore', 'dimensionScores', 'confidence', 'findings', 'recommendations', 'warnings']
        : TOOL_FIELDS[toolId] ?? GENERIC_FIELDS;
  const value: Record<string, unknown> = {};
  const omitted: Omission[] = Object.keys(record)
    .filter((key) => !fields.includes(key))
    .map((field) => ({ field, reason: 'not_projected' }));

  for (const field of fields) {
    if (!(field in record)) continue;
    const sanitized = sanitizeValue(record[field]);
    if (sanitized === BINARY_OMITTED) {
      omitted.push({ field, reason: 'binary' });
      continue;
    }
    value[field] = sanitized;
  }
  return { value, omitted };
}

const BINARY_OMITTED = '[媒体资产已省略]';

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[已省略: 嵌套过深]';
  if (typeof value === 'string') {
    if (MEDIA_DATA_URL.test(value)) return BINARY_OMITTED;
    return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}...[已截断]` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => sanitizeValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !['dataUrl', 'heatmapImage', 'image', 'images', 'raw'].includes(key))
      .map(([key, item]) => [key, sanitizeValue(item, depth + 1)]));
  }
  return value;
}

function fits(value: unknown, budgetChars: number): boolean {
  return JSON.stringify(value).length <= budgetChars;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
