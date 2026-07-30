# Tavily Web Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real Tavily-backed public web search Tool named `tavily-web-search` without replacing the existing fake `o2-web-search` path.

**Architecture:** Add a focused `adapter_type: tavily` path to the existing ToolRouter. Tool metadata stays in YAML/JSON schema under `tools/tavily-web-search/`; runtime calls go through `ToolActorRunner → ToolAdapter.invoke()` like every other tool. No generic provider abstraction and no API key in git.

**Tech Stack:** Node.js 20+, TypeScript, native `fetch`, `node:test`, AJV schema validation, YAML registry.

## Global Constraints

- Keep `o2-web-search` registered and unchanged; do not replace it with Tavily.
- New Tool id is exactly `tavily-web-search`.
- New adapter type is exactly `tavily`.
- Tavily API key must be read from `TAVILY_API_KEY`; never write the secret value to code, tests, docs, manifest, examples, logs, or committed config.
- Add `.env.example` placeholders only: `TAVILY_API_KEY=`, `TAVILY_BASE_URL=https://api.tavily.com`, `TAVILY_TIMEOUT_MS=30000`.
- Default request must send `include_raw_content: false`.
- Tavily `answer` is optional summary only; report facts must cite `results[].url`.
- `pnpm test` must not require real Tavily network access.
- Real Tavily verification is opt-in with `TAVILY_TEST=1 npx tsx --test tests/tavily-integration.test.ts`.

---

## File Structure

- Modify: `apps/orchestrator-runtime/src/runtime/config-loader.ts`
  - Add `tavily` to `ToolRegistryEntry.adapter_type` and `ToolManifest.adapter_type` unions.
- Modify: `apps/orchestrator-runtime/src/runtime/tool-adapter.ts`
  - Add `TavilyAdapter`, request/response mapping helpers, and error handling.
- Modify: `apps/orchestrator-runtime/src/runtime/agent-runtime.ts`
  - Register `adapter_type: tavily` in `ToolRouter`.
- Modify: `orchestrator/tool-registry.yaml`
  - Register active `tavily-web-search`.
- Create: `tools/tavily-web-search/manifest.yaml`
  - Runtime boundary and schema paths.
- Create: `tools/tavily-web-search/input.schema.json`
  - Input contract passed to TavilyAdapter.
- Create: `tools/tavily-web-search/output.schema.json`
  - Output contract consumed by report synthesis.
- Create: `tools/tavily-web-search/adapter.md`
  - Operational notes and boundaries.
- Create: `tools/tavily-web-search/examples/example-01.json`
  - Safe example output with fake URLs only.
- Modify: `.env.example`
  - Add Tavily placeholders only.
- Create: `tests/tavily-adapter.test.ts`
  - Offline TDD coverage for adapter behavior.
- Create: `tests/tavily-integration.test.ts`
  - Opt-in real Tavily smoke test.

---

### Task 1: Add Tavily Tool Contract

**Files:**
- Modify: `apps/orchestrator-runtime/src/runtime/config-loader.ts:59-86`
- Modify: `orchestrator/tool-registry.yaml`
- Create: `tools/tavily-web-search/manifest.yaml`
- Create: `tools/tavily-web-search/input.schema.json`
- Create: `tools/tavily-web-search/output.schema.json`
- Create: `tools/tavily-web-search/adapter.md`
- Create: `tools/tavily-web-search/examples/example-01.json`
- Modify: `.env.example`
- Test: existing `tests/registry-linter` coverage through `pnpm lint:registry`

**Interfaces:**
- Consumes: existing `loadToolRegistry()`, `loadToolManifest(relPath)`, `loadToolInputSchema(path)`, registry linter behavior.
- Produces: `ToolManifest.adapter_type` accepts `'tavily'`; active tool `tavily-web-search` resolves to `tools/tavily-web-search/manifest.yaml` with input and output schemas.

- [ ] **Step 1: Write the failing contract by adding registry and manifest first**

Add this registry entry to `orchestrator/tool-registry.yaml` after `o2-web-search`:

```yaml
  - id: tavily-web-search
    name: Tavily 网页检索
    path: tools/tavily-web-search/manifest.yaml
    adapter_type: tavily
    auth_required: true
    risk_level: low
    status: active
```

Create `tools/tavily-web-search/manifest.yaml`:

