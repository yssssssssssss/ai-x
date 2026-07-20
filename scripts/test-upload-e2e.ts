// 素材上传闭环真实验证:构造 base64 图片走完 plan → select → execute → 看 lab 是否返回真实分析。
// 目的:证明"用户传图后 tool 真能拿到并产生真实结果",不是 insufficient_inputs。
import { loadEnv } from '../database/db.ts';
loadEnv();

import { readFileSync, existsSync } from 'node:fs';

const API = process.env.TEST_API_BASE ?? 'http://localhost:3001';
const IMG_PATH = '/tmp/design-test/homepage.png';

async function req(path: string, opts: { method?: string; body?: unknown; token?: string } = {}): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? 'GET', headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// 登录(用之前注册过的账号)
const auth = await req('/api/auth/login', {
  method: 'POST', body: { email: 'tester+ui@local.dev', password: 'testtest' },
});
const token = auth.token as string;
console.log('✓ 登录');

// 读图 → base64 dataUrl
const img = readFileSync(IMG_PATH);
const dataUrl = `data:image/png;base64,${img.toString('base64')}`;
console.log(`✓ 图片 ${img.length}B`);

// 1. plan
const t0 = Date.now();
console.log('→ plan(15-40s)…');
const plan = await req('/api/tasks/plan', {
  method: 'POST', token,
  body: { originalInput: '请评估附上的电商 APP 首屏视觉设计与体验' },
});
console.log(`✓ plan ${((Date.now() - t0) / 1000).toFixed(1)}s · task_type=${plan.task.task_type} · candidates=${plan.candidates.length}`);

// 2. select depth
const sel = await req(`/api/tasks/${plan.taskId}/select`, {
  method: 'POST', token, body: { candidateId: 'depth' },
});
console.log(`✓ select · steps=${sel.plan.steps.length} · pendingUploads=${sel.pendingUploads.length}`);
console.log('   pendingUploads roles:', sel.pendingUploads.map((p: any) => `${p.role}(${p.targets?.length ?? 0} 步)`));

// 3. execute 时传图(uploads role 匹配 pendingUploads.role)
const uploadRoles = sel.pendingUploads.map((p: any) => p.role);
const uploads = uploadRoles.map((role: string) => ({ role, dataUrl }));
console.log(`→ execute · uploads=${uploads.length} 张图 · 后台真跑,轮询磁盘等报告…`);

// 不 await execute(避免 undici 5min headers timeout);轮询 report.json 出现即可。
const wsDir = `run-workspaces/${plan.taskId}`;
const reportPath = `${wsDir}/artifacts/report.json`;
const t1 = Date.now();
const execP = req(`/api/tasks/${plan.taskId}/execute`, { method: 'POST', token, body: { uploads } })
  .catch((e) => ({ __err: (e as Error).message }));

// 每 10 秒轮询,最长 15 分钟
let report: any = null;
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  if (existsSync(reportPath)) {
    // 等 status=200 写完(避免读半份 JSON)
    try { report = JSON.parse(readFileSync(reportPath, 'utf8')); if (report.findings) break; } catch {}
  }
  process.stdout.write(`  ${((Date.now() - t1) / 1000).toFixed(0)}s…\r`);
}
process.stdout.write('\n');
const execResult = await execP.catch(() => ({}));
console.log(`✓ execute ${((Date.now() - t1) / 1000).toFixed(1)}s`);
if ((execResult as any).__err) console.log(`  (fetch 侧超时:${(execResult as any).__err.slice(0, 60)}——已从磁盘读结果)`);
const exec = (execResult as any).__err ? null : execResult;

// 4. 分析报告:tool_result 占比 + 每个 lab tool 的 output 是否 insufficient_inputs
const findings = report?.findings ?? exec?.report?.findings ?? [];
const sourceCounts = findings.reduce((acc: any, f: any) => { acc[f.source] = (acc[f.source] ?? 0) + 1; return acc; }, {});
console.log(`\n=== 报告 findings=${findings.length} ===`);
console.log('  来源分布:', sourceCounts);

// 从 tool_outputs 文件系统直接读 3 个 lab 的输出,看是不是 insufficient_inputs
const outputDir = `${wsDir}/tool_outputs`;
console.log('\n=== 每步真实性(insufficient_inputs=假)===');
for (let i = 1; i <= 20; i++) {
  const p = `${outputDir}/step${i}.json`;
  if (!existsSync(p)) continue;
  try {
    const out = JSON.parse(readFileSync(p, 'utf8'));
    const txt = JSON.stringify(out);
    const topStatus = out.status ?? '-';
    const hasInsufficient = txt.includes('insufficient_inputs');
    console.log(`  step${String(i).padStart(2)} · status=${topStatus} · ${hasInsufficient ? '⚠️ 含 insufficient' : '✅ 全部真实'} · ${txt.length}B`);
  } catch {}
}

console.log(`\ntaskId: ${plan.taskId}`);
process.exit(0);
