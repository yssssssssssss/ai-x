// 真实调用每个 active tool,产出可用性自检报告。
// 目的:让"tool 真实可调用"这件事有事实依据,不靠代码推断。
// 用法:pnpm tsx scripts/capability-check.ts
import { loadEnv } from '../database/db.ts';
loadEnv();

import { buildRuntime } from '../apps/orchestrator-runtime/src/runtime/agent-runtime.ts';
import { loadToolManifest } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';

const rt = buildRuntime();
const tools = rt.deps.skillLoader.listActiveTools();

interface Row { id: string; adapter: string; status: 'real' | 'fake' | 'fail'; note: string; }
const rows: Row[] = [];

for (const t of tools) {
  const manifest = loadToolManifest(t.path);
  const adapter = manifest.adapter_type;
  try {
    // 用最小合法入参:大多数 tool 的 input.schema 要求 query 或 image;先都试 {query}
    const res = await rt.deps.toolAdapter.invoke({
      toolId: t.id,
      input: { query: '直播 数字人 竞品' },
      manifest,
    });
    const out = res.output as Record<string, unknown>;
    const size = JSON.stringify(out).length;
    // 判 fake:FakeO2Adapter 硬编码返回 3 条以 example.com 开头的 results
    const fake = adapter === 'o2' && JSON.stringify(out).includes('example.com');
    rows.push({
      id: t.id, adapter,
      status: fake ? 'fake' : 'real',
      note: `${size}B · ${fake ? '硬编码假数据' : 'ok'}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    rows.push({ id: t.id, adapter, status: 'fail', note: msg.slice(0, 80) });
  }
}

console.log('\n=== 能力自检 · 真实调用结果 ===\n');
console.log('id'.padEnd(24), 'adapter'.padEnd(14), 'status'.padEnd(6), 'note');
console.log('-'.repeat(90));
for (const r of rows) {
  console.log(r.id.padEnd(24), r.adapter.padEnd(14), r.status.padEnd(6), r.note);
}
const real = rows.filter((r) => r.status === 'real').length;
const fake = rows.filter((r) => r.status === 'fake').length;
const fail = rows.filter((r) => r.status === 'fail').length;
console.log('-'.repeat(90));
console.log(`合计 ${rows.length} · 真实产出 ${real} · 假数据 ${fake} · 调用失败 ${fail}`);
process.exit(0);