```yaml
id: tavily-web-search
name: Tavily 网页检索
adapter_type: tavily
entrypoint: /search
base_url_env: TAVILY_BASE_URL
auth_required: true
risk_level: low
approver_rule: none
timeout_seconds: 30
retry_policy:
  max_attempts: 2
  backoff_seconds: 3
input_schema: tools/tavily-web-search/input.schema.json
output_schema: tools/tavily-web-search/output.schema.json
redaction_policy:
  pii: mask
  sensitive_business_data: block
```

Create `tools/tavily-web-search/input.schema.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "tavily-web-search/input.schema.json",
  "title": "TavilyWebSearchInput",
  "type": "object",
  "additionalProperties": false,
  "required": ["query"],
  "properties": {
    "query": { "type": "string", "minLength": 1, "description": "检索关键词" },
    "max_results": { "type": "integer", "minimum": 1, "maximum": 20, "default": 5 },
    "search_depth": { "type": "string", "enum": ["basic", "advanced", "fast", "ultra-fast"], "default": "basic" },
    "topic": { "type": "string", "enum": ["general", "news", "finance"], "default": "general" },
    "time_range": { "type": "string", "enum": ["day", "week", "month", "year", "d", "w", "m", "y"] },
    "include_answer": {
      "oneOf": [
        { "type": "boolean" },
        { "type": "string", "enum": ["basic", "advanced"] }
      ],
      "default": false
    }
  }
}
```

Create `tools/tavily-web-search/output.schema.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "tavily-web-search/output.schema.json",
  "title": "TavilyWebSearchOutput",
  "type": "object",
  "additionalProperties": false,
  "required": ["results"],
  "properties": {
    "answer": { "type": ["string", "null"], "description": "Tavily 生成的摘要，只能辅助阅读，不能作为事实源" },
    "response_time": { "type": ["number", "null"] },
    "results": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "url", "snippet"],
        "properties": {
          "title": { "type": "string" },
          "url": { "type": "string", "minLength": 1 },
          "snippet": { "type": "string" },
          "score": { "type": ["number", "null"] },
          "published_date": { "type": ["string", "null"] }
        }
      }
    }
  }
}
```

Create `tools/tavily-web-search/adapter.md`:

```markdown
# tavily-web-search · Adapter 说明

## 定位

调用 Tavily Search API 做公开网页检索，返回可追溯 URL、标题和摘要，供竞品研究和桌面研究使用。

## 调用方式(adapter_type: tavily → TavilyAdapter)

1. 从 `TAVILY_API_KEY` 读取密钥。
2. 从 `TAVILY_BASE_URL` 读取 base URL，默认 `https://api.tavily.com`。
3. `POST {base_url}/search`，body = `{ query, max_results, search_depth, topic, time_range, include_answer, include_raw_content:false }`。
4. 返回映射为 `output.schema.json` 结构：`answer / response_time / results[]`。

## 配置(本机 .env,勿提交)

```env
TAVILY_API_KEY=
TAVILY_BASE_URL=https://api.tavily.com
TAVILY_TIMEOUT_MS=30000
```

## 边界

- 不默认请求 raw content。
- `answer` 只作摘要，不能作为竞品事实证据。
- 报告事实引用必须落到 `results[].url`。
- API key 不进入日志、manifest、示例或测试输出。
```

Create `tools/tavily-web-search/examples/example-01.json`:

```json
{
  "input": { "query": "直播 数字人 竞品", "max_results": 3 },
  "output": {
    "answer": "公开资料显示，直播数字人能力主要围绕互动、形象生成和运营转化展开。",
    "response_time": 0.72,
    "results": [
      {
        "title": "Example Digital Human Live Commerce",
        "url": "https://example.com/digital-human-live-commerce",
        "snippet": "Example page describing live commerce digital human features.",
        "score": 0.91,
        "published_date": "2026-07-30"
      }
    ]
  }
}
```

Add these lines to `.env.example` after the `TOOL_ADAPTER` block:

```env
# Tavily 公开网页检索 tool(tavily-web-search)连接配置
TAVILY_API_KEY=
TAVILY_BASE_URL=https://api.tavily.com
TAVILY_TIMEOUT_MS=30000
```

- [ ] **Step 2: Run registry linter to verify it fails on unsupported adapter_type**

Run:

```bash
pnpm lint:registry
```

Expected before TypeScript type update: FAIL mentioning invalid `adapter_type` or TypeScript compile error around `tavily` not assignable.

- [ ] **Step 3: Add `tavily` to config-loader unions**

Modify `apps/orchestrator-runtime/src/runtime/config-loader.ts` so both unions include `tavily`:

```ts
export interface ToolRegistryEntry {
  id: string;
  name: string;
  path: string;
  adapter_type: 'o2' | 'internal_api' | 'rest_json' | 'tavily' | 'mcp' | 'script' | 'fake';
  auth_required: boolean;
  risk_level: 'low' | 'medium' | 'high';
  status: 'draft' | 'active' | 'deprecated';
}

