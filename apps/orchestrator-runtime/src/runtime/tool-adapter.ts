import { type ToolManifest } from './config-loader.ts';

// tool 调用统一接口。业务/skill 只经此调用 tool,不直接 shell out / import SDK。
// V0 实现 = FakeO2Adapter;二期加 O2Adapter(真实 o2)/ InternalApiAdapter / McpAdapter / ScriptAdapter。

export type ToolExecutionMode = 'real' | 'fake';

export type ToolFailureKind =
  | 'capacity'
  | 'lease_lost'
  | 'rate_limit'
  | 'server'
  | 'timeout'
  | 'network'
  | 'quota'
  | 'authentication'
  | 'permission'
  | 'browser_bridge'
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
  runtimeVersions?: Record<string, string>;
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

export interface ToolKnowledgeAttachment {
  attachmentId: string;
  title: string;
  body: string;
  sourceUrl: string;
  author: string | null;
  updatedAt: string | null;
  contentSha256: string;
  sensitivity: 'internal';
}

export interface ToolInvokeResult {
  output: object;
  latencyMs: number;
  receipt: ToolInvocationReceipt;
  mediaAttachments?: ToolMediaAttachment[];
  knowledgeAttachments?: ToolKnowledgeAttachment[];
}

export type ToolAbortReason = 'lease_lost' | 'deadline_exceeded';

export interface ToolInvocationContext {
  signal: AbortSignal;
  deadlineAt: number;
}

export interface ToolMediaAttachment {
  attachmentId: string;
  bytes: Uint8Array;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  contentSha256: string;
  sourcePageUrl: string;
  capturedAt: string;
  captureMode: 'extracted_image' | 'element_screenshot' | 'full_page_screenshot';
  selector?: string;
  viewport: { width: number; height: number };
  width: number;
  height: number;
}

export interface ToolInvokeOptions {
  toolId: string;
  input: object;
  manifest: ToolManifest;
  context: ToolInvocationContext;
  attemptId?: string;
  retryOf?: string | null;
}

export interface ToolAdapter {
  readonly adapterType: ToolManifest['adapter_type'];
  readonly implementationId: string;
  readonly executionMode: ToolExecutionMode;
  endpointHost?(manifest: ToolManifest): string | null;
  invoke(opts: ToolInvokeOptions): Promise<ToolInvokeResult>;
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
  return {
    ...resolution,
    status,
    latencyMs,
    ...(context?.attemptId === undefined ? {} : { attemptId: context.attemptId }),
    ...(context?.retryOf === undefined ? {} : { retryOf: context.retryOf }),
  };
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
    ...(context?.attemptId === undefined ? {} : { attemptId: context.attemptId }),
    ...(context?.retryOf === undefined ? {} : { retryOf: context.retryOf }),
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
    sanitizedMessage: sanitizeMessage(err instanceof Error ? err.message : String(err)),
  });
}

function stableAbortReason(signal: AbortSignal, deadlineAt?: number): ToolAbortReason | null {
  if (signal.aborted) {
    if (signal.reason === 'lease_lost') return 'lease_lost';
    if (signal.reason === 'deadline_exceeded') return 'deadline_exceeded';
  }
  return deadlineAt !== undefined && Date.now() >= deadlineAt ? 'deadline_exceeded' : null;
}

export function toolAbortError(
  toolId: string,
  signal: AbortSignal,
  deadlineAt?: number,
): ToolInvocationError {
  const reason = stableAbortReason(signal, deadlineAt);
  if (reason === 'lease_lost') {
    return new ToolInvocationError(toolId, {
      kind: 'lease_lost',
      retryable: true,
      sanitizedMessage: 'execution lease lost',
      details: { abortReason: reason },
    });
  }
  return new ToolInvocationError(toolId, {
    kind: 'timeout',
    retryable: true,
    sanitizedMessage: reason === 'deadline_exceeded'
      ? 'tool execution deadline exceeded'
      : 'tool invocation timed out',
    details: reason ? { abortReason: reason } : {},
  });
}

export function throwIfToolInvocationAborted(toolId: string, context: ToolInvocationContext): void {
  if (context.signal.aborted || Date.now() >= context.deadlineAt) {
    throw toolAbortError(toolId, context.signal, context.deadlineAt);
  }
}

