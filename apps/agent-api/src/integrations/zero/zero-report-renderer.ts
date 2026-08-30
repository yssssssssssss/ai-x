import type {
  RenderableReportDocument,
  ReportAuditAppendixV1,
  ReportBlockV1V2,
  ReportBlockV3,
  ReportBlockV4,
  ReportDocumentV3,
  ReportDocumentV4,
  ReportEditorialCopyFragmentV4,
  ReportNoticeCodeV1,
  ReportNoticeV1,
  ReportSemanticManifestV1,
  ReportSemanticManifestV2,
} from '../../../../../packages/api-contract/report-document.ts';
import {
  isReportDocumentV3,
  isReportDocumentV4,
} from '../../../../../packages/api-contract/report-document.ts';
import {
  visitReportDocumentV3,
  visitReportDocumentV4,
} from '../../../../../packages/report-rendering/report-document-visitor.ts';
import {
  createReportRenderManifestV1,
  createReportRenderManifestV2,
  type ReportRenderManifestV1,
  type ReportRenderManifestV2,
} from '../../../../../packages/report-rendering/report-render-manifest.ts';

export const ZERO_REPORT_TEMPLATE_VERSION = 'zero-report-v1';
const MAX_HTML_CHARS = 500_000;

export type ZeroVisualRole = 'image' | 'image_original' | 'image_annotation' | 'chart';

export interface ZeroVisualPlacement {
  key: string;
  blockId: string;
  role: ZeroVisualRole;
  sliceIndex: number;
  sliceCount: number;
  label: string;
}

export interface ZeroHtmlPlaceholder extends ZeroVisualPlacement {
  nodeName: string;
}

export interface ZeroHtmlDraft {
  html: string;
  name: string;
  templateVersion: typeof ZERO_REPORT_TEMPLATE_VERSION;
  expectedWidth: number;
  expectedMinimumHeight: number;
  placeholders: ZeroHtmlPlaceholder[];
  renderManifest?: ReportRenderManifestV1 | ReportRenderManifestV2;
}

type ZeroReadableBlock = ReportBlockV1V2 | ReportBlockV3 | ReportBlockV4;
type ZeroChartBlock = Extract<ZeroReadableBlock, { type: 'chart' }>;

