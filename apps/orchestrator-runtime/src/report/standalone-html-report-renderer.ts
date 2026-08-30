import type {
  ReportAuditAppendixV1,
  ReportBlockV3,
  ReportBlockV4,
  ReportDocumentV3,
  ReportDocumentV4,
  ReportEditorialCopyFragmentV4,
  ReportNoticeCodeV1,
  ReportNoticeV1,
} from '../../../../packages/api-contract/report-document.ts';
import {
  visitReportDocumentV3,
  visitReportDocumentV4,
} from '../../../../packages/report-rendering/report-document-visitor.ts';
import {
  createReportRenderManifestV1,
  createReportRenderManifestV2,
  type ReportRenderManifestV1,
  type ReportRenderManifestV2,
} from '../../../../packages/report-rendering/report-render-manifest.ts';

export const STANDALONE_HTML_RENDERER_VERSION = 'standalone-html-v1';
export const STANDALONE_HTML_V4_RENDERER_VERSION = 'standalone-html-v2';
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const SAFE_ASSET_PATH = /^assets\/[A-Za-z0-9._-]+$/u;

const NOTICE_TEXT: Record<ReportNoticeCodeV1, string> = {
  layout_fallback: '结构编排已使用确定性排版，报告内容与来源覆盖不受影响。',
  copy_fallback: '编辑文案缺失或未通过校验的部分已使用受审原文。',
  data_policy_fallback: '当前数据策略未启用模型编排，已自动使用确定性排版。',
  editorial_adapter_fallback: '本报告已使用兼容的原始报告结构。',
  optional_visual_omitted: '部分可选视觉素材未纳入，文本内容保持完整。',
  requested_artifact_unfulfilled: '用户要求的部分交付物尚未完成。',
  visualization_linearized: '部分复杂结构已使用无损线性形式展示。',
  export_attachment_omitted: '部分可选审计附件未包含在此次导出中。',
  renderer_compatibility_fallback: '部分交互已改为始终展开，以保证兼容与完整。',
  html_unavailable: '离线 HTML 当前不可用，其他报告出口不受影响。',
  zero_unavailable: 'Zero 发布当前不可用，其他报告出口不受影响。',
  legacy_trace_incomplete: '历史报告的部分细粒度溯源信息不可用。',
};

export interface StandaloneHtmlReportResult {
  html: string;
  renderManifest: ReportRenderManifestV1 | ReportRenderManifestV2;
}

