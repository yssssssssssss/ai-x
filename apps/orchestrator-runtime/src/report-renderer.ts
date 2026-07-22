// report-renderer.ts — 自包含 HTML 报告渲染纯函数(暗色仪表盘风格)
// 输出完整 HTML5 文档:内联 CSS,图片 base64 内嵌,可脱离服务器独立打开。

export interface ReportFinding {
  statement: string;
  source: string;
  source_ref?: string;
}

export interface CoreIssue {
  title: string;
  severity: string;
  description: string;
  impact?: string;
  evidence_source?: string;
  evidence_basis?: 'evidence' | 'inference';
  evidence_refs?: string[];
  recommendation?: string;
}

export interface DimensionAnalysis {
  dimension: string;
  status: string;
  summary: string;
  metrics?: Record<string, number>;
  data_source?: string;
  image_ref?: string;
}

export interface Recommendation {
  priority: string;
  action: string;
  expected_impact: string;
  validation: string;
  evidence_basis: 'evidence' | 'inference';
  evidence_refs?: string[];
}

export interface ReportData {
  task_id: string;
  research_goal: string;
  executive_summary?: string;
  findings: Array<ReportFinding>;
  core_issues?: Array<CoreIssue>;
  dimension_analyses?: Array<DimensionAnalysis>;
  recommendations?: Array<Recommendation>;
  report_metadata?: { version: string; task_type: string; blueprint_id: string; generation_mode: 'production' | 'mock_demo'; evidence_ledger_ref: string };
  evidence_summary?: { ledger_entry_count: number; source_count: number; cited_evidence_count: number; limitations: string[] };
  timeline: Array<{ phase: string; activity: string }>;
  deliverables: string[];
  capability_orchestration: Array<{ capability_id: string; capability_type: string; purpose: string }>;
  risks_and_open_issues?: string[];
}

export interface ToolOutput {
  toolId: string;
  output: unknown;
}

export interface Upload {
  role: string;
  dataUrl: string;
}

export interface RenderReportParams {
  report: ReportData;
  toolOutputs?: Array<ToolOutput>;
  uploads?: Array<Upload>;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface Hotspot {
  region: string;
  score: number;
  description?: string;
}

function extractHotspots(toolOutputs: Array<ToolOutput>): Hotspot[] | null {
  const entry = toolOutputs.find(t => t.toolId === 'attention-analysis-lab');
  if (!entry || !entry.output) return null;
  const out = entry.output as Record<string, unknown>;
  const rawSpots = Array.isArray(out.hotspots) ? out.hotspots : null;
  if (!rawSpots || rawSpots.length === 0) return null;
  return rawSpots.map((h: any) => ({
    region: h.region ?? h.id ?? `(${(h.x ?? 0).toFixed(2)}, ${(h.y ?? 0).toFixed(2)})`,
    score: typeof h.score === 'number' ? h.score : 0,
    description: h.description ?? h.reason ?? '',
  }));
}

function extractAttentionMetrics(toolOutputs: Array<ToolOutput>): Record<string, number> | null {
  const entry = toolOutputs.find(t => t.toolId === 'attention-analysis-lab');
  if (!entry || !entry.output) return null;
  const out = entry.output as Record<string, unknown>;
  const metrics: Record<string, number> = {};
  if (typeof out.distractionRiskScore === 'number') metrics.distractionRiskScore = out.distractionRiskScore;
  if (typeof out.focusBalanceScore === 'number') metrics.focusBalanceScore = out.focusBalanceScore;
  return Object.keys(metrics).length > 0 ? metrics : null;
}

// ─── CSS ───────────────────────────────────────────────────────────────────────

const CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --bg: #0f1419;
  --surface: #1c2128;
  --surface-2: #252c35;
  --text: #e6edf3;
  --text-dim: #8b949e;
  --accent: #58a6ff;
  --green: #3fb950;
  --yellow: #d29922;
  --red: #f85149;
  --border: #30363d;
  --radius: 10px;
}
body { font-family: -apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif; background: var(--bg); color: var(--text); line-height: 1.7; }
.dashboard { display: grid; grid-template-columns: 260px 1fr; min-height: 100vh; }