export interface ToolManifest {
  id: string;
  name: string;
  adapter_type: 'o2' | 'internal_api' | 'rest_json' | 'tavily' | 'mcp' | 'script' | 'fake';
  entrypoint?: string;
  base_url_env?: string;
  auth_required: boolean;
  risk_level: 'low' | 'medium' | 'high';
  approver_rule?: 'none' | 'owner' | 'security' | 'legal';
  timeout_seconds?: number;
  retry_policy?: { max_attempts: number; backoff_seconds: number };
  input_schema: string;
  output_schema: string;
  redaction_policy?: Record<string, string>;
  image_input_fields?: Array<{ field: string; multiple?: boolean; role?: string }>;
}
```

- [ ] **Step 4: Run linter to verify contract passes**

Run:

```bash
pnpm lint:registry
```

Expected: PASS.

- [ ] **Step 5: Commit contract files**

```bash
git add .env.example orchestrator/tool-registry.yaml apps/orchestrator-runtime/src/runtime/config-loader.ts tools/tavily-web-search
git commit -m "feat: add tavily web search contract"
```

---

### Task 2: Implement TavilyAdapter with Offline TDD

**Files:**
- Create: `tests/tavily-adapter.test.ts`
- Modify: `apps/orchestrator-runtime/src/runtime/tool-adapter.ts`

**Interfaces:**
- Consumes: `ToolAdapter.invoke(opts: { toolId: string; input: object; manifest: ToolManifest }): Promise<ToolInvokeResult>`.
- Produces: exported `class TavilyAdapter implements ToolAdapter`, `adapterType = 'tavily'`, output matching `tools/tavily-web-search/output.schema.json`.

- [ ] **Step 1: Write failing tests for TavilyAdapter**

Create `tests/tavily-adapter.test.ts`:

```ts
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  TavilyAdapter,
  ToolInvocationError,
} from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import { loadToolManifest } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

const OLD_ENV = { ...process.env };
const manifest = loadToolManifest('tools/tavily-web-search/manifest.yaml');

afterEach(() => {
  process.env = { ...OLD_ENV };
  globalThis.fetch = OLD_ENV.fetch as typeof fetch;
});

function installFetch(fn: typeof fetch) {
  globalThis.fetch = fn;
}

test('tavily-adapter: 缺 TAVILY_API_KEY 时抛 ToolInvocationError', async () => {
  delete process.env.TAVILY_API_KEY;
  const adapter = new TavilyAdapter();

  await assert.rejects(
    () => adapter.invoke({ toolId: 'tavily-web-search', input: { query: '直播 数字人' }, manifest }),
    (err) => err instanceof ToolInvocationError && /TAVILY_API_KEY/.test(err.message),
  );
});

