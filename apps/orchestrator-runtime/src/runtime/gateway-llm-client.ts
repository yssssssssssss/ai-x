import {
  type LegacyStructuredLLMCallOptions,
  type LegacyTextLLMCallOptions,
  type LLMClient,
  type LLMProviderIdentity,
  LLMInvocationError,
  type LLMResult,
  type TextLLMResult,
  type TokenUsage,
  hashPrompt,
} from './llm-client.ts';
import { resolveSchema, loadSchemaText, type SchemaSpec } from './schema-registry.ts';

// 真实 LLM 通道:京东内网网关(OpenAI 兼容 /v1/chat/completions)。
// 只用 Node20 内置 fetch,不引入任何 SDK。实现与 MockLLMClient 完全相同的 interface。
// 结构化输出用 response_format:{type:'json_object'}(网关已验证支持;json_schema strict 不支持)。

export interface GatewayModelRoute {
  requestedModel: string;
  expectedActualModel: string;
}

interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  modelRoutes: GatewayModelRoute[];
  timeoutMs: number;
}

class RateLimitError extends LLMInvocationError {
  constructor(
    public readonly retryAfterMs?: number,
    message = 'gateway HTTP 429',
  ) {
    super('rate_limit', true, 429, message);
    this.name = 'RateLimitError';
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function parseModelRoutes(raw: string | undefined, fallbackModel: string | undefined): GatewayModelRoute[] {
  if (!raw?.trim()) {
    if (!fallbackModel) throw new Error('GatewayLLMClient: 缺少 LLM_MODEL_NAME');
    return [{
      requestedModel: fallbackModel,
      expectedActualModel: process.env.LLM_EXPECTED_ACTUAL_MODEL?.trim() || fallbackModel,
    }];
  }
  const routes = raw.split(',').map((entry) => {
    const separator = entry.indexOf('=');
    const requestedModel = separator > 0 ? entry.slice(0, separator).trim() : '';
    const expectedActualModel = separator > 0 ? entry.slice(separator + 1).trim() : '';
    if (!requestedModel || !expectedActualModel) {
      throw new Error('GatewayLLMClient: LLM_MODEL_ROUTES 需为 requested=expectedActual 逗号列表');
    }
    return { requestedModel, expectedActualModel };
  });
  if (new Set(routes.map(({ requestedModel }) => requestedModel)).size !== routes.length) {
    throw new Error('GatewayLLMClient: LLM_MODEL_ROUTES 包含重复 requested model');
  }
  return routes;
}

function readConfig(): GatewayConfig {
  const baseUrl = process.env.LLM_GATEWAY_BASE_URL;
  const apiKey = process.env.LLM_GATEWAY_API_KEY;
  if (!baseUrl) throw new Error('GatewayLLMClient: 缺少 LLM_GATEWAY_BASE_URL');
  if (!apiKey) throw new Error('GatewayLLMClient: 缺少 LLM_GATEWAY_API_KEY');
  return {
    baseUrl,
    apiKey,
    modelRoutes: parseModelRoutes(process.env.LLM_MODEL_ROUTES, process.env.LLM_MODEL_NAME),
    timeoutMs: Number(process.env.LLM_GATEWAY_TIMEOUT_MS ?? 30000),
  };
}

function rateLimitMessage(body: string): string {
  return /throughput limit/i.test(body)
    ? 'gateway provisioned throughput limit exceeded'
    : 'gateway HTTP 429';
}

// 结构化输出的 schema 说明。schemaName 语义(项目 schema / decision-states 数组 / skill:* 动态)
// 统一由 schema-registry 描述;这里只按 spec 组织提示词。
// 优先用传入的 schema 对象(如 skill 目录下的 output schema);否则据 spec 读 schemas/ 文本。
function schemaHint(spec: SchemaSpec, schema?: object): string {
  if (schema && Object.keys(schema).length > 0) {
    return `输出的 JSON 必须严格符合以下 JSON Schema:\n${JSON.stringify(schema)}`;
  }
  const text = loadSchemaText(spec);
  if (text && spec.isArrayEnvelope) {
    return `输出一个 JSON 数组,数组每一项都必须符合以下 JSON Schema:\n${text}\n注意:顶层是数组,但因为 response_format 要求 JSON object,请用 {"items": [...]} 包裹,items 为该数组。`;
  }
  if (text) {
    return `输出的 JSON 必须严格符合以下 JSON Schema:\n${text}`;
  }
  return `输出符合 "${spec.id}" 结构的 JSON。`;
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
  private nextModelIndex = 0;

  constructor(cfg?: Partial<GatewayConfig>) {
    const defaults = readConfig();
    this.cfg = {
      ...defaults,
      ...cfg,
      modelRoutes: cfg?.modelRoutes ?? defaults.modelRoutes,
    };
  }

  get identity(): LLMProviderIdentity {
    return this.identityFor(this.cfg.modelRoutes[0]);
  }

  private identityFor(route: GatewayModelRoute): LLMProviderIdentity {
    return {
      provider: 'gateway',
      endpointHost: new URL(this.cfg.baseUrl).host,
      requestedModel: route.requestedModel,
      mode: 'real',
      eligibleAsReal: true,
    };
  }

  private async call(messages: object[], jsonMode: boolean): Promise<{
    content: string;
    resp: ChatResponse;
    route: GatewayModelRoute;
  }> {
    const routes = this.cfg.modelRoutes;
    const startIndex = this.nextModelIndex;
    this.nextModelIndex = (this.nextModelIndex + 1) % routes.length;
    let lastError: unknown;
    for (let offset = 0; offset < routes.length; offset += 1) {
      const route = routes[(startIndex + offset) % routes.length];
      try {
        const response = await this.callRoute(route, messages, jsonMode);
        return { ...response, route };
      } catch (error) {
        lastError = error;
        const switchable = error instanceof LLMInvocationError
          && (error.retryable || error.kind === 'quota');
        if (!switchable || routes.length === 1) throw error;
      }
    }
    throw lastError ?? new Error('GatewayLLMClient: model pool exhausted without an error');
  }

  private async callRoute(
    route: GatewayModelRoute,
    messages: object[],
    jsonMode: boolean,
  ): Promise<{ content: string; resp: ChatResponse }> {
    const maxAttempts = this.cfg.modelRoutes.length === 1 ? 3 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.callOnce(route.requestedModel, messages, jsonMode);
      } catch (error) {
        lastError = error;
        if (error instanceof RateLimitError && attempt < maxAttempts) {
          await sleep(error.retryAfterMs ?? attempt * 5000);
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  private async callOnce(model: string, messages: object[], jsonMode: boolean): Promise<{ content: string; resp: ChatResponse }> {
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
          model,
          messages,
          stream: false,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: ac.signal,
      });
      if (res.status === 429) {
        const body = await res.text();
        const exhausted = res.headers.get('x-quota-exhausted') === 'true' || res.headers.get('x-quota-remaining') === '0';
        if (exhausted) throw new LLMInvocationError('quota', false, 429, 'gateway quota exhausted');
        const retryAfter = Number(res.headers.get('retry-after')) * 1000;
        throw new RateLimitError(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
          rateLimitMessage(body),
        );
      }
      if (!res.ok) {
        const kind = res.status === 401 || res.status === 403
          ? 'authentication'
          : res.status >= 500 ? 'server' : 'unknown';
        throw new LLMInvocationError(kind, res.status >= 500, res.status, `gateway HTTP ${res.status}`);
      }
      const resp = (await res.json()) as ChatResponse;
      if (resp.error) throw new LLMInvocationError('capability', false, null, 'gateway returned an error payload');
      const content = resp.choices?.[0]?.message?.content;
      if (content == null) throw new LLMInvocationError('capability', false, null, 'gateway response missing content');
      return { content, resp };
    } catch (error) {
      if (error instanceof LLMInvocationError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new LLMInvocationError('timeout', true, null, 'gateway request timed out');
      }
      throw new LLMInvocationError('network', true, null, 'gateway network request failed');
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

  async generateStructured<T>(opts: LegacyStructuredLLMCallOptions): Promise<LLMResult<T>> {
    const spec = resolveSchema(opts.schemaName);
    const messages = [
      {
        role: 'system',
        content: `你是用研任务编排器。只输出 JSON,不要任何解释或 markdown 代码块。\n${schemaHint(spec, opts.schema)}`,
      },
      {
        role: 'user',
        content: opts.context
          ? `${opts.prompt}\n\n上下文:\n${JSON.stringify(opts.context)}`
          : opts.prompt,
      },
    ];
    const { content, resp, route } = await this.call(messages, true);

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new LLMInvocationError('schema', false, null, `gateway returned invalid JSON for ${opts.schemaName}`);
    }
    let data = parsed;
    if (spec.isArrayEnvelope && parsed !== null && typeof parsed === 'object' && 'items' in parsed) {
      data = parsed.items;
    }
    const typedData = data as T;

    return {
      data: typedData,
      promptHash: hashPrompt(opts.prompt, opts.context, opts.schemaName),
      modelName: resp.model ?? 'unknown',
      modelVersion: resp.model ?? 'unknown',
      traceId: resp.id ?? 'gateway-no-id',
      tokens: this.usageOf(resp),
      providerIdentity: this.identityFor(route),
      expectedModel: route.expectedActualModel,
    };
  }

  async generateText(opts: LegacyTextLLMCallOptions): Promise<TextLLMResult> {
    const messages = [
      {
        role: 'user',
        content: opts.context ? `${opts.prompt}\n\n上下文:\n${JSON.stringify(opts.context)}` : opts.prompt,
      },
    ];
    const { content, resp, route } = await this.call(messages, false);
    return {
      text: content,
      promptHash: hashPrompt(opts.prompt, opts.context),
      modelName: resp.model ?? 'unknown',
      modelVersion: resp.model ?? 'unknown',
      traceId: resp.id ?? 'gateway-no-id',
      tokens: this.usageOf(resp),
      providerIdentity: this.identityFor(route),
      expectedModel: route.expectedActualModel,
    };
  }
}