interface InvocationSignal {
  signal: AbortSignal;
  dispose(): void;
}

function invocationSignal(context: ToolInvocationContext, timeoutMs: number): InvocationSignal {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(context.signal.reason);
  if (context.signal.aborted) forwardAbort();
  else context.signal.addEventListener('abort', forwardAbort, { once: true });
  const remaining = Math.max(0, context.deadlineAt - Date.now());
  const duration = Math.min(Math.max(0, timeoutMs), remaining);
  const timer = setTimeout(() => {
    controller.abort(remaining <= timeoutMs ? 'deadline_exceeded' : 'provider_timeout');
  }, duration);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', forwardAbort);
    },
  };
}

function errorFromInvocation(
  toolId: string,
  error: unknown,
  fallbackKind: ToolFailureKind,
  signal: AbortSignal,
  deadlineAt: number,
): ToolInvocationError {
  const reason = stableAbortReason(signal, deadlineAt);
  if (reason || error instanceof DOMException && error.name === 'AbortError') {
    return toolAbortError(toolId, signal, deadlineAt);
  }
  if (error instanceof ToolInvocationError) return error;
  return errorFromUnknown(toolId, error, fallbackKind);
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

  async invoke(opts: ToolInvokeOptions): Promise<ToolInvokeResult> {
    const start = performance.now();
    throwIfToolInvocationAborted(opts.toolId, opts.context);
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


  private async login(toolId: string, cfg: HttpAdapterConfig, context: ToolInvocationContext): Promise<string> {
    if (!cfg.username || !cfg.password) {
      throw new Error('缺少 SPIDER_USERNAME / SPIDER_PASSWORD,无法登录');
    }
    const invocation = invocationSignal(context, cfg.timeoutMs);
    try {
      const res = await fetch(`${cfg.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: cfg.username, password: cfg.password }),
        signal: invocation.signal,
      });
      if (!res.ok) throw new Error(`登录失败 HTTP ${res.status}`);
      const data: unknown = await res.json();
      if (!data || typeof data !== 'object' || !('access_token' in data) || typeof data.access_token !== 'string') {
        throw new Error('登录响应缺少 access_token');
      }
      return data.access_token;
    } catch (error) {
      throw errorFromInvocation(toolId, error, 'network', invocation.signal, context.deadlineAt);
    } finally {
      invocation.dispose();
    }
  }

  async invoke(opts: ToolInvokeOptions): Promise<ToolInvokeResult> {
    const start = performance.now();
    throwIfToolInvocationAborted(opts.toolId, opts.context);
    const cfg = this.config();
    // manifest.entrypoint 声明相对路径(如 /api/search);默认 /api/search
    const path = opts.manifest.entrypoint || '/api/search';

    const doCall = async (): Promise<InvocationSignal & { response: Response }> => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.manifest.auth_required) {
        this.token ??= await this.login(opts.toolId, cfg, opts.context);
        headers.Authorization = `Bearer ${this.token}`;
      }
      const invocation = invocationSignal(opts.context, cfg.timeoutMs);
      try {
        const response = await fetch(`${cfg.baseUrl}${path}`, {
          method: 'POST', headers, body: JSON.stringify(opts.input), signal: invocation.signal,
        });
        return { ...invocation, response };
      } catch (error) {
        invocation.dispose();
        throw errorFromInvocation(opts.toolId, error, 'network', invocation.signal, opts.context.deadlineAt);
      }
    };

    let call: (InvocationSignal & { response: Response }) | undefined;
    try {
      call = await doCall();
      if (call.response.status === 401 && opts.manifest.auth_required) {
        call.dispose();
        call = undefined;
        this.token = null;
        throwIfToolInvocationAborted(opts.toolId, opts.context);
        call = await doCall();
      }
      const res = call.response;
      if (!res.ok) {
        throw new ToolInvocationError(opts.toolId, {
          kind: res.status === 429 && quotaExceeded(res.headers) ? 'quota' : httpFailureKind(res.status),
          retryable: !(res.status === 429 && quotaExceeded(res.headers)) && isRetryableHttp(res.status),
          providerStatus: res.status,
          sanitizedMessage: `HTTP ${res.status}`,
        });
      }
      const raw = (await res.json()) as unknown;
      throwIfToolInvocationAborted(opts.toolId, opts.context);
      const latencyMs = Math.round(performance.now() - start);
      return { output: mapSearchResults(raw), latencyMs, receipt: directReceipt(this, opts.manifest, 'ok', latencyMs) };
    } catch (err) {
      throw errorFromInvocation(
        opts.toolId,
        err,
        'network',
        call?.signal ?? opts.context.signal,
        opts.context.deadlineAt,
      );
    } finally {
      call?.dispose();
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

  async invoke(opts: ToolInvokeOptions): Promise<ToolInvokeResult> {
    const start = performance.now();
    throwIfToolInvocationAborted(opts.toolId, opts.context);
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

    const invocation = invocationSignal(opts.context, timeoutMs);
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts.input),
        signal: invocation.signal,
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
      throwIfToolInvocationAborted(opts.toolId, opts.context);
      const latencyMs = Math.round(performance.now() - start);
      return { output, latencyMs, receipt: directReceipt(this, opts.manifest, 'ok', latencyMs) };
    } catch (err) {
      throw errorFromInvocation(opts.toolId, err, 'network', invocation.signal, opts.context.deadlineAt);
    } finally {
      invocation.dispose();
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

interface MappedTavilyResult {
  title: string;
  url: string;
  snippet: string;
  score: number | null;
  published_date: string | null;
}

interface MappedTavilyResponse {
  answer: string | null;
  response_time: number | null;
  results: MappedTavilyResult[];
}

const MAX_TAVILY_QUERY_CONCURRENCY = 4;

function tavilyQueries(input: TavilyInput, toolId: string): string[] {
  const values = Array.isArray(input.query) ? input.query : [input.query];
  if (
    values.length === 0
    || values.some((value) => typeof value !== 'string' || !value.trim())
  ) {
    throw new ToolInvocationError(toolId, {
      kind: 'schema',
      retryable: false,
      sanitizedMessage: 'Tavily requires one query or a non-empty query list',
    });
  }
  return values.map((value) => (value as string).trim());
}

function tavilyMaxResults(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 20
    ? Number(value)
    : 5;
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


  async invoke(opts: ToolInvokeOptions): Promise<ToolInvokeResult> {
    const start = performance.now();
    throwIfToolInvocationAborted(opts.toolId, opts.context);
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
    const queries = tavilyQueries(input, opts.toolId);
    const maxResults = tavilyMaxResults(input.max_results);
    const perQueryMaxResults = Math.max(1, Math.ceil(maxResults / queries.length));
    const commonBody: Record<string, unknown> = {
      search_depth: input.search_depth ?? 'basic',
      topic: input.topic ?? 'general',
      include_answer: input.include_answer ?? false,
      include_raw_content: false,
    };
    if (input.time_range !== undefined) commonBody.time_range = input.time_range;

    const invocation = invocationSignal(opts.context, timeoutMs);
    try {
      const request = async (query: string, signal: AbortSignal): Promise<TavilyResponse> => {
        const res = await fetch(`${baseUrl}${opts.manifest.entrypoint || '/search'}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            query,
            max_results: perQueryMaxResults,
            ...commonBody,
          }),
          signal,
        });
        if (!res.ok) {
          throw new ToolInvocationError(opts.toolId, {
            kind: res.status === 429 && quotaExceeded(res.headers) ? 'quota' : httpFailureKind(res.status),
            retryable: !(res.status === 429 && quotaExceeded(res.headers)) && isRetryableHttp(res.status),
            providerStatus: res.status,
            sanitizedMessage: `HTTP ${res.status}`,
          });
        }
        return (await res.json()) as TavilyResponse;
      };
      const requestBatch = async (batch: string[]): Promise<TavilyResponse[]> => {
        const controller = new AbortController();
        const forwardAbort = () => controller.abort(invocation.signal.reason);
        if (invocation.signal.aborted) forwardAbort();
        else invocation.signal.addEventListener('abort', forwardAbort, { once: true });
        let hasPrimaryFailure = false;
        let primaryFailure: unknown;
        try {
          const requests = batch.map(async (query) => {
            try {
              return await request(query, controller.signal);
            } catch (error) {
              if (!hasPrimaryFailure) {
                hasPrimaryFailure = true;
                primaryFailure = error;
                if (!controller.signal.aborted) controller.abort('sibling_failed');
              }
              throw error;
            }
          });
          const settled = await Promise.allSettled(requests);
          if (hasPrimaryFailure) throw primaryFailure;
          return settled.map((result) => {
            if (result.status === 'rejected') throw result.reason;
            return result.value;
          });
        } finally {
          invocation.signal.removeEventListener('abort', forwardAbort);
        }
      };
      const responses: TavilyResponse[] = [];
      for (let index = 0; index < queries.length; index += MAX_TAVILY_QUERY_CONCURRENCY) {
        responses.push(...await requestBatch(
          queries.slice(index, index + MAX_TAVILY_QUERY_CONCURRENCY),
        ));
      }
      throwIfToolInvocationAborted(opts.toolId, opts.context);
      const latencyMs = Math.round(performance.now() - start);
      return {
        output: mergeTavilyResponses(responses, maxResults),
        latencyMs,
        receipt: directReceipt(this, opts.manifest, 'ok', latencyMs),
      };
    } catch (err) {
      throw errorFromInvocation(opts.toolId, err, 'network', invocation.signal, opts.context.deadlineAt);
    } finally {
      invocation.dispose();
    }
  }
}

