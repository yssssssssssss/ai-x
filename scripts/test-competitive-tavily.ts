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
  body: { originalInput: '对直播场域头部数字人产品(硅基智能、小冰、Live-Persona 等)做公开互联网信息竞品研究,梳理各家产品能力、商业模式、市场动态' },
});
console.log(`✓ plan · task_type=${plan.task.task_type}`);
console.log('depth steps:', plan.candidates[0].steps.map((s: any) => `${s.actor_type}:${s.actor_id}`));

const hasTavily = plan.candidates[0].steps.some((s: any) => s.actor_id === 'tavily-web-search');
const hasJd = plan.candidates[0].steps.some((s: any) => s.actor_id === 'jd-product-search');
console.log(`\ntavily 被选? ${hasTavily ? '✅' : '❌'}   jd-product 被选? ${hasJd ? '✅' : '❌'}`);

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
const { Counter } = { Counter: null };
const srcCount = findings.reduce((acc: any, f: any) => { acc[f.source] = (acc[f.source] ?? 0) + 1; return acc; }, {});
console.log(`\n=== 报告 findings=${findings.length} ===`);
console.log('  来源分布:', srcCount);
console.log(`\ntaskId: ${plan.taskId}`);

// 验证:tavily 步是否真产出 + 报告里是否引用了 tavily 数据
const allText = JSON.stringify(report);
const tavilyMarkers = ['tavily', 'https://', '硅基', '小冰', 'Live-Persona', 'https://pdf', '.com/'];
const hits = tavilyMarkers.filter(k => allText.includes(k));
console.log(`真实网页数据关键词命中: ${hits.length}/${tavilyMarkers.length} — ${hits.join(', ')}`);
process.exit(0);
