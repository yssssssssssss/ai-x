import { createHash } from 'node:crypto';

// LLM 通道统一接口。业务代码只依赖此接口,不 import 任何 SDK。
// V0 实现 = MockLLMClient(返回预置 fixture);二期加 GatewayLLMClient(内部网关)/ OpenAIAgentLLMClient。
// 硬约束落点:切换 provider 不改 skill / DB / 前台 / 执行日志。

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface LLMResult<T> {
  data: T;
  promptHash: string;
  modelName: string;
  modelVersion: string;
  traceId: string;
  receiptId?: string;
  tokens?: TokenUsage;
  providerIdentity?: LLMProviderIdentity;
  expectedModel?: string;
}

export type LLMFailureKind =
  | 'rate_limit'
  | 'server'
  | 'timeout'
  | 'network'
  | 'quota'
  | 'authentication'
  | 'configuration'
  | 'schema'
  | 'capability'
  | 'unknown';

export class LLMInvocationError extends Error {
  constructor(
    readonly kind: LLMFailureKind,
    readonly retryable: boolean,
    readonly providerStatus: number | null,
    readonly sanitizedMessage: string,
  ) {
    super(sanitizedMessage);
    this.name = 'LLMInvocationError';
  }
}

export type GatewayConfigurationErrorCode =
  | 'PROVIDER_UNCONFIGURED'
  | 'GATEWAY_BASE_URL_MISSING'
  | 'GATEWAY_API_KEY_MISSING'
  | 'GATEWAY_ENDPOINT_INVALID'
  | 'GATEWAY_ROUTE_INVALID'
  | 'GATEWAY_ACTUAL_MODEL_PIN_MISSING';

export class GatewayConfigurationError extends Error {
  readonly name = 'GatewayConfigurationError';