function mapTavilyResponse(raw: TavilyResponse): MappedTavilyResponse {
  const rows = Array.isArray(raw.results) ? raw.results : [];
  return {
    answer: typeof raw.answer === 'string' ? raw.answer : null,
    response_time: typeof raw.response_time === 'number' ? raw.response_time : null,
    results: rows.map((row) => mapTavilyResult(row as TavilyResultRow)),
  };
}

function mergeTavilyResponses(
  responses: TavilyResponse[],
  maxResults: number,
): MappedTavilyResponse {
  const mapped = responses.map(mapTavilyResponse);
  if (mapped.length === 1) {
    return { ...mapped[0]!, results: mapped[0]!.results.slice(0, maxResults) };
  }
  const results: MappedTavilyResult[] = [];
  const seenUrls = new Set<string>();
  const maxRows = Math.max(0, ...mapped.map((response) => response.results.length));
  for (let rowIndex = 0; rowIndex < maxRows && results.length < maxResults; rowIndex += 1) {
    for (const response of mapped) {
      const row = response.results[rowIndex];
      if (!row || seenUrls.has(row.url)) continue;
      seenUrls.add(row.url);
      results.push(row);
      if (results.length >= maxResults) break;
    }
  }
  const responseTimes = mapped
    .map((response) => response.response_time)
    .filter((value): value is number => value !== null);
  return {
    answer: null,
    response_time: responseTimes.length > 0
      ? responseTimes.reduce((total, value) => total + value, 0)
      : null,
    results,
  };
}

