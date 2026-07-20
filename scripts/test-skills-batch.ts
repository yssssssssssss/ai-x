// 批量端到端验证:6 个用研 skill 依次跑,汇总结果。
// KISS:一个脚本 + 6 个 case,不为每 skill 单独写。
// 每 case:query → plan(SSE 关掉) → select(depth) → execute → poll report → 断言。
// 输出:一张对照表(skill_hit / findings / real_rate / kb_hit / exec_seconds)+ 每 case 的 taskId(留档溯源)。

import { loadEnv } from '../database/db.ts';
loadEnv();
import { readFileSync, existsSync, writeFileSync } from 'node:fs';

const API = 'http://localhost:3001';
async function req(path: string, opts: any = {}): Promise<any> {
  const h: any = { 'Content-Type': 'application/json' };
  if (opts.token) h.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${API}${path}`, { method: opts.method ?? 'GET', headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}→${res.status}: ${JSON.stringify(d).slice(0, 200)}`);
  return d;
}

interface Case {
  skill: string;
  query: string;
  kbMarkers: string[];   // 命中即证明 skill 用了 KB 方法学
}

const CASES: Case[] = [
  {
    skill: 'generate-research-plan',
    query:
      '要研究京东 App 首页改版后,老年用户(60+)是否更容易找到"我的订单"和"客服"入口。给一份 3 周内可执行的完整研究方案,含研究目标、方法组合、抽样、时间线、交付物。',
    kbMarkers: ['抽样', '研究目标', '深访', '可用性', '交付物'],
  },
  {
    skill: 'jobs-to-be-done',
    query:
      '「京东数字人直播间智能应答」这个功能,PM 想在选品/带货主播场景切入。用 JTBD 帮我定义:用户在什么场景下雇它、进度力和阻力是什么、和现有做法竞争关系。',
    kbMarkers: ['进度力', '阻力', 'JTBD', '任务', '场景'],
  },
  {
    skill: 'build-experience-metrics',
    query:
      '给「京东 App 直播频道」搭一套体验度量体系。业务目标:提高用户在直播间停留时长与转化,底线不可恶化广告体验和加载性能。用 HEART/GSM 定 3-5 维、给北极星和护栏、写清采集口径、附跨版本追踪方案。',
    kbMarkers: ['HEART', 'GSM', '北极星', '护栏', '口径'],
  },
  {
    skill: 'journey-map',
    query:
      '基于访谈材料,画一份「用户在京东买生鲜从看到收货」的用户旅程图。材料要点:①50%用户会先看主图和价格,再看评价;②冷链配送焦虑集中在下单后到发货前;③收货破损率虽低但情绪冲击大;④会员优惠感知不明显。请出可视化 HTML 旅程图,含阶段/触点/情绪曲线/机会点评级。',
    kbMarkers: ['阶段', '触点', '情绪', '机会点', '旅程'],
  },
  {
    skill: 'synthesize-qualitative-insights',
    query:
      '3 份用户访谈发现:A(30岁女白领)"晚上想买菜懒得比价、图快,信任京东自营";B(45岁家庭主妇)"每天早晨看农场直播,图新鲜、要看主播动手挑";C(28岁男码农)"周末做饭才买,爱看别人评价里的分量吐槽"。归纳跨用户主题,提炼 3-5 条洞察(用户+场景+任务+情感需求+矛盾),各带频次和代表原话。',
    kbMarkers: ['亲和图', '主题', '洞察', '编码', '证据'],
  },
  {
    skill: 'analyze-satisfaction',
    query:
      '本季度京东会员产品 NSS 分数如下:总体 78.5(上季 82.1)。属性分:商品丰富度 84、价格 71(上季 78)、物流 88、售后 74(上季 80)、会员权益感知 68。分析为什么总体掉了、先改哪个属性、给排序建议。',
    kbMarkers: ['驱动', 'IPA', '归因', '掉分', '权益'],
  },
];

const auth = await req('/api/auth/login', { method: 'POST', body: { email: 'tester+ui@local.dev', password: 'testtest' } });
const token = auth.token;
console.log(`✓ 登录 · 待跑 ${CASES.length} 个 skill\n`);

interface Row {
  skill: string;
  taskId: string;
  skillHit: boolean;
  planSteps: number;
  execSec: number;
  findings: number;
  realRate: number;
  kbHits: string[];
  status: string;
  stepOutputSize?: number;
  err?: string;
}
const rows: Row[] = [];

