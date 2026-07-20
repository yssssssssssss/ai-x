// 竞品研究端到端 + 用户上传竞品资料闭环验证(Phase 1a)。
// 上传一份真实的竞品对比材料(text/plain base64),验证 competitive-analysis skill 是否真消费用户材料。
// 目的:证明"agent+人在环"路径成立——用户提供素材,skill 真分析。
import { loadEnv } from '../database/db.ts';
loadEnv();

import { readFileSync, existsSync } from 'node:fs';

const API = process.env.TEST_API_BASE ?? 'http://localhost:3001';

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

const auth = await req('/api/auth/login', {
  method: 'POST', body: { email: 'tester+ui@local.dev', password: 'testtest' },
});
const token = auth.token as string;
console.log('✓ 登录');

// 构造真实竞品资料(直播场域数字人赛道 · 3 家代表玩家)
const material = `
# 直播场域数字人竞品资料(用户提供 · 2026-07)

## 竞品 A · 硅基智能
- **定位**:2B 数字人 SaaS,面向电商直播/客服/内容创作
- **核心能力**:声音克隆(30 秒样本)、口型驱动、7×24 无人直播
- **商业模式**:年费 6-18 万,按角色数分层
- **公开动态**:2026 Q1 融资 3 亿元;发布 4.0 版本,支持实时多模态互动
- **典型客户**:某快消品牌 24h 无人直播场,单日 GMV 破 500 万
- **短板**:互动延迟 2-3s,复杂问答仍需真人接管

## 竞品 B · 元宇宙引擎(化名)
- **定位**:虚拟 IP 运营平台,重内容/IP 联名
- **核心能力**:高保真数字人形象定制(骨骼级)、内容剧本 AI 生成
- **商业模式**:项目制,单 IP 授权 50 万起,分成模式
- **公开动态**:与知名影视 IP 合作 3 个虚拟主播,粉丝量破千万
- **典型场景**:品牌代言、内容营销、跨平台账号运营
- **短板**:自动化程度较低,重人工运营;直播互动能力弱

## 竞品 C · Live-Persona(海外)
- **定位**:面向欧美电商的实时数字人主播
- **核心能力**:多语言(35 种)、实时表情迁移、Shopify/TikTok Shop 深度集成
- **商业模式**:订阅制 $99-$499/月,按直播时长计费
- **公开动态**:2026 年 GA,单月 100+ 商家试用
- **短板**:亚太合规问题(数据出境),暂无中国代理

## 已知我方现状(知己)
- 我方产品处于 MVP 阶段,已完成声音克隆 + 口型驱动 demo
- 目标场景:京东内直播带货,首批 10 位商家试点
- 生命周期:0-1 验证期,尚无付费客户
- 团队:全职 15 人,算法 6 人
`.trim();

const dataUrl = `data:text/plain;base64,${Buffer.from(material, 'utf8').toString('base64')}`;
console.log(`✓ 竞品资料 ${material.length}B(base64 dataUrl ${dataUrl.length}B)`);

// 1. plan · 明确竞品研究场景
console.log('→ plan(15-40s)…');
const t0 = Date.now();
const plan = await req('/api/tasks/plan', {
  method: 'POST', token,
  body: { originalInput: '我要为直播场域做一次数字人竞品研究,已附上部分竞品资料,请基于这些材料做战略意图与差异化分析' },
});
console.log(`✓ plan ${((Date.now() - t0) / 1000).toFixed(1)}s · task_type=${plan.task.task_type} · candidates=${plan.candidates.length}`);
console.log('  depth steps:', plan.candidates[0].steps.map((s: any) => `${s.actor_type}:${s.actor_id}`).slice(0, 10));

// 2. select depth
const sel = await req(`/api/tasks/${plan.taskId}/select`, {
  method: 'POST', token, body: { candidateId: 'depth' },
});
console.log(`✓ select · steps=${sel.plan.steps.length} · pendingUploads=${sel.pendingUploads.length}`);

// 3. execute · 手动传竞品资料(role='competitive_material',不撞任何 tool 的 image role)
const uploads = [{ role: 'competitive_material', dataUrl }];
console.log(`→ execute · uploads=1 张竞品资料 · 后台真跑…`);

const wsDir = `run-workspaces/${plan.taskId}`;
const reportPath = `${wsDir}/artifacts/report.json`;
const t1 = Date.now();
const execP = req(`/api/tasks/${plan.taskId}/execute`, { method: 'POST', token, body: { uploads } })
  .catch((e) => ({ __err: (e as Error).message }));

let report: any = null;
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  if (existsSync(reportPath)) {
    try { report = JSON.parse(readFileSync(reportPath, 'utf8')); if (report.findings) break; } catch {}
  }
  process.stdout.write(`  ${((Date.now() - t1) / 1000).toFixed(0)}s…\r`);
}
process.stdout.write('\n');
await execP.catch(() => {});
console.log(`✓ execute ${((Date.now() - t1) / 1000).toFixed(1)}s`);

// 4. 分析报告:findings 里是否引用了用户资料中的具体名字("硅基智能"、"Live-Persona"、"元宇宙引擎")
if (!report) { console.log('❌ 未生成 report'); process.exit(1); }

const findings = report.findings ?? [];
const srcCount = findings.reduce((acc: any, f: any) => { acc[f.source] = (acc[f.source] ?? 0) + 1; return acc; }, {});
console.log(`\n=== 报告 findings=${findings.length} ===`);
console.log('  来源分布:', srcCount);

const KEYWORDS = ['硅基智能', 'Live-Persona', '元宇宙引擎', '30 秒样本', '35 种', 'Shopify', 'TikTok Shop', '骨骼级'];
const allText = JSON.stringify(findings);
const hits = KEYWORDS.filter((k) => allText.includes(k));
console.log(`\n=== 用户资料消费验证 ===`);
console.log(`  用户资料关键词命中: ${hits.length}/${KEYWORDS.length}`);
console.log(`  命中的关键词: ${hits.join(', ')}`);
console.log(`  ${hits.length >= 3 ? '✅ skill 真消费了用户资料' : '❌ skill 未有效使用用户资料'}`);

console.log('\n=== 前 3 条 findings 预览 ===');
for (const f of findings.slice(0, 3)) {
  console.log(`  [${f.source}] ${f.statement.slice(0, 200)}`);
  console.log(`  ref: ${(f.source_ref ?? '-').slice(0, 80)}`);
  console.log();
}

console.log(`\ntaskId: ${plan.taskId}`);
process.exit(0);
