import { type ToolManifest } from './config-loader.ts';

// tool 调用统一接口。业务/skill 只经此调用 tool,不直接 shell out / import SDK。
// V0 实现 = FakeO2Adapter;二期加 O2Adapter(真实 o2)/ InternalApiAdapter / McpAdapter / ScriptAdapter。

export type ToolExecutionMode = 'real' | 'fake';

export type ToolFailureKind =
  | 'rate_limit'
  | 'server'
  | 'timeout'
  | 'network'
  | 'quota'
  | 'authentication'
  | 'configuration'
  | 'schema'
  | 'capability'
  | 'safety'
  | 'unknown';

export type ToolInvocationStatus = 'ok' | 'failed';

export interface ToolInvocationReceipt {
  declaredAdapterType: ToolManifest['adapter_type'];
  resolvedAdapterType: ToolManifest['adapter_type'] | 'unknown';
  implementationId: string;
  executionMode: ToolExecutionMode | 'unknown';
  endpointHost: string | null;
  status: ToolInvocationStatus;
  latencyMs: number;
  attemptId?: string;
  retryOf?: string | null;
}

export interface ToolAdapterResolution {
  declaredAdapterType: ToolManifest['adapter_type'];
  resolvedAdapterType: ToolManifest['adapter_type'];
  implementationId: string;
  executionMode: ToolExecutionMode;
  endpointHost: string | null;
}

interface ToolInvocationErrorOptions {
  kind: ToolFailureKind;
  retryable: boolean;
  providerStatus?: number | null;
  sanitizedMessage: string;
  receipt?: ToolInvocationReceipt;
  details?: Record<string, unknown>;
}

export interface ToolInvokeResult {
  output: object;
  latencyMs: number;
  receipt: ToolInvocationReceipt;
}

export interface ToolAdapter {
  readonly adapterType: ToolManifest['adapter_type'];
  readonly implementationId: string;
  readonly executionMode: ToolExecutionMode;
  endpointHost?(manifest: ToolManifest): string | null;
  invoke(opts: {
    toolId: string;
    input: object;
    manifest: ToolManifest;
    attemptId?: string;
    retryOf?: string | null;
  }): Promise<ToolInvokeResult>;
}


export class ToolInvocationError extends Error {
  readonly kind: ToolFailureKind;
  readonly retryable: boolean;
  readonly providerStatus: number | null;
  readonly sanitizedMessage: string;
  readonly receipt: ToolInvocationReceipt | null;
  readonly details: Record<string, unknown>;

  constructor(public readonly toolId: string, messageOrOptions: string | ToolInvocationErrorOptions) {
    const opts = typeof messageOrOptions === 'string'
      ? {
          kind: 'unknown' as const,
          retryable: false,
          providerStatus: null,
          sanitizedMessage: messageOrOptions,
          receipt: undefined,
          details: undefined,
        }
      : messageOrOptions;
    super(`tool "${toolId}" 调用失败: ${opts.sanitizedMessage}`);
    this.name = 'ToolInvocationError';
    this.kind = opts.kind;
    this.retryable = opts.retryable;
    this.providerStatus = opts.providerStatus ?? null;
    this.sanitizedMessage = opts.sanitizedMessage;
    this.receipt = opts.receipt ?? null;
    this.details = opts.details ?? {};
  }
}

function receiptFromResolution(
  resolution: ToolAdapterResolution,
  status: ToolInvocationStatus,
  latencyMs: number,
  context?: { attemptId?: string; retryOf?: string | null },
): ToolInvocationReceipt {
  return { ...resolution, status, latencyMs, ...context };
}

function directReceipt(adapter: ToolAdapter, manifest: ToolManifest, status: ToolInvocationStatus, latencyMs: number): ToolInvocationReceipt {
  return {
    declaredAdapterType: manifest.adapter_type,
    resolvedAdapterType: adapter.adapterType,
    implementationId: adapter.implementationId,
    executionMode: adapter.executionMode,
    endpointHost: adapter.endpointHost?.(manifest) ?? null,
    status,
    latencyMs,
  };
}

function unknownReceipt(
  declaredAdapterType: ToolManifest['adapter_type'],
  latencyMs: number,
  context?: { attemptId?: string; retryOf?: string | null },
): ToolInvocationReceipt {
  return {
    declaredAdapterType,
    resolvedAdapterType: 'unknown',
    implementationId: 'unknown',
    executionMode: 'unknown',
    endpointHost: null,
    status: 'failed',
    latencyMs,
    ...context,
  };
}


