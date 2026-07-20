// 定位 Kimi 结构化 JSON 报错的确切位置。
import { loadEnv } from '../database/db.ts';
loadEnv();
process.env.LLM_MODEL_NAME = 'Kimi-K2.6-joybuilder';
process.env.LLM_MODEL_FALLBACKS = '';

// 直接手工发一次网关请求,看 Kimi 的 structured 响应长啥样
const body = {
  model: 'Kimi-K2.6-joybuilder',
  messages: [
    { role: 'system', content: '你是用研任务编排器。只输出 JSON,不要任何解释或 markdown 代码块。\n输出的 JSON 必须严格符合以下 JSON Schema:\n{"type":"object","required":["items"],"properties":{"items":{"type":"array","items":{"type":"object","required":["id","name"],"properties":{"id":{"type":"integer"},"name":{"type":"string"}}}}}}' },
    { role: 'user', content: '返回一个 JSON,items 是包含 3 个对象的数组,每个 {id:递增整数从1开始, name:短水果名}' },
  ],
  stream: false,
  response_format: { type: 'json_object' },
};
const res = await fetch(`${process.env.LLM_GATEWAY_BASE_URL}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LLM_GATEWAY_API_KEY}` },
  body: JSON.stringify(body),
});
console.log(`HTTP ${res.status}`);
const raw = await res.json() as any;
console.log('\n=== 原始响应 ===');
console.log(JSON.stringify(raw, null, 2).slice(0, 1500));
console.log('\n=== 关键字段 ===');
console.log('message.content:', JSON.stringify(raw?.choices?.[0]?.message?.content));
console.log('message.reasoning_content 长度:', raw?.choices?.[0]?.message?.reasoning_content?.length ?? 'undefined');
console.log('finish_reason:', raw?.choices?.[0]?.finish_reason);

// 再用 GatewayLLMClient 走一次,捕获完整堆栈
console.log('\n=== 用 client 复现 ===');
const { GatewayLLMClient } = await import('../apps/orchestrator-runtime/src/runtime/gateway-llm-client.ts');
const c = new GatewayLLMClient();
try {
  const r = await c.generateStructured({
    prompt: '返回一个 JSON,items 是包含 3 个对象的数组,每个 {id:递增整数从1开始, name:短水果名}',
    schema: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'object', required: ['id','name'], properties: { id: { type: 'integer' }, name: { type: 'string' } } } } } },
    schemaName: 'debug',
  });
  console.log('client OK:', JSON.stringify(r.data).slice(0, 200));
} catch (e: any) {
  console.log('client ERR:', e.message);
  console.log('stack:', e.stack?.split('\n').slice(0, 8).join('\n'));
}
process.exit(0);
