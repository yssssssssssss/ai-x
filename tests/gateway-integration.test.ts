import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../database/db.ts';
import { GatewayLLMClient } from '../apps/orchestrator-runtime/src/runtime/gateway-llm-client.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

// 可选集成测:默认 skip(不花 token、不依赖内网)。
// 跑真实网关:GATEWAY_TEST=1 npx tsx --test tests/gateway-integration.test.ts
// 前置:.env 里 LLM_GATEWAY_BASE_URL / LLM_GATEWAY_API_KEY / LLM_MODEL_NAME 已配。
loadEnv(); // 直跑本文件时需显式加载 .env(不经 db.ts 的 import 副作用)

const skip = !process.env.GATEWAY_TEST;
const v = new SchemaValidator();

test('真实网关能生成过 schema 的 ResearchTask', { skip }, async () => {
  const llm = new GatewayLLMClient();
  const r = await llm.generateStructured({
    prompt: '将用户需求结构化为 ResearchTask:我要为直播场域做一次数字人竞品研究',
    schema: {}, schemaName: 'research-task',
    context: { input: '我要为直播场域做一次数字人竞品研究' },
  });
  const errors = v.validate('research-task', r.data);
  assert.deepEqual(errors, [], `ResearchTask 应过 schema,实际错误: ${errors.join('; ')}`);
  assert.ok(r.tokens && r.tokens.total > 0, '应返回 token 用量');
  assert.ok(r.modelName.includes('gpt') || r.modelName.length > 0, '应返回真实 model 名');
  console.log(`  真实 model=${r.modelName} tokens=${r.tokens?.total} trace=${r.traceId}`);
});

test('真实网关能生成 decision-states 数组', { skip }, async () => {
  const llm = new GatewayLLMClient();
  const r = await llm.generateStructured<Array<{ node_key: string }>>({
    prompt: '对以下激活的决策节点逐一判定状态:D1_research_goal, D5_competitive',
    schema: {}, schemaName: 'decision-states',
    context: { activated: ['D1_research_goal', 'D5_competitive'] },
  });
  assert.ok(Array.isArray(r.data), 'decision-states 应返回数组');
  for (const s of r.data) {
    const errors = v.validate('decision-state', s);
    assert.deepEqual(errors, [], `每项应过 decision-state schema: ${errors.join('; ')}`);
  }
});
