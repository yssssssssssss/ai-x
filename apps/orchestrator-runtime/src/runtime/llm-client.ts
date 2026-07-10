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
  tokens?: TokenUsage;
}

export interface LLMClient {
  generateStructured<T>(opts: {
    prompt: string;
    schema: object;
    schemaName: string;
    context?: object;
  }): Promise<LLMResult<T>>;

  generateText(opts: {
    prompt: string;
    context?: object;
  }): Promise<Omit<LLMResult<string>, 'data'> & { text: string }>;
}

// 确定性 hash:同输入同输出,便于测试与复盘对齐。
export function hashPrompt(prompt: string, context?: object): string {
  const h = createHash('sha256');
  h.update(prompt);
  if (context) h.update(JSON.stringify(context));
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
  const report = out as { findings?: Array<Record<string, unknown>> };
  if (Array.isArray(report.findings)) {
    report.findings.unshift({
      statement: `检索到竞品「${String(app)}」:${String(detail).slice(0, 60)}`,
      source: 'tool_result',
      source_ref: 'run/tool_outputs',
    });
  }
  return out;
}

export type FixtureMap = Record<string, unknown>;

export class MockLLMClient implements LLMClient {
  constructor(
    private readonly fixtures: FixtureMap = defaultFixtures,
    private readonly model = { name: process.env.LLM_MODEL_NAME ?? 'mock-llm', version: process.env.LLM_MODEL_VERSION ?? 'v0' },
  ) {}

  async generateStructured<T>(opts: {
    prompt: string; schema: object; schemaName: string; context?: object;
  }): Promise<LLMResult<T>> {
    const data = this.fixtures[opts.schemaName];
    if (data === undefined) {
      throw new Error(`MockLLMClient: 没有为 schemaName="${opts.schemaName}" 预置 fixture`);
    }
    let out = structuredClone(data) as T;
    // report 生成时若 context 带非空 tool_outputs,注入一条来自检索数据的 tool_result 结论,
    // 让 mock 也体现"报告用了真实检索数据"(与 gateway 真实 LLM 行为一致的最小证明)。
    out = injectToolResultFinding(opts.schemaName, opts.context, out);
    return {
      data: out,
      promptHash: hashPrompt(opts.prompt, opts.context),
      modelName: this.model.name,
      modelVersion: this.model.version,
      traceId: traceFrom(opts.prompt, opts.schemaName),
      tokens: { prompt: 0, completion: 0, total: 0 },
    };
  }

  async generateText(opts: { prompt: string; context?: object }) {
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
// 内容均能通过对应 schema 校验,且命中 digital-human skill / o2-web-search tool。
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
      { step_no: 1, step_name: '竞品公开资料检索', actor_type: 'tool', actor_id: 'o2-web-search', purpose: '采集竞品公开能力与评测信息', requires_approval: false },
      { step_no: 2, step_name: '数字人竞品分析', actor_type: 'skill', actor_id: 'digital-human-competitive-analysis', purpose: '逐维对比并归纳差异化机会', requires_approval: false },
    ],
    activated_nodes: ['D1_research_goal', 'D3_method_selection', 'D5_competitive', 'D6_data_sensitivity', 'D7_output_standard'],
    assumptions: [
      { key: 'competitors', value: '默认取该域头部 3 家', editable: true },
    ],
  },
  'research-report': {
    task_id: '__RUNTIME__',
    research_goal: '了解直播场域数字人竞品的能力与体验差异,识别差异化机会',
    findings: [
      { statement: '实时多模态互动是普遍短板,响应延迟集中在 1-3s', source: 'tool_result', source_ref: 'run/tool_outputs/step1.json' },
      { statement: '竞品研究应区分事实与推断,仅凭推断的判断须显式标注', source: 'knowledge_base', source_ref: 'knowledge-base/methods/competitive-research-method.md' },
      { statement: '低延迟实时互动 + 行业垂直内容模板是可切入的差异化方向', source: 'llm_inference' },
    ],
    timeline: [
      { phase: 'W1', activity: '界定对标范围与维度' },
      { phase: 'W2', activity: '竞品公开资料检索与对比' },
      { phase: 'W3', activity: '差异化归纳与报告产出' },
    ],
    deliverables: ['竞品对比矩阵', '差异化机会建议'],
    capability_orchestration: [
      { capability_id: 'o2-web-search', capability_type: 'tool', purpose: '采集竞品公开信息' },
      { capability_id: 'digital-human-competitive-analysis', capability_type: 'skill', purpose: '逐维对比并归纳差异化' },
    ],
    risks_and_open_issues: ['部分竞品能力为推断,需人工确认'],
  },
};