function hostFromUrl(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).host;
  } catch {
    return null;
  }
}

function sanitizeMessage(message: string, secrets: string[] = []): string {
  const known = secrets.reduce(
    (current, secret) => secret ? current.replaceAll(secret, '[REDACTED]') : current,
    message,
  );
  return known
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|authorization|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function errorFromUnknown(toolId: string, err: unknown, fallbackKind: ToolFailureKind = 'unknown'): ToolInvocationError {
  if (err instanceof ToolInvocationError) return err;
  return new ToolInvocationError(toolId, {
    kind: err instanceof DOMException && err.name === 'AbortError' ? 'timeout' : fallbackKind,
    retryable: err instanceof DOMException && err.name === 'AbortError' || fallbackKind === 'network' || fallbackKind === 'timeout',
    providerStatus: null,
    sanitizedMessage: err instanceof Error ? err.message : String(err),
  });
}

function httpFailureKind(status: number): ToolFailureKind {
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'authentication';
  if (status >= 500) return 'server';
  return 'unknown';
}

function isRetryableHttp(status: number): boolean {
  return status === 429 || status >= 500;
}

function quotaExceeded(headers: Headers): boolean {
  return headers.get('x-quota-exhausted') === 'true' || headers.get('x-quota-remaining') === '0';
}


// Fake o2 adapter:返回预置检索结果。
// failOnToolIds 里的 tool 会抛错——用于验证失败回放(execution_log.status=failed + failures.jsonl)。
export class FakeO2Adapter implements ToolAdapter {
  readonly adapterType = 'fake' as const;
  readonly implementationId = 'fake-o2';
  readonly executionMode = 'fake' as const;

  constructor(private readonly opts: { failOnToolIds?: string[] } = {}) {}

  async invoke(opts: { toolId: string; input: object; manifest: ToolManifest }): Promise<ToolInvokeResult> {
    const start = performance.now();
    if (this.opts.failOnToolIds?.includes(opts.toolId)) {
      throw new ToolInvocationError(opts.toolId, {
        kind: 'unknown',
        retryable: false,
        providerStatus: null,
        sanitizedMessage: '模拟失败(FakeO2Adapter.failOnToolIds)',
      });
    }
    // 与 o2-web-search/output.schema.json 对齐的预置结果
    const output = {
      results: [
        { title: '竞品A数字人产品页', url: 'https://example.com/a', snippet: '支持实时语音互动与形象定制' },
        { title: '行业评测:直播AI横评', url: 'https://example.com/review', snippet: '对比交互延迟与内容质量' },
        { title: '应用商店榜单', url: 'https://example.com/rank', snippet: '数字人直播产品下载榜' },
      ],
    };
    const latencyMs = Math.round(performance.now() - start);
    return { output, latencyMs, receipt: directReceipt(this, opts.manifest, 'ok', latencyMs) };
  }
}

// HttpApiAdapter:调用外部 REST 服务的通用 adapter(第一个真实 tool 通道)。
// V0 首个消费者 = ai-spider-app 的 /api/search(竞品截图库检索)。
// 只做 HTTP 消费者,不改被调服务;登录拿 JWT 缓存,401 重登一次。
// base_url / 账号密码从 env 读(SPIDER_*),endpoint/auth 由 tool manifest 声明。
interface HttpAdapterConfig {
  baseUrl: string;
  username?: string;
  password?: string;
  timeoutMs: number;
}

export class HttpApiAdapter implements ToolAdapter {
  readonly adapterType = 'internal_api' as const;
  readonly implementationId = 'http-api';
  readonly executionMode = 'real' as const;
  private token: string | null = null;


  constructor(private readonly cfg?: Partial<HttpAdapterConfig>) {}

  private config(): HttpAdapterConfig {
    return {
      baseUrl: this.cfg?.baseUrl ?? process.env.SPIDER_BASE_URL ?? 'http://localhost:8000',
      username: this.cfg?.username ?? process.env.SPIDER_USERNAME,
      password: this.cfg?.password ?? process.env.SPIDER_PASSWORD,
      timeoutMs: this.cfg?.timeoutMs ?? Number(process.env.SPIDER_TIMEOUT_MS ?? 30000),
    };
  }
  endpointHost(): string | null {
    return hostFromUrl(this.config().baseUrl);
  }


  private async login(cfg: HttpAdapterConfig): Promise<string> {
    if (!cfg.username || !cfg.password) {
      throw new Error('缺少 SPIDER_USERNAME / SPIDER_PASSWORD,无法登录');
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(`${cfg.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: cfg.username, password: cfg.password }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`登录失败 HTTP ${res.status}`);
      const data: unknown = await res.json();
      if (!data || typeof data !== 'object' || !('access_token' in data) || typeof data.access_token !== 'string') {
        throw new Error('登录响应缺少 access_token');
      }
      return data.access_token;
    } finally {
      clearTimeout(timer);
    }
  }

  async invoke(opts: { toolId: string; input: object; manifest: ToolManifest }): Promise<ToolInvokeResult> {
    const start = performance.now();
    const cfg = this.config();
    // manifest.entrypoint 声明相对路径(如 /api/search);默认 /api/search
    const path = opts.manifest.entrypoint || '/api/search';

    const doCall = async (): Promise<Response> => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.manifest.auth_required) {
        this.token ??= await this.login(cfg);
        headers.Authorization = `Bearer ${this.token}`;
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
      try {
        return await fetch(`${cfg.baseUrl}${path}`, {
          method: 'POST', headers, body: JSON.stringify(opts.input), signal: ac.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      let res = await doCall();
      if (res.status === 401 && opts.manifest.auth_required) {
        this.token = null;
        res = await doCall();
      }
      if (!res.ok) {
        throw new ToolInvocationError(opts.toolId, {
          kind: res.status === 429 && quotaExceeded(res.headers) ? 'quota' : httpFailureKind(res.status),
          retryable: !(res.status === 429 && quotaExceeded(res.headers)) && isRetryableHttp(res.status),
          providerStatus: res.status,
          sanitizedMessage: `HTTP ${res.status}`,
        });
      }
      const raw = (await res.json()) as unknown;
      const latencyMs = Math.round(performance.now() - start);
      return { output: mapSearchResults(raw), latencyMs, receipt: directReceipt(this, opts.manifest, 'ok', latencyMs) };
    } catch (err) {
      if (err instanceof ToolInvocationError) throw err;
      throw errorFromUnknown(opts.toolId, err, 'network');
    }
  }
}

// RestJsonAdapter:无鉴权 REST 工具的通用通道(external-tools/*-lab 均走此)。
// 与 HttpApiAdapter 的区别:不登录、不做结果映射——body/返回都原样透传。
// base_url 从 manifest.base_url_env 指定的环境变量读(如 EXPERIENCE_MODEL_BASE_URL);
// entrypoint 由 manifest 声明(如 /api/analyze);超时取 manifest.timeout_seconds。
export class RestJsonAdapter implements ToolAdapter {
  readonly adapterType = 'rest_json' as const;
  readonly implementationId = 'rest-json';
  readonly executionMode = 'real' as const;


  endpointHost(manifest: ToolManifest): string | null {
    const envKey = manifest.base_url_env;
    const baseUrl = (envKey ? process.env[envKey] : undefined)?.replace(/\/$/, '');
    return baseUrl ? hostFromUrl(baseUrl) : null;
  }

  async invoke(opts: { toolId: string; input: object; manifest: ToolManifest }): Promise<ToolInvokeResult> {
    const start = performance.now();
    const envKey = opts.manifest.base_url_env;
    const baseUrl = (envKey ? process.env[envKey] : undefined)?.replace(/\/$/, '');
    if (!baseUrl) {
      throw new ToolInvocationError(opts.toolId, {
        kind: 'configuration',
        retryable: false,
        providerStatus: null,
        sanitizedMessage: `缺少 base_url:请设置环境变量 ${envKey ?? '(manifest 未声明 base_url_env)'}`,
      });
    }
    const path = opts.manifest.entrypoint || '/api/analyze';
    const timeoutMs = (opts.manifest.timeout_seconds ?? 60) * 1000;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts.input),
        signal: ac.signal,
      });
      if (!res.ok) {
        throw new ToolInvocationError(opts.toolId, {
          kind: res.status === 429 && quotaExceeded(res.headers) ? 'quota' : httpFailureKind(res.status),
          retryable: !(res.status === 429 && quotaExceeded(res.headers)) && isRetryableHttp(res.status),
          providerStatus: res.status,
          sanitizedMessage: `HTTP ${res.status}`,
        });
      }
      const output = (await res.json()) as object;
      const latencyMs = Math.round(performance.now() - start);
      return { output, latencyMs, receipt: directReceipt(this, opts.manifest, 'ok', latencyMs) };
    } catch (err) {
      if (err instanceof ToolInvocationError) throw err;
      throw errorFromUnknown(opts.toolId, err, 'network');
    } finally {
      clearTimeout(timer);
    }
  }
}

interface TavilyAdapterConfig {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}

interface TavilyInput {
  query?: unknown;
  max_results?: unknown;
  search_depth?: unknown;
  topic?: unknown;
  include_answer?: unknown;
  time_range?: unknown;
}

interface TavilyResultRow {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  snippet?: unknown;
  score?: unknown;
  published_date?: unknown;
}

interface TavilyResponse {
  answer?: unknown;
  response_time?: unknown;
  results?: unknown;
}

export class TavilyAdapter implements ToolAdapter {
  readonly adapterType = 'tavily' as const;
  readonly implementationId = 'tavily';
  readonly executionMode = 'real' as const;


  constructor(private readonly cfg: TavilyAdapterConfig = {}) {}
  endpointHost(): string | null {
    const baseUrl = (this.cfg.baseUrl ?? process.env.TAVILY_BASE_URL ?? 'https://api.tavily.com').replace(/\/$/, '');
    return hostFromUrl(baseUrl);
  }


  async invoke(opts: { toolId: string; input: object; manifest: ToolManifest }): Promise<ToolInvokeResult> {
    const start = performance.now();
    const apiKey = this.cfg.apiKey ?? process.env.TAVILY_API_KEY;
    if (!apiKey) {
      throw new ToolInvocationError(opts.toolId, {
        kind: 'configuration',
        retryable: false,
        providerStatus: null,
        sanitizedMessage: 'Missing TAVILY_API_KEY',
      });
    }

    const baseUrl = (this.cfg.baseUrl ?? process.env.TAVILY_BASE_URL ?? 'https://api.tavily.com').replace(/\/$/, '');
    const timeoutMs = opts.manifest.timeout_seconds
      ? opts.manifest.timeout_seconds * 1000
      : this.cfg.timeoutMs ?? Number(process.env.TAVILY_TIMEOUT_MS ?? 30000);
    const input = opts.input as TavilyInput;
    const body: Record<string, unknown> = {
      query: input.query,
      max_results: input.max_results ?? 5,
      search_depth: input.search_depth ?? 'basic',
      topic: input.topic ?? 'general',
      include_answer: input.include_answer ?? false,
      include_raw_content: false,
    };
    if (input.time_range !== undefined) body.time_range = input.time_range;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}${opts.manifest.entrypoint || '/search'}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) {
        throw new ToolInvocationError(opts.toolId, {
          kind: res.status === 429 && quotaExceeded(res.headers) ? 'quota' : httpFailureKind(res.status),
          retryable: !(res.status === 429 && quotaExceeded(res.headers)) && isRetryableHttp(res.status),
          providerStatus: res.status,
          sanitizedMessage: `HTTP ${res.status}`,
        });
      }
      const raw = (await res.json()) as TavilyResponse;
      const latencyMs = Math.round(performance.now() - start);
      return { output: mapTavilyResponse(raw), latencyMs, receipt: directReceipt(this, opts.manifest, 'ok', latencyMs) };
    } catch (err) {
      if (err instanceof ToolInvocationError) throw err;
      throw errorFromUnknown(opts.toolId, err, 'network');
    } finally {
      clearTimeout(timer);
    }
  }
}

function mapTavilyResponse(raw: TavilyResponse): object {
  const rows = Array.isArray(raw.results) ? raw.results : [];
  return {
    answer: typeof raw.answer === 'string' ? raw.answer : null,
    response_time: typeof raw.response_time === 'number' ? raw.response_time : null,
    results: rows.map((row) => mapTavilyResult(row as TavilyResultRow)),
  };
}

function mapTavilyResult(row: TavilyResultRow): object {
  return {
    title: typeof row.title === 'string' ? row.title : '',
    url: typeof row.url === 'string' ? row.url : '',
    snippet: typeof row.content === 'string'
      ? row.content
      : typeof row.snippet === 'string' ? row.snippet : '',
    score: typeof row.score === 'number' ? row.score : null,
    published_date: typeof row.published_date === 'string' ? row.published_date : null,
  };
}

// 把 ai-spider-app 的 SearchResult[] 映射为 ai-spider-search/output.schema.json 结构。
function mapSearchResults(raw: unknown): object {
  const arr = Array.isArray(raw) ? raw : [];
  return {
    results: arr.map((r) => {
      const row = r as { image?: Record<string, unknown>; analysis?: Record<string, unknown>; search_mode?: string };
      return {
        source_app: row.image?.source_app ?? null,
        scenario: row.image?.scenario ?? null,
        oss_url: row.image?.oss_url ?? row.image?.file_path ?? null,
        design_analysis: row.analysis?.design_analysis ?? null,
        ops_analysis: row.analysis?.ops_analysis ?? null,
        search_mode: row.search_mode ?? null,
      };
    }),
  };
}

// ToolRouter:按 tool manifest 的 adapter_type 分发到对应 adapter。
// 让 fake / internal_api 在同一次任务里共存(计划里可能既有 fake 步又有真实 http 步)。
// 自身实现 ToolAdapter 接口,故 RuntimeDeps.toolAdapter 签名不变,orchestrator 无需改。
export class ToolRouter implements ToolAdapter {
  readonly adapterType = 'router' as unknown as ToolManifest['adapter_type'];
  readonly implementationId = 'tool-router';
  readonly executionMode = 'real' as const;
  private readonly byType = new Map<string, ToolAdapter>();

  register(adapter: ToolAdapter): this {
    this.byType.set(adapter.adapterType, adapter);
    return this;
  }

  // 显式 key 注册:一个 adapter 覆盖多个 adapter_type(如 Fake 兼容 o2 + fake)。
  registerAs(key: string, adapter: ToolAdapter): this {
    this.byType.set(key, adapter);
    return this;
  }

  resolve(manifest: ToolManifest): ToolAdapterResolution | null {
    const adapter = this.byType.get(manifest.adapter_type);
    if (!adapter) return null;
    return {
      declaredAdapterType: manifest.adapter_type,
      resolvedAdapterType: adapter.adapterType,
      implementationId: adapter.implementationId,
      executionMode: adapter.executionMode,
      endpointHost: adapter.endpointHost?.(manifest) ?? null,
    };
  }

  async invoke(opts: {
    toolId: string;
    input: object;
    manifest: ToolManifest;
    attemptId?: string;
    retryOf?: string | null;
  }): Promise<ToolInvokeResult> {
    const start = performance.now();
    const resolution = this.resolve(opts.manifest);
    if (!resolution) {
      const latencyMs = Math.round(performance.now() - start);
      throw new ToolInvocationError(opts.toolId, {
        kind: 'configuration', retryable: false, providerStatus: null,
        sanitizedMessage: `No adapter registered for adapter_type=${opts.manifest.adapter_type}`,
        receipt: unknownReceipt(opts.manifest.adapter_type, latencyMs, opts),
      });
    }
    try {
      const result = await this.byType.get(opts.manifest.adapter_type)!.invoke(opts);
      const latencyMs = Math.round(performance.now() - start);
      return { ...result, latencyMs, receipt: receiptFromResolution(resolution, 'ok', latencyMs, opts) };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - start);
      if (err instanceof ToolInvocationError) {
        throw new ToolInvocationError(opts.toolId, {
          kind: err.kind, retryable: err.retryable, providerStatus: err.providerStatus,
          sanitizedMessage: err.sanitizedMessage,
          receipt: receiptFromResolution(resolution, 'failed', latencyMs, opts), details: err.details,
        });
      }
      const structured = errorFromUnknown(opts.toolId, err, 'network');
      throw new ToolInvocationError(opts.toolId, {
        kind: structured.kind, retryable: structured.retryable, providerStatus: structured.providerStatus,
        sanitizedMessage: structured.sanitizedMessage,
        receipt: receiptFromResolution(resolution, 'failed', latencyMs, opts),
      });
    }
  }
}