function mapTavilyResult(row: TavilyResultRow): MappedTavilyResult {
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

  async invoke(opts: ToolInvokeOptions): Promise<ToolInvokeResult> {
    const start = performance.now();
    throwIfToolInvocationAborted(opts.toolId, opts.context);
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
      throwIfToolInvocationAborted(opts.toolId, opts.context);
      const latencyMs = Math.round(performance.now() - start);
      const routedReceipt = receiptFromResolution(resolution, 'ok', latencyMs, opts);
      return {
        ...result,
        latencyMs,
        receipt: {
          ...routedReceipt,
          ...(result.receipt.runtimeVersions === undefined
            ? {}
            : { runtimeVersions: { ...result.receipt.runtimeVersions } }),
        },
      };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - start);
      const structured = errorFromInvocation(
        opts.toolId,
        err,
        'network',
        opts.context.signal,
        opts.context.deadlineAt,
      );
      const failedReceipt = receiptFromResolution(resolution, 'failed', latencyMs, opts);
      throw new ToolInvocationError(opts.toolId, {
        kind: structured.kind, retryable: structured.retryable, providerStatus: structured.providerStatus,
        sanitizedMessage: structured.sanitizedMessage,
        receipt: {
          ...failedReceipt,
          ...(structured.receipt?.runtimeVersions === undefined
            ? {}
            : { runtimeVersions: { ...structured.receipt.runtimeVersions } }),
        },
        details: structured.details,
      });
    }
  }
}
