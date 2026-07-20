// 单独检查 Kimi / Gemini 是否都能独立跑通(不靠 fallback 兜底)。
// 每个模型独立 3 个 case:短文本 / 结构化 JSON / 稍长中文 prompt。
// LLM_MODEL_FALLBACKS 传空,任何失败立即抛错。
import { loadEnv } from '../database/db.ts';
loadEnv();
import { GatewayLLMClient } from '../apps/orchestrator-runtime/src/runtime/gateway-llm-client.ts';

interface CaseResult { name: string; ok: boolean; ms: number; model?: string; tokens?: any; err?: string; sample?: string }

async function runAll(): Promise<Record<string, CaseResult[]>> {
  const targets = [
    { label: 'GPT-5.4-joybuilder',                env: 'GPT-5.4-joybuilder' },
    { label: 'GPT-5-joybuilder',                  env: 'GPT-5-joybuilder' },
  ];
  const out: Record<string, CaseResult[]> = {};

  for (const t of targets) {
    process.env.LLM_MODEL_NAME = t.env;
    process.env.LLM_MODEL_FALLBACKS = '';  // 强制空,失败立即抛
    const c = new GatewayLLMClient();
    const cases: CaseResult[] = [];

    // #1 短文本
    {
      const t0 = Date.now(); const name = '短文本';
      try {
        const r = await c.generateText({ prompt: '只回复 4 个中文字:测试通过' });
        cases.push({ name, ok: true, ms: Date.now() - t0, model: r.modelName, tokens: r.tokens, sample: r.text.slice(0, 30) });
      } catch (e: any) { cases.push({ name, ok: false, ms: Date.now() - t0, err: e.message.slice(0, 160) }); }
    }

    // #2 结构化 JSON
    {
      const t0 = Date.now(); const name = '结构化 JSON';
      try {
        const r = await c.generateStructured<{ items: Array<{ id: number; name: string }> }>({
          prompt: '返回一个 JSON,items 是包含 3 个对象的数组,每个 {id:递增整数从1开始, name:短水果名}',
          schema: {
            type: 'object', required: ['items'],
            properties: { items: { type: 'array', items: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'integer' }, name: { type: 'string' } } } } },
          },
          schemaName: 'smoke-array',
        });
        const items = (r.data as any).items;
        const valid = Array.isArray(items) && items.length === 3 && items.every((x: any) => Number.isInteger(x?.id) && typeof x?.name === 'string');
        cases.push({ name, ok: valid, ms: Date.now() - t0, model: r.modelName, tokens: r.tokens, sample: JSON.stringify(items).slice(0, 80) });
      } catch (e: any) { cases.push({ name, ok: false, ms: Date.now() - t0, err: e.message.slice(0, 160) }); }
    }

    // #3 稍长中文 prompt(模拟真 skill 场景)
    {
      const t0 = Date.now(); const name = '中文长 prompt';
      try {
        const r = await c.generateText({
          prompt: '你是用户研究助手。请判断以下 3 段用户反馈的情感极性,分别标记为 正面/负面/中性,并给一句总结。反馈:①"物流真慢,3 天了还没到" ②"客服态度非常好,问题秒解决" ③"页面加载有点慢,但功能齐全"',
        });
        cases.push({ name, ok: r.text.length > 15, ms: Date.now() - t0, model: r.modelName, tokens: r.tokens, sample: r.text.slice(0, 80) });
      } catch (e: any) { cases.push({ name, ok: false, ms: Date.now() - t0, err: e.message.slice(0, 160) }); }
    }

    out[t.label] = cases;
  }
  return out;
}

const results = await runAll();
for (const [model, cases] of Object.entries(results)) {
  console.log(`\n===== ${model} =====`);
  for (const c of cases) {
    const mark = c.ok ? '✅' : '❌';
    console.log(`  ${mark} ${c.name.padEnd(14)} ${(c.ms + 'ms').padStart(6)}  ${c.ok ? `model=${c.model}  tokens=${JSON.stringify(c.tokens)}  → ${c.sample}` : 'ERR: ' + c.err}`);
  }
  const pass = cases.filter((c) => c.ok).length;
  console.log(`  · 汇总: ${pass}/${cases.length} pass`);
}
process.exit(0);