/* 侧栏 */
.sidebar { background: var(--surface); padding: 28px 20px; border-right: 1px solid var(--border); position: sticky; top: 0; height: 100vh; overflow-y: auto; }
.sidebar .logo { font-size: 13px; font-weight: 700; color: var(--accent); margin-bottom: 28px; letter-spacing: 1px; text-transform: uppercase; }
.sidebar nav a { display: block; padding: 9px 12px; margin-bottom: 3px; border-radius: 6px; font-size: 13px; color: var(--text-dim); text-decoration: none; transition: background 0.15s; }
.sidebar nav a:hover { background: var(--surface-2); color: var(--text); }
.sidebar .stats { margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--border); }
.sidebar .stat { margin-bottom: 14px; }
.sidebar .stat-label { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; }
.sidebar .stat-value { font-size: 22px; font-weight: 700; margin-top: 2px; }
.stat-value.warn { color: var(--yellow); }
.stat-value.ok { color: var(--green); }
.stat-value.blue { color: var(--accent); }

/* 主区 */
.main { padding: 36px 44px; max-width: 1100px; }
.main h1 { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
.main .desc { font-size: 13px; color: var(--text-dim); margin-bottom: 28px; }
h2 { font-size: 15px; font-weight: 600; margin: 36px 0 14px; color: var(--text); }

/* 摘要 */
.summary-card { background: linear-gradient(135deg, #1a3a5c 0%, #1c2128 100%); border: 1px solid #264d73; border-radius: var(--radius); padding: 20px 24px; margin-bottom: 28px; font-size: 13px; line-height: 1.9; color: #c8ddf0; }
.summary-card strong { color: var(--accent); font-size: 10px; text-transform: uppercase; letter-spacing: 1px; display: block; margin-bottom: 8px; }
.demo-notice { border: 1px solid var(--yellow); background: rgba(210,153,34,0.12); border-radius: 6px; padding: 11px 14px; margin: -10px 0 18px; color: #e3b341; font-size: 12px; }
.evidence-summary { display: flex; flex-wrap: wrap; gap: 14px; margin: -10px 0 24px; color: var(--text-dim); font-size: 11px; }

/* 指标卡片 */
.metrics { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 14px; margin-bottom: 32px; }
.metric-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px; }
.metric-card .label { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
.metric-card .value { font-size: 26px; font-weight: 700; }
.metric-card .sub { font-size: 11px; color: var(--text-dim); margin-top: 3px; }
.value.red { color: var(--red); }
.value.yellow { color: var(--yellow); }
.value.green { color: var(--green); }
.value.blue { color: var(--accent); }

/* 热力图区 */
.heatmap-section { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 22px; margin-bottom: 28px; }
.heatmap-section h2 { margin: 0 0 14px; }
.heatmap-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.hotspot-chart { background: var(--surface-2); border-radius: 8px; padding: 16px; height: 180px; position: relative; }
.hotspot-bar { position: absolute; bottom: 16px; left: 16px; right: 16px; display: flex; align-items: flex-end; gap: 6px; height: 130px; }
.hotspot-bar .bar { flex: 1; background: var(--accent); border-radius: 3px 3px 0 0; opacity: 0.7; position: relative; }
.hotspot-bar .bar-label { position: absolute; bottom: -18px; left: 50%; transform: translateX(-50%); font-size: 9px; color: var(--text-dim); white-space: nowrap; }
.hotspot-list table { width: 100%; font-size: 12px; }
.hotspot-list th { text-align: left; padding: 7px 8px; color: var(--text-dim); font-size: 10px; text-transform: uppercase; border-bottom: 1px solid var(--border); }
.hotspot-list td { padding: 7px 8px; border-bottom: 1px solid var(--border); }
.score-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; }
.note-box { margin-top: 10px; font-size: 11px; color: var(--text-dim); padding: 8px 10px; background: var(--surface-2); border-radius: 6px; }

/* 核心问题 */
.issue-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 20px; margin-bottom: 10px; border-left: 4px solid var(--border); }
.issue-card.critical { border-left-color: var(--red); }
.issue-card.major { border-left-color: var(--yellow); }
.issue-card.minor { border-left-color: var(--text-dim); }
.issue-card .header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.issue-card .sev { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; padding: 2px 8px; border-radius: 3px; }
.issue-card .sev.critical { background: rgba(248,81,73,0.15); color: var(--red); }
.issue-card .sev.major { background: rgba(210,153,34,0.15); color: var(--yellow); }
.issue-card .sev.minor { background: rgba(139,148,158,0.15); color: var(--text-dim); }
.issue-card .title { font-size: 14px; font-weight: 600; }
.issue-card .body { font-size: 12px; color: var(--text-dim); line-height: 1.7; }
.issue-card .rec { margin-top: 8px; font-size: 12px; color: var(--accent); }
.issue-card .impact { margin-top: 7px; font-size: 12px; color: var(--text); }
.issue-card .src { margin-top: 6px; font-size: 10px; color: #555d66; }

/* 优先行动 */
.recommendation-card { background: var(--surface); border: 1px solid var(--border); border-left: 4px solid var(--accent); border-radius: var(--radius); padding: 15px 18px; margin-bottom: 10px; }
.recommendation-card.p0 { border-left-color: var(--red); }
.recommendation-card.p1 { border-left-color: var(--yellow); }
.recommendation-card .header { display: flex; align-items: center; gap: 10px; margin-bottom: 7px; }
.recommendation-card .priority { font-size: 10px; font-weight: 700; color: var(--accent); }
.recommendation-card.p0 .priority { color: var(--red); }
.recommendation-card.p1 .priority { color: var(--yellow); }
.recommendation-card .action { font-size: 13px; font-weight: 600; }
.recommendation-card .detail { font-size: 12px; color: var(--text-dim); margin-top: 3px; }
.recommendation-card .basis { font-size: 10px; color: var(--text-dim); margin-top: 7px; }

/* 维度 */
.dim-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 20px; margin-bottom: 10px; }
.dim-card .header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.dim-card .dim-name { font-size: 13px; font-weight: 600; text-transform: capitalize; }
.dim-status { font-size: 9px; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
.dim-status.complete { background: rgba(63,185,80,0.15); color: var(--green); }
.dim-status.partial { background: rgba(210,153,34,0.15); color: var(--yellow); }
.dim-status.data_incomplete { background: rgba(248,81,73,0.15); color: var(--red); }
.dim-card .summary { font-size: 12px; color: var(--text-dim); line-height: 1.7; }
.dim-card .metrics-row { margin-top: 8px; display: flex; gap: 10px; flex-wrap: wrap; }
.dim-card .m { font-size: 11px; padding: 3px 8px; background: var(--surface-2); border-radius: 4px; }
.dim-card .m strong { color: var(--accent); }

/* 发现列表 */
.finding-row { display: grid; grid-template-columns: 48px 1fr 90px; gap: 14px; padding: 14px 18px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 8px; align-items: center; }
.finding-row .idx { font-size: 18px; font-weight: 700; color: var(--text-dim); text-align: center; }
.finding-row .text { font-size: 12px; line-height: 1.7; }
.finding-row .ref { display: block; margin-top: 4px; font-size: 10px; color: #555d66; font-family: "SF Mono", Menlo, monospace; }
.tag { font-size: 9px; padding: 3px 8px; border-radius: 12px; text-align: center; font-weight: 600; white-space: nowrap; }
.tag-tool { background: rgba(88,166,255,0.15); color: var(--accent); }
.tag-llm { background: rgba(210,153,34,0.15); color: var(--yellow); }
.tag-human { background: rgba(248,81,73,0.15); color: var(--red); }

/* 能力网格 */
.cap-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; margin-bottom: 32px; }
.cap-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; }
.cap-card .name { font-size: 11px; font-weight: 600; color: var(--accent); margin-bottom: 4px; font-family: "SF Mono", Menlo, monospace; }
.cap-card .type { font-size: 9px; color: var(--text-dim); text-transform: uppercase; margin-bottom: 4px; }
.cap-card .purpose { font-size: 11px; color: var(--text-dim); line-height: 1.6; }

/* 时间线 */
.timeline-table { width: 100%; font-size: 12px; border-collapse: collapse; margin-bottom: 28px; }
.timeline-table th { text-align: left; padding: 8px 12px; color: var(--text-dim); font-size: 10px; text-transform: uppercase; border-bottom: 1px solid var(--border); background: var(--surface); }
.timeline-table td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
.timeline-table td:first-child { font-weight: 600; color: var(--accent); width: 70px; }

/* 产出物 */
.deliverables li { font-size: 12px; margin-bottom: 6px; line-height: 1.7; color: var(--text-dim); }
.deliverables { padding-left: 18px; margin-bottom: 28px; }

/* 风险 */
.risk-section { background: rgba(248,81,73,0.06); border: 1px solid rgba(248,81,73,0.25); border-radius: var(--radius); padding: 20px 22px; margin-bottom: 28px; }
.risk-section h2 { color: var(--red); margin: 0 0 12px; }
.risk-section li { font-size: 12px; margin-bottom: 8px; color: #ffa198; line-height: 1.7; }
.risk-section ul { padding-left: 16px; }

/* 图片 */
.upload-section img { max-width: 100%; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 12px; }

/* 页脚 */
.footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--border); font-size: 11px; color: var(--text-dim); text-align: center; }

@media (max-width: 768px) {
  .dashboard { grid-template-columns: 1fr; }
  .sidebar { position: static; height: auto; }
  .metrics { grid-template-columns: repeat(2, 1fr); }
  .heatmap-grid { grid-template-columns: 1fr; }
  .cap-grid { grid-template-columns: 1fr; }
}
`;

// ─── Main renderer ─────────────────────────────────────────────────────────────

export function renderReportHtml(params: RenderReportParams): string {
  const { report, toolOutputs = [], uploads = [] } = params;
  const date = formatDate();
  const hotspots = extractHotspots(toolOutputs);
  const attentionMetrics = extractAttentionMetrics(toolOutputs);
  const parts: string[] = [];

  // 统计数据
  const findingsCount = report.findings.length;
  const toolCount = report.findings.filter(f => f.source === 'tool_result').length;
  const toolPct = findingsCount > 0 ? Math.round((toolCount / findingsCount) * 100) : 0;
  const capCount = report.capability_orchestration.length;
  const riskCount = report.risks_and_open_issues?.length ?? 0;
  const issueCount = report.core_issues?.length ?? 0;

  // ── HTML 头 ──
  parts.push(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(report.research_goal)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="dashboard">`);

  // ── 侧栏 ──
  parts.push(`<aside class="sidebar">
<div class="logo">用研 AI · 报告</div>
<nav>`);
  if (report.executive_summary) parts.push(`<a href="#summary">摘要</a>`);
  parts.push(`<a href="#metrics">指标概览</a>`);
  if (hotspots) parts.push(`<a href="#attention">注意力分析</a>`);
  if (issueCount > 0) parts.push(`<a href="#issues">核心问题</a>`);
  if (report.dimension_analyses?.length) parts.push(`<a href="#dimensions">维度分析</a>`);
  if (report.recommendations?.length) parts.push(`<a href="#recommendations">优先行动</a>`);
  parts.push(`<a href="#findings">关键发现</a>`);
  parts.push(`<a href="#timeline">时间线</a>`);
  parts.push(`<a href="#capabilities">能力编排</a>`);
  if (riskCount > 0) parts.push(`<a href="#risks">风险项</a>`);
  parts.push(`</nav>
<div class="stats">
<div class="stat"><div class="stat-label">发现总数</div><div class="stat-value">${findingsCount}</div></div>
<div class="stat"><div class="stat-label">工具证据占比</div><div class="stat-value ${toolPct >= 70 ? 'ok' : 'warn'}">${toolPct}%</div></div>
<div class="stat"><div class="stat-label">风险/待确认</div><div class="stat-value ${riskCount > 3 ? 'warn' : ''}">${riskCount}</div></div>
<div class="stat"><div class="stat-label">调用能力</div><div class="stat-value blue">${capCount}</div></div>
</div>
</aside>`);

  // ── 主内容区 ──
  parts.push(`<main class="main">
<h1>${esc(report.research_goal)}</h1>
<div class="desc">任务 ${esc(report.task_id.slice(0, 8))} · ${date} · ${findingsCount} 条发现 · ${capCount} 项能力</div>`);

  // ── 摘要 ──
  if (report.executive_summary) {
    parts.push(`<div class="summary-card" id="summary">
<strong>Executive Summary</strong>
${esc(report.executive_summary)}
</div>`);
  }
  if (report.report_metadata?.generation_mode === 'mock_demo') {
    parts.push(`<div class="demo-notice">当前为测试/演示报告，不能作为业务结论使用。</div>`);
  }
  if (report.evidence_summary) {
    parts.push(`<div class="evidence-summary"><span>证据来源 ${report.evidence_summary.source_count}</span><span>台账条目 ${report.evidence_summary.ledger_entry_count}</span><span>已引用 ${report.evidence_summary.cited_evidence_count}</span></div>`);
  }

  // ── 指标卡片 ──
  parts.push(`<div class="metrics" id="metrics">`);
  if (attentionMetrics) {
    if (attentionMetrics.distractionRiskScore !== undefined) {
      const v = attentionMetrics.distractionRiskScore;
      const cls = v > 0.6 ? 'red' : v > 0.3 ? 'yellow' : 'green';
      parts.push(`<div class="metric-card"><div class="label">分散风险指数</div><div class="value ${cls}">${v.toFixed(3)}</div><div class="sub">distractionRiskScore</div></div>`);
    }
    if (attentionMetrics.focusBalanceScore !== undefined) {
      const v = attentionMetrics.focusBalanceScore;
      const cls = v < 0.4 ? 'red' : v < 0.6 ? 'yellow' : 'green';
      parts.push(`<div class="metric-card"><div class="label">焦点平衡</div><div class="value ${cls}">${v.toFixed(3)}</div><div class="sub">focusBalanceScore</div></div>`);
    }
  }
  if (hotspots) {
    const highCount = hotspots.filter(h => h.score >= 0.8).length;
    parts.push(`<div class="metric-card"><div class="label">高分热点数</div><div class="value ${highCount > 3 ? 'red' : 'yellow'}">${highCount}</div><div class="sub">score ≥ 0.8</div></div>`);
  }
  // 维度完整率
  if (report.dimension_analyses?.length) {
    const complete = report.dimension_analyses.filter(d => d.status === 'complete').length;
    const total = report.dimension_analyses.length;
    parts.push(`<div class="metric-card"><div class="label">维度完整率</div><div class="value blue">${complete}/${total}</div><div class="sub">complete / total</div></div>`);
  }
  parts.push(`<div class="metric-card"><div class="label">工具证据率</div><div class="value ${toolPct >= 70 ? 'green' : 'yellow'}">${toolPct}%</div><div class="sub">${toolCount}/${findingsCount} tool_result</div></div>`);
  parts.push(`</div>`);

  // ── 注意力热力图 ──
  if (hotspots) {
    parts.push(`<div class="heatmap-section" id="attention">
<h2>🎯 注意力热点分布</h2>
<div class="heatmap-grid">
<div class="hotspot-chart"><div class="hotspot-bar">`);
    for (const h of hotspots.slice(0, 8)) {
      parts.push(`<div class="bar" style="height:${(h.score * 100).toFixed(1)}%"><span class="bar-label">${esc(h.region)}</span></div>`);
    }
    parts.push(`</div></div>
<div class="hotspot-list"><table>
<thead><tr><th>热点</th><th>分数</th><th>描述</th></tr></thead><tbody>`);
    for (const h of hotspots) {
      const color = h.score >= 0.9 ? 'var(--red)' : h.score >= 0.7 ? 'var(--yellow)' : 'var(--green)';
      parts.push(`<tr><td><span class="score-dot" style="background:${color}"></span>${esc(h.region)}</td><td>${h.score.toFixed(3)}</td><td>${esc(h.description ?? '')}</td></tr>`);
    }
    parts.push(`</tbody></table>
<div class="note-box">⚠️ 启发式估计，非真实眼动实验。只能辅助判断视觉刺激分布。</div>
</div></div></div>`);
  }

  // ── 核心问题 ──
  if (report.core_issues && report.core_issues.length > 0) {
    parts.push(`<h2 id="issues">核心问题</h2>`);
    for (const issue of report.core_issues) {
      const sev = issue.severity.toLowerCase();
      parts.push(`<div class="issue-card ${sev}">
<div class="header"><span class="sev ${sev}">${esc(issue.severity)}</span><span class="title">${esc(issue.title)}</span></div>
<div class="body">${esc(issue.description)}</div>`);
      if (issue.impact) parts.push(`<div class="impact">影响: ${esc(issue.impact)}</div>`);
      if (issue.recommendation) parts.push(`<div class="rec">💡 ${esc(issue.recommendation)}</div>`);
      const evidenceText = issue.evidence_basis === 'inference'
        ? '依据: 推断，待验证'
        : `来源: ${issue.evidence_source ?? issue.evidence_refs?.join(', ') ?? '未标注'}`;
      parts.push(`<div class="src">${esc(evidenceText)}</div></div>`);
    }
  }

  // ── 维度分析 ──
  if (report.dimension_analyses && report.dimension_analyses.length > 0) {
    parts.push(`<h2 id="dimensions">维度分析</h2>`);
    for (const dim of report.dimension_analyses) {
      const st = dim.status.toLowerCase().replace(/\s/g, '_');
      parts.push(`<div class="dim-card">
<div class="header"><span class="dim-name">${esc(dim.dimension)}</span><span class="dim-status ${st}">${esc(dim.status)}</span></div>
<div class="summary">${esc(dim.summary)}</div>`);
      if (dim.metrics && Object.keys(dim.metrics).length > 0) {
        parts.push(`<div class="metrics-row">`);
        for (const [key, val] of Object.entries(dim.metrics)) {
          parts.push(`<span class="m">${esc(key)}: <strong>${typeof val === 'number' ? val.toFixed(3) : val}</strong></span>`);
        }
        parts.push(`</div>`);
      }
      if (dim.data_source) parts.push(`<div style="margin-top:6px;font-size:10px;color:var(--text-dim)">数据源: ${esc(dim.data_source)}</div>`);
      // 内嵌图片
      if (dim.image_ref) {
        const upload = uploads.find(u => u.dataUrl.includes(dim.image_ref!) || u.role === dim.image_ref);
        if (upload) parts.push(`<img style="max-width:100%;border-radius:6px;margin-top:10px" src="${upload.dataUrl}" alt="${esc(dim.dimension)}">`);
      }
      parts.push(`</div>`);
    }
  }

  // ── 优先行动 ──
  if (report.recommendations && report.recommendations.length > 0) {
    parts.push(`<h2 id="recommendations">优先行动</h2>`);
    for (const recommendation of report.recommendations) {
      const priority = recommendation.priority.toLowerCase();
      const basis = recommendation.evidence_basis === 'inference'
        ? '依据: 推断，待验证'
        : `证据: ${recommendation.evidence_refs?.join(', ') ?? '未标注'}`;
      parts.push(`<div class="recommendation-card ${esc(priority)}">
<div class="header"><span class="priority">${esc(recommendation.priority)}</span><span class="action">${esc(recommendation.action)}</span></div>
<div class="detail">预期影响: ${esc(recommendation.expected_impact)}</div>
<div class="detail">验证方式: ${esc(recommendation.validation)}</div>
<div class="basis">${esc(basis)}</div></div>`);
    }
  }

  // ── 关键发现 ──
  parts.push(`<h2 id="findings">关键发现</h2>`);
  for (let i = 0; i < report.findings.length; i++) {
    const f = report.findings[i];
    const tagClass = f.source === 'tool_result' ? 'tag-tool' : f.source === 'llm_inference' ? 'tag-llm' : 'tag-human';
    const tagText = f.source === 'tool_result' ? '工具产出' : f.source === 'llm_inference' ? 'LLM 推断' : '待人工确认';
    parts.push(`<div class="finding-row">
<div class="idx">#${i + 1}</div>
<div class="text">${esc(f.statement)}${f.source_ref ? `<span class="ref">${esc(f.source_ref)}</span>` : ''}</div>
<div class="tag ${tagClass}">${tagText}</div>
</div>`);
  }

  // ── 时间线 ──
  if (report.timeline.length > 0) {
    parts.push(`<h2 id="timeline">执行时间线</h2>
<table class="timeline-table"><thead><tr><th>阶段</th><th>活动</th></tr></thead><tbody>`);
    for (const t of report.timeline) {
      parts.push(`<tr><td>${esc(t.phase)}</td><td>${esc(t.activity)}</td></tr>`);
    }
    parts.push(`</tbody></table>`);
  }

  // ── 产出物 ──
  if (report.deliverables.length > 0) {
    parts.push(`<h2>产出物清单</h2><ul class="deliverables">`);
    for (const d of report.deliverables) {
      parts.push(`<li>${esc(d)}</li>`);
    }
    parts.push(`</ul>`);
  }

  // ── 能力编排 ──
  parts.push(`<h2 id="capabilities">能力编排</h2><div class="cap-grid">`);
  for (const c of report.capability_orchestration) {
    parts.push(`<div class="cap-card">
<div class="name">${esc(c.capability_id)}</div>
<div class="type">${esc(c.capability_type)}</div>
<div class="purpose">${esc(c.purpose)}</div>
</div>`);
  }
  parts.push(`</div>`);

  // ── 风险 ──
  if (report.risks_and_open_issues && report.risks_and_open_issues.length > 0) {
    parts.push(`<div class="risk-section" id="risks">
<h2>⚠️ 风险与待确认</h2><ul>`);
    for (const r of report.risks_and_open_issues) {
      parts.push(`<li>${esc(r)}</li>`);
    }
    parts.push(`</ul></div>`);
  }

  // ── 用户素材图片 ──
  if (uploads.length > 0) {
    parts.push(`<h2>参考素材</h2><div class="upload-section">`);
    for (const u of uploads) {
      if (u.dataUrl) parts.push(`<img src="${u.dataUrl}" alt="${esc(u.role)}">`);
    }
    parts.push(`</div>`);
  }

  // ── 页脚 ──
  parts.push(`<div class="footer">用研 AI · 自动生成 · ${date} · 任务 ${esc(report.task_id)}</div>`);

  // ── 关闭 ──
  parts.push(`</main></div></body></html>`);

  return parts.join('\n');
}
