import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  TavilyAdapter,
  ToolInvocationError,
} from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import { loadToolManifest } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import { buildRuntime } from '../apps/orchestrator-runtime/src/runtime/agent-runtime.ts';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const manifest = loadToolManifest('tools/tavily-web-search/manifest.yaml');

interface CapturedFetch {
  url: string;
  init: RequestInit;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

function installFetch(fn: typeof fetch) {
  globalThis.fetch = fn;
}

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

test('runtime: TOOL_ADAPTER=fake 时 tavily adapter_type 走离线 fake', async () => {
  delete process.env.TAVILY_API_KEY;
  process.env.TOOL_ADAPTER = 'fake';
  installFetch(async () => {
    throw new Error('fake mode must not call Tavily network');
  });

  const runtime = buildRuntime();
  const res = await runtime.deps.toolAdapter.invoke({
    toolId: 'tavily-web-search',
    input: { query: '直播 数字人' },
    manifest,
  });

  assert.deepEqual(res.output, {
    results: [
      { title: '竞品A数字人产品页', url: 'https://example.com/a', snippet: '支持实时语音互动与形象定制' },
      { title: '行业评测:直播AI横评', url: 'https://example.com/review', snippet: '对比交互延迟与内容质量' },
      { title: '应用商店榜单', url: 'https://example.com/rank', snippet: '数字人直播产品下载榜' },
    ],
  });
});

test('missing TAVILY_API_KEY rejects with ToolInvocationError for the requested tool', async () => {
  delete process.env.TAVILY_API_KEY;
  const adapter = new TavilyAdapter();

  await assert.rejects(
    adapter.invoke({ toolId: 'custom-tavily-id', input: { query: 'AI search' }, manifest }),
    (err) => {
      assert.ok(err instanceof ToolInvocationError);
      assert.equal(err.toolId, 'custom-tavily-id');
      assert.match(err.message, /TAVILY_API_KEY/);
      return true;
    },
  );
});

test('successful invoke sends Tavily POST with bearer auth and default body', async () => {
  process.env.TAVILY_API_KEY = 'test-key';
  const captured: CapturedFetch[] = [];
  installFetch(async (url, init) => {
    captured.push({ url: String(url), init: init ?? {} });
    return response({
      answer: 'summary only',
      response_time: 0.12,
      results: [
        {
          title: 'Result title',
          url: 'https://example.com/source',
          content: 'Content becomes snippet',
          score: 0.9,
          published_date: '2026-07-30',
        },
      ],
    });
  });

  const result = await new TavilyAdapter().invoke({
    toolId: 'tavily-web-search',
    input: { query: 'AI search' },
    manifest,
  });

  assert.equal(captured.length, 1);
  const call = captured[0];
  assert.equal(call.url, 'https://api.tavily.com/search');
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(call.init.headers, {
    'Content-Type': 'application/json',
    Authorization: 'Bearer test-key',
  });
  assert.deepEqual(JSON.parse(String(call.init.body)), {
    query: 'AI search',
    max_results: 5,
    search_depth: 'basic',
    topic: 'general',
    include_answer: false,
    include_raw_content: false,
  });
  assert.deepEqual(result.output, {
    answer: 'summary only',
    response_time: 0.12,
    results: [
      {
        title: 'Result title',
        url: 'https://example.com/source',
        snippet: 'Content becomes snippet',
        score: 0.9,
        published_date: '2026-07-30',
      },
    ],
  });
});

test('request body includes optional time_range when supplied', async () => {
  process.env.TAVILY_API_KEY = 'test-key';
  let body: unknown = null;
  installFetch(async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return response({ results: [] });
  });

  await new TavilyAdapter().invoke({
    toolId: 'tavily-web-search',
    input: {
      query: 'AI search',
      max_results: 3,
      search_depth: 'advanced',
      topic: 'news',
      include_answer: 'basic',
      time_range: 'week',
    },
    manifest,
  });

  assert.deepEqual(body, {
    query: 'AI search',
    max_results: 3,
    search_depth: 'advanced',
    topic: 'news',
    include_answer: 'basic',
    include_raw_content: false,
    time_range: 'week',
  });
});

test('output passes tavily output schema and falls back from content to snippet', async () => {
  process.env.TAVILY_API_KEY = 'test-key';
  installFetch(async () => response({
    answer: null,
    response_time: null,
    results: [
      { title: 'Snippet title', url: 'https://example.com/snippet', snippet: 'Existing snippet' },
    ],
  }));

  const result = await new TavilyAdapter().invoke({
    toolId: 'tavily-web-search',
    input: { query: 'AI search' },
    manifest,
  });

  assert.deepEqual(result.output, {
    answer: null,
    response_time: null,
    results: [
      {
        title: 'Snippet title',
        url: 'https://example.com/snippet',
        snippet: 'Existing snippet',
        score: null,
        published_date: null,
      },
    ],
  });
  const errors = new SchemaValidator().validateFile(
    join(process.cwd(), 'tools/tavily-web-search/output.schema.json'),
    result.output,
  );
  assert.deepEqual(errors, []);
});

test('HTTP non-2xx rejects with ToolInvocationError without leaking API key', async () => {
  process.env.TAVILY_API_KEY = 'test-key';
  installFetch(async () => new Response('upstream denied', { status: 403 }));

  await assert.rejects(
    new TavilyAdapter().invoke({
      toolId: 'tavily-web-search',
      input: { query: 'AI search' },
      manifest,
    }),
    (err) => {
      assert.ok(err instanceof ToolInvocationError);
      assert.equal(err.toolId, 'tavily-web-search');
      assert.match(err.message, /HTTP 403: upstream denied/);
      assert.doesNotMatch(err.message, /test-key/);
      return true;
    },
  );
});
