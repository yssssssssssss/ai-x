import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GatewayLLMClient } from '../apps/orchestrator-runtime/src/runtime/gateway-llm-client.ts';

const chain = [
  { name: 'GPT-5.4-joybuilder', endpoint: '/chat/completions' as const, protocol: 'openai' as const },
  { name: 'GPT-5.2-joybuilder', endpoint: '/chat/completions' as const, protocol: 'openai' as const },
  { name: 'GPT-5-joybuilder', endpoint: '/chat/completions' as const, protocol: 'openai' as const },
];

function createClient() {
  return new GatewayLLMClient({
    baseUrl: 'http://gateway.test/v1',
    apiKey: 'test-key',
    chain,
    timeoutMs: 1000,
    rateLimitBackoffMs: 1,
    circuitFailureThreshold: 2,
    circuitCooldownMs: 60_000,
  });
}

function successResponse(model: string): Response {
  return Response.json({
    id: `request-${model}`,
    model,
    choices: [{ message: { content: 'OK' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

test('网关按 5.4、5.2、5 顺序切换 5xx 故障候选', async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const model = JSON.parse(String(init?.body)).model as string;
    requested.push(model);
    return model === 'GPT-5-joybuilder' ? successResponse(model) : new Response('unavailable', { status: 503 });
  };
  try {
    const result = await createClient().generateText({ prompt: '只回复 OK' });
    assert.equal(result.text, 'OK');
    assert.equal(result.modelName, 'GPT-5-joybuilder');
    assert.deepEqual(requested, ['GPT-5.4-joybuilder', 'GPT-5.2-joybuilder', 'GPT-5-joybuilder']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('普通 429 有限退避后也会切换候选模型', async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const model = JSON.parse(String(init?.body)).model as string;
    requested.push(model);
    return model === 'GPT-5.2-joybuilder'
      ? successResponse(model)
      : new Response(JSON.stringify({ error: { message: 'too many requests' } }), { status: 429 });
  };
  try {
    const result = await createClient().generateText({ prompt: '只回复 OK' });
    assert.equal(result.modelName, 'GPT-5.2-joybuilder');
    assert.deepEqual(requested, [
      'GPT-5.4-joybuilder',
      'GPT-5.4-joybuilder',
      'GPT-5.4-joybuilder',
      'GPT-5.2-joybuilder',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('认证类 4xx 不切换候选模型', async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const model = JSON.parse(String(init?.body)).model as string;
    requested.push(model);
    return new Response('unauthorized', { status: 401 });
  };
  try {
    await assert.rejects(() => createClient().generateText({ prompt: '只回复 OK' }), /HTTP 401/);
    assert.deepEqual(requested, ['GPT-5.4-joybuilder']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('连续失败候选进入冷却，后续请求直接使用健康候选', async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const model = JSON.parse(String(init?.body)).model as string;
    requested.push(model);
    return model === 'GPT-5.4-joybuilder'
      ? new Response('unavailable', { status: 503 })
      : successResponse(model);
  };
  try {
    const client = createClient();
    await client.generateText({ prompt: '第一次' });
    await client.generateText({ prompt: '第二次' });
    await client.generateText({ prompt: '第三次' });
    assert.deepEqual(requested, [
      'GPT-5.4-joybuilder', 'GPT-5.2-joybuilder',
      'GPT-5.4-joybuilder', 'GPT-5.2-joybuilder',
      'GPT-5.2-joybuilder',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
