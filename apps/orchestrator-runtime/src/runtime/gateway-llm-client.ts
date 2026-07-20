import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type LLMClient,
  type LLMResult,
  type TokenUsage,
  hashPrompt,
} from './llm-client.ts';

// 真实 LLM 通道:京东内网网关,支持多模型热切换 fallback。
// 协议:OpenAI 兼容 /chat/completions 与 Gemini 原生 /responses 双通道。
// 遇到 429 配额耗尽 / 5xx / 超时时按 LLM_MODEL_FALLBACKS 顺序切下一个模型继续,不重启进程。

interface ModelSpec {
  name: string;
  endpoint: '/chat/completions' | '/responses';
  protocol: 'openai' | 'gemini';
}

// 已知模型注册表(未列入的默认按 OpenAI 处理)。
const MODEL_TABLE: Record<string, Omit<ModelSpec, 'name'>> = {
  'GPT-5.2-joybuilder':                 { endpoint: '/chat/completions', protocol: 'openai' },
  'Kimi-K2.6-joybuilder':               { endpoint: '/chat/completions', protocol: 'openai' },
  'Gemini-3.1-Pro-Preview-joybuilder':  { endpoint: '/responses',         protocol: 'gemini' },
};

function resolveModel(name: string): ModelSpec {
  const spec = MODEL_TABLE[name] ?? { endpoint: '/chat/completions' as const, protocol: 'openai' as const };
  return { name, ...spec };
}

interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  chain: ModelSpec[];   // 尝试链:主 + fallbacks
  timeoutMs: number;
}

class RateLimitError extends Error {
  constructor(public readonly retryAfterMs: number | undefined, public readonly quotaExhausted: boolean) {
    super(quotaExhausted ? '网关配额已用尽' : '网关限流 HTTP 429');
    this.name = 'RateLimitError';
  }
}

