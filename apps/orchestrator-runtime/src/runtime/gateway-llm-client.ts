import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type LLMClient,
  type LLMResult,
  type TokenUsage,
  hashPrompt,
} from './llm-client.ts';

// 真实 LLM 通道:京东内网网关(OpenAI 兼容 /v1/chat/completions)。
// 只用 Node20 内置 fetch,不引入任何 SDK。实现与 MockLLMClient 完全相同的 interface。
// 结构化输出用 response_format:{type:'json_object'}(网关已验证支持;json_schema strict 不支持)。

interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

class RateLimitError extends Error {
  constructor(public readonly retryAfterMs?: number) {
    super('网关限流 HTTP 429');
    this.name = 'RateLimitError';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function readConfig(): GatewayConfig {
  const baseUrl = process.env.LLM_GATEWAY_BASE_URL;
  const apiKey = process.env.LLM_GATEWAY_API_KEY;
  const model = process.env.LLM_MODEL_NAME;
  if (!baseUrl) throw new Error('GatewayLLMClient: 缺少 LLM_GATEWAY_BASE_URL');
  if (!apiKey) throw new Error('GatewayLLMClient: 缺少 LLM_GATEWAY_API_KEY');
  if (!model) throw new Error('GatewayLLMClient: 缺少 LLM_MODEL_NAME');
  return { baseUrl, apiKey, model, timeoutMs: Number(process.env.LLM_GATEWAY_TIMEOUT_MS ?? 30000) };
}

// 结构化输出的 schema 说明:按 schemaName 从 schemas/ 加载真实 JSON Schema 塞进 prompt,
// 让 LLM 精确按结构产出。decision-states 是 decision-state 的数组(无独立文件),特殊处理。
function schemaHint(schemaName: string): string {
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

interface ChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

export class GatewayLLMClient implements LLMClient {
  private readonly cfg: GatewayConfig;

  constructor(cfg?: Partial<GatewayConfig>) {
    this.cfg = { ...readConfig(), ...cfg };
  }

  // 带 429 限流退避的重试外层(网关有 per-minute token 上限)。
  private async call(messages: object[], jsonMode: boolean): Promise<{ content: string; resp: ChatResponse }> {
    const maxAttempts = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.callOnce(messages, jsonMode);
      } catch (err) {
        lastErr = err;
        // 仅对 429 限流退避重试;其它错误立即抛出
        if (err instanceof RateLimitError && attempt < maxAttempts) {
          await sleep(err.retryAfterMs ?? attempt * 5000);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  private async callOnce(messages: object[], jsonMode: boolean): Promise<{ content: string; resp: ChatResponse }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: this.cfg.model,
          messages,
          stream: false,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: ac.signal,
      });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after')) * 1000;
        throw new RateLimitError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
      }
      if (!res.ok) {
        throw new Error(`网关返回 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const resp = (await res.json()) as ChatResponse;
      if (resp.error) throw new Error(`网关错误: ${resp.error.message}`);
      const content = resp.choices?.[0]?.message?.content;
      if (content == null) throw new Error('网关响应缺少 choices[0].message.content');
      return { content, resp };
    } finally {
      clearTimeout(timer);
    }
  }

  private usageOf(resp: ChatResponse): TokenUsage {
    return {
      prompt: resp.usage?.prompt_tokens ?? 0,
      completion: resp.usage?.completion_tokens ?? 0,
      total: resp.usage?.total_tokens ?? 0,
    };
  }

  async generateStructured<T>(opts: {
    prompt: string; schema: object; schemaName: string; context?: object;
  }): Promise<LLMResult<T>> {
    const messages = [
      {
        role: 'system',
        content: `你是用研任务编排器。只输出 JSON,不要任何解释或 markdown 代码块。\n${schemaHint(opts.schemaName)}`,
      },
      {
        role: 'user',
        content: opts.context
          ? `${opts.prompt}\n\n上下文:\n${JSON.stringify(opts.context)}`
          : opts.prompt,
      },
    ];
    const { content, resp } = await this.call(messages, true);

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`网关返回非法 JSON(schemaName=${opts.schemaName}): ${content.slice(0, 200)}`);
    }
    // decision-states 用 {items:[...]} 包裹返回,拆出数组
    const data = opts.schemaName === 'decision-states' && parsed && typeof parsed === 'object' && 'items' in parsed
      ? (parsed as { items: unknown }).items
      : parsed;

    return {
      data: data as T,
      promptHash: hashPrompt(opts.prompt, opts.context),
      modelName: resp.model ?? this.cfg.model,
      modelVersion: resp.model ?? this.cfg.model,
      traceId: resp.id ?? 'gateway-no-id',
      tokens: this.usageOf(resp),
    };
  }

  async generateText(opts: { prompt: string; context?: object }) {
    const messages = [
      {
        role: 'user',
        content: opts.context ? `${opts.prompt}\n\n上下文:\n${JSON.stringify(opts.context)}` : opts.prompt,
      },
    ];
    const { content, resp } = await this.call(messages, false);
    return {
      text: content,
      promptHash: hashPrompt(opts.prompt, opts.context),
      modelName: resp.model ?? this.cfg.model,
      modelVersion: resp.model ?? this.cfg.model,
      traceId: resp.id ?? 'gateway-no-id',
      tokens: this.usageOf(resp),
    };
  }
}
