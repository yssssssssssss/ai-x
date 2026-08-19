import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeO2Adapter,
  HttpApiAdapter,
  TavilyAdapter,
  ToolInvocationError,
  ToolRouter,
  type ToolAdapter,
} from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import { type ToolManifest } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

const baseManifest: ToolManifest = {
  id: 'tavily-web-search',
  name: 'Tavily Web Search',
  adapter_type: 'tavily',
  entrypoint: '/search',
  auth_required: true,
  risk_level: 'low',
  input_schema: 'tools/tavily-web-search/input.schema.json',
  output_schema: 'tools/tavily-web-search/output.schema.json',
};

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

function manifestWith(adapterType: ToolManifest['adapter_type']): ToolManifest {
  return { ...baseManifest, adapter_type: adapterType };
}

function invocationContext() {
  return { signal: new AbortController().signal, deadlineAt: Date.now() + 90_000 };
}

function installFetch(fn: typeof fetch): void {
  globalThis.fetch = fn;
}

function okResponse(): Response {
  return new Response(JSON.stringify({ results: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function captureToolError(promise: Promise<unknown>): Promise<ToolInvocationError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ToolInvocationError);
    return err;
  }
  assert.fail('expected ToolInvocationError');
}

test('ToolRouter receipt records real Tavily identity and endpoint host', async () => {
  process.env.TAVILY_API_KEY = 'test-key';
  installFetch(async () => okResponse());
  const router = new ToolRouter().register(new TavilyAdapter());

  const resolved = router.resolve(manifestWith('tavily'));
  assert.equal(resolved?.declaredAdapterType, 'tavily');
  assert.equal(resolved?.resolvedAdapterType, 'tavily');
  assert.equal(resolved?.implementationId, 'tavily');
  assert.equal(resolved?.executionMode, 'real');

  const result = await router.invoke({
    toolId: 'tavily-web-search',
    input: { query: 'AI search' },
    manifest: manifestWith('tavily'),
    context: invocationContext(),
  });

  assert.equal(result.receipt.declaredAdapterType, 'tavily');
  assert.equal(result.receipt.resolvedAdapterType, 'tavily');
  assert.equal(result.receipt.implementationId, 'tavily');
  assert.equal(result.receipt.executionMode, 'real');
  assert.equal(result.receipt.endpointHost, 'api.tavily.com');
  assert.equal(result.receipt.status, 'ok');
  assert.equal(typeof result.receipt.latencyMs, 'number');
  assert.equal('toolId' in result.receipt, false);
  assert.equal('input' in result.receipt, false);
  assert.equal('manifest' in result.receipt, false);
  assert.equal('context' in result.receipt, false);
});

test('ToolRouter gives a shared lease abort priority over a late adapter success', async () => {
  const controller = new AbortController();
  const adapter = {
    adapterType: 'tavily' as const,
    implementationId: 'late-success-adapter',
    executionMode: 'real' as const,
    async invoke() {
      controller.abort('lease_lost');
      return {
        output: { secretProbe: 'must-not-reach-receipt' },
        latencyMs: 0,
        receipt: {
          declaredAdapterType: 'tavily' as const,
          resolvedAdapterType: 'tavily' as const,
          implementationId: 'late-success-adapter',
          executionMode: 'real' as const,
          endpointHost: null,
          status: 'ok' as const,
          latencyMs: 0,
        },
      };
    },
  } satisfies ToolAdapter;

  const error = await captureToolError(new ToolRouter().register(adapter).invoke({
    toolId: 'tavily-web-search',
    input: { secretProbe: 'must-not-reach-receipt' },
    manifest: manifestWith('tavily'),
    context: { signal: controller.signal, deadlineAt: Date.now() + 90_000 },
  }));

  assert.equal(error.kind, 'lease_lost');
  assert.equal(error.details.abortReason, 'lease_lost');
  assert.doesNotMatch(JSON.stringify(error.receipt), /secretProbe|must-not-reach-receipt/u);
});

test('ToolRouter preserves retry lineage through adapter invocation and receipt', async () => {
  let capturedLineage: { attemptId?: string; retryOf?: string | null } | undefined;
  const adapter = {
    adapterType: 'tavily' as const,
    implementationId: 'capturing-real-adapter',
    executionMode: 'real' as const,
    async invoke(options: Parameters<ToolAdapter['invoke']>[0]) {
      capturedLineage = { attemptId: options.attemptId, retryOf: options.retryOf };
      return {
        output: {},
        latencyMs: 0,
        receipt: {
          declaredAdapterType: 'tavily' as const,
          resolvedAdapterType: 'tavily' as const,
          implementationId: 'capturing-real-adapter',
          executionMode: 'real' as const,
          endpointHost: null,
          status: 'ok' as const,
          latencyMs: 0,
        },
      };
    },
  } satisfies ToolAdapter;

  const result = await new ToolRouter().register(adapter).invoke({
    toolId: 'tavily-web-search',
    input: { query: 'AI search' },
    manifest: manifestWith('tavily'),
    context: invocationContext(),
    attemptId: 'attempt-2',
    retryOf: 'attempt-1',
  });

  assert.deepEqual(capturedLineage, { attemptId: 'attempt-2', retryOf: 'attempt-1' });
  assert.equal(result.receipt.attemptId, 'attempt-2');
  assert.equal(result.receipt.retryOf, 'attempt-1');
});

test('ToolRouter receipt records FakeO2 fake identity without mismatch', async () => {
  const router = new ToolRouter().register(new FakeO2Adapter());

  const result = await router.invoke({
    toolId: 'offline-search',
    input: { query: 'AI search' },
    manifest: manifestWith('fake'),
    context: invocationContext(),
  });

  assert.equal(result.receipt.declaredAdapterType, 'fake');
  assert.equal(result.receipt.resolvedAdapterType, 'fake');
  assert.equal(result.receipt.implementationId, 'fake-o2');
  assert.equal(result.receipt.executionMode, 'fake');
  assert.equal(result.receipt.status, 'ok');
});

test('ToolRouter receipt reports declared/resolved mismatch when O2 is aliased to fake', async () => {
  const router = new ToolRouter().registerAs('o2', new FakeO2Adapter());

  const result = await router.invoke({
    toolId: 'o2-web-search',
    input: { query: 'AI search' },
    manifest: manifestWith('o2'),
    context: invocationContext(),
  });

  assert.equal(result.receipt.declaredAdapterType, 'o2');
  assert.equal(result.receipt.resolvedAdapterType, 'fake');
  assert.equal(result.receipt.implementationId, 'fake-o2');
  assert.equal(result.receipt.executionMode, 'fake');
  assert.equal(result.receipt.status, 'ok');
});

test('ToolRouter receipt reports declared/resolved mismatch when Tavily is aliased to fake', async () => {
  const router = new ToolRouter().registerAs('tavily', new FakeO2Adapter());

  const result = await router.invoke({
    toolId: 'tavily-web-search',
    input: { query: 'AI search' },
    manifest: manifestWith('tavily'),
    context: invocationContext(),
  });

  assert.equal(result.receipt.declaredAdapterType, 'tavily');
  assert.equal(result.receipt.resolvedAdapterType, 'fake');
  assert.equal(result.receipt.implementationId, 'fake-o2');
  assert.equal(result.receipt.executionMode, 'fake');
  assert.equal(result.receipt.status, 'ok');
});

test('ToolRouter missing adapter exposes unknown configuration failure', async () => {
  const router = new ToolRouter();

  await assert.rejects(
    router.invoke({
      toolId: 'missing-tool',
      input: { query: 'AI search' },
      manifest: manifestWith('tavily'),
      context: invocationContext(),
    }),
    (err) => {
      assert.ok(err instanceof ToolInvocationError);
      assert.equal(err.toolId, 'missing-tool');
      assert.equal(err.kind, 'configuration');
      assert.equal(err.retryable, false);
      assert.equal(err.providerStatus, null);
      assert.equal(err.sanitizedMessage, 'No adapter registered for adapter_type=tavily');
      return true;
    },
  );
});

test('ToolRouter preserves resolved identity when an adapter throws an unknown error', async () => {
  const throwingAdapter = {
    adapterType: 'tavily' as const,
    implementationId: 'throwing-real-adapter',
    executionMode: 'real' as const,
    endpointHost: () => 'dependency.test',
    async invoke(): Promise<never> {
      throw new Error('socket closed');
    },
  } satisfies ToolAdapter;
  const error = await captureToolError(new ToolRouter().register(throwingAdapter).invoke({
    toolId: 'tavily-web-search',
    input: { query: 'AI search' },
    manifest: manifestWith('tavily'),
    context: invocationContext(),
  }));

  assert.equal(error.kind, 'network');
  assert.equal(error.receipt?.implementationId, 'throwing-real-adapter');
  assert.equal(error.receipt?.executionMode, 'real');
  assert.equal(error.receipt?.endpointHost, 'dependency.test');
  assert.equal(error.receipt?.status, 'failed');
});


test('HttpApiAdapter login uses an AbortSignal and returns a structured timeout failure', async () => {
  installFetch(async (_input, init) => {
    assert.ok(init?.signal, 'login request must carry an AbortSignal');
    throw new DOMException('aborted', 'AbortError');
  });
  const manifest: ToolManifest = {
    ...baseManifest,
    id: 'ai-spider-search',
    adapter_type: 'internal_api',
    entrypoint: '/api/search',
  };
  const adapter = new HttpApiAdapter({
    baseUrl: 'https://spider.test',
    username: 'user',
    password: 'secret',
    timeoutMs: 10,
  });
  const error = await captureToolError(
    adapter.invoke({ toolId: 'ai-spider-search', input: { query: 'x' }, manifest, context: invocationContext() }),
  );

  assert.equal(error.kind, 'timeout');
  assert.equal(error.retryable, true);
});
test('Tavily failures expose structured kinds without leaking API keys', async () => {
  delete process.env.TAVILY_API_KEY;
  const missingKey = await captureToolError(
    new TavilyAdapter().invoke({ toolId: 'tavily-web-search', input: { query: 'AI search' }, manifest: manifestWith('tavily'), context: invocationContext() }),
  );
  assert.ok(missingKey instanceof ToolInvocationError);
  assert.equal(missingKey.kind, 'configuration');
  assert.equal(missingKey.retryable, false);
  assert.equal(missingKey.providerStatus, null);
  assert.equal(missingKey.sanitizedMessage, 'Missing TAVILY_API_KEY');

  process.env.TAVILY_API_KEY = 'secret-test-key';
  installFetch(async () => new Response('quota exceeded for secret-test-key', { status: 429 }));
  const rateLimited = await captureToolError(
    new TavilyAdapter().invoke({ toolId: 'tavily-web-search', input: { query: 'AI search' }, manifest: manifestWith('tavily'), context: invocationContext() }),
  );
  assert.ok(rateLimited instanceof ToolInvocationError);
  assert.equal(rateLimited.kind, 'rate_limit');
  assert.equal(rateLimited.retryable, true);
  assert.equal(rateLimited.providerStatus, 429);
  assert.doesNotMatch(rateLimited.sanitizedMessage, /secret-test-key/);

  installFetch(async () => new Response('temporary failure', { status: 503 }));
  const server = await captureToolError(
    new TavilyAdapter().invoke({ toolId: 'tavily-web-search', input: { query: 'AI search' }, manifest: manifestWith('tavily'), context: invocationContext() }),
  );
  assert.ok(server instanceof ToolInvocationError);
  assert.equal(server.kind, 'server');
  assert.equal(server.retryable, true);
  assert.equal(server.providerStatus, 503);

  installFetch(async (_url, init) => {
    init?.signal?.dispatchEvent(new Event('abort'));
    throw new DOMException('The operation was aborted.', 'AbortError');
  });
  const timeout = await captureToolError(
    new TavilyAdapter().invoke({ toolId: 'tavily-web-search', input: { query: 'AI search' }, manifest: manifestWith('tavily'), context: invocationContext() }),
  );
  assert.ok(timeout instanceof ToolInvocationError);
  assert.equal(timeout.kind, 'timeout');
  assert.equal(timeout.retryable, true);
  assert.equal(timeout.providerStatus, null);

  installFetch(async () => {
    throw new TypeError('fetch failed');
  });
  const network = await captureToolError(
    new TavilyAdapter().invoke({ toolId: 'tavily-web-search', input: { query: 'AI search' }, manifest: manifestWith('tavily'), context: invocationContext() }),
  );
  assert.ok(network instanceof ToolInvocationError);
  assert.equal(network.kind, 'network');
  assert.equal(network.retryable, true);
  assert.equal(network.providerStatus, null);
});