class SwitchModelError extends Error {
  constructor(public readonly reason: string) { super(reason); this.name = 'SwitchModelError'; }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function readConfig(): GatewayConfig {
  const baseUrl = process.env.LLM_GATEWAY_BASE_URL;
  const apiKey = process.env.LLM_GATEWAY_API_KEY;
  const primary = process.env.LLM_MODEL_NAME;
  if (!baseUrl) throw new Error('GatewayLLMClient: 缺少 LLM_GATEWAY_BASE_URL');
  if (!apiKey) throw new Error('GatewayLLMClient: 缺少 LLM_GATEWAY_API_KEY');
  if (!primary) throw new Error('GatewayLLMClient: 缺少 LLM_MODEL_NAME');
  const fbRaw = process.env.LLM_MODEL_FALLBACKS ?? '';
  const chainNames = [primary, ...fbRaw.split(',').map((s) => s.trim()).filter(Boolean)];
  const chain = chainNames.map(resolveModel);
  return { baseUrl, apiKey, chain, timeoutMs: Number(process.env.LLM_GATEWAY_TIMEOUT_MS ?? 30000) };
}

// schema 提示词构造(所有模型统一走 prompt 引导,不依赖 response_format)。
function schemaHint(schemaName: string, schema?: object): string {
  if (schema && Object.keys(schema).length > 0) {
    return `输出的 JSON 必须严格符合以下 JSON Schema:\n${JSON.stringify(schema)}`;
  }
  const dir = join(process.cwd(), 'schemas');
  if (schemaName === 'decision-states') {
    const one = readFileSync(join(dir, 'decision-state.schema.json'), 'utf8');
    return `输出一个 JSON 数组,数组每一项都必须符合以下 JSON Schema:\n${one}\n注意:顶层是数组,但因为 response_format 要求 JSON object,请用 {"items": [...]} 包裹,items 为该数组。`;
  }
  try {
    const s = readFileSync(join(dir, `${schemaName}.schema.json`), 'utf8');
    return `输出的 JSON 必须严格符合以下 JSON Schema:\n${s}`;
  } catch {
    return `输出符合 "${schemaName}" 结构的 JSON。`;
  }
}

interface Normalized {
  content: string;
  modelName: string;
  traceId: string;
  usage: TokenUsage;
}

// 判断响应是否是"配额耗尽" —— 触发模型热切换。JD 网关格式:{"error":{"code":2001,"message":"模型配额已用尽"}}
function isQuotaExhausted(status: number, bodyText: string): boolean {
  if (status !== 429) return false;
  try {
    const j = JSON.parse(bodyText);
    const code = j?.error?.code;
    const msg = String(j?.error?.message ?? '');
    return code === 2001 || /配额|quota|exhaust|额度/i.test(msg);
  } catch { return false; }
}

// OpenAI 兼容(GPT-5.2 / Kimi):body = {model, messages, ...};响应 = {choices[0].message.content}
// Kimi 特色:content 空时读 reasoning_content 兜底。
function buildOpenAIBody(model: string, messages: object[], jsonMode: boolean): object {
  return {
    model,
    messages,
    stream: false,
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  };
}
function parseOpenAI(raw: any): { content: string; model: string; traceId: string; usage: TokenUsage } {
  const msg = raw?.choices?.[0]?.message;
  const content = msg?.content || msg?.reasoning_content || '';
  if (!content) throw new Error(`OpenAI 响应缺 content/reasoning_content: ${String(JSON.stringify(raw) ?? 'undefined').slice(0, 200)}`);
  return {
    content,
    model: raw?.model ?? '',
    traceId: raw?.id ?? '',
    usage: {
      prompt: raw?.usage?.prompt_tokens ?? 0,
      completion: raw?.usage?.completion_tokens ?? 0,
      total: raw?.usage?.total_tokens ?? 0,
    },
  };
}

// Gemini 原生(/responses):body = {model, contents:[{role, parts:[{text}]}]};响应 = {candidates[0].content.parts[*].text}
function buildGeminiBody(model: string, messages: Array<{ role: string; content: string }>, jsonMode: boolean): object {
  // 拍平 system → 融入第一条 user;role: user/assistant/system → user/model
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');
  const contents = rest.map((m, i) => {
    let text = m.content;
    if (i === 0 && sys) text = `${sys}\n\n${text}`;
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text }] };
  });
  // Gemini 网关默认 maxOutputTokens 偏小,长 JSON/长文本会被截断(finishReason=MAX_TOKENS);显式放大。
  const generationConfig: Record<string, unknown> = { maxOutputTokens: 16384 };
  if (jsonMode) generationConfig.responseMimeType = 'application/json';
  return { model, contents, stream: false, generationConfig };
}
function parseGemini(raw: any): { content: string; model: string; traceId: string; usage: TokenUsage } {
  const parts = raw?.candidates?.[0]?.content?.parts ?? [];
  const content = parts.map((p: any) => p?.text ?? '').join('').trim();
  if (!content) throw new Error(`Gemini 响应缺 candidates[0].content.parts[*].text: ${String(JSON.stringify(raw) ?? 'undefined').slice(0, 200)}`);
  const meta = raw?.usageMetadata ?? {};
  return {
    content,
    model: raw?.modelVersion ?? raw?.model ?? '',
    traceId: raw?.responseId ?? '',
    usage: {
      prompt: meta.promptTokenCount ?? 0,
      completion: meta.candidatesTokenCount ?? 0,
      total: meta.totalTokenCount ?? 0,
    },
  };
}

export class GatewayLLMClient implements LLMClient {
  private readonly cfg: GatewayConfig;

  constructor(cfg?: Partial<GatewayConfig>) {
    this.cfg = { ...readConfig(), ...cfg };
  }

