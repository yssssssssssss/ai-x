import {
  type LegacyStructuredLLMCallOptions,
  type LegacyTextLLMCallOptions,
  type LLMCallLimits,
  type LLMClient,
  type LLMProviderIdentity,
  GatewayConfigurationError,
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
  expectedActualModelExplicit?: boolean;
}

interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  modelRoutes: GatewayModelRoute[];
  timeoutMs: number;
}

interface ResolvedGatewayModelRoute {
  readonly requestedModel: string;
  readonly expectedActualModel: string;
  readonly expectedActualModelExplicit: boolean;
}

interface ResolvedGatewayConfig {
  readonly apiKey: string;
  readonly modelRoutes: readonly ResolvedGatewayModelRoute[];
  readonly timeoutMs: number;
  readonly endpointHost: string;
  readonly canonicalRequestUrl: string;
}

export interface GatewayConfigurationIdentity {
  readonly provider: 'gateway';
  readonly endpointHost: string;
  readonly endpointUrl: string;
  readonly mode: 'real';
  readonly eligibleAsReal: true;
  readonly routes: ReadonlyArray<{
    readonly requestedModel: string;
    readonly expectedActualModel: string;
    readonly expectedActualModelExplicit: boolean;
  }>;
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

interface GatewayCallControls {
  readonly limits?: Readonly<LLMCallLimits>;
  readonly redirectMode?: 'error';
}

interface GatewayCallBudget {
  readonly limits: Readonly<LLMCallLimits>;
  readonly deadlineAt: number;
  httpAttempts: number;
}

function timeoutError(): LLMInvocationError {
  return new LLMInvocationError('timeout', true, null, 'gateway request timed out');
}

function callControls(
  limits: LLMCallLimits | undefined,
  redirectMode: 'error' | undefined,
): GatewayCallControls {
  if (redirectMode !== undefined && redirectMode !== 'error') {
    throw new LLMInvocationError('configuration', false, null, 'gateway redirect mode is invalid');
  }
  if (!limits) return Object.freeze({ redirectMode });
  const values: Array<[keyof LLMCallLimits, number, boolean]> = [
    ['overallTimeoutMs', limits.overallTimeoutMs, false],
    ['maxHttpAttempts', limits.maxHttpAttempts, false],
    ['maxRetryAfterMs', limits.maxRetryAfterMs, true],
    ['maxResponseBytes', limits.maxResponseBytes, false],
    ['maxOutputTokens', limits.maxOutputTokens, false],
  ];
  for (const [, value, allowZero] of values) {
    if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
      throw new LLMInvocationError('configuration', false, null, 'gateway call limits are invalid');
    }
  }
  return Object.freeze({
    limits: Object.freeze({ ...limits }),
    redirectMode,
  });
}

function assertNoReceiptId(options: object): void {
  if ('receiptId' in options) {
    throw new LLMInvocationError(
      'configuration',
      false,
      null,
      'gateway request receiptId is not allowed',
    );
  }
}

function throwIfDeadlineExpired(budget: GatewayCallBudget | undefined): void {
  if (budget && Date.now() >= budget.deadlineAt) throw timeoutError();
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await readChunk(reader, signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new LLMInvocationError(
          'capability',
          false,
          null,
          'gateway response exceeded byte limit',
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (signal.aborted) void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // An aborted stream may still have a pending read. The request signal owns cleanup.
    }
  }
}

