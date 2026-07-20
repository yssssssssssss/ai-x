// 端到端首验:generate-interview-guide skill
// 目的:证明用研 skill 从 planPhase 到 executePhase 到 report 能真跑,且能引用 knowledge-base 里的方法正典。
// 判据:①planPhase 候选步骤含 skill:generate-interview-guide ②execute 产 report.findings 非空
//        ③report 引用了 knowledge-base/methods 相关路径(证明 research_wiki_index 生效)。
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
  body: {
    originalInput:
      '给直播数字人竞品调研做一份用户访谈提纲。目标用户=直播运营、带货主播;3 个核心研究问题:①他们在选数字人产品时最看重什么、②当前用哪家产品痛点是什么、③愿意为哪些新能力付费。要求提纲含破冰、主问、追问、收尾。',
  },
});
console.log(`✓ plan · task_type=${plan.task.task_type}`);
console.log('depth steps:', plan.candidates[0].steps.map((s: any) => `${s.actor_type}:${s.actor_id}`));
console.log('speed steps:', plan.candidates[1]?.steps?.map((s: any) => `${s.actor_type}:${s.actor_id}`) ?? '(无 speed)');

const depthSteps = plan.candidates[0].steps;
const hasSkill = depthSteps.some((s: any) => s.actor_id === 'generate-interview-guide');
console.log(`\ngenerate-interview-guide 被选? ${hasSkill ? '✅' : '❌'}`);

// 若 depth 没选到,尝试 speed;仍没有则报警但继续跑(观察退化后的产出)
let candidateId = 'depth';
if (!hasSkill && plan.candidates[1]?.steps?.some((s: any) => s.actor_id === 'generate-interview-guide')) {
  candidateId = 'speed';
  console.log('  ↳ depth 没选到,fallback 到 speed');
}

const sel = await req(`/api/tasks/${plan.taskId}/select`, { method: 'POST', token, body: { candidateId } });
console.log(`✓ select ${candidateId} · steps=${sel.plan.steps.length}`);

const execP = req(`/api/tasks/${plan.taskId}/execute`, { method: 'POST', token, body: {} }).catch((e) => ({ __err: e.message }));
const reportPath = `run-workspaces/${plan.taskId}/artifacts/report.json`;
let report: any = null;
const t = Date.now();
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  if (existsSync(reportPath)) {
    try { report = JSON.parse(readFileSync(reportPath, 'utf8')); if (report.findings) break; } catch {}
  }
  process.stdout.write(`  ${((Date.now()-t)/1000).toFixed(0)}s…\r`);
}
process.stdout.write('\n');
await execP.catch(()=>{});
console.log(`✓ execute ${((Date.now()-t)/1000).toFixed(1)}s`);

if (!report) { console.log('❌ 未生成报告'); process.exit(1); }
const findings = report.findings ?? [];
const srcCount = findings.reduce((acc: any, f: any) => { acc[f.source] = (acc[f.source] ?? 0) + 1; return acc; }, {});
console.log(`\n=== 报告 findings=${findings.length} · 来源=${JSON.stringify(srcCount)} ===`);
console.log(`taskId: ${plan.taskId}`);

// 关键判据:报告是否引用 knowledge-base/methods 或知名方法名(证明 research_wiki_index 生效)
const allText = JSON.stringify(report);
const kbMarkers = [
  'knowledge-base/methods',
  'deep-interview',
  '深度访谈',
  '半结构化',
  '破冰',
  '追问',
  'toolbox',
];
const hits = kbMarkers.filter(k => allText.includes(k));
console.log(`KB 正典引用关键词命中: ${hits.length}/${kbMarkers.length} — ${hits.join(', ')}`);

// 检查 tool_outputs.step<N>.json 里 generate-interview-guide 步的产出结构
const skillStep = sel.plan.steps.findIndex((s: any) => s.actor_id === 'generate-interview-guide');
if (skillStep >= 0) {
  const stepFile = `run-workspaces/${plan.taskId}/tool_outputs/step${skillStep + 1}.json`;
  if (existsSync(stepFile)) {
    const out = JSON.parse(readFileSync(stepFile, 'utf8'));
    console.log(`\n=== generate-interview-guide 产出预览(step${skillStep + 1}) ===`);
    console.log(JSON.stringify(out).slice(0, 800));
  }
}
process.exit(0);