test('tavily-adapter: 发送正确请求且强制 include_raw_content=false', async () => {
  process.env.TAVILY_API_KEY = 'test-key';
  process.env.TAVILY_BASE_URL = 'https://api.tavily.com';
  let captured: { url?: string; init?: RequestInit; body?: Record<string, unknown> } = {};

  installFetch(async (url, init) => {
    captured = { url: String(url), init, body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({
      answer: '摘要',
      response_time: 0.5,
      results: [{ title: 'A', url: 'https://example.com/a', content: '片段', score: 0.9, published_date: '2026-07-30' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const adapter = new TavilyAdapter();
  const res = await adapter.invoke({
    toolId: 'tavily-web-search',
    input: { query: '直播 数字人', max_results: 3, include_answer: 'basic' },
    manifest,
  });

  assert.equal(captured.url, 'https://api.tavily.com/search');
  assert.equal((captured.init?.headers as Record<string, string>)['Content-Type'], 'application/json');
  assert.equal((captured.init?.headers as Record<string, string>)['Authorization'], 'Bearer test-key');
  assert.deepEqual(captured.body, {
    query: '直播 数字人',
    max_results: 3,
    search_depth: 'basic',
    topic: 'general',
    include_answer: 'basic',
    include_raw_content: false,
  });
  assert.deepEqual(res.output, {
    answer: '摘要',
    response_time: 0.5,
    results: [{ title: 'A', url: 'https://example.com/a', snippet: '片段', score: 0.9, published_date: '2026-07-30' }],
  });
});

test('tavily-adapter: output 通过 tavily output schema', async () => {
  process.env.TAVILY_API_KEY = 'test-key';
  installFetch(async () => new Response(JSON.stringify({
    results: [{ title: 'B', url: 'https://example.com/b', content: '内容' }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

  const adapter = new TavilyAdapter();
  const res = await adapter.invoke({ toolId: 'tavily-web-search', input: { query: '竞品' }, manifest });
  const validator = new SchemaValidator();
  const errors = validator.validateFile(join(process.cwd(), 'tools/tavily-web-search/output.schema.json'), res.output);

  assert.deepEqual(errors, []);
});

test('tavily-adapter: HTTP 非 2xx 时抛 ToolInvocationError 且不泄漏 key', async () => {
  process.env.TAVILY_API_KEY = 'secret-key-should-not-appear';
  installFetch(async () => new Response('bad request', { status: 400 }));
  const adapter = new TavilyAdapter();

  await assert.rejects(
    () => adapter.invoke({ toolId: 'tavily-web-search', input: { query: 'x' }, manifest }),
    (err) => err instanceof ToolInvocationError && /HTTP 400/.test(err.message) && !err.message.includes('secret-key-should-not-appear'),
  );
});
```

- [ ] **Step 2: Run tests to verify they fail because TavilyAdapter is missing**

Run:

```bash
npx tsx --test tests/tavily-adapter.test.ts
```

Expected: FAIL with import/export error for `TavilyAdapter`.

- [ ] **Step 3: Implement minimal TavilyAdapter**

Modify `apps/orchestrator-runtime/src/runtime/tool-adapter.ts` after `RestJsonAdapter` and before `mapSearchResults`:

```ts
interface TavilyAdapterConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
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

  constructor(private readonly cfg?: Partial<TavilyAdapterConfig>) {}

  private config(): TavilyAdapterConfig {
    const apiKey = this.cfg?.apiKey ?? process.env.TAVILY_API_KEY;
    if (!apiKey) throw new ToolInvocationError('tavily-web-search', '缺少 TAVILY_API_KEY,无法调用 Tavily');
    return {
      baseUrl: (this.cfg?.baseUrl ?? process.env.TAVILY_BASE_URL ?? 'https://api.tavily.com').replace(/\/$/, ''),
      apiKey,
      timeoutMs: this.cfg?.timeoutMs ?? Number(process.env.TAVILY_TIMEOUT_MS ?? 30000),
    };
  }

  async invoke(opts: { toolId: string; input: object; manifest: ToolManifest }): Promise<ToolInvokeResult> {
    const start = performance.now();
    let cfg: TavilyAdapterConfig;
    try {
      cfg = this.config();
    } catch (err) {
      if (err instanceof ToolInvocationError) throw new ToolInvocationError(opts.toolId, err.message.replace(/^tool ".*" 调用失败: /, ''));
      throw err;
    }

    const input = opts.input as Record<string, unknown>;
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
    const timeoutMs = opts.manifest.timeout_seconds ? opts.manifest.timeout_seconds * 1000 : cfg.timeoutMs;
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${cfg.baseUrl}${opts.manifest.entrypoint || '/search'}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) {
        throw new ToolInvocationError(opts.toolId, `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const raw = (await res.json()) as TavilyResponse;
      return { output: mapTavilyResponse(raw), latencyMs: Math.round(performance.now() - start) };
    } catch (err) {
      if (err instanceof ToolInvocationError) throw err;
      throw new ToolInvocationError(opts.toolId, err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }
}

function mapTavilyResponse(raw: TavilyResponse): object {
  const results = Array.isArray(raw.results) ? raw.results : [];
  return {
    answer: typeof raw.answer === 'string' ? raw.answer : null,
    response_time: typeof raw.response_time === 'number' ? raw.response_time : null,
    results: results.map((item) => {
      const row = item as TavilyResultRow;
      return {
        title: typeof row.title === 'string' ? row.title : '',
        url: typeof row.url === 'string' ? row.url : '',
        snippet: typeof row.content === 'string' ? row.content : typeof row.snippet === 'string' ? row.snippet : '',
        score: typeof row.score === 'number' ? row.score : null,
        published_date: typeof row.published_date === 'string' ? row.published_date : null,
      };
    }),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npx tsx --test tests/tavily-adapter.test.ts
```

Expected: PASS all 4 tests.

- [ ] **Step 5: Commit adapter implementation**

```bash
git add tests/tavily-adapter.test.ts apps/orchestrator-runtime/src/runtime/tool-adapter.ts
git commit -m "feat: add tavily adapter"
```

---

### Task 3: Register TavilyAdapter in Runtime and Add Integration Smoke

**Files:**
- Modify: `apps/orchestrator-runtime/src/runtime/agent-runtime.ts`
- Create: `tests/tavily-integration.test.ts`

**Interfaces:**
- Consumes: `TavilyAdapter` export from `tool-adapter.ts`.
- Produces: `buildRuntime().deps.toolAdapter` can invoke manifests with `adapter_type: tavily`; opt-in test exercises real Tavily network path.

- [ ] **Step 1: Write failing runtime registration test inside tavily adapter test file**

Append to `tests/tavily-adapter.test.ts`:

```ts
import { buildRuntime } from '../apps/orchestrator-runtime/src/runtime/agent-runtime.ts';

test('runtime: ToolRouter 注册 tavily adapter_type', async () => {
  process.env.TAVILY_API_KEY = 'test-key';
  installFetch(async () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

  const runtime = buildRuntime();
  const res = await runtime.deps.toolAdapter.invoke({
    toolId: 'tavily-web-search',
    input: { query: '直播 数字人' },
    manifest,
  });

  assert.deepEqual(res.output, { answer: null, response_time: null, results: [] });
});
```

- [ ] **Step 2: Run test to verify it fails because router lacks tavily registration**

Run:

```bash
npx tsx --test tests/tavily-adapter.test.ts
```

Expected: FAIL with `无对应 adapter: adapter_type=tavily`.

- [ ] **Step 3: Register TavilyAdapter in runtime**

Modify `apps/orchestrator-runtime/src/runtime/agent-runtime.ts` import:

```ts
import { type ToolAdapter, FakeO2Adapter, HttpApiAdapter, RestJsonAdapter, TavilyAdapter, ToolRouter } from './tool-adapter.ts';
```

Modify `buildToolAdapter()`:

```ts
function buildToolAdapter(channel: string): ToolAdapter {
  // ToolRouter 按 tool manifest 的 adapter_type 分发,fake / o2 / internal_api / tavily 共存。
  // fake 与 o2 都映射到 FakeO2Adapter(V0 无真实 o2 通道);internal_api 和 tavily 走真实 HTTP。
  const fake = new FakeO2Adapter();
  const router = new ToolRouter();
  router.registerAs('fake', fake);
  router.registerAs('o2', fake);
  router.registerAs('internal_api', new HttpApiAdapter());
  router.registerAs('rest_json', new RestJsonAdapter());
  router.registerAs('tavily', new TavilyAdapter());
  void channel;
  return router;
}
```

- [ ] **Step 4: Run offline tests to verify runtime registration passes**

Run:

```bash
npx tsx --test tests/tavily-adapter.test.ts
```

Expected: PASS all tests.

- [ ] **Step 5: Add opt-in real integration test**

Create `tests/tavily-integration.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadEnv } from '../database/db.ts';
import { TavilyAdapter } from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import { loadToolManifest } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

// 可选集成测:默认 skip(不依赖 Tavily 网络和配额)。
// 真机验证:.env 填好 TAVILY_API_KEY,再:
//   TAVILY_TEST=1 npx tsx --test tests/tavily-integration.test.ts
loadEnv();
const skip = !process.env.TAVILY_TEST;

test('TavilyAdapter 能检索公开网页并返回 schema 合法结果', { skip }, async () => {
  const adapter = new TavilyAdapter();
  const manifest = loadToolManifest('tools/tavily-web-search/manifest.yaml');
  const res = await adapter.invoke({
    toolId: 'tavily-web-search',
    input: { query: '直播 数字人 竞品', max_results: 3 },
    manifest,
  });

  const validator = new SchemaValidator();
  const errors = validator.validateFile(
    join(process.cwd(), 'tools/tavily-web-search/output.schema.json'),
    res.output,
  );
  assert.deepEqual(errors, [], `Tavily 结果应过 schema,实际: ${errors.join('; ')}`);
  const out = res.output as { results: unknown[] };
  console.log(`  Tavily 命中 ${out.results.length} 条,耗时 ${res.latencyMs}ms`);
  if (out.results.length === 0) console.log('  ⚠️ Tavily 返回为空,确认配额、网络或查询词');
});
```

- [ ] **Step 6: Run default test to verify integration is skipped**

Run:

```bash
npx tsx --test tests/tavily-integration.test.ts
```

Expected: PASS with 1 skipped test.

- [ ] **Step 7: Commit runtime registration and integration smoke**

```bash
git add apps/orchestrator-runtime/src/runtime/agent-runtime.ts tests/tavily-adapter.test.ts tests/tavily-integration.test.ts
git commit -m "test: add tavily runtime and integration coverage"
```

---

### Task 4: Final Quality Gate and Local Secret Setup

**Files:**
- Modify: `.env` only if local Tavily verification is requested; `.env` is not committed.
- No production source changes unless previous tasks exposed failures.

**Interfaces:**
- Consumes: all previous task outputs.
- Produces: verified offline quality gate and optional real Tavily smoke evidence.

- [ ] **Step 1: Run project offline quality gate**

Run:

```bash
pnpm lint:registry && pnpm test
```

Expected: PASS. `tests/tavily-integration.test.ts` is skipped unless `TAVILY_TEST=1` is set.

- [ ] **Step 2: Add Tavily key to local `.env` without committing it**

Open `.env` and add these keys if they are absent. Use the secret value supplied by the user in the current private conversation for `TAVILY_API_KEY`; do not paste it into any committed file or command transcript.

```env
TAVILY_API_KEY=<use-user-provided-secret-only-in-local-env>
TAVILY_BASE_URL=https://api.tavily.com
TAVILY_TIMEOUT_MS=30000
```

After editing, run:

```bash
git status --short .env
```

Expected: `.env` remains untracked or ignored; do not stage it.

- [ ] **Step 3: Run real Tavily smoke test**

Run:

```bash
TAVILY_TEST=1 npx tsx --test tests/tavily-integration.test.ts
```

Expected: PASS. Output may show 0 or more results, but schema validation must pass and API key must not appear in output.

- [ ] **Step 4: Run final status check and verify no secret is staged**

Run:

```bash
git status --short
```

Expected: only intended source/test/tool contract files are staged or committed; `.env` is not staged. If any output contains `TAVILY_API_KEY` value, stop and remove it from logs/artifacts before proceeding.

- [ ] **Step 5: Commit final fixes only if Task 4 changed tracked files**

If Task 4 required source/test fixes, commit them:

```bash
git add <changed-tracked-files-only>
git commit -m "chore: verify tavily web search gate"
```

If Task 4 only changed `.env`, do not commit.

---

## Plan Self-Review

- Spec coverage: Task 1 covers registry, manifest, schemas, examples, `.env.example`; Task 2 covers `TavilyAdapter`, request defaults, response mapping, no raw content, error handling; Task 3 covers ToolRouter registration and opt-in integration test; Task 4 covers quality gate and local secret handling.
- Placeholder scan: The only angle-bracket token is in a local `.env` instruction and explicitly denotes a non-committed secret insertion step; no production code or committed file contains placeholders.
- Type consistency: `adapter_type: tavily`, `TavilyAdapter`, `tavily-web-search`, `max_results`, `search_depth`, `include_answer`, `include_raw_content:false`, `answer`, `response_time`, and `results[].snippet` names are consistent across tasks.
- Boundary check: `o2-web-search` remains unchanged; no generic web search provider abstraction is introduced.
