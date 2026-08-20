import type {
  ReportBlock,
  ReportDocument,
} from '../../../../orchestrator-runtime/src/report/report-document-composer.ts';

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
}

function escape(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function blockIds(document: ReportDocument): Set<string> {
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

function tableHtml(block: Extract<ReportBlock, { type: 'chart' }>): string {
  const table = block.table;
  const header = table.columns.map((column) => `<th>${escape(column)}</th>`).join('');
  const rows = table.rows.map((row) => `<tr><th>${escape(row.label)}</th>${row.cells.map((cell) => `<td>${cell == null ? '—' : escape(cell)}</td>`).join('')}</tr>`).join('');
  return `<table class="data-table"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderBlock(
  block: ReportBlock,
  visualByBlock: ReadonlyMap<string, ZeroHtmlPlaceholder[]>,
): string {
  switch (block.type) {
    case 'paragraph':
      return `<p class="paragraph" data-ai-alt="${escape(block.id)}">${escape(block.text)}</p>`;
    case 'list':
      return `<ul class="list" data-ai-alt="${escape(block.id)}">${block.items.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>`;
    case 'metric':
      return `<article class="metric" data-ai-alt="${escape(block.id)}"><span>${escape(block.label)}</span><strong>${escape(block.value)}</strong></article>`;
    case 'fact':
      return `<article class="fact" data-ai-alt="${escape(block.id)}"><span>FACT</span><p>${escape(block.text)}</p></article>`;
    case 'image':
      return `<article class="visual-block" data-ai-alt="${escape(block.id)}"><h3>${escape(block.caption)}</h3>${visualGroup(visualByBlock.get(block.id) ?? [])}<p class="caption">${escape(block.altText)}</p></article>`;
    case 'image-comparison':
      return `<article class="visual-block" data-ai-alt="${escape(block.id)}"><h3>${escape(block.caption)}</h3>${visualGroup(visualByBlock.get(block.id) ?? [])}<p class="caption">${escape(block.altText)}</p></article>`;
    case 'chart':
      return `<article class="visual-block" data-ai-alt="${escape(block.id)}"><h3>${escape(block.caption)}</h3>${visualGroup(visualByBlock.get(block.id) ?? [])}${tableHtml(block)}<p class="caption">${escape(block.altText)}</p></article>`;
  }
}

const STYLE = `
*{box-sizing:border-box}html,body{margin:0;padding:0;background:#e9e8e4;color:#171717;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",Arial,sans-serif}.page{width:1440px;background:#f8f7f4;padding:72px 88px 64px}.hero{background:#151515;color:#f7f5f1;border-radius:24px;padding:56px 64px;border-left:12px solid #e1251b}.hero .kicker{font-size:14px;font-weight:700;letter-spacing:2px;color:#ff5b50}.hero h1{font-size:48px;line-height:1.18;margin:18px 0}.hero p{font-size:20px;line-height:1.65;color:#c9c5bd;max-width:1040px}.summary{margin-top:22px;padding:18px 20px;border-radius:14px;background:#262626;color:#eee9e1;font-size:15px;line-height:1.7}.section{margin-top:52px}.section-head{border-bottom:1px solid #cbc8c1;padding-bottom:14px;margin-bottom:22px}.section-no{font-size:12px;font-weight:800;letter-spacing:1.5px;color:#e1251b}.section h2{font-size:30px;line-height:1.3;margin:7px 0 0}.blocks{display:grid;gap:16px}.paragraph,.list,.fact,.visual-block{background:#fff;border:1px solid #ddd9d2;border-radius:16px;padding:22px 24px;margin:0;font-size:14px;line-height:1.8}.list{padding-left:44px}.list li{margin:8px 0}.metric{background:#fff;border:1px solid #ddd9d2;border-radius:16px;padding:22px 24px;display:flex;justify-content:space-between;align-items:center}.metric span{font-size:14px;color:#67625b}.metric strong{font-size:32px}.fact{border-left:4px solid #e1251b}.fact span{font-size:11px;font-weight:800;color:#e1251b}.fact p{margin:8px 0 0}.visual-block h3{font-size:20px;margin:0 0 16px}.visual-stack{display:grid;gap:16px}.visual-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.visual-card{margin:0;padding:14px;background:#f3f1ec;border-radius:14px}.visual-label{font-size:13px;font-weight:700;margin-bottom:10px}.visual-placeholder{height:900px;background:#d9d9d9;border:1px solid #cbc7bf;border-radius:10px}.visual-placeholder.chart{height:620px}.visual-card figcaption,.caption{font-size:12px;color:#746f67;line-height:1.6;margin:10px 0 0}.visual-empty{padding:30px;background:#f0eee9;border-radius:12px;color:#777}.data-table{width:100%;border-collapse:collapse;margin-top:18px}.data-table th,.data-table td{border-bottom:1px solid #ddd9d2;padding:12px;text-align:left;font-size:12px}.footer{margin-top:56px;padding-top:22px;border-top:1px solid #cbc8c1;color:#77736c;font-size:12px}
`;

export function renderZeroReport(input: {
  document: ReportDocument;
  publicationId: string;
  visuals: readonly ZeroVisualPlacement[];
}): ZeroHtmlDraft {
  const knownBlocks = blockIds(input.document);
  const prepared = placeholders({
    publicationId: input.publicationId,
    visuals: input.visuals,
    knownBlocks,
  });
  const visualByBlock = new Map<string, ZeroHtmlPlaceholder[]>();
  for (const placeholder of prepared) {
    const list = visualByBlock.get(placeholder.blockId) ?? [];
    list.push(placeholder);
    visualByBlock.set(placeholder.blockId, list);
  }
  const sections = input.document.sections.map((section, index) => `<section class="section" data-ai-alt="${escape(section.title)}"><div class="section-head"><div class="section-no">${String(index + 1).padStart(2, '0')} · REPORT SECTION</div><h2>${escape(section.title)}</h2></div><div class="blocks">${section.blocks.map((block) => renderBlock(block, visualByBlock)).join('')}</div></section>`).join('');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"/><title>${escape(input.document.title)}</title><style>${STYLE}</style></head><body><main class="page" data-ai-alt="Zero研究报告"><header class="hero" data-ai-alt="报告封面"><div class="kicker">AI RESEARCH REPORT</div><h1>${escape(input.document.title)}</h1><p>${escape(input.document.subtitle)}</p><div class="summary">${escape(input.document.executiveSummary)}</div></header>${sections}<footer class="footer">${escape(input.document.title)} · ${escape(ZERO_REPORT_TEMPLATE_VERSION)}</footer></main></body></html>`;
  if (html.length >= MAX_HTML_CHARS) throw new Error('Zero report HTML exceeds 500000 characters');
  return {
    html,
    name: input.document.title,
    templateVersion: ZERO_REPORT_TEMPLATE_VERSION,
    expectedWidth: 1440,
    expectedMinimumHeight: 800 + input.document.sections.length * 420 + prepared.length * 460,
    placeholders: prepared,
  };
}