  constructor(
    readonly code: GatewayConfigurationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface LLMReceiptContext {
  stage: string;
  attemptId?: string;
  stepNo?: number;
  contextManifestHash?: string;
  expectedModel?: string;
}

export interface LLMProviderIdentity {
  provider: string;
  endpointHost: string;
  requestedModel: string;
  mode: 'mock' | 'real' | 'draft';
  eligibleAsReal: boolean;
}

export interface LLMCallLimits {
  overallTimeoutMs: number;
  maxHttpAttempts: number;
  maxRetryAfterMs: number;
  maxResponseBytes: number;
  maxOutputTokens: number;
}

export interface StructuredLLMCallOptions {
  prompt: string;
  systemPrompt?: string;
  schema: object;
  schemaName: string;
  context?: object;
  receipt: LLMReceiptContext;
  limits?: LLMCallLimits;
  redirectMode?: 'error';
}

export interface TextLLMCallOptions {
  prompt: string;
  context?: object;
  receipt: LLMReceiptContext;
}

export interface ModelCallRecordInput {
  attemptId?: string;
  stage: string;
  stepNo?: number;
  provider: string;
  endpointHost: string;
  requestedModel: string;
  actualModel: string;
  modelVersion?: string;
  promptHash: string;
  contextManifestHash?: string;
  traceId?: string;
  tokens?: TokenUsage;
  status: 'succeeded' | 'failed';
  failure: Record<string, unknown> | null;
  startedAt: Date;
  finishedAt: Date;
}

export interface ModelCallRecorder {
  recordModelCall(input: ModelCallRecordInput): Promise<string>;
}

export type LegacyStructuredLLMCallOptions = Omit<StructuredLLMCallOptions, 'receipt'> & { receipt?: LLMReceiptContext };
export type LegacyTextLLMCallOptions = Omit<TextLLMCallOptions, 'receipt'> & { receipt?: LLMReceiptContext };

export type TextLLMResult = Omit<LLMResult<string>, 'data'> & { text: string };

export interface LLMClient {
  readonly identity: LLMProviderIdentity;

  generateStructured<T>(opts: StructuredLLMCallOptions): Promise<LLMResult<T>>;

  generateText(opts: TextLLMCallOptions): Promise<TextLLMResult>;
}

// 确定性 hash:同输入同输出,便于测试与复盘对齐。
// schemaId 与可选 system prompt 纳入 hash：同一 user prompt 在不同执行约束下不复用指纹。
export function hashPrompt(
  prompt: string,
  context?: object,
  schemaId?: string,
  systemPrompt?: string,
): string {
  const h = createHash('sha256');
  h.update(prompt);
  if (context) h.update(JSON.stringify(context));
  if (schemaId) h.update(schemaId);
  if (systemPrompt) {
    h.update('\0system\0');
    h.update(systemPrompt);
  }
  return 'sha256:' + h.digest('hex').slice(0, 16);
}

function traceFrom(prompt: string, schemaName: string): string {
  return 'trace_' + createHash('sha256').update(schemaName + prompt).digest('hex').slice(0, 12);
}

// Mock 返回的 fixture 由调用方按 schemaName 决定;这里给出竞品研究主链路所需的默认集。
// 允许注入自定义 fixtures(测试 schema 不合规重试/降级用)。
// report 生成时,若 context 带非空 tool_outputs,把首条检索结果作为 tool_result 结论注入 findings 头部。
// 仅 mock 用:证明"报告确实消费了真实检索数据"这条链路通;gateway 真实 LLM 会自行据 context 生成。
function injectToolResultFinding<T>(schemaName: string, context: object | undefined, out: T): T {
  if (schemaName !== 'research-report' || !context) return out;
  const toolOutputs = (context as { tool_outputs?: Array<{ output?: unknown }> }).tool_outputs;
  if (!Array.isArray(toolOutputs) || toolOutputs.length === 0) return out;
  const first = (toolOutputs[0]?.output as { results?: Array<Record<string, unknown>> })?.results?.[0];
  if (!first) return out;
  const app = first.source_app ?? first.title ?? '竞品';
  const detail = first.design_analysis ?? first.snippet ?? '检索到竞品页面';
  const report = out as {
    findings?: Array<Record<string, unknown>>;
    sub_questions?: Array<{ finding_ids?: string[] }>;
  };
  if (Array.isArray(report.findings)) {
    report.findings.unshift({
      id: 'F0',
      statement: `检索到竞品「${String(app)}」:${String(detail).slice(0, 60)}`,
      source: 'tool_result',
      source_ref: 'run/tool_outputs',
    });
    // 把注入的检索发现接入首个子问题,兑现"报告消费了真实检索数据"的链路证明。
    const firstSq = report.sub_questions?.[0];
    if (firstSq && Array.isArray(firstSq.finding_ids) && !firstSq.finding_ids.includes('F0')) {
      firstSq.finding_ids.unshift('F0');
    }
  }
  return out;
}

interface FixtureSchema {
  const?: unknown;
  enum?: unknown[];
  type?: string | string[];
  required?: string[];
  properties?: Record<string, FixtureSchema>;
  items?: FixtureSchema;
  minItems?: number;
  minimum?: number;
  oneOf?: FixtureSchema[];
  anyOf?: FixtureSchema[];
}

function fixtureValue(schema: FixtureSchema): unknown {
  if (schema.const !== undefined) return structuredClone(schema.const);
  if (schema.enum && schema.enum.length > 0) return structuredClone(schema.enum[0]);
  const alternative = schema.oneOf?.[0] ?? schema.anyOf?.[0];
  if (alternative) return fixtureValue(alternative);
  const type = Array.isArray(schema.type)
    ? schema.type.find((candidate) => candidate !== 'null')
    : schema.type;
  if (type === 'object' || schema.properties) {
    return Object.fromEntries(
      (schema.required ?? []).map((key) => [key, fixtureValue(schema.properties?.[key] ?? {})]),
    );
  }
  if (type === 'array') {
    return Array.from({ length: schema.minItems ?? 0 }, () => fixtureValue(schema.items ?? {}));
  }
  if (type === 'integer') return Math.ceil(schema.minimum ?? 0);
  if (type === 'number') return schema.minimum ?? 0;
  if (type === 'boolean') return false;
  if (type === 'string') return 'mock';
  return {};
}

// Skill mock follows the effective runtime schema, including an inlined domain payload contract.
function skillFixtureFor(schemaName: string, schema: object): unknown | undefined {
  if (!schemaName.startsWith('skill:')) return undefined;
  return fixtureValue(schema as FixtureSchema);
}

export type FixtureMap = Record<string, unknown>;

export class MockLLMClient implements LLMClient {
  constructor(
    private readonly fixtures: FixtureMap = defaultFixtures,
    private readonly model = { name: process.env.LLM_MODEL_NAME ?? 'mock-llm', version: process.env.LLM_MODEL_VERSION ?? 'v0' },
  ) {}

  get identity(): LLMProviderIdentity {
    return {
      provider: 'mock',
      endpointHost: 'local-mock',
      requestedModel: this.model.name,
      mode: 'mock',
      eligibleAsReal: false,
    };
  }

  async generateStructured<T>(opts: LegacyStructuredLLMCallOptions): Promise<LLMResult<T>> {
    const data = this.fixtures[opts.schemaName] ?? skillFixtureFor(opts.schemaName, opts.schema);
    if (data === undefined) {
      throw new Error(`MockLLMClient: 没有为 schemaName="${opts.schemaName}" 预置 fixture`);
    }
    let out = structuredClone(data) as T;
    // report 生成时若 context 带非空 tool_outputs,注入一条来自检索数据的 tool_result 结论,
    // 让 mock 也体现"报告用了真实检索数据"(与 gateway 真实 LLM 行为一致的最小证明)。
    out = injectToolResultFinding(opts.schemaName, opts.context, out);
    return {
      data: out,
      promptHash: hashPrompt(opts.prompt, opts.context, opts.schemaName, opts.systemPrompt),
      modelName: this.model.name,
      modelVersion: this.model.version,
      traceId: traceFrom(opts.prompt, opts.schemaName),
      tokens: { prompt: 0, completion: 0, total: 0 },
    };
  }

  async generateText(opts: LegacyTextLLMCallOptions): Promise<TextLLMResult> {
    return {
      text: (this.fixtures['__text__'] as string) ?? '（mock 文本输出）',
      promptHash: hashPrompt(opts.prompt, opts.context),
      modelName: this.model.name,
      modelVersion: this.model.version,
      traceId: traceFrom(opts.prompt, 'text'),
      tokens: { prompt: 0, completion: 0, total: 0 },
    };
  }
}

// 竞品研究主链路默认 fixture:段1 ResearchTask、段2 决策状态与计划、段4 报告。
// 内容均能通过对应 schema 校验,且命中 digital-human skill / tavily-web-search tool。
export const defaultFixtures: FixtureMap = {
  'research-task': {
    task_type: 'competitive_research',
    business_domain: 'live_commerce',
    research_goal: '了解直播场域数字人竞品的能力与体验差异,识别差异化机会',
    assumptions: [
      { key: 'competitors', value: '默认取该域头部 3 家', editable: true },
      { key: 'time_window', value: '近 12 个月公开资料', editable: true },
      { key: 'report_format', value: '竞品对比矩阵 + 差异化建议', editable: true },
    ],
    confirmations: [
      { key: 'competitor_list', question: '是否指定对标竞品?', suggestion: '默认头部 3 家' },
    ],
    blocking_issues: [],
    sensitivity: 'internal',
    pii_detected: false,
  },
  // 段2:对激活节点的判定(数组,逐条过 decision-state.schema)
  'decision-states': [
    { node_key: 'D1_research_goal', state: 'satisfied', reason: '研究目标已明确:数字人竞品能力与体验差异', confidence: 0.9, user_override: null, final_state: 'satisfied' },
    { node_key: 'D3_method_selection', state: 'need_execute', reason: '需用竞品分析方法,命中 digital-human skill', confidence: 0.85, user_override: null, final_state: 'need_execute' },
    { node_key: 'D5_competitive', state: 'need_execute', reason: '用户明确要做竞品参照', confidence: 0.95, user_override: null, final_state: 'need_execute' },
    { node_key: 'D6_data_sensitivity', state: 'satisfied', reason: '仅用公开信息,无 PII,无需审批', confidence: 0.8, user_override: null, final_state: 'satisfied' },
    { node_key: 'D7_output_standard', state: 'satisfied', reason: '默认竞品对比矩阵 + 差异化建议', confidence: 0.8, user_override: null, final_state: 'satisfied' },
  ],
  'execution-plan': {
    task_id: '__RUNTIME__',
    task_type: 'competitive_research',
    steps: [
      { step_no: 1, step_name: '竞品公开资料检索', actor_type: 'tool', actor_id: 'tavily-web-search', purpose: '采集竞品公开能力与评测信息', requires_approval: false },
      { step_no: 2, step_name: '数字人竞品分析', actor_type: 'skill', actor_id: 'digital-human-competitive-analysis', purpose: '逐维对比并归纳差异化机会', requires_approval: false },
    ],
    activated_nodes: ['D1_research_goal', 'D3_method_selection', 'D5_competitive', 'D6_data_sensitivity', 'D7_output_standard'],
    assumptions: [
      { key: 'competitors', value: '默认取该域头部 3 家', editable: true },
    ],
  },
  // 段2c 候选计划(candidates,恰好 2 份 depth/speed);steps 只用真实存在的能力(过幻觉校验)。
  // depth = tool + skill + reviewer(可测复核回流);speed = tool + llm(可测 llm 步)。
  'current-plan-candidates': {
    candidates: [
      {
        id: 'depth',
        title: '深度优先·方法论覆盖',
        rationale: '按 JTBD 全维度对比 + 质量复核,覆盖广、结论可追溯。',
        tradeoffs: '耗时约翻倍,步骤多。',
        steps: [
          { step_no: 1, step_name: '竞品公开资料检索', actor_type: 'tool', actor_id: 'tavily-web-search', purpose: '采集竞品公开能力与评测', requires_approval: false },
          { step_no: 2, step_name: '数字人竞品分析', actor_type: 'skill', actor_id: 'competitive-analysis', purpose: '逐维对比并归纳差异化', requires_approval: false },
          { step_no: 3, step_name: '质量复核', actor_type: 'reviewer', actor_id: '质量复核', purpose: '检查来源标注与数据缺口', requires_approval: false },
        ],
        assumptions: [{ key: 'competitors', value: '默认取该域头部 3 家', editable: true }],
      },
      {
        id: 'speed',
        title: '速度优先·关键结论',
        rationale: '最短路径:检索后直接归纳关键差异。',
        tradeoffs: '省去复核,覆盖窄可能漏点。',
        steps: [
          { step_no: 1, step_name: '竞品公开资料检索', actor_type: 'tool', actor_id: 'tavily-web-search', purpose: '采集竞品公开信息', requires_approval: false },
          { step_no: 2, step_name: '快速差异化归纳', actor_type: 'llm', actor_id: '快速归纳', purpose: '基于检索直接归纳', requires_approval: false },
        ],
        assumptions: [{ key: 'competitors', value: '默认取该域头部 3 家', editable: true }],
      },
    ],
  },
  'research-report': {
    task_id: '__RUNTIME__',
    research_goal: '了解直播场域数字人竞品的能力与体验差异,识别差异化机会',
    method_summary: '通过公开资料检索 + 数字人竞品分析方法,综合归纳能力与体验差异',
    findings: [
      { id: 'F1', statement: '实时多模态互动是普遍短板,响应延迟集中在 1-3s', source: 'tool_result', source_ref: 'run/tool_outputs/step1.json' },
      { id: 'F2', statement: '竞品研究应区分事实与推断,仅凭推断的判断须显式标注', source: 'knowledge_base', source_ref: 'knowledge-base/methods/competitive-research-method.md' },
      { id: 'F3', statement: '低延迟实时互动 + 行业垂直内容模板是可切入的差异化方向', source: 'llm_inference' },
    ],
    sub_questions: [
      {
        question: '竞品数字人的实时互动能力处于什么水平?',
        finding_ids: ['F1'],
        analysis: [{ statement: '实时性是行业共性短板,谁先压低延迟谁占先机', based_on: ['F1'] }],
        summary: '实时互动能力普遍不足,是可切入的突破口。',
      },
      {
        question: '京东可切入的差异化方向是什么?',
        finding_ids: ['F1', 'F3'],
        analysis: [{ statement: '低延迟 + 垂直内容模板组合是当前空白位', based_on: ['F1', 'F3'] }],
        summary: '建议以低延迟实时互动叠加行业垂直模板作为差异化主线。',
      },
    ],
    overall_conclusion: [
      '优先补齐低延迟实时互动能力,对齐并超越竞品共性短板。',
      '以行业垂直内容模板构建差异化,避免同质化竞争。',
    ],
    timeline: [
      { phase: 'W1', activity: '界定对标范围与维度' },
      { phase: 'W2', activity: '竞品公开资料检索与对比' },
      { phase: 'W3', activity: '差异化归纳与报告产出' },
    ],
    deliverables: ['竞品能力研究报告', '差异化机会建议'],
    capability_orchestration: [
      { capability_id: 'tavily-web-search', capability_type: 'tool', purpose: '采集竞品公开信息' },
      { capability_id: 'digital-human-competitive-analysis', capability_type: 'skill', purpose: '逐维对比并归纳差异化' },
    ],
    risks_and_open_issues: ['部分竞品能力为推断,需人工确认'],
  },
};
