import assert from 'node:assert/strict';
import { test } from 'node:test';
import { env } from '../external-tools/virtual-user-lab/apps/server/src/config/env.ts';
import { simulateVirtualUsers } from '../external-tools/virtual-user-lab/apps/server/src/services/personaService.ts';

test('虚拟用户在全部模型失败后标记规则降级', async () => {
  const previous = { ...env.llm, models: [...env.llm.models] };
  const originalFetch = globalThis.fetch;
  Object.assign(env.llm, { baseUrl: 'http://llm.test/v1', apiKey: 'test-key', models: ['primary', 'fallback'] });
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  try {
    const result = await simulateVirtualUsers({ scenario: '用户评审商品详情页' });
    assert.equal(result.status, 'available');
    assert.ok(result.warnings.includes('reasonCode=llm_failed'));
    assert.ok(result.warnings.includes('engine=rule_simulation'));
    assert.match(result.summary, /规则降级模拟/);
  } finally {
    Object.assign(env.llm, previous);
    globalThis.fetch = originalFetch;
  }
});
