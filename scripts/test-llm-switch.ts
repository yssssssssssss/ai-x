// 一次性 smoke:验证 GatewayLLMClient 的模型 fallback 与协议适配。
import { loadEnv } from '../database/db.ts';
loadEnv();
import { GatewayLLMClient } from '../apps/orchestrator-runtime/src/runtime/gateway-llm-client.ts';

const c = new GatewayLLMClient();

console.log('=== #1 generateText ===');
const r1 = await c.generateText({ prompt: '只回复 4 个中文字:一切正常' });
console.log('  用模型:', r1.modelName, '· tokens:', r1.tokens, '· text:', r1.text.slice(0, 40));

console.log('\n=== #2 generateStructured(小 JSON)===');
const r2 = await c.generateStructured<{ ok: boolean; note: string }>({
  prompt: '判断今天心情如何。返回 { ok: true, note: "简短一句话" }',
  schema: { type: 'object', required: ['ok', 'note'], properties: { ok: { type: 'boolean' }, note: { type: 'string' } } },
  schemaName: 'smoke-json',
});
console.log('  用模型:', r2.modelName, '· tokens:', r2.tokens, '· data:', r2.data);

process.exit(0);