function escapeText(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderHeading(block: { title?: string }): string {
  return block.title ? `<h3>${escapeText(block.title)}</h3>` : '';
}

function copyAttributes(fragment: ReportEditorialCopyFragmentV4): string {
  return `data-copy-fragment-id="${escapeText(fragment.id)}" data-copy-provenance="${escapeText(fragment.provenance)}" data-source-leaf-ids="${escapeText(fragment.sourceLeafIds.join(' '))}"`;
}

function renderCopy(fragment: ReportEditorialCopyFragmentV4, className: string): string {
  return `<p class="${className}" ${copyAttributes(fragment)}>${escapeText(fragment.text)}</p>`;
}

function renderList(block: Extract<ReportBlockV3, { type: 'list' }>): string {
  const tag = block.ordered ? 'ol' : 'ul';
  return `<${tag} class="report-list">${block.items.map((item) => (
    `<li data-leaf-ref="${escapeText(item.leafRef)}">${item.label ? `<strong>${escapeText(item.label)}</strong> ` : ''}${escapeText(item.text)}</li>`
  )).join('')}</${tag}>`;
}

function renderRecordTable(block: Extract<ReportBlockV3, { type: 'record-table' }>): string {
  const headers = block.columns.map((column) => `<th scope="col">${escapeText(column.label)}</th>`).join('');
  const rows = block.rows.map((row) => {
    const byColumn = new Map(row.cells.map((cell) => [cell.columnKey, cell]));
    return `<tr>${row.label ? `<th scope="row">${escapeText(row.label)}</th>` : ''}${block.columns.map((column) => {
      const cell = byColumn.get(column.key)!;
      return `<td data-leaf-ref="${escapeText(cell.leafRef)}">${cell.value === null ? '—' : escapeText(cell.value)}</td>`;
    }).join('')}</tr>`;
  }).join('');
  return `<div class="table-scroll"><table class="record-table">${block.title ? `<caption>${escapeText(block.title)}</caption>` : ''}<thead><tr>${block.rows.some(({ label }) => label) ? '<th scope="col">项目</th>' : ''}${headers}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderGraph(block: Extract<ReportBlockV3, { type: 'graph' }>): string {
  const nodes = new Map(block.nodes.map((node) => [node.id, node]));
  const nodeList = block.nodes.map((node) => (
    `<li class="graph-node" data-leaf-ref="${escapeText(node.leafRef)}"><strong>${escapeText(node.label)}</strong>${node.description ? `<span>${escapeText(node.description)}</span>` : ''}</li>`
  )).join('');
  const edges = block.edges.map((edge) => (
    `<li data-leaf-ref="${escapeText(edge.leafRef)}"><span>${escapeText(nodes.get(edge.from)!.label)}</span><b aria-hidden="true">→</b><span>${escapeText(nodes.get(edge.to)!.label)}</span>${edge.label ? `<em>${escapeText(edge.label)}</em>` : ''}</li>`
  )).join('');
  return `<div class="graph graph-${escapeText(block.variant)}" data-graph-variant="${escapeText(block.variant)}"><ol class="graph-nodes">${nodeList}</ol>${edges ? `<h4>关系</h4><ul class="graph-edges">${edges}</ul>` : ''}</div>`;
}

function renderPriorityBoard(block: Extract<ReportBlockV3, { type: 'priority-board' }>): string {
  return `<div class="priority-board">${block.groups.map((group) => (
    `<section class="priority-group priority-${escapeText(group.priority.toLowerCase())}"><h4>${escapeText(group.priority)}</h4><ol>${group.items.map((item) => (
      `<li data-leaf-ref="${escapeText(item.leafRef)}"><strong>${escapeText(item.action)}</strong>${item.rationale ? `<p>${escapeText(item.rationale)}</p>` : ''}<dl>${item.owner ? `<div><dt>负责人</dt><dd>${escapeText(item.owner)}</dd></div>` : ''}${item.validationMethod ? `<div><dt>验证</dt><dd>${escapeText(item.validationMethod)}</dd></div>` : ''}</dl></li>`
    )).join('')}</ol></section>`
  )).join('')}</div>`;
}

function renderCardGrid(block: Extract<ReportBlockV4, { type: 'card-grid' }>): string {
  return `<ul class="card-grid">${block.cards.map((card) => (
    `<li class="report-card" data-leaf-refs="${escapeText(card.leafRefs.join(' '))}">${card.status ? `<span class="card-status">${escapeText(card.status)}</span>` : ''}<h4>${escapeText(card.title)}</h4>${card.body ? `<p>${escapeText(card.body)}</p>` : ''}</li>`
  )).join('')}</ul>`;
}

function renderStageFlow(block: Extract<ReportBlockV4, { type: 'stage-flow' }>): string {
  return `<ol class="stage-flow">${block.stages.map((stage) => (
    `<li class="stage" data-leaf-refs="${escapeText(stage.leafRefs.join(' '))}">${stage.timeLabel ? `<span class="stage-time">${escapeText(stage.timeLabel)}</span>` : ''}<h4>${escapeText(stage.label)}</h4>${stage.description ? `<p>${escapeText(stage.description)}</p>` : ''}</li>`
  )).join('')}</ol>`;
}

function renderChartTable(block: Extract<ReportBlockV3, { type: 'chart' }>): string {
  const headers = block.table.columns.map((column) => `<th scope="col">${escapeText(column)}</th>`).join('');
  const rows = block.table.rows.map((row) => (
    `<tr><th scope="row">${escapeText(row.label)}</th>${row.cells.map((cell) => `<td>${cell === null ? '—' : escapeText(cell)}</td>`).join('')}</tr>`
  )).join('');
  return `<div class="table-scroll"><table class="record-table chart-table"><caption>${escapeText(block.table.caption)}</caption><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function checkedAssetPath(assetId: string, assetPathById: ReadonlyMap<string, string>): string {
  const path = assetPathById.get(assetId);
  if (!path || !SAFE_ASSET_PATH.test(path)) {
    throw new Error(`Standalone HTML Asset ${assetId} has no safe bundle path`);
  }
  return path;
}

function renderBlock(block: ReportBlockV3, assetPathById: ReadonlyMap<string, string>): string {
  let body: string;
  switch (block.type) {
    case 'paragraph':
    case 'fact':
      body = `${renderHeading(block)}<p data-leaf-ref="${escapeText(block.leafRef)}">${escapeText(block.text)}</p>`;
      break;
    case 'metric':
      body = `${renderHeading(block)}<dl class="metric" data-leaf-ref="${escapeText(block.leafRef)}"><dt>${escapeText(block.label)}</dt><dd>${escapeText(block.value)}${block.unit ? `<span>${escapeText(block.unit)}</span>` : ''}</dd></dl>`;
      break;
    case 'list':
      body = `${renderHeading(block)}${renderList(block)}`;
      break;
    case 'answer':
      body = `${renderHeading(block)}<p class="answer" data-leaf-ref="${escapeText(block.textLeafRef)}">${escapeText(block.text)}</p>${block.items.length > 0 ? `<ul class="report-list">${block.items.map((item) => `<li data-leaf-ref="${escapeText(item.leafRef)}">${item.label ? `<strong>${escapeText(item.label)}</strong> ` : ''}${escapeText(item.text)}</li>`).join('')}</ul>` : ''}`;
      break;
    case 'image': {
      const path = checkedAssetPath(block.assetRef.assetId, assetPathById);
      body = `${renderHeading(block)}<figure data-leaf-ref="${escapeText(block.leafRef)}"><img src="${escapeText(path)}" alt="${escapeText(block.altText)}" loading="lazy"><figcaption>${escapeText(block.caption)}</figcaption></figure>`;
      break;
    }
    case 'image-comparison': {
      const before = checkedAssetPath(block.beforeAssetRef.assetId, assetPathById);
      const after = checkedAssetPath(block.afterAssetRef.assetId, assetPathById);
      body = `${renderHeading(block)}<div class="image-comparison"><figure data-leaf-ref="${escapeText(block.beforeLeafRef)}"><img src="${escapeText(before)}" alt="${escapeText(block.altText)}（原图）" loading="lazy"><figcaption>原图</figcaption></figure><figure data-leaf-ref="${escapeText(block.afterLeafRef)}"><img src="${escapeText(after)}" alt="${escapeText(block.altText)}（标注图）" loading="lazy"><figcaption>标注图</figcaption></figure></div><p class="caption">${escapeText(block.caption)}</p>`;
      break;
    }
    case 'chart': {
      const path = checkedAssetPath(block.chartRef.assetId, assetPathById);
      body = `${renderHeading(block)}<figure data-leaf-ref="${escapeText(block.leafRef)}"><img src="${escapeText(path)}" alt="${escapeText(block.altText)}" loading="lazy"><figcaption>${escapeText(block.caption)}</figcaption></figure>${renderChartTable(block)}`;
      break;
    }
    case 'record-table':
      body = renderRecordTable(block);
      break;
    case 'graph':
      body = `${renderHeading(block)}${renderGraph(block)}`;
      break;
    case 'priority-board':
      body = `${renderHeading(block)}${renderPriorityBoard(block)}`;
      break;
  }
  const attributes = `class="report-block report-block-${escapeText(block.type)}" id="${escapeText(block.id)}" data-unit-refs="${escapeText(block.unitRefs.join(' '))}"`;
  return block.visibility === 'collapsible'
    ? `<details class="screen-disclosure report-block report-block-${escapeText(block.type)}" id="${escapeText(block.id)}" data-unit-refs="${escapeText(block.unitRefs.join(' '))}"><summary>${escapeText(block.title ?? '查看详细内容')}</summary><div class="collapsible-body">${body}</div></details><article class="print-disclosure report-block report-block-${escapeText(block.type)}" id="${escapeText(`${block.id}-print`)}">${body.replaceAll('data-leaf-ref=', 'data-print-leaf-ref=')}</article>`
    : `<article ${attributes}>${body}</article>`;
}

function renderV4Block(block: ReportBlockV4, assetPathById: ReadonlyMap<string, string>): string {
  const digest = block.digest ? renderCopy(block.digest, 'block-digest') : '';
  if (block.type !== 'card-grid' && block.type !== 'stage-flow') {
    return `${digest}${renderBlock(block, assetPathById)}`;
  }
  const body = `${renderHeading(block)}${block.type === 'card-grid' ? renderCardGrid(block) : renderStageFlow(block)}`;
  const attributes = `class="report-block report-block-${escapeText(block.type)}" id="${escapeText(block.id)}" data-unit-refs="${escapeText(block.unitRefs.join(' '))}"`;
  const rendered = block.visibility === 'collapsible'
    ? `<details class="screen-disclosure report-block report-block-${escapeText(block.type)}" id="${escapeText(block.id)}" data-unit-refs="${escapeText(block.unitRefs.join(' '))}"><summary>${escapeText(block.title ?? '查看详细内容')}</summary><div class="collapsible-body">${body}</div></details><article class="print-disclosure report-block report-block-${escapeText(block.type)}" id="${escapeText(`${block.id}-print`)}">${body.replaceAll('data-leaf-refs=', 'data-print-leaf-refs=')}</article>`
    : `<article ${attributes}>${body}</article>`;
  return `${digest}${rendered}`;
}

function renderNotice(notice: ReportNoticeV1): string {
  return `<li class="notice-${escapeText(notice.severity)}" data-notice-id="${escapeText(notice.id)}">${escapeText(NOTICE_TEXT[notice.code])}</li>`;
}

function renderNotices(notices: readonly string[]): string {
  if (notices.length === 0) return '';
  return `<aside class="notices" aria-label="生成说明"><h2>生成说明</h2><ul>${notices.join('')}</ul></aside>`;
}

function renderAuditRecord(record: ReportAuditAppendixV1['records'][number]): string {
  return `<tr data-audit-record-id="${escapeText(record.id)}"><td>${escapeText(record.sourceUnitKey)}</td><td>${escapeText(record.disposition)}</td><td>${escapeText(record.canonicalNodeIds.join('、') || '—')}</td><td>${escapeText(record.reasonCode ?? '—')}</td></tr>`;
}

function renderAuditAppendix(rows: readonly string[]): string {
  if (rows.length === 0) return '';
  const screenRows = rows.join('');
  const table = `<div class="table-scroll"><table class="record-table"><thead><tr><th scope="col">来源单元</th><th scope="col">处理结果</th><th scope="col">Canonical 映射</th><th scope="col">说明</th></tr></thead><tbody>${screenRows}</tbody></table></div>`;
  return `<section class="report-section audit" id="audit-appendix"><details class="screen-disclosure"><summary>分析审计附录（${rows.length}）</summary>${table}</details><div class="print-disclosure"><h2>分析审计附录（${rows.length}）</h2>${table.replaceAll('data-audit-record-id=', 'data-print-audit-record-id=')}</div></section>`;
}

const STYLE = `
:root{color-scheme:light;--paper:#f5f2eb;--ink:#171714;--muted:#68645c;--line:#d5d0c5;--accent:#b42419;--surface:#fffdf8;--soft:#ebe6dc;font-family:"Noto Serif SC","Songti SC","STSong",serif}*{box-sizing:border-box}html{scroll-behavior:smooth;background:var(--paper)}body{margin:0;color:var(--ink);background:var(--paper);line-height:1.7}.shell{display:grid;grid-template-columns:minmax(13rem,18rem) minmax(0,56rem);gap:clamp(2rem,5vw,6rem);max-width:86rem;margin:0 auto;padding:clamp(1.25rem,4vw,4rem)}.toc{position:sticky;top:1.5rem;align-self:start;border-top:3px solid var(--ink);padding-top:1rem}.toc strong{font:700 .78rem/1.2 system-ui,sans-serif;letter-spacing:.14em}.toc ol{padding-left:1.3rem}.toc a{color:inherit;text-decoration:none}.toc a:hover,.toc a:focus-visible{color:var(--accent);text-decoration:underline;text-underline-offset:.25rem}.report{min-width:0;overflow-wrap:anywhere}.cover{min-height:72vh;display:flex;flex-direction:column;justify-content:flex-end;border-top:10px solid var(--accent);padding:clamp(2rem,7vw,6rem) 0 3rem}.kicker{font:700 .78rem/1.2 system-ui,sans-serif;letter-spacing:.18em;color:var(--accent)}h1{max-width:18ch;margin:.8rem 0 1.2rem;font-size:clamp(2.8rem,7vw,6rem);line-height:.98;letter-spacing:-.04em}h2{font-size:clamp(1.7rem,3vw,2.5rem);line-height:1.15}h3{margin:0 0 1rem;font-size:1.22rem}.subtitle{max-width:45rem;color:var(--muted);font-size:1.08rem}.executive-summary{max-width:45rem;margin-top:2rem;padding-left:1.25rem;border-left:3px solid var(--accent);font-size:1.12rem}.notices{margin:0 0 3rem;padding:1rem 1.25rem;background:var(--soft);font-family:system-ui,sans-serif;font-size:.9rem}.notices h2{margin:0;font-size:.8rem}.notices ul{margin:.5rem 0 0;padding-left:1.2rem}.report-section{padding:3.5rem 0;border-top:1px solid var(--line);scroll-margin-top:1.5rem}.section-meta{font:700 .72rem/1 system-ui,sans-serif;color:var(--accent);letter-spacing:.12em}.report-block{margin:2rem 0}.report-block-collapsible{}.report-list{padding-left:1.25rem}.report-list li+li{margin-top:.7rem}.answer{font-size:1.08rem}.metric{display:flex;align-items:baseline;justify-content:space-between;border-block:1px solid var(--line);padding:1.25rem 0}.metric div{}.metric dt{font:600 .85rem/1.3 system-ui,sans-serif;color:var(--muted)}.metric dd{margin:0;font-size:2.5rem}.metric dd span{margin-left:.4rem;font-size:1rem;color:var(--muted)}.table-scroll{overflow-x:auto}.record-table{width:100%;border-collapse:collapse;font-family:system-ui,sans-serif;font-size:.9rem}.record-table caption{text-align:left;font:700 1.1rem/1.4 system-ui,sans-serif;margin-bottom:.8rem}.record-table th,.record-table td{padding:.75rem;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}.record-table thead th{font-size:.76rem;letter-spacing:.04em;color:var(--muted)}.graph-nodes,.graph-edges{list-style:none;padding:0}.graph-nodes{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.8rem}.graph-node{min-height:7rem;padding:1rem;border-top:3px solid var(--accent);background:var(--surface)}.graph-node span{display:block;margin-top:.5rem;color:var(--muted)}.graph-edges li{display:grid;grid-template-columns:1fr auto 1fr;gap:.75rem;align-items:center;padding:.65rem 0;border-bottom:1px solid var(--line)}.graph-edges em{grid-column:1/-1;color:var(--muted);font-size:.85rem}.priority-board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem}.priority-group{border-top:5px solid var(--ink);padding-top:.8rem}.priority-p0{border-color:var(--accent)}.priority-group h4{font:800 1.1rem/1 system-ui,sans-serif}.priority-group ol{padding-left:1.25rem}.priority-group li{padding:.65rem 0}.priority-group p{margin:.35rem 0;color:var(--muted)}.priority-group dl{margin:.5rem 0;font:400 .8rem/1.5 system-ui,sans-serif}.priority-group dl div{display:grid;grid-template-columns:3rem 1fr}.priority-group dd{margin:0}.image-comparison{display:grid;grid-template-columns:1fr 1fr;gap:1rem}figure{margin:0}img{display:block;max-width:100%;height:auto;border:1px solid var(--line)}figcaption,.caption{margin-top:.6rem;color:var(--muted);font:400 .82rem/1.5 system-ui,sans-serif}details{border-top:1px solid var(--line);padding-top:.8rem}summary{cursor:pointer;font:650 .88rem/1.4 system-ui,sans-serif}summary:focus-visible{outline:3px solid var(--accent);outline-offset:4px}.collapsible-body{margin-top:1rem}.print-disclosure{display:none}.audit{font-size:.88rem}.footer{padding:2rem 0;border-top:1px solid var(--line);color:var(--muted);font:.78rem/1.5 system-ui,sans-serif}@media(max-width:800px){.shell{display:block}.toc{position:static;margin-bottom:3rem}.cover{min-height:60vh}.priority-board,.image-comparison{grid-template-columns:1fr}.graph-edges li{grid-template-columns:1fr}.graph-edges b{transform:rotate(90deg);justify-self:start}}@media print{@page{size:A4;margin:16mm}.shell{display:block;max-width:none;padding:0}.toc{position:static;break-after:page}.cover{min-height:240mm;break-after:page}.report-section{break-before:page}.report-block{break-inside:avoid}.table-scroll{overflow:visible}.priority-board{display:block}.priority-group{break-inside:avoid;margin-bottom:1rem}.screen-disclosure{display:none!important}.print-disclosure{display:block!important}.notices{break-inside:avoid}a{color:inherit;text-decoration:none}}

body.report-style-analytical{--paper:#eef3f6;--ink:#14212b;--muted:#566774;--line:#cbd7de;--accent:#176b87;--surface:#fff;--soft:#e2edf2;font-family:Inter,"Noto Sans SC",system-ui,sans-serif}
body.report-style-operational{--paper:#f3f4ed;--ink:#18241c;--muted:#5d685f;--line:#cfd5c9;--accent:#28724a;--surface:#fff;--soft:#e4eadf;font-family:Inter,"Noto Sans SC",system-ui,sans-serif}
.report-style-analytical h1,.report-style-analytical h2,.report-style-analytical h3,.report-style-operational h1,.report-style-operational h2,.report-style-operational h3{font-family:Inter,"Noto Sans SC",system-ui,sans-serif;letter-spacing:-.025em}
.report-style-analytical .cover{border-top-width:4px}.report-style-operational .cover{border-top-width:14px}
.section-primary{padding-top:4.5rem;border-top:4px solid var(--ink)}.section-primary>h2{max-width:18ch;font-size:clamp(2.1rem,4vw,3.25rem)}
.section-supporting{padding-top:3rem}.section-supporting>h2{font-size:clamp(1.6rem,2.6vw,2.2rem)}
.section-appendix{padding-top:2.25rem;color:var(--muted);font-size:.92rem}.section-appendix>h2{font:700 1.35rem/1.25 system-ui,sans-serif;color:var(--ink)}
.report-density-compact .shell{gap:clamp(1.5rem,3vw,3.5rem);padding-block:clamp(1rem,2.5vw,2.5rem)}.report-density-compact .cover{min-height:48vh;padding-block:2.5rem 2rem}.report-density-compact .report-section{padding-block:2.25rem}.report-density-compact .report-block{margin-block:1.2rem}.report-density-compact .record-table th,.report-density-compact .record-table td{padding:.5rem .6rem}.report-density-compact .graph-node{min-height:5.5rem;padding:.75rem}.report-density-compact .priority-group li{padding:.4rem 0}
.graph-linear .graph-nodes{display:flex;counter-reset:graph-step;overflow-x:auto}.graph-linear .graph-node{position:relative;flex:1 0 10rem;padding-top:2.6rem;counter-increment:graph-step}.graph-linear .graph-node::before{content:counter(graph-step,decimal-leading-zero);position:absolute;top:.75rem;left:1rem;color:var(--accent);font:800 .7rem/1 system-ui,sans-serif}.graph-linear .graph-node:not(:last-child)::after{content:"→";position:absolute;z-index:1;top:50%;right:-.7rem;color:var(--accent);font:800 1.1rem/1 system-ui,sans-serif}
.graph-hub_spoke .graph-nodes{grid-template-columns:repeat(2,minmax(0,1fr))}.graph-hub_spoke .graph-node:first-child{grid-column:1/-1;justify-self:center;width:min(22rem,70%);min-height:auto;border:3px solid var(--accent);border-radius:999px;text-align:center}.graph-hub_spoke .graph-edges{display:flex;flex-wrap:wrap;gap:.5rem}.graph-hub_spoke .graph-edges li{display:flex;flex:1 1 16rem;border:1px solid var(--line);border-radius:.5rem;padding:.7rem;background:var(--surface)}.graph-hub_spoke .graph-edges em{margin-left:auto}
.graph-two_sided .graph-nodes{grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem 2rem}.graph-two_sided .graph-node:nth-child(odd){border-top:0;border-left:4px solid var(--accent);text-align:right}.graph-two_sided .graph-node:nth-child(even){border-top:0;border-right:4px solid var(--accent)}.graph-two_sided .graph-edges{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.6rem}.graph-two_sided .graph-edges li{display:block;padding:.8rem;border:1px solid var(--line);background:var(--surface)}.graph-two_sided .graph-edges b{margin-inline:.5rem}.graph-two_sided .graph-edges em{display:block;margin-top:.35rem}
.section-lead{max-width:42rem;margin:.75rem 0 2rem;color:var(--muted);font-size:1.08rem}.section-transition{margin:2.5rem 0 0;padding:1rem 1.2rem;border-left:3px solid var(--accent);background:var(--soft);font-style:italic}.block-digest{margin:1.4rem 0 .75rem;color:var(--muted);font-size:.96rem}.section-disclosure{margin:2rem 0;padding:0;border-top:1px solid var(--line)}.section-disclosure>summary{padding:1.5rem 0;list-style-position:outside}.section-disclosure>summary h2{display:inline;margin:0 0 0 .65rem}.section-disclosure-body{padding-bottom:2rem}.card-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:1rem;margin:0;padding:0;list-style:none}.report-card{padding:1.2rem;border-top:4px solid var(--accent);background:var(--surface)}.report-card h4,.stage h4{margin:.35rem 0;font-size:1.05rem}.report-card p,.stage p{margin:.5rem 0 0;color:var(--muted)}.card-status,.stage-time{display:inline-block;color:var(--accent);font:700 .72rem/1.3 system-ui,sans-serif;letter-spacing:.05em}.stage-flow{display:flex;gap:1rem;margin:0;padding:0;overflow-x:auto;list-style:none;counter-reset:stage}.stage{position:relative;flex:1 0 12rem;min-height:9rem;padding:2.6rem 1rem 1rem;border-top:4px solid var(--accent);background:var(--surface);counter-increment:stage}.stage::before{content:counter(stage,decimal-leading-zero);position:absolute;top:.85rem;left:1rem;color:var(--accent);font:800 .72rem/1 system-ui,sans-serif}.stage:not(:last-child)::after{content:"→";position:absolute;z-index:1;top:50%;right:-.7rem;color:var(--accent);font-weight:800}
@media(max-width:800px){.graph-linear .graph-nodes{display:grid;grid-template-columns:1fr;overflow:visible}.graph-linear .graph-node:not(:last-child)::after{content:"↓";top:auto;right:50%;bottom:-.9rem}.graph-hub_spoke .graph-nodes,.graph-two_sided .graph-nodes,.graph-two_sided .graph-edges,.card-grid,.stage-flow{display:grid;grid-template-columns:1fr;overflow:visible}.graph-hub_spoke .graph-node:first-child{grid-column:auto;width:100%}.graph-two_sided .graph-node:nth-child(n){border:0;border-top:3px solid var(--accent);text-align:left}.stage{min-height:auto}.stage:not(:last-child)::after{content:"↓";top:auto;right:50%;bottom:-.8rem}}
@media print{.section-primary{break-before:page}.section-supporting,.section-appendix{break-before:auto}.graph-linear .graph-nodes{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));overflow:visible}.graph-linear .graph-node::after{display:none}.card-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.stage-flow{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));overflow:visible}.report-card,.stage{break-inside:avoid}.stage::after{display:none}}
`;

interface StandaloneHtmlReportInput<TDocument extends ReportDocumentV3 | ReportDocumentV4> {
  document: TDocument;
  sourceReportDocumentContentSha256: string;
  assetPathById?: ReadonlyMap<string, string>;
}

function renderStandaloneReportV4(
  input: StandaloneHtmlReportInput<ReportDocumentV4>,
  assetPathById: ReadonlyMap<string, string>,
): StandaloneHtmlReportResult {
  const traversal = visitReportDocumentV4(input.document, {
    visitBlock(block) {
      return renderV4Block(block, assetPathById);
    },
    visitSection(section, blocks, index) {
      const meta = `<div class="section-meta">${String(index + 1).padStart(2, '0')} · ${escapeText(section.view.toUpperCase())}</div>`;
      const heading = `<h2 ${copyAttributes(section.title)}>${escapeText(section.title.text)}</h2>`;
      const lead = section.lead ? renderCopy(section.lead, 'section-lead') : '';
      const transition = section.transition ? renderCopy(section.transition, 'section-transition') : '';
      const content = `${meta}${heading}${lead}${blocks.join('')}${transition}`;
      const sectionAttributes = `class="report-section section-${escapeText(section.prominence)}" id="${escapeText(section.id)}" data-view="${escapeText(section.view)}" data-prominence="${escapeText(section.prominence)}"`;
      if (section.prominence === 'primary') return `<section ${sectionAttributes}>${content}</section>`;
      const summary = `<span class="section-meta">${String(index + 1).padStart(2, '0')} · ${escapeText(section.view.toUpperCase())}</span><h2 ${copyAttributes(section.title)}>${escapeText(section.title.text)}</h2>`;
      const disclosureBody = `${lead}${blocks.join('')}${transition}`;
      return `<details class="screen-disclosure section-disclosure section-${escapeText(section.prominence)}" id="${escapeText(section.id)}" data-view="${escapeText(section.view)}" data-prominence="${escapeText(section.prominence)}"><summary>${summary}</summary><div class="section-disclosure-body">${disclosureBody}</div></details><section class="print-disclosure report-section section-${escapeText(section.prominence)}" id="${escapeText(`${section.id}-print`)}" data-view="${escapeText(section.view)}" data-prominence="${escapeText(section.prominence)}">${content.replaceAll('data-copy-fragment-id=', 'data-print-copy-fragment-id=').replaceAll('data-leaf-ref=', 'data-print-leaf-ref=').replaceAll('data-leaf-refs=', 'data-print-leaf-refs=')}</section>`;
    },
    visitNotice(notice) {
      return renderNotice(notice);
    },
    visitAuditRecord(record) {
      return renderAuditRecord(record);
    },
  });
  const navigation = input.document.sections.map((section) => `<li><a href="#${escapeText(section.id)}">${escapeText(section.title.text)}</a></li>`).join('');
  const title = input.document.title;
  const summary = input.document.executiveSummary;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="report-document-sha256" content="${escapeText(input.sourceReportDocumentContentSha256)}"><meta name="report-renderer-version" content="${escapeText(STANDALONE_HTML_V4_RENDERER_VERSION)}"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'"><title>${escapeText(title.text)}</title><style>${STYLE}</style></head><body class="report-style-${escapeText(input.document.style)} report-density-${escapeText(input.document.density)}" data-report-version="report-document-v4" data-copy-mode="${escapeText(input.document.copyMode)}" data-report-style="${escapeText(input.document.style)}" data-report-density="${escapeText(input.document.density)}"><div class="shell"><nav class="toc" aria-label="报告目录"><strong>目录 / CONTENTS</strong><ol>${navigation}</ol></nav><main class="report"><header class="cover"><div class="kicker">RESEARCH REPORT</div><h1 ${copyAttributes(title)}>${escapeText(title.text)}</h1><p class="subtitle">${escapeText(input.document.subtitle)}</p><p class="executive-summary" ${copyAttributes(summary)}>${escapeText(summary.text)}</p></header>${renderNotices(traversal.notices)}${traversal.sections.join('')}${renderAuditAppendix(traversal.auditRecords)}<footer class="footer">${escapeText(title.text)} · ${escapeText(STANDALONE_HTML_V4_RENDERER_VERSION)}</footer></main></div></body></html>`;
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    throw new Error(`Standalone HTML exceeds ${MAX_HTML_BYTES} bytes`);
  }
  return {
    html,
    renderManifest: createReportRenderManifestV2({
      renderer: 'standalone_html',
      rendererVersion: STANDALONE_HTML_V4_RENDERER_VERSION,
      sourceReportDocumentContentSha256: input.sourceReportDocumentContentSha256,
      document: input.document,
      semantics: traversal.semantics,
    }),
  };
}

export function renderStandaloneReport(
  input: StandaloneHtmlReportInput<ReportDocumentV3 | ReportDocumentV4>,
): StandaloneHtmlReportResult {
  const assetPathById = input.assetPathById ?? new Map<string, string>();
  const paths = [...assetPathById.values()];
  if (new Set(paths).size !== paths.length) throw new Error('Standalone HTML Asset bundle paths must be unique');
  for (const path of paths) {
    if (!SAFE_ASSET_PATH.test(path)) throw new Error(`Standalone HTML Asset path is unsafe: ${path}`);
  }
  if (input.document.version === 'report-document-v4') {
    return renderStandaloneReportV4({ ...input, document: input.document }, assetPathById);
  }

  const traversal = visitReportDocumentV3(input.document, {
    visitBlock(block) {
      return renderBlock(block, assetPathById);
    },
    visitSection(section, blocks, index) {
      return `<section class="report-section section-${escapeText(section.prominence)}" id="${escapeText(section.id)}" data-view="${escapeText(section.view)}" data-prominence="${escapeText(section.prominence)}"><div class="section-meta">${String(index + 1).padStart(2, '0')} · ${escapeText(section.view.toUpperCase())}</div><h2>${escapeText(section.title)}</h2>${blocks.join('')}</section>`;
    },
    visitNotice(notice) {
      return renderNotice(notice);
    },
    visitAuditRecord(record) {
      return renderAuditRecord(record);
    },
  });
  const navigation = input.document.sections.map((section) => `<li><a href="#${escapeText(section.id)}">${escapeText(section.title)}</a></li>`).join('');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="report-document-sha256" content="${escapeText(input.sourceReportDocumentContentSha256)}"><meta name="report-renderer-version" content="${escapeText(STANDALONE_HTML_RENDERER_VERSION)}"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'"><title>${escapeText(input.document.title)}</title><style>${STYLE}</style></head><body class="report-style-${escapeText(input.document.style)} report-density-${escapeText(input.document.density)}" data-report-style="${escapeText(input.document.style)}" data-report-density="${escapeText(input.document.density)}"><div class="shell"><nav class="toc" aria-label="报告目录"><strong>目录 / CONTENTS</strong><ol>${navigation}</ol></nav><main class="report"><header class="cover"><div class="kicker">RESEARCH REPORT</div><h1>${escapeText(input.document.title)}</h1><p class="subtitle">${escapeText(input.document.subtitle)}</p><p class="executive-summary">${escapeText(input.document.executiveSummary)}</p></header>${renderNotices(traversal.notices)}${traversal.sections.join('')}${renderAuditAppendix(traversal.auditRecords)}<footer class="footer">${escapeText(input.document.title)} · ${escapeText(STANDALONE_HTML_RENDERER_VERSION)}</footer></main></div></body></html>`;
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    throw new Error(`Standalone HTML exceeds ${MAX_HTML_BYTES} bytes`);
  }
  return {
    html,
    renderManifest: createReportRenderManifestV1({
      renderer: 'standalone_html',
      rendererVersion: STANDALONE_HTML_RENDERER_VERSION,
      sourceReportDocumentContentSha256: input.sourceReportDocumentContentSha256,
      document: input.document,
      semantics: traversal.semantics,
    }),
  };
}