for (const [idx, c] of CASES.entries()) {
  console.log(`\n===== [${idx + 1}/${CASES.length}] ${c.skill} =====`);
  const row: Row = { skill: c.skill, taskId: '', skillHit: false, planSteps: 0, execSec: 0, findings: 0, realRate: 0, kbHits: [], status: '?' };
  try {
    const plan = await req('/api/tasks/plan', { method: 'POST', token, body: { originalInput: c.query } });
    row.taskId = plan.taskId;
    const depthSteps = plan.candidates[0].steps;
    row.planSteps = depthSteps.length;
    row.skillHit = depthSteps.some((s: any) => s.actor_id === c.skill);
    let candidateId: 'depth' | 'speed' = 'depth';
    if (!row.skillHit && plan.candidates[1]?.steps?.some((s: any) => s.actor_id === c.skill)) {
      candidateId = 'speed'; row.skillHit = true;
    }
    console.log(`  plan · task_type=${plan.task.task_type} · steps=${depthSteps.length} · ${c.skill} 命中=${row.skillHit}`);
    console.log(`  depth: ${depthSteps.map((s: any) => `${s.actor_type[0]}:${s.actor_id}`).join(' → ')}`);

    if (!row.skillHit) {
      row.status = 'skill_not_selected'; rows.push(row); continue;
    }

    const sel = await req(`/api/tasks/${plan.taskId}/select`, { method: 'POST', token, body: { candidateId } });
    console.log(`  select ${candidateId} · finalSteps=${sel.plan.steps.length}`);
    const t0 = Date.now();
    const execP = req(`/api/tasks/${plan.taskId}/execute`, { method: 'POST', token, body: {} }).catch(() => null);
    const reportPath = `run-workspaces/${plan.taskId}/artifacts/report.json`;
    let report: any = null;
    for (let i = 0; i < 200; i++) {   // 200 × 6s = 1200s 上限,应对 12-13 步深流水线
      await new Promise((r) => setTimeout(r, 6_000));
      if (existsSync(reportPath)) {
        try { report = JSON.parse(readFileSync(reportPath, 'utf8')); if (report.findings) break; } catch {}
      }
      process.stdout.write(`  ${((Date.now() - t0) / 1000).toFixed(0)}s…\r`);
    }
    process.stdout.write('\n');
    await execP;
    row.execSec = Math.round((Date.now() - t0) / 1000);

    if (!report) { row.status = 'no_report'; rows.push(row); continue; }
    const findings = report.findings ?? [];
    row.findings = findings.length;
    const tr = findings.filter((f: any) => f.source === 'tool_result').length;
    row.realRate = findings.length ? Math.round((tr / findings.length) * 100) : 0;

    // 找 skill 步的产出文件
    const stepIdx = sel.plan.steps.findIndex((s: any) => s.actor_id === c.skill);
    if (stepIdx >= 0) {
      const stepFile = `run-workspaces/${plan.taskId}/tool_outputs/step${stepIdx + 1}.json`;
      if (existsSync(stepFile)) row.stepOutputSize = readFileSync(stepFile).length;
    }

    const text = JSON.stringify(report);
    row.kbHits = c.kbMarkers.filter((k) => text.includes(k));
    row.status = 'ok';
    console.log(`  ✓ ${row.execSec}s · findings=${row.findings} · real=${row.realRate}% · KB命中=${row.kbHits.length}/${c.kbMarkers.length} · skillOut=${row.stepOutputSize ?? 0}B`);
  } catch (e: any) {
    row.status = 'error'; row.err = e.message.slice(0, 100);
    console.log(`  ✗ ${row.err}`);
  }
  rows.push(row);
}

console.log('\n\n============ 汇总 ============\n');
console.log('skill'.padEnd(36), 'sel', 'exec', 'findings', 'real', 'KB', 'skill 产出', 'taskId (前 8)');
console.log('-'.repeat(120));
for (const r of rows) {
  console.log(
    r.skill.padEnd(36),
    (r.skillHit ? '✅' : '❌').padEnd(4),
    `${r.execSec}s`.padEnd(6),
    `${r.findings}`.padEnd(9),
    `${r.realRate}%`.padEnd(5),
    `${r.kbHits.length}`.padEnd(4),
    `${r.stepOutputSize ?? 0}B`.padEnd(11),
    r.taskId.slice(0, 8),
  );
}
console.log('-'.repeat(120));
const okCount = rows.filter((r) => r.status === 'ok').length;
console.log(`\n${okCount}/${rows.length} 全流程跑通 · 平均 exec ${Math.round(rows.reduce((a, r) => a + r.execSec, 0) / rows.length)}s`);

// 落盘明细供报告引用
writeFileSync('/tmp/skill-batch-results.json', JSON.stringify(rows, null, 2));
console.log('\n明细已写 /tmp/skill-batch-results.json');
process.exit(0);
