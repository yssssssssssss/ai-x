import { type ToolManifest } from './config-loader.ts';

// tool 调用统一接口。业务/skill 只经此调用 tool,不直接 shell out / import SDK。
// V0 实现 = FakeO2Adapter;二期加 O2Adapter(真实 o2)/ InternalApiAdapter / McpAdapter / ScriptAdapter。

export interface ToolInvokeResult {
  output: object;
  latencyMs: number;
}

export interface ToolAdapter {
  readonly adapterType: ToolManifest['adapter_type'];
  invoke(opts: { toolId: string; input: object; manifest: ToolManifest }): Promise<ToolInvokeResult>;
}

export class ToolInvocationError extends Error {
  constructor(public readonly toolId: string, message: string) {
    super(`tool "${toolId}" 调用失败: ${message}`);
    this.name = 'ToolInvocationError';
  }
}

// Fake o2 adapter:返回预置检索结果。
// failOnToolIds 里的 tool 会抛错——用于验证失败回放(execution_log.status=failed + failures.jsonl)。
export class FakeO2Adapter implements ToolAdapter {
  readonly adapterType = 'fake' as const;

  constructor(private readonly opts: { failOnToolIds?: string[] } = {}) {}

  async invoke(opts: { toolId: string; input: object; manifest: ToolManifest }): Promise<ToolInvokeResult> {
    const start = performance.now();
    if (this.opts.failOnToolIds?.includes(opts.toolId)) {
      throw new ToolInvocationError(opts.toolId, '模拟失败(FakeO2Adapter.failOnToolIds)');
    }
    // 与 o2-web-search/output.schema.json 对齐的预置结果
    const output = {
      results: [
        { title: '竞品A数字人产品页', url: 'https://example.com/a', snippet: '支持实时语音互动与形象定制' },
        { title: '行业评测:直播AI横评', url: 'https://example.com/review', snippet: '对比交互延迟与内容质量' },
        { title: '应用商店榜单', url: 'https://example.com/rank', snippet: '数字人直播产品下载榜' },
      ],
    };
    return { output, latencyMs: Math.round(performance.now() - start) };
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

  private async login(cfg: HttpAdapterConfig): Promise<string> {
    if (!cfg.username || !cfg.password) {
      throw new Error('缺少 SPIDER_USERNAME / SPIDER_PASSWORD,无法登录');
    }
    const res = await fetch(`${cfg.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: cfg.username, password: cfg.password }),
    });
    if (!res.ok) throw new Error(`登录失败 HTTP ${res.status}`);
    const data = (await res.json()) as { access_token?: string };
    if (!data.access_token) throw new Error('登录响应缺少 access_token');
    return data.access_token;
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
      // token 过期 → 重登一次
      if (res.status === 401 && opts.manifest.auth_required) {
        this.token = null;
        res = await doCall();
      }
      if (!res.ok) {
        throw new ToolInvocationError(opts.toolId, `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const raw = (await res.json()) as unknown;
      return { output: mapSearchResults(raw), latencyMs: Math.round(performance.now() - start) };
    } catch (err) {
      if (err instanceof ToolInvocationError) throw err;
      throw new ToolInvocationError(opts.toolId, err instanceof Error ? err.message : String(err));
    }
  }
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

  async invoke(opts: { toolId: string; input: object; manifest: ToolManifest }): Promise<ToolInvokeResult> {
    const adapter = this.byType.get(opts.manifest.adapter_type);
    if (!adapter) {
      throw new ToolInvocationError(opts.toolId, `无对应 adapter: adapter_type=${opts.manifest.adapter_type}`);
    }
    return adapter.invoke(opts);
  }
}
