import { loadEnv } from '../database/db.ts';
loadEnv();
import { readFileSync, existsSync } from 'node:fs';

const API = 'http://localhost:3001';
async function req(path: string, opts: any = {}): Promise<any> {
  const h: any = { 'Content-Type': 'application/json' };
  if (opts.token) h.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${API}${path}`, { method: opts.method ?? 'GET', headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}→${res.status}: ${JSON.stringify(d).slice(0, 200)}`);
  return d;
}

const auth = await req('/api/auth/login', { method: 'POST', body: { email: 'tester+ui@local.dev', password: 'testtest' } });
const token = auth.token;
console.log('✓ 登录');

const plan = await req('/api/tasks/plan', {
  method: 'POST', token,
  body: { originalInput: '为京东内自营的数字人产品做竞品研究,分析行业头部数字人相关商品与出版书籍的分布,识别品类关键词与用户关注点' },
});
console.log(`✓ plan · task_type=${plan.task.task_type}`);
console.log('depth steps:', plan.candidates[0].steps.map((s: any) => `${s.actor_type}:${s.actor_id}`));

// 检查 candidates 是否含 jd-product-search
const allSteps = [...plan.candidates[0].steps, ...(plan.candidates[1]?.steps ?? [])];
const hasJd = allSteps.some((s: any) => s.actor_id === 'jd-product-search');
console.log(`\n=== jd-product-search 出现在候选? ${hasJd ? '✅' : '❌ 未选中(编排未推荐)'} ===`);

if (!hasJd) {
  console.log('taskId:', plan.taskId, '— 未验证真实链');
  process.exit(0);
}

// select + execute + 轮询 report
const sel = await req(`/api/tasks/${plan.taskId}/select`, { method: 'POST', token, body: { candidateId: 'depth' } });
console.log(`✓ select · steps=${sel.plan.steps.length}`);
const execP = req(`/api/tasks/${plan.taskId}/execute`, { method: 'POST', token, body: {} }).catch((e) => ({ __err: e.message }));
const reportPath = `run-workspaces/${plan.taskId}/artifacts/report.json`;
let report: any = null;
const t = Date.now();
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  if (existsSync(reportPath)) { try { report = JSON.parse(readFileSync(reportPath, 'utf8')); if (report.findings) break; } catch {} }
  process.stdout.write(`  ${((Date.now()-t)/1000).toFixed(0)}s…\r`);
}
process.stdout.write('\n');
await execP.catch(()=>{});
console.log(`✓ execute ${((Date.now()-t)/1000).toFixed(1)}s`);

if (!report) { console.log('❌ 未生成报告'); process.exit(1); }
const findings = report.findings ?? [];
console.log(`\n=== 报告 findings=${findings.length} ===`);
// 检查 findings 是否引用了京东商品(sku_id / item.jd.com / 具体商品名)
const allText = JSON.stringify(findings);
const jdMarkers = ['sku_id', 'item.jd.com', '京东', 'AI数字人', '数字人一体机'];
const hits = jdMarkers.filter((k) => allText.includes(k));
console.log(`京东商品数据关键词命中: ${hits.length}/${jdMarkers.length} — ${hits.join(', ')}`);
console.log(`\ntaskId: ${plan.taskId}`);
process.exit(0);
