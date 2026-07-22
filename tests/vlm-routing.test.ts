import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../external-tools/vision-brand-lab/apps/server/src/config/env.ts';
import { chatVisionJSON } from '../external-tools/vision-brand-lab/apps/server/src/services/llmClient.ts';

test('VLM 客户端按独立模型列表回退并报告实际模型与尝试次数', async () => {
  const previous = { ...env.llm, models: [...env.llm.models] };
  const originalFetch = globalThis.fetch;
  const requestedModels: string[] = [];
  env.llm.baseUrl = 'http://vlm.test/v1';
  env.llm.apiKey = 'test-key';
  env.llm.models = ['vision-primary', 'vision-fallback'];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    requestedModels.push(body.model);
    return body.model === 'vision-primary'
      ? new Response('unavailable', { status: 503 })
      : Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
  };
  try {
    const result = await chatVisionJSON<{ ok: boolean }>([{ role: 'user', content: 'test' }]);
    assert.deepEqual(requestedModels, ['vision-primary', 'vision-fallback']);
    assert.equal(result.model, 'vision-fallback');
    assert.equal(result.attempts, 2);
    assert.ok(result.latencyMs >= 0);
    assert.equal(result.data.ok, true);
  } finally {
    Object.assign(env.llm, previous);
    globalThis.fetch = originalFetch;
  }
});

test('VLM 客户端对 HTTP 200 错误载荷和无法解析 JSON 切换候选', async () => {
  const previous = { ...env.llm, models: [...env.llm.models] };
  const originalFetch = globalThis.fetch;
  const requestedModels: string[] = [];
  Object.assign(env.llm, { baseUrl: 'http://vlm.test/v1', apiKey: 'test-key', models: ['primary', 'fallback'] });
  globalThis.fetch = async (_url, init) => {
    const model = JSON.parse(String(init?.body)).model as string;
    requestedModels.push(model);
    return model === 'primary'
      ? Response.json({ error: { message: 'model unavailable' } })
      : Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
  };
  try {
    const result = await chatVisionJSON<{ ok: boolean }>([{ role: 'user', content: 'test' }]);
    assert.deepEqual(requestedModels, ['primary', 'fallback']);
    assert.equal(result.model, 'fallback');
    assert.equal(result.data.ok, true);
  } finally {
    Object.assign(env.llm, previous);
    globalThis.fetch = originalFetch;
  }
});