function escape(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function blockIds(document: RenderableReportDocument): Set<string> {
  return new Set(document.sections.flatMap((section) => section.blocks.map((block) => block.id)));
}

function placeholders(input: {
  publicationId: string;
  visuals: readonly ZeroVisualPlacement[];
  knownBlocks: ReadonlySet<string>;
}): ZeroHtmlPlaceholder[] {
  const keys = new Set<string>();
  const names = new Set<string>();
  return input.visuals.map((visual) => {
    if (keys.has(visual.key)) throw new Error(`duplicate visual key ${visual.key}`);
    if (!input.knownBlocks.has(visual.blockId)) {
      throw new Error(`visual ${visual.key} references unknown report block ${visual.blockId}`);
    }
    if (
      !Number.isInteger(visual.sliceIndex)
      || !Number.isInteger(visual.sliceCount)
      || visual.sliceIndex < 0
      || visual.sliceCount < 1
      || visual.sliceIndex >= visual.sliceCount
    ) {
      throw new Error(`visual ${visual.key} has invalid slice position`);
    }
    keys.add(visual.key);
    const nodeName = `zero:${input.publicationId}:${visual.key}`;
    if (names.has(nodeName)) throw new Error(`duplicate Zero node name ${nodeName}`);
    names.add(nodeName);
    return { ...visual, nodeName };
  });
}

const VISUAL_ROLE_ORDER: Record<ZeroVisualRole, number> = {
  image_original: 0,
  image_annotation: 1,
  image: 2,
  chart: 3,
};

function visualGroup(items: readonly ZeroHtmlPlaceholder[]): string {
  if (items.length === 0) return '<div class="visual-empty">该视觉内容没有可导出的图片。</div>';
  const bySlice = new Map<number, ZeroHtmlPlaceholder[]>();
  for (const item of items) {
    const list = bySlice.get(item.sliceIndex) ?? [];
    list.push(item);
    bySlice.set(item.sliceIndex, list);
  }
  return `<div class="visual-stack">${[...bySlice.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, slice]) => `<div class="visual-row">${slice
      .sort((left, right) => VISUAL_ROLE_ORDER[left.role] - VISUAL_ROLE_ORDER[right.role])
      .map((item) => `<figure class="visual-card"><div class="visual-label">${escape(item.label)}</div><div class="visual-placeholder ${item.role === 'chart' ? 'chart' : ''}" data-ai-alt="${escape(item.nodeName)}"></div><figcaption>${escape(item.label)} · ${item.sliceIndex + 1}/${item.sliceCount}</figcaption></figure>`)
      .join('')}</div>`)
    .join('')}</div>`;
}

function tableHtml(block: ZeroChartBlock): string {
  const table = block.table;
  const header = table.columns.map((column) => `<th>${escape(column)}</th>`).join('');
  const rows = table.rows.map((row) => `<tr><th>${escape(row.label)}</th>${row.cells.map((cell) => `<td>${cell == null ? '—' : escape(cell)}</td>`).join('')}</tr>`).join('');
  return `<table class="data-table"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderLegacyBlock(
  block: ReportBlockV1V2,
  visualByBlock: ReadonlyMap<string, ZeroHtmlPlaceholder[]>,
): string {
  switch (block.type) {
    case 'paragraph':
      return `<p class="paragraph" data-ai-alt="${escape(block.id)}">${escape(block.text)}</p>`;
    case 'list':
    case 'projection-list':
      return `<ul class="list" data-ai-alt="${escape(block.id)}">${block.items.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>`;
    case 'metric':
      return `<article class="metric" data-ai-alt="${escape(block.id)}"><span>${escape(block.label)}</span><strong>${escape(block.value)}</strong></article>`;
    case 'fact':
      return `<article class="fact" data-ai-alt="${escape(block.id)}"><span>FACT</span><p>${escape(block.text)}</p></article>`;
    case 'answer':
      return `<article class="fact" data-ai-alt="${escape(block.id)}"><span>${escape(block.kind.replaceAll('_', ' ').toUpperCase())}${block.answerStatus ? ` · ${escape(block.answerStatus.toUpperCase())}` : ''}</span><h3>${escape(block.title)}</h3><p>${escape(block.text)}</p>${block.items.length > 0 ? `<ul>${block.items.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>` : ''}${typeof block.confidence === 'number' ? `<p class="caption">Confidence ${Math.round(block.confidence * 100)}%${block.evidenceIds.length > 0 ? ` · Evidence ${block.evidenceIds.map(escape).join(', ')}` : ''}</p>` : block.evidenceIds.length > 0 ? `<p class="caption">Evidence ${block.evidenceIds.map(escape).join(', ')}</p>` : ''}${block.findingIds.length > 0 || block.summaryIds.length > 0 ? `<p class="caption">Finding ${block.findingIds.map(escape).join(', ') || '—'} · Summary ${block.summaryIds.map(escape).join(', ') || '—'}</p>` : ''}</article>`;
    case 'image':
      return `<article class="visual-block" data-ai-alt="${escape(block.id)}"><h3>${escape(block.caption)}</h3>${visualGroup(visualByBlock.get(block.id) ?? [])}<p class="caption">${escape(block.altText)}</p></article>`;
    case 'image-comparison':
      return `<article class="visual-block" data-ai-alt="${escape(block.id)}"><h3>${escape(block.caption)}</h3>${visualGroup(visualByBlock.get(block.id) ?? [])}<p class="caption">${escape(block.altText)}</p></article>`;
    case 'chart':
      return `<article class="visual-block" data-ai-alt="${escape(block.id)}"><h3>${escape(block.caption)}</h3>${visualGroup(visualByBlock.get(block.id) ?? [])}${tableHtml(block)}<p class="caption">${escape(block.altText)}</p></article>`;
  }
}

function v3Heading(block: ReportBlockV3): string {
  return block.title ? `<h3>${escape(block.title)}</h3>` : '';
}

function renderRecordTable(block: Extract<ReportBlockV3, { type: 'record-table' }>): string {
  const hasRowLabels = block.rows.some(({ label }) => label !== undefined);
  const headers = block.columns.map((column) => `<th>${escape(column.label)}</th>`).join('');
  const rows = block.rows.map((row) => {
    const cells = new Map(row.cells.map((cell) => [cell.columnKey, cell]));
    return `<tr>${hasRowLabels ? `<th>${escape(row.label ?? '—')}</th>` : ''}${block.columns.map((column) => {
      const cell = cells.get(column.key)!;
      return `<td data-leaf-ref="${escape(cell.leafRef)}">${cell.value === null ? '—' : escape(cell.value)}</td>`;
    }).join('')}</tr>`;
  }).join('');
  return `<table class="data-table record-table">${block.title ? `<caption>${escape(block.title)}</caption>` : ''}<thead><tr>${hasRowLabels ? '<th>项目</th>' : ''}${headers}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderGraph(block: Extract<ReportBlockV3, { type: 'graph' }>): string {
  const nodes = new Map(block.nodes.map((node) => [node.id, node]));
  const nodeItems = block.nodes.map((node) => `<li class="graph-node" data-leaf-ref="${escape(node.leafRef)}"><strong>${escape(node.label)}</strong>${node.description ? `<p>${escape(node.description)}</p>` : ''}</li>`).join('');
  const edgeItems = block.edges.map((edge) => `<li data-leaf-ref="${escape(edge.leafRef)}">${escape(nodes.get(edge.from)!.label)} → ${escape(nodes.get(edge.to)!.label)}${edge.label ? ` · ${escape(edge.label)}` : ''}</li>`).join('');
  return `${v3Heading(block)}<div class="graph graph-${escape(block.variant)}"><ul class="graph-nodes">${nodeItems}</ul>${edgeItems ? `<h4>关系</h4><ul class="graph-edges">${edgeItems}</ul>` : ''}</div>`;
}

function renderPriorityBoard(block: Extract<ReportBlockV3, { type: 'priority-board' }>): string {
  const groups = block.groups.map((group) => `<section class="priority-group priority-${escape(group.priority.toLowerCase())}"><h4>${escape(group.priority)}</h4><ol>${group.items.map((item) => `<li data-leaf-ref="${escape(item.leafRef)}"><strong>${escape(item.action)}</strong>${item.rationale ? `<p>${escape(item.rationale)}</p>` : ''}${item.owner ? `<p class="caption">负责人：${escape(item.owner)}</p>` : ''}${item.validationMethod ? `<p class="caption">验证：${escape(item.validationMethod)}</p>` : ''}</li>`).join('')}</ol></section>`).join('');
  return `${v3Heading(block)}<div class="priority-board">${groups}</div>`;
}

function wrapV3Block(block: ReportBlockV3, body: string): string {
  return `<article class="v3-block ${escape(block.type)} visibility-${escape(block.visibility)}" data-ai-alt="${escape(block.id)}" data-unit-refs="${escape(block.unitRefs.join(' '))}">${body}</article>`;
}

function renderV3Block(
  block: ReportBlockV3,
  visualByBlock: ReadonlyMap<string, ZeroHtmlPlaceholder[]>,
): string {
  let body: string;
  switch (block.type) {
    case 'paragraph':
      body = `${v3Heading(block)}<p class="paragraph" data-leaf-ref="${escape(block.leafRef)}">${escape(block.text)}</p>`;
      break;
    case 'fact':
      body = `${v3Heading(block)}<div class="fact" data-leaf-ref="${escape(block.leafRef)}"><span>FACT</span><p>${escape(block.text)}</p></div>`;
      break;
    case 'metric':
      body = `${v3Heading(block)}<div class="metric" data-leaf-ref="${escape(block.leafRef)}"><span>${escape(block.label)}</span><strong>${escape(block.value)}${block.unit ? `<small>${escape(block.unit)}</small>` : ''}</strong></div>`;
      break;
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      body = `${v3Heading(block)}<${tag} class="list">${block.items.map((item) => `<li data-leaf-ref="${escape(item.leafRef)}">${item.label ? `<strong>${escape(item.label)}</strong> ` : ''}${escape(item.text)}</li>`).join('')}</${tag}>`;
      break;
    }
    case 'answer':
      body = `<div class="fact"><span>${escape(block.kind.replaceAll('_', ' ').toUpperCase())}${block.answerStatus ? ` · ${escape(block.answerStatus.toUpperCase())}` : ''}</span>${v3Heading(block)}<p data-leaf-ref="${escape(block.textLeafRef)}">${escape(block.text)}</p>${block.items.length > 0 ? `<ul>${block.items.map((item) => `<li data-leaf-ref="${escape(item.leafRef)}">${item.label ? `<strong>${escape(item.label)}</strong> ` : ''}${escape(item.text)}</li>`).join('')}</ul>` : ''}</div>`;
      break;
    case 'image':
      body = `<div class="visual-block">${v3Heading(block)}<h4>${escape(block.caption)}</h4>${visualGroup(visualByBlock.get(block.id) ?? [])}<p class="caption" data-leaf-ref="${escape(block.leafRef)}">${escape(block.altText)}</p></div>`;
      break;
    case 'image-comparison':
      body = `<div class="visual-block">${v3Heading(block)}<h4>${escape(block.caption)}</h4>${visualGroup(visualByBlock.get(block.id) ?? [])}<p class="caption"><span data-leaf-ref="${escape(block.beforeLeafRef)}">原图</span> · <span data-leaf-ref="${escape(block.afterLeafRef)}">标注图</span> · ${escape(block.altText)}</p></div>`;
      break;
    case 'chart':
      body = `<div class="visual-block">${v3Heading(block)}<h4>${escape(block.caption)}</h4>${visualGroup(visualByBlock.get(block.id) ?? [])}${tableHtml(block)}<p class="caption" data-leaf-ref="${escape(block.leafRef)}">${escape(block.altText)}</p></div>`;
      break;
    case 'record-table':
      body = renderRecordTable(block);
      break;
    case 'graph':
      body = renderGraph(block);
      break;
    case 'priority-board':
      body = renderPriorityBoard(block);
      break;
  }
  return wrapV3Block(block, body);
}

function copyAttributes(fragment: ReportEditorialCopyFragmentV4): string {
  return `data-copy-fragment-id="${escape(fragment.id)}" data-copy-provenance="${escape(fragment.provenance)}" data-source-leaf-ids="${escape(fragment.sourceLeafIds.join(' '))}"`;
}

function renderCopy(fragment: ReportEditorialCopyFragmentV4, className: string): string {
  return `<p class="${className}" ${copyAttributes(fragment)}>${escape(fragment.text)}</p>`;
}

function renderCardGrid(block: Extract<ReportBlockV4, { type: 'card-grid' }>): string {
  return `<ul class="card-grid">${block.cards.map((card) => `<li class="report-card" data-card-id="${escape(card.id)}" data-leaf-refs="${escape(card.leafRefs.join(' '))}">${card.status ? `<span class="card-status">${escape(card.status)}</span>` : ''}<h4>${escape(card.title)}</h4>${card.body ? `<p>${escape(card.body)}</p>` : ''}</li>`).join('')}</ul>`;
}

function renderStageFlow(block: Extract<ReportBlockV4, { type: 'stage-flow' }>): string {
  return `<ol class="stage-flow">${block.stages.map((stage) => `<li class="stage" data-stage-id="${escape(stage.id)}" data-leaf-refs="${escape(stage.leafRefs.join(' '))}">${stage.timeLabel ? `<span class="stage-time">${escape(stage.timeLabel)}</span>` : ''}<h4>${escape(stage.label)}</h4>${stage.description ? `<p>${escape(stage.description)}</p>` : ''}</li>`).join('')}</ol>`;
}

function renderV4Block(
  block: ReportBlockV4,
  visualByBlock: ReadonlyMap<string, ZeroHtmlPlaceholder[]>,
): string {
  const digest = block.digest ? renderCopy(block.digest, 'block-digest') : '';
  if (block.type !== 'card-grid' && block.type !== 'stage-flow') {
    return `${digest}${renderV3Block(block, visualByBlock)}`;
  }
  const heading = block.title ? `<h3>${escape(block.title)}</h3>` : '';
  const body = block.type === 'card-grid' ? renderCardGrid(block) : renderStageFlow(block);
  return `${digest}<article class="v3-block v4-block ${escape(block.type)} visibility-${escape(block.visibility)}" data-ai-alt="${escape(block.id)}" data-unit-refs="${escape(block.unitRefs.join(' '))}">${heading}${body}</article>`;
}

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

function renderNotice(notice: ReportNoticeV1): string {
  return `<li data-notice-id="${escape(notice.id)}">${escape(NOTICE_TEXT[notice.code])}</li>`;
}

function renderNotices(notices: readonly string[]): string {
  if (notices.length === 0) return '';
  return `<aside class="notices" data-ai-alt="report-notices"><h2>生成说明</h2><ul>${notices.join('')}</ul></aside>`;
}

function renderAuditRecord(record: ReportAuditAppendixV1['records'][number]): string {
  return `<tr data-audit-record-id="${escape(record.id)}"><td>${escape(record.sourceUnitKey)}</td><td>${escape(record.disposition)}</td><td>${escape(record.canonicalNodeIds.join('、') || '—')}</td><td>${escape(record.reasonCode ?? '—')}</td></tr>`;
}

function renderAuditAppendix(rows: readonly string[]): string {
  if (rows.length === 0) return '';
  return `<section class="section audit-appendix" data-ai-alt="audit-appendix"><div class="section-head"><div class="section-no">AUDIT APPENDIX</div><h2>分析审计附录</h2></div><table class="data-table"><thead><tr><th>来源单元</th><th>处理结果</th><th>Canonical 映射</th><th>说明</th></tr></thead><tbody>${rows.join('')}</tbody></table></section>`;
}

const STYLE = `
*{box-sizing:border-box}html,body{margin:0;padding:0;background:#e9e8e4;color:#171717;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",Arial,sans-serif}.page{width:1440px;background:#f8f7f4;padding:72px 88px 64px}.hero{background:#151515;color:#f7f5f1;border-radius:24px;padding:56px 64px;border-left:12px solid #e1251b}.hero .kicker{font-size:14px;font-weight:700;letter-spacing:2px;color:#ff5b50}.hero h1{font-size:48px;line-height:1.18;margin:18px 0}.hero p{font-size:20px;line-height:1.65;color:#c9c5bd;max-width:1040px}.summary{margin-top:22px;padding:18px 20px;border-radius:14px;background:#262626;color:#eee9e1;font-size:15px;line-height:1.7}.section{margin-top:52px}.section-head{border-bottom:1px solid #cbc8c1;padding-bottom:14px;margin-bottom:22px}.section-no{font-size:12px;font-weight:800;letter-spacing:1.5px;color:#e1251b}.section h2{font-size:30px;line-height:1.3;margin:7px 0 0}.blocks{display:grid;gap:16px}.paragraph,.list,.fact,.visual-block,.v3-block,.notices{background:#fff;border:1px solid #ddd9d2;border-radius:16px;padding:22px 24px;margin:0;font-size:14px;line-height:1.8}.list{padding-left:44px}.list li{margin:8px 0}.metric{background:#fff;border:1px solid #ddd9d2;border-radius:16px;padding:22px 24px;display:flex;justify-content:space-between;align-items:center}.metric span{font-size:14px;color:#67625b}.metric strong{font-size:32px}.metric small{font-size:14px;margin-left:6px}.fact{border-left:4px solid #e1251b}.fact span{font-size:11px;font-weight:800;color:#e1251b}.fact p{margin:8px 0 0}.v3-block.visibility-collapsible:before{content:"详细内容·静态展开";display:block;margin-bottom:10px;font-size:11px;font-weight:800;color:#746f67}.visual-block h3,.v3-block h3{font-size:20px;margin:0 0 16px}.visual-block h4{font-size:16px;margin:0 0 14px}.visual-stack{display:grid;gap:16px}.visual-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.visual-card{margin:0;padding:14px;background:#f3f1ec;border-radius:14px}.visual-label{font-size:13px;font-weight:700;margin-bottom:10px}.visual-placeholder{height:900px;background:#d9d9d9;border:1px solid #cbc7bf;border-radius:10px}.visual-placeholder.chart{height:620px}.visual-card figcaption,.caption{font-size:12px;color:#746f67;line-height:1.6;margin:10px 0 0}.visual-empty{padding:30px;background:#f0eee9;border-radius:12px;color:#777}.data-table{width:100%;border-collapse:collapse;margin-top:18px}.data-table caption{text-align:left;font-size:17px;font-weight:700;margin-bottom:10px}.data-table th,.data-table td{border-bottom:1px solid #ddd9d2;padding:12px;text-align:left;font-size:12px}.graph-nodes,.graph-edges{display:grid;gap:10px;list-style:none;padding:0}.graph-nodes{grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}.graph-node{padding:16px;background:#f3f1ec;border-top:4px solid #e1251b}.graph-node p{margin:6px 0 0}.priority-board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.priority-group{padding:16px;background:#f3f1ec;border-top:5px solid #444}.priority-p0{border-color:#e1251b}.priority-group ol{padding-left:20px}.notices{margin-top:24px;background:#eeeae2}.notices h2{font-size:16px;margin:0}.footer{margin-top:56px;padding-top:22px;border-top:1px solid #cbc8c1;color:#77736c;font-size:12px}
`;

const V4_STYLE = `
.block-digest,.section-lead,.section-transition{margin:0;padding:14px 18px;background:#eeeae2;border-radius:12px}.section-transition{margin-top:16px}.card-grid,.stage-flow{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0;padding:0;list-style:none}.report-card,.stage{padding:18px;background:#f3f1ec;border-top:4px solid #e1251b}.report-card h4,.stage h4{margin:6px 0}.report-card p,.stage p{margin:6px 0 0}.card-status,.stage-time{font-size:11px;font-weight:800;color:#e1251b}
`;

function v3RenderManifest(input: {
  document: ReportDocumentV3;
  semantics: ReportSemanticManifestV1;
  sourceReportDocumentContentSha256?: string;
}): ReportRenderManifestV1 | undefined {
  if (input.sourceReportDocumentContentSha256 === undefined) return undefined;
  const manifest = createReportRenderManifestV1({
    renderer: 'zero',
    rendererVersion: ZERO_REPORT_TEMPLATE_VERSION,
    sourceReportDocumentContentSha256: input.sourceReportDocumentContentSha256,
    document: input.document,
    semantics: input.semantics,
  });
  return manifest;
}

function v4RenderManifest(input: {
  document: ReportDocumentV4;
  semantics: ReportSemanticManifestV2;
  sourceReportDocumentContentSha256?: string;
}): ReportRenderManifestV2 | undefined {
  if (input.sourceReportDocumentContentSha256 === undefined) return undefined;
  return createReportRenderManifestV2({
    renderer: 'zero',
    rendererVersion: ZERO_REPORT_TEMPLATE_VERSION,
    sourceReportDocumentContentSha256: input.sourceReportDocumentContentSha256,
    document: input.document,
    semantics: input.semantics,
  });
}

export function renderZeroReport(input: {
  document: RenderableReportDocument;
  publicationId: string;
  visuals: readonly ZeroVisualPlacement[];
  sourceReportDocumentContentSha256?: string;
}): ZeroHtmlDraft {
  const prepared = placeholders({
    publicationId: input.publicationId,
    visuals: input.visuals,
    knownBlocks: blockIds(input.document),
  });
  const visualByBlock = new Map<string, ZeroHtmlPlaceholder[]>();
  for (const placeholder of prepared) {
    const list = visualByBlock.get(placeholder.blockId) ?? [];
    list.push(placeholder);
    visualByBlock.set(placeholder.blockId, list);
  }

  let sections: string;
  let notices = '';
  let auditAppendix = '';
  let renderManifest: ReportRenderManifestV1 | ReportRenderManifestV2 | undefined;
  if (isReportDocumentV4(input.document)) {
    const traversal = visitReportDocumentV4(input.document, {
      visitBlock(block) {
        return renderV4Block(block, visualByBlock);
      },
      visitSection(section, blocks, index) {
        const lead = section.lead ? renderCopy(section.lead, 'section-lead') : '';
        const transition = section.transition ? renderCopy(section.transition, 'section-transition') : '';
        return `<section class="section" data-ai-alt="${escape(section.title.text)}" data-view="${escape(section.view)}"><div class="section-head"><div class="section-no">${String(index + 1).padStart(2, '0')} · ${escape(section.view.toUpperCase())}</div><h2 ${copyAttributes(section.title)}>${escape(section.title.text)}</h2></div>${lead}<div class="blocks">${blocks.join('')}</div>${transition}</section>`;
      },
      visitNotice(notice) {
        return renderNotice(notice);
      },
      visitAuditRecord(record) {
        return renderAuditRecord(record);
      },
    });
    sections = traversal.sections.join('');
    notices = renderNotices(traversal.notices);
    auditAppendix = renderAuditAppendix(traversal.auditRecords);
    renderManifest = v4RenderManifest({
      document: input.document,
      semantics: traversal.semantics,
      ...(input.sourceReportDocumentContentSha256 === undefined
        ? {}
        : { sourceReportDocumentContentSha256: input.sourceReportDocumentContentSha256 }),
    });
  } else if (isReportDocumentV3(input.document)) {
    const traversal = visitReportDocumentV3(input.document, {
      visitBlock(block) {
        return renderV3Block(block, visualByBlock);
      },
      visitSection(section, blocks, index) {
        return `<section class="section" data-ai-alt="${escape(section.title)}" data-view="${escape(section.view)}"><div class="section-head"><div class="section-no">${String(index + 1).padStart(2, '0')} · ${escape(section.view.toUpperCase())}</div><h2>${escape(section.title)}</h2></div><div class="blocks">${blocks.join('')}</div></section>`;
      },
      visitNotice(notice) {
        return renderNotice(notice);
      },
      visitAuditRecord(record) {
        return renderAuditRecord(record);
      },
    });
    sections = traversal.sections.join('');
    notices = renderNotices(traversal.notices);
    auditAppendix = renderAuditAppendix(traversal.auditRecords);
    renderManifest = v3RenderManifest({
      document: input.document,
      semantics: traversal.semantics,
      ...(input.sourceReportDocumentContentSha256 === undefined
        ? {}
        : { sourceReportDocumentContentSha256: input.sourceReportDocumentContentSha256 }),
    });
  } else {
    sections = input.document.sections.map((section, index) => `<section class="section" data-ai-alt="${escape(section.title)}"><div class="section-head"><div class="section-no">${String(index + 1).padStart(2, '0')} · REPORT SECTION</div><h2>${escape(section.title)}</h2></div><div class="blocks">${section.blocks.map((block) => renderLegacyBlock(block, visualByBlock)).join('')}</div></section>`).join('');
  }

  const title = isReportDocumentV4(input.document) ? input.document.title.text : input.document.title;
  const executiveSummary = isReportDocumentV4(input.document)
    ? input.document.executiveSummary.text
    : input.document.executiveSummary;
  const titleCopyAttributes = isReportDocumentV4(input.document)
    ? ` ${copyAttributes(input.document.title)}`
    : '';
  const summaryCopyAttributes = isReportDocumentV4(input.document)
    ? ` ${copyAttributes(input.document.executiveSummary)}`
    : '';
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"/><title>${escape(title)}</title><style>${STYLE}${V4_STYLE}</style></head><body><main class="page" data-ai-alt="Zero研究报告"><header class="hero" data-ai-alt="报告封面"><div class="kicker">AI RESEARCH REPORT</div><h1${titleCopyAttributes}>${escape(title)}</h1><p>${escape(input.document.subtitle)}</p><div class="summary"${summaryCopyAttributes}>${escape(executiveSummary)}</div></header>${notices}${sections}${auditAppendix}<footer class="footer">${escape(title)} · ${escape(ZERO_REPORT_TEMPLATE_VERSION)}</footer></main></body></html>`;
  if (html.length >= MAX_HTML_CHARS) throw new Error('Zero report HTML exceeds 500000 characters');
  return {
    html,
    name: title,
    templateVersion: ZERO_REPORT_TEMPLATE_VERSION,
    expectedWidth: 1440,
    expectedMinimumHeight: 800
      + input.document.sections.length * 420
      + prepared.length * 460
      + ((isReportDocumentV3(input.document) || isReportDocumentV4(input.document))
        && input.document.auditAppendix ? 420 : 0),
    placeholders: prepared,
    ...(renderManifest === undefined ? {} : { renderManifest }),
  };
}
