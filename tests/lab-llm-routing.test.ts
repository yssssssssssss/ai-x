import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveVisionLlm as resolveAttentionVlm } from '../external-tools/attention-analysis-lab/apps/server/src/config/env.ts';
import { env as attentionEnv } from '../external-tools/attention-analysis-lab/apps/server/src/config/env.ts';
import { chatVisionJSON as chatAttentionVisionJSON } from '../external-tools/attention-analysis-lab/apps/server/src/services/llmClient.ts';
import { resolveVisionLlm as resolveBrandVlm } from '../external-tools/vision-brand-lab/apps/server/src/config/env.ts';
import { env as virtualUserEnv } from '../external-tools/virtual-user-lab/apps/server/src/config/env.ts';
import { chatJSON } from '../external-tools/virtual-user-lab/apps/server/src/services/llmClient.ts';

test('视觉实验室仅在显式开关开启时继承文本三模型链路', () => {
  const resolved = resolveAttentionVlm({
    VLM_USE_TEXT_GATEWAY: 'true',
    LLM_GATEWAY_BASE_URL: 'http://gateway.test/v1',
    LLM_GATEWAY_API_KEY: 'test-key',
    LLM_MODEL_NAME: 'GPT-5.4-joybuilder',
    LLM_MODEL_FALLBACKS: 'GPT-5.2-joybuilder,GPT-5-joybuilder,GPT-5.2-joybuilder',
  });
  assert.equal(resolved.baseUrl, 'http://gateway.test/v1');
  assert.deepEqual(resolved.models, ['GPT-5.4-joybuilder', 'GPT-5.2-joybuilder', 'GPT-5-joybuilder']);

  const isolated = resolveAttentionVlm({ LLM_MODEL_NAME: 'GPT-5.4-joybuilder' });
  assert.equal(isolated.baseUrl, '');
  assert.deepEqual(isolated.models, []);
});

test('视觉品牌实验室保留独立视觉模型候选并复用网关连接配置', () => {
  const resolved = resolveBrandVlm({
    VLM_USE_TEXT_GATEWAY: 'true',
    LLM_GATEWAY_BASE_URL: 'http://gateway.test/v1',
    LLM_GATEWAY_API_KEY: 'test-key',
    VLM_MODEL_NAME: 'GPT-5.4-joybuilder',
    VLM_MODEL_FALLBACKS: 'GPT-5.5-joybuilder,GPT-5-joybuilder',
  });
  assert.equal(resolved.baseUrl, 'http://gateway.test/v1');
  assert.equal(resolved.apiKey, 'test-key');
  assert.deepEqual(resolved.models, ['GPT-5.4-joybuilder', 'GPT-5.5-joybuilder', 'GPT-5-joybuilder']);
});

test('注意力 VLM 仅在可恢复错误时切换候选', async () => {
  const previous = { ...attentionEnv.llm, models: [...attentionEnv.llm.models] };
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  Object.assign(attentionEnv.llm, { baseUrl: 'http://vlm.test/v1', apiKey: 'test-key', models: ['primary', 'fallback'] });
  globalThis.fetch = async (_url, init) => {
    const model = JSON.parse(String(init?.body)).model as string;
    requested.push(model);
    return model === 'primary'
      ? new Response('unavailable', { status: 503 })
      : Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
  };
  try {
    const result = await chatAttentionVisionJSON<{ ok: boolean }>([{ role: 'user', content: 'test' }]);
    assert.equal(result.model, 'fallback');
    assert.deepEqual(requested, ['primary', 'fallback']);
  } finally {
    Object.assign(attentionEnv.llm, previous);
    globalThis.fetch = originalFetch;
  }
});

test('虚拟用户 LLM 按文本候选链切换', async () => {
  const previous = { ...virtualUserEnv.llm, models: [...virtualUserEnv.llm.models] };
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  Object.assign(virtualUserEnv.llm, { baseUrl: 'http://llm.test/v1', apiKey: 'test-key', models: ['primary', 'fallback'] });
  globalThis.fetch = async (_url, init) => {
    const model = JSON.parse(String(init?.body)).model as string;
    requested.push(model);
    return model === 'primary'
      ? new Response('overloaded', { status: 503 })
      : Response.json({ choices: [{ message: { content: '{"reviews":[]}' } }] });
  };
  try {
    const result = await chatJSON<{ reviews: unknown[] }>([{ role: 'user', content: 'test' }]);
    assert.deepEqual(result, { reviews: [] });
    assert.deepEqual(requested, ['primary', 'fallback']);
  } finally {
    Object.assign(virtualUserEnv.llm, previous);
    globalThis.fetch = originalFetch;
  }
});
