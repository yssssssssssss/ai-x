import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { ToolManifest } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import { loadToolManifest } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import {
  PlaywrightPageCaptureAdapter,
  type PlaywrightLauncher,
} from '../apps/orchestrator-runtime/src/runtime/playwright-page-capture-adapter.ts';
import {
  TavilyAdapter,
  type ToolInvocationContext,
} from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const TAVILY_MANIFEST = loadToolManifest('tools/tavily-web-search/manifest.yaml');
const PLAYWRIGHT_MANIFEST: ToolManifest = {
  id: 'playwright-page-capture',
  name: 'Playwright page capture',
  adapter_type: 'playwright',
  auth_required: false,
  risk_level: 'medium',
  timeout_seconds: 90,
  retry_policy: { max_attempts: 2, backoff_seconds: 1 },
  input_schema: 'tools/playwright-page-capture/input.schema.json',
  output_schema: 'tools/playwright-page-capture/output.schema.json',
};
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.from(PNG_1X1);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

function invocationContext(): ToolInvocationContext {
  return {
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 90_000,
  };
}

test('Tavily multi-query results are merged round-robin under one global max_results cap', async () => {
  process.env.TAVILY_API_KEY = 'test-key';
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    const query = String(body.query);
    const prefix = query === 'alpha site:alpha.example' ? 'alpha' : 'beta';
    return new Response(JSON.stringify({
      response_time: 0.1,
      results: [1, 2].map((index) => ({
        title: `${prefix}-${index}`,
        url: `https://${prefix}.example/${index}`,
        content: `${prefix} result ${index}`,
        score: 1 - index / 10,
      })),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await new TavilyAdapter().invoke({
    toolId: TAVILY_MANIFEST.id,
    manifest: TAVILY_MANIFEST,
    context: invocationContext(),
    input: {
      query: ['alpha site:alpha.example', 'beta site:beta.example'],
      max_results: 3,
      search_depth: 'advanced',
    },
  });

  assert.deepEqual(requests.map((request) => request.query), [
    'alpha site:alpha.example',
    'beta site:beta.example',
  ]);
  assert.deepEqual(requests.map((request) => request.max_results), [2, 2]);
  assert.deepEqual(
    (result.output as { results: Array<{ url: string }> }).results.map((row) => row.url),
    [
      'https://alpha.example/1',
      'https://beta.example/1',
      'https://alpha.example/2',
    ],
  );
});

test('Playwright capture spends at most one successful slot per normalized hostname', async () => {
  const attemptedUrls: string[] = [];
  let connected = true;
  const launcher = {
    launch: async () => ({
      newContext: async () => ({
        route: async () => undefined,
        routeWebSocket: async () => undefined,
        on: () => undefined,
        newPage: async () => {
          let currentUrl = 'about:blank';
          return {
            goto: async (url: string) => {
              currentUrl = url;
              attemptedUrls.push(url);
              return { status: () => 200, headers: () => ({ 'content-type': 'text/html' }) };
            },
            url: () => currentUrl,
            title: async () => 'Captured page',
            evaluate: async (fn: unknown) => String(fn).includes('innerText')
              ? ''
              : { width: 1, height: 1 },
            screenshot: async () => PNG_1X1,
            close: async () => undefined,
            on: () => undefined,
          };
        },
        close: async () => undefined,
      }),
      close: async () => { connected = false; },
      isConnected: () => connected,
    }),
  } as unknown as PlaywrightLauncher;
  const adapter = new PlaywrightPageCaptureAdapter({
    launcher,
    resolveHost: async () => ['93.184.216.34'],
    getEffectiveUid: () => 501,
  });

  const result = await adapter.invoke({
    toolId: PLAYWRIGHT_MANIFEST.id,
    manifest: PLAYWRIGHT_MANIFEST,
    context: invocationContext(),
    input: {
      pages: [
        { url: 'https://www.alpha.example/first' },
        { url: 'https://alpha.example/second' },
        { url: 'https://beta.example/first' },
      ],
      capture: { mode: 'full_page_screenshot', max_pages: 2, unique_hostnames: true },
    },
  });

  assert.deepEqual(attemptedUrls.sort(), [
    'https://beta.example/first',
    'https://www.alpha.example/first',
  ]);
  assert.deepEqual(
    result.mediaAttachments?.map((attachment) => attachment.sourcePageUrl).sort(),
    [
      'https://beta.example/first',
      'https://www.alpha.example/first',
    ],
  );
});

test('Playwright capture retries the next same-host candidate after a failed or near-blank page', async () => {
  const attemptedUrls: string[] = [];
  let connected = true;
  const nearBlank = pngHeader(1440, 900);
  const launcher = {
    launch: async () => ({
      newContext: async () => ({
        route: async () => undefined,
        routeWebSocket: async () => undefined,
        on: () => undefined,
        newPage: async () => {
          let currentUrl = 'about:blank';
          return {
            goto: async (url: string) => {
              currentUrl = url;
              attemptedUrls.push(url);
              if (url.endsWith('/about')) {
                throw Object.assign(new Error('navigation timeout'), { name: 'TimeoutError' });
              }
              return { status: () => 200, headers: () => ({ 'content-type': 'text/html' }) };
            },
            url: () => currentUrl,
            title: async () => 'Captured page',
            evaluate: async (fn: unknown) => String(fn).includes('innerText')
              ? ''
              : { width: 1, height: 1 },
            screenshot: async () => currentUrl.endsWith('/') ? PNG_1X1 : nearBlank,
            close: async () => undefined,
            on: () => undefined,
          };
        },
        close: async () => undefined,
      }),
      close: async () => { connected = false; },
      isConnected: () => connected,
    }),
  } as unknown as PlaywrightLauncher;
  const adapter = new PlaywrightPageCaptureAdapter({
    launcher,
    resolveHost: async () => ['93.184.216.34'],
    getEffectiveUid: () => 501,
  });

  const result = await adapter.invoke({
    toolId: PLAYWRIGHT_MANIFEST.id,
    manifest: PLAYWRIGHT_MANIFEST,
    context: invocationContext(),
    input: {
      pages: [
        { url: 'https://alpha.example/about' },
        { url: 'https://alpha.example/brand' },
        { url: 'https://alpha.example/' },
        { url: 'https://beta.example/' },
      ],
      capture: { mode: 'full_page_screenshot', max_pages: 2, unique_hostnames: true },
    },
  });

  assert.ok(attemptedUrls.includes('https://alpha.example/about'));
  assert.ok(attemptedUrls.includes('https://alpha.example/brand'));
  assert.ok(attemptedUrls.includes('https://alpha.example/'));
  assert.ok(attemptedUrls.includes('https://beta.example/'));
  assert.deepEqual(
    result.mediaAttachments?.map((attachment) => attachment.sourcePageUrl).sort(),
    ['https://alpha.example/', 'https://beta.example/'],
  );
  assert.ok(
    (result.output as { failures: Array<{ requested_url: string; sanitized_message: string }> }).failures
      .some((failure) => failure.requested_url.endsWith('/about')),
  );
  assert.ok(
    (result.output as { failures: Array<{ requested_url: string; sanitized_message: string }> }).failures
      .some((failure) => failure.requested_url.endsWith('/brand')),
  );
});