export function parseModelRoutes(
  raw: string | undefined,
  fallbackModel: string | undefined,
  fallbackExpectedActualModel = process.env.LLM_EXPECTED_ACTUAL_MODEL,
): GatewayModelRoute[] {
  if (!raw?.trim()) {
    if (!fallbackModel?.trim()) {
      throw new GatewayConfigurationError(
        'GATEWAY_ROUTE_INVALID',
        'GatewayLLMClient: 缺少 LLM_MODEL_NAME',
      );
    }
    const requestedModel = fallbackModel.trim();
    const explicitExpectedActualModel = fallbackExpectedActualModel?.trim();
    const expectedActualModel = explicitExpectedActualModel || requestedModel;
    return [{
      requestedModel,
      expectedActualModel,
      expectedActualModelExplicit: Boolean(explicitExpectedActualModel),
    }];
  }
  const routes = raw.split(',').map((entry) => {
    const separator = entry.indexOf('=');
    const hasExtraSeparator = separator >= 0 && entry.indexOf('=', separator + 1) >= 0;
    const requestedModel = separator > 0 ? entry.slice(0, separator).trim() : '';
    const expectedActualModel = separator > 0 ? entry.slice(separator + 1).trim() : '';
    if (
      !requestedModel
      || !expectedActualModel
      || hasExtraSeparator
    ) {
      throw new GatewayConfigurationError(
        'GATEWAY_ROUTE_INVALID',
        'GatewayLLMClient: LLM_MODEL_ROUTES 需为 requested=expectedActual 逗号列表',
      );
    }
    return { requestedModel, expectedActualModel, expectedActualModelExplicit: true };
  });
  if (new Set(routes.map(({ requestedModel }) => requestedModel)).size !== routes.length) {
    throw new GatewayConfigurationError(
      'GATEWAY_ROUTE_INVALID',
      'GatewayLLMClient: LLM_MODEL_ROUTES 包含重复 requested model',
    );
  }
  return routes;
}

function readConfig(): GatewayConfig {
  const baseUrl = process.env.LLM_GATEWAY_BASE_URL;
  const apiKey = process.env.LLM_GATEWAY_API_KEY;
  if (!baseUrl?.trim()) {
    throw new GatewayConfigurationError(
      'GATEWAY_BASE_URL_MISSING',
      'GatewayLLMClient: 缺少 LLM_GATEWAY_BASE_URL',
    );
  }
  if (!apiKey?.trim()) {
    throw new GatewayConfigurationError(
      'GATEWAY_API_KEY_MISSING',
      'GatewayLLMClient: 缺少 LLM_GATEWAY_API_KEY',
    );
  }
  return {
    baseUrl,
    apiKey,
    modelRoutes: parseModelRoutes(
      process.env.LLM_MODEL_ROUTES,
      process.env.LLM_MODEL_NAME,
      process.env.LLM_EXPECTED_ACTUAL_MODEL,
    ),
    timeoutMs: Number(process.env.LLM_GATEWAY_TIMEOUT_MS ?? 30000),
  };
}