  // 一次逻辑请求 = 遍历 chain,当前模型失败(quota/5xx/timeout)则切下一个。同模型内 429 临时限流按 3 次退避。
  private async call(messages: object[], jsonMode: boolean): Promise<Normalized> {
    const errs: string[] = [];
    for (const model of this.cfg.chain) {
      try {
        return await this.callWithBackoff(model, messages, jsonMode);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errs.push(`[${model.name}] ${msg}`);
        // 只有"配额耗尽 / 5xx / 超时 / SwitchModel"才切下个;其它错误(如响应缺字段)不该跨模型重试
        if (err instanceof RateLimitError && err.quotaExhausted) continue;
        if (err instanceof SwitchModelError) continue;
        // 未知错但网关侧(fetch/5xx/timeout)也切
        if (err instanceof Error && /HTTP 5\d\d|AbortError|timed?\s*out|fetch failed/i.test(err.message)) continue;
        throw err;
      }
    }
    throw new Error(`所有模型均失败:\n${errs.join('\n')}`);
  }

  private async callWithBackoff(model: ModelSpec, messages: object[], jsonMode: boolean): Promise<Normalized> {
    const maxAttempts = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.callModelOnce(model, messages, jsonMode);
      } catch (err) {
        lastErr = err;
        // 配额耗尽不重试(退回上层切下一模型)
        if (err instanceof RateLimitError && err.quotaExhausted) throw err;
        // 临时 429 才退避
        if (err instanceof RateLimitError && attempt < maxAttempts) {
          await sleep(err.retryAfterMs ?? attempt * 5000);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  private async callModelOnce(model: ModelSpec, messages: any[], jsonMode: boolean): Promise<Normalized> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
    try {
      const body = model.protocol === 'gemini'
        ? buildGeminiBody(model.name, messages, jsonMode)
        : buildOpenAIBody(model.name, messages, jsonMode);
      const res = await fetch(`${this.cfg.baseUrl}${model.endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (res.status === 429) {
        const text = await res.text();
        const retryAfter = Number(res.headers.get('retry-after')) * 1000;
        throw new RateLimitError(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
          isQuotaExhausted(429, text),
        );
      }
      if (!res.ok) {
        throw new Error(`${model.name} 网关 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const raw = await res.json();
      if ((raw as any)?.error) throw new SwitchModelError(`${model.name} 返回 error: ${JSON.stringify((raw as any).error).slice(0, 200)}`);
      const parsed = model.protocol === 'gemini' ? parseGemini(raw) : parseOpenAI(raw);
      return {
        content: parsed.content,
        modelName: parsed.model || model.name,
        traceId: parsed.traceId || 'gateway-no-id',
        usage: parsed.usage,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async generateStructured<T>(opts: {
    prompt: string; schema: object; schemaName: string; context?: object;
  }): Promise<LLMResult<T>> {
    const messages = [
      { role: 'system', content: `你是用研任务编排器。只输出 JSON,不要任何解释或 markdown 代码块。\n${schemaHint(opts.schemaName, opts.schema)}` },
      { role: 'user', content: opts.context ? `${opts.prompt}\n\n上下文:\n${JSON.stringify(opts.context)}` : opts.prompt },
    ];
    const norm = await this.call(messages, true);
    let parsed: unknown;
    try { parsed = JSON.parse(norm.content); }
    catch { throw new Error(`网关返回非法 JSON(schemaName=${opts.schemaName}, model=${norm.modelName}): ${String(norm?.content ?? '').slice(0, 200)}`); }
    const data = opts.schemaName === 'decision-states' && parsed && typeof parsed === 'object' && 'items' in parsed
      ? (parsed as { items: unknown }).items
      : parsed;
    return {
      data: data as T,
      promptHash: hashPrompt(opts.prompt, opts.context),
      modelName: norm.modelName,
      modelVersion: norm.modelName,
      traceId: norm.traceId,
      tokens: norm.usage,
    };
  }

  async generateText(opts: { prompt: string; context?: object }) {
    const messages = [
      { role: 'user', content: opts.context ? `${opts.prompt}\n\n上下文:\n${JSON.stringify(opts.context)}` : opts.prompt },
    ];
    const norm = await this.call(messages, false);
    return {
      text: norm.content,
      promptHash: hashPrompt(opts.prompt, opts.context),
      modelName: norm.modelName,
      modelVersion: norm.modelName,
      traceId: norm.traceId,
      tokens: norm.usage,
    };
  }
}
