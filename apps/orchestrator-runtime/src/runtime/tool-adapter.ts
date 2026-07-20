import { type ToolManifest } from './config-loader.ts';
import { spawn } from 'node:child_process';

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

// RestJsonAdapter:无鉴权 REST 工具的通用通道(external-tools/*-lab 均走此)。
// 与 HttpApiAdapter 的区别:不登录、不做结果映射——body/返回都原样透传。
// base_url 从 manifest.base_url_env 指定的环境变量读(如 EXPERIENCE_MODEL_BASE_URL);
// entrypoint 由 manifest 声明(如 /api/analyze);超时取 manifest.timeout_seconds。
export class RestJsonAdapter implements ToolAdapter {
  readonly adapterType = 'rest_json' as const;

  async invoke(opts: { toolId: string; input: object; manifest: ToolManifest }): Promise<ToolInvokeResult> {
    const start = performance.now();
    const envKey = opts.manifest.base_url_env;
    const baseUrl = (envKey ? process.env[envKey] : undefined)?.replace(/\/$/, '');
    if (!baseUrl) {
      throw new ToolInvocationError(opts.toolId, `缺少 base_url:请设置环境变量 ${envKey ?? '(manifest 未声明 base_url_env)'}`);
    }
    const path = opts.manifest.entrypoint || '/api/analyze';
    const timeoutMs = (opts.manifest.timeout_seconds ?? 60) * 1000;

    // body_inject:从 env 读值注入 body,支持 API key 等鉴权字段(如 { api_key: 'TAVILY_API_KEY' })
    const inject = (opts.manifest as ToolManifest & { body_inject?: Record<string, string> }).body_inject ?? {};
    const body = { ...(opts.input as Record<string, unknown>) };
    for (const [field, env] of Object.entries(inject)) {
      const v = process.env[env];
      if (v) body[field] = v;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) {
        throw new ToolInvocationError(opts.toolId, `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const output = (await res.json()) as object;
      return { output, latencyMs: Math.round(performance.now() - start) };
    } catch (err) {
      if (err instanceof ToolInvocationError) throw err;
      throw new ToolInvocationError(opts.toolId, err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }
}

// O2LaunchAdapter:通过 o2 CLI 生态调用真实检索能力。
// 契约:tool manifest 声明 o2_cli(如 metasearch)+ o2_subcommand(如 search)+ arg_template(参数占位);
// 输出走 stdout JSON,按 output_path(如 "data.products")取出主字段,套上 manifest 声明的 output_field(如 "products")。
// 认证:各 o2 CLI 有自己的鉴权(env token / SSO 登录态),由 CLI 自行读;adapter 只是 spawn。
export class O2LaunchAdapter implements ToolAdapter {
  readonly adapterType = 'o2' as const;

  async invoke(opts: { toolId: string; input: object; manifest: ToolManifest }): Promise<ToolInvokeResult> {
    const start = performance.now();
    const m = opts.manifest as ToolManifest & {
      o2_cli?: string;
      o2_subcommand?: string;
      o2_arg_map?: Record<string, string>;    // { queryInputField: 'query' } → arg 从 input.<field> 取值
      o2_extra_args?: string[];               // 附加参数如 ["--output","json"]
      o2_output_path?: string;                // 从 stdout JSON 取哪一路径(如 "data.products")
      o2_output_field?: string;               // 打包 output 的 field 名(如 "products")
    };
    const cli = m.o2_cli;
    const sub = m.o2_subcommand;
    if (!cli) throw new ToolInvocationError(opts.toolId, 'manifest 缺 o2_cli');

    // 组装命令:o2 launch <cli> [subcommand] <args> [extra_args]
    const args = ['launch', cli];
    if (sub) args.push(sub);
    const input = opts.input as Record<string, unknown>;
    // arg_map 未声明时,默认把 input.query 作为主要位置参数(与 metasearch/o2-crawler 语义一致)
    const argMap = m.o2_arg_map ?? { query: 'query' };
    for (const [inputField] of Object.entries(argMap)) {
      const v = input[inputField];
      if (v !== undefined && v !== null && v !== '') args.push(String(v));
    }
    for (const a of m.o2_extra_args ?? ['--output', 'json']) args.push(a);

    const timeoutMs = (m.timeout_seconds ?? 60) * 1000;
    return new Promise((resolve, reject) => {
      const child = spawn('o2', args, { env: process.env });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new ToolInvocationError(opts.toolId, `o2 launch 超时 ${timeoutMs}ms`)); }, timeoutMs);
      child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
      child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
      child.on('error', (err) => { clearTimeout(timer); reject(new ToolInvocationError(opts.toolId, `spawn o2 失败: ${err.message}`)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new ToolInvocationError(opts.toolId, `o2 exit=${code}: ${stderr.slice(0, 300) || stdout.slice(0, 300)}`));
        let parsed: unknown;
        try { parsed = JSON.parse(stdout); }
        catch (e) { return reject(new ToolInvocationError(opts.toolId, `o2 stdout 非 JSON: ${stdout.slice(0, 200)}`)); }
        const p = parsed as Record<string, unknown>;
        if (p.ok === false) return reject(new ToolInvocationError(opts.toolId, `o2 返回 ok=false: ${JSON.stringify(p).slice(0, 200)}`));

        // 按 o2_output_path 取主字段(如 "data.products");未声明则原样透传
        const path = m.o2_output_path;
        let picked: unknown = parsed;
        if (path) {
          picked = path.split('.').reduce((acc: any, k) => (acc && typeof acc === 'object' ? acc[k] : undefined), parsed);
        }
        const field = m.o2_output_field ?? 'results';
        const output = { [field]: picked ?? [] };
        resolve({ output, latencyMs: Math.round(performance.now() - start) });
      });
    });
  }
}

// WebcliAdapter:通过 webcli(Make any website your CLI)生态调用真实检索能力。
// 与 O2LaunchAdapter 的区别:二进制是 `webcli`,调用形态 `webcli <adapter> <command> <位置参数> --flags`,
// 输出多为裸 JSON 数组(如 joyspace search 返回 [{title,url,...}])。复用浏览器 SSO 登录态,无需单独申请数据权限。
// 契约(manifest 字段):
//   webcli_adapter    如 "joyspace"     → 第一段
//   webcli_command    如 "search"       → 第二段
//   webcli_arg_map    { query: 'query' }→ 按声明顺序把 input.<field> 追加为位置参数
//   webcli_flag_map   { limit: '--limit' } → input.<field> 有值时追加 "--limit <value>"
//   webcli_extra_args 默认 ['-f','json','--window','background']
//   webcli_output_field 裸数组时打包字段名(如 "results"/"notes");未声明则原样透传
// 部署注意:webcli 依赖浏览器桥 daemon + Chrome 扩展常驻;生产 Linux 需无头 Chrome + 扩展。
export class WebcliAdapter implements ToolAdapter {
  readonly adapterType = 'webcli' as const;

  async invoke(opts: { toolId: string; input: object; manifest: ToolManifest }): Promise<ToolInvokeResult> {
    const start = performance.now();
    const m = opts.manifest as ToolManifest & {
      webcli_adapter?: string;
      webcli_command?: string;
      webcli_arg_map?: Record<string, string>;
      webcli_flag_map?: Record<string, string>;
      webcli_extra_args?: string[];
      webcli_output_field?: string;
    };
    const adapter = m.webcli_adapter;
    const command = m.webcli_command;
    if (!adapter || !command) throw new ToolInvocationError(opts.toolId, 'manifest 缺 webcli_adapter / webcli_command');

    const input = opts.input as Record<string, unknown>;
    const args = [adapter, command];
    // 位置参数:按 arg_map 声明顺序
    for (const [inputField] of Object.entries(m.webcli_arg_map ?? { query: 'query' })) {
      const v = input[inputField];
      if (v !== undefined && v !== null && v !== '') args.push(String(v));
    }
    // flag 参数:仅在 input 有值时追加
    for (const [inputField, flag] of Object.entries(m.webcli_flag_map ?? {})) {
      const v = input[inputField];
      if (v !== undefined && v !== null && v !== '') args.push(flag, String(v));
    }
    for (const a of m.webcli_extra_args ?? ['-f', 'json', '--window', 'background']) args.push(a);

    const timeoutMs = (m.timeout_seconds ?? 90) * 1000; // 浏览器自动化偏慢,默认 90s
    const outputField = m.webcli_output_field;
    return new Promise((resolve, reject) => {
      const child = spawn('webcli', args, { env: process.env });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new ToolInvocationError(opts.toolId, `webcli 超时 ${timeoutMs}ms`)); }, timeoutMs);
      child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
      child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
      child.on('error', (err) => { clearTimeout(timer); reject(new ToolInvocationError(opts.toolId, `spawn webcli 失败: ${err.message}`)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        let parsed: unknown;
        try { parsed = JSON.parse(stdout); }
        catch { return reject(new ToolInvocationError(opts.toolId, `webcli 非 JSON 输出(exit=${code}): ${(stderr || stdout).slice(0, 300)}`)); }
        // webcli 失败契约:{ ok:false, error:{...} }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as Record<string, unknown>).ok === false) {
          return reject(new ToolInvocationError(opts.toolId, `webcli 返回 ok=false: ${JSON.stringify(parsed).slice(0, 200)}`));
        }
        const output = outputField ? { [outputField]: parsed } : (Array.isArray(parsed) ? { results: parsed } : (parsed as object));
        resolve({ output, latencyMs: Math.round(performance.now() - start) });
      });
    });
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