function canonicalGatewayEndpoint(baseUrl: string): { endpointHost: string; requestUrl: string } {
  try {
    const endpoint = new URL(baseUrl);
    if (
      (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:')
      || baseUrl.includes('?')
      || baseUrl.includes('#')
      || endpoint.username
      || endpoint.password
      || endpoint.search
      || endpoint.hash
    ) {
      throw new Error('unsafe endpoint');
    }
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, '')}/chat/completions`;
    return {
      endpointHost: endpoint.host.toLowerCase(),
      requestUrl: endpoint.toString(),
    };
  } catch {
    throw new GatewayConfigurationError(
      'GATEWAY_ENDPOINT_INVALID',
      'GatewayLLMClient: LLM_GATEWAY_BASE_URL 无法安全解析',
    );
  }
}

function freezeModelRoutes(routes: readonly GatewayModelRoute[]): readonly ResolvedGatewayModelRoute[] {
  if (routes.length === 0) {
    throw new GatewayConfigurationError(
      'GATEWAY_ROUTE_INVALID',
      'GatewayLLMClient: model route 列表不能为空',
    );
  }
  const normalized = routes.map((route) => {
    const requestedModel = route.requestedModel?.trim();
    const expectedActualModel = route.expectedActualModel?.trim();
    if (!requestedModel || !expectedActualModel) {
      throw new GatewayConfigurationError(
        'GATEWAY_ROUTE_INVALID',
        'GatewayLLMClient: model route 必须包含 requested model 与 expected actual model',
      );
    }
    return Object.freeze({
      requestedModel,
      expectedActualModel,
      expectedActualModelExplicit: route.expectedActualModelExplicit ?? true,
    });
  });
  if (new Set(normalized.map(({ requestedModel }) => requestedModel)).size !== normalized.length) {
    throw new GatewayConfigurationError(
      'GATEWAY_ROUTE_INVALID',
      'GatewayLLMClient: model route 包含重复 requested model',
    );
  }
  return Object.freeze(normalized);
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
  private readonly cfg: ResolvedGatewayConfig;
  private nextModelIndex = 0;

  constructor(cfg?: Partial<GatewayConfig>) {
    const defaults = readConfig();
    const merged = {
      ...defaults,
      ...cfg,
      modelRoutes: cfg?.modelRoutes ?? defaults.modelRoutes,
    };
    const endpoint = canonicalGatewayEndpoint(merged.baseUrl);
    this.cfg = Object.freeze({
      apiKey: merged.apiKey,
      modelRoutes: freezeModelRoutes(merged.modelRoutes),
      timeoutMs: merged.timeoutMs,
      endpointHost: endpoint.endpointHost,
      canonicalRequestUrl: endpoint.requestUrl,
    });
  }

  get identity(): LLMProviderIdentity {
    return this.identityFor(this.cfg.modelRoutes[0]);
  }

  get configurationIdentity(): GatewayConfigurationIdentity {
    const routes = Object.freeze(this.cfg.modelRoutes.map((route) => Object.freeze({
      requestedModel: route.requestedModel,
      expectedActualModel: route.expectedActualModel,
      expectedActualModelExplicit: route.expectedActualModelExplicit,
    })));
    return Object.freeze({
      provider: 'gateway',
      endpointHost: this.cfg.endpointHost,
      endpointUrl: this.cfg.canonicalRequestUrl,
      mode: 'real',
      eligibleAsReal: true,
      routes,
    });
  }

  private identityFor(route: ResolvedGatewayModelRoute): LLMProviderIdentity {
    return {
      provider: 'gateway',
      endpointHost: this.cfg.endpointHost,
      requestedModel: route.requestedModel,
      mode: 'real',
      eligibleAsReal: true,
    };
  }

  private async call(
    messages: object[],
    jsonMode: boolean,
    controls: GatewayCallControls = {},
  ): Promise<{
    content: string;
    resp: ChatResponse;
    route: ResolvedGatewayModelRoute;
  }> {
    const routes = this.cfg.modelRoutes;
    const startIndex = this.nextModelIndex;
    this.nextModelIndex = (this.nextModelIndex + 1) % routes.length;
    const budget = controls.limits
      ? {
          limits: controls.limits,
          deadlineAt: Date.now() + controls.limits.overallTimeoutMs,
          httpAttempts: 0,
        }
      : undefined;
    let lastError: unknown;
    for (let offset = 0; offset < routes.length; offset += 1) {
      throwIfDeadlineExpired(budget);
      if (budget && budget.httpAttempts >= budget.limits.maxHttpAttempts) break;
      const route = routes[(startIndex + offset) % routes.length];
      try {
        const response = await this.callRoute(route, messages, jsonMode, controls, budget);
        return { ...response, route };
      } catch (error) {
        lastError = error;
        const switchable = error instanceof LLMInvocationError
          && (error.retryable || error.kind === 'quota');
        if (!switchable || routes.length === 1) throw error;
      }
    }
    throwIfDeadlineExpired(budget);
    throw lastError ?? new Error('GatewayLLMClient: model pool exhausted without an error');
  }

  private async callRoute(
    route: ResolvedGatewayModelRoute,
    messages: object[],
    jsonMode: boolean,
    controls: GatewayCallControls,
    budget: GatewayCallBudget | undefined,
  ): Promise<{ content: string; resp: ChatResponse }> {
    const routeAttempts = this.cfg.modelRoutes.length === 1 ? 3 : 1;
    const maxAttempts = budget
      ? Math.min(routeAttempts, budget.limits.maxHttpAttempts - budget.httpAttempts)
      : routeAttempts;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.callOnce(route.requestedModel, messages, jsonMode, controls, budget);
      } catch (error) {
        lastError = error;
        if (error instanceof RateLimitError && attempt < maxAttempts) {
          if (budget && budget.httpAttempts >= budget.limits.maxHttpAttempts) throw error;
          const retryDelayMs = budget
            ? Math.min(error.retryAfterMs ?? attempt * 5000, budget.limits.maxRetryAfterMs)
            : error.retryAfterMs ?? attempt * 5000;
          if (budget) {
            const remainingMs = budget.deadlineAt - Date.now();
            if (remainingMs <= 0) throw timeoutError();
            if (retryDelayMs >= remainingMs) {
              await sleep(remainingMs);
              throw timeoutError();
            }
            await sleep(retryDelayMs);
            throwIfDeadlineExpired(budget);
          } else {
            await sleep(retryDelayMs);
          }
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  private async callOnce(
    model: string,
    messages: object[],
    jsonMode: boolean,
    controls: GatewayCallControls,
    budget: GatewayCallBudget | undefined,
  ): Promise<{ content: string; resp: ChatResponse }> {
    throwIfDeadlineExpired(budget);
    if (budget) {
      if (budget.httpAttempts >= budget.limits.maxHttpAttempts) {
        throw new LLMInvocationError(
          'capability',
          false,
          null,
          'gateway HTTP attempt limit exceeded',
        );
      }
      budget.httpAttempts += 1;
    }
    const ac = new AbortController();
    const remainingMs = budget ? Math.max(1, budget.deadlineAt - Date.now()) : this.cfg.timeoutMs;
    const timer = setTimeout(() => ac.abort(), Math.min(this.cfg.timeoutMs, remainingMs));
    try {
      const res = await fetch(this.cfg.canonicalRequestUrl, {
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
          ...(controls.limits ? { max_tokens: controls.limits.maxOutputTokens } : {}),
        }),
        signal: ac.signal,
        ...(controls.redirectMode ? { redirect: controls.redirectMode } : {}),
      });
      const boundedBody = controls.limits
        ? await readBoundedResponseText(res, controls.limits.maxResponseBytes, ac.signal)
        : undefined;
      if (res.status === 429) {
        const body = boundedBody ?? await res.text();
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
      const resp = (boundedBody === undefined
        ? await res.json()
        : JSON.parse(boundedBody)) as ChatResponse;
      if (resp.error) throw new LLMInvocationError('capability', false, null, 'gateway returned an error payload');
      const content = resp.choices?.[0]?.message?.content;
      if (content == null) throw new LLMInvocationError('capability', false, null, 'gateway response missing content');
      throwIfDeadlineExpired(budget);
      return { content, resp };
    } catch (error) {
      if (error instanceof LLMInvocationError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw timeoutError();
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
    assertNoReceiptId(opts);
    const controls = callControls(opts.limits, opts.redirectMode);
    const spec = resolveSchema(opts.schemaName);
    const messages = [
      {
        role: 'system',
        // Some OpenAI-compatible gateways validate response_format=json_object by
        // looking for the lowercase token "json" in the prompt. Keep the human
        // instruction and the protocol marker together so all supported routes
        // receive the same contract.
        content: [
          opts.systemPrompt?.trim(),
          `你是用研任务编排器。只输出 JSON（json object）,不要任何解释或 markdown 代码块。\n${schemaHint(spec, opts.schema)}`,
        ].filter(Boolean).join('\n'),
      },
      {
        role: 'user',
        content: opts.context
          ? `${opts.prompt}\n\n上下文:\n${JSON.stringify(opts.context)}`
          : opts.prompt,
      },
    ];
    const { content, resp, route } = await this.call(messages, true, controls);

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
      promptHash: hashPrompt(opts.prompt, opts.context, opts.schemaName, opts.systemPrompt),
      modelName: resp.model ?? 'unknown',
      modelVersion: resp.model ?? 'unknown',
      traceId: resp.id ?? 'gateway-no-id',
      tokens: this.usageOf(resp),
      providerIdentity: this.identityFor(route),
      expectedModel: route.expectedActualModel,
    };
  }

  async generateText(opts: LegacyTextLLMCallOptions): Promise<TextLLMResult> {
    assertNoReceiptId(opts);
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
