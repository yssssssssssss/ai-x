import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RestJsonAdapter } from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import type { ToolManifest } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';

const manifest: ToolManifest = {
  id: 'retry-test', name: 'retry-test', adapter_type: 'rest_json', base_url_env: 'RETRY_TEST_URL',
  auth_required: false, risk_level: 'low', input_schema: 'unused', output_schema: 'unused',
  retry_policy: { max_attempts: 2, backoff_seconds: 0 },
};

test('RestJsonAdapter 仅对瞬态 HTTP 错误重试', async () => {
  process.env.RETRY_TEST_URL = 'http://retry.test';
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return attempts === 1
      ? new Response('temporary', { status: 503 })
      : Response.json({ status: 'ok' });
  };
  try {
    const result = await new RestJsonAdapter().invoke({ toolId: 'retry-test', input: {}, manifest });
    assert.deepEqual(result.output, { status: 'ok' });
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('RestJsonAdapter 不重试确定性 4xx', async () => {
  process.env.RETRY_TEST_URL = 'http://retry.test';
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response('bad request', { status: 400 });
  };
  try {
    await assert.rejects(() => new RestJsonAdapter().invoke({ toolId: 'retry-test', input: {}, manifest }), /HTTP 400/);
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
