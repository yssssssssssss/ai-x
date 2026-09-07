import { strToU8, zipSync } from 'fflate';

import {
  parseNativeReportDocument,
  type NativeReportBlock,
  type NativeReportDocumentV1,
  type SourceReference,
} from '../../../../packages/api-contract/native-skill-orchestration.ts';

const MAX_RENDERED_HTML_BYTES = 5 * 1024 * 1024;
const ZIP_TIMESTAMP = new Date('1980-01-01T00:00:00.000Z');

export class NativeReportRenderError extends Error {
  constructor(message: string) {
    super(`native report rendering failed: ${message}`);
    this.name = 'NativeReportRenderError';
  }
}

export interface NativeReportRenderInput {
  document: NativeReportDocumentV1;
  sources: readonly SourceReference[];
  gaps: readonly string[];
  assetUrl(assetId: string): string;
}

export interface NativeReportBundleAsset {
  assetId: string;
  fileName: string;
  bytes: Uint8Array;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sourceIdsFor(document: NativeReportDocumentV1): string[] {
  return document.tabs.flatMap(({ sections }) => sections.flatMap(({ blocks }) => (
    blocks.flatMap(({ sourceIds }) => sourceIds)
  )));
}

function assertBindings(
  document: NativeReportDocumentV1,
  sources: readonly SourceReference[],
): Map<string, SourceReference> {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const unknownSource = sourceIdsFor(document).find((id) => !sourceById.has(id));
  if (unknownSource) throw new NativeReportRenderError(`unknown Source ID ${unknownSource}`);
  const assets = new Set(document.assetIds);
  const unknownAsset = document.tabs.flatMap(({ sections }) => sections.flatMap(({ blocks }) => (
    blocks.flatMap((block) => block.type === 'image' ? [block.assetId] : [])
  ))).find((assetId) => !assets.has(assetId));
  if (unknownAsset) throw new NativeReportRenderError(`unknown Asset ID ${unknownAsset}`);
  return sourceById;
}

function sourceNumber(sourceById: ReadonlyMap<string, SourceReference>, id: string): number {
  const index = [...sourceById.keys()].indexOf(id);
  if (index < 0) throw new NativeReportRenderError(`unknown Source ID ${id}`);
  return index + 1;
}

function sourceMarks(ids: readonly string[], sourceById: ReadonlyMap<string, SourceReference>): string {
  if (ids.length === 0) return '';
  return `<div class="source-marks">${ids.map((id) => `<span>[${sourceNumber(sourceById, id)}]</span>`).join('')}</div>`;
}

function renderInline(value: string, sourceById: ReadonlyMap<string, SourceReference>): string {
  return escapeHtml(value)
    .replace(/\[(S-[A-Za-z0-9._:-]+)\]/gu, (_full, id: string) => (
      `<span class="citation">[${sourceNumber(sourceById, id)}]</span>`
    ))
    .replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
    .replace(/`([^`]+)`/gu, '<code>$1</code>');
}

function renderMarkdown(markdown: string, sourceById: ReadonlyMap<string, SourceReference>): string {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const output: string[] = [];
  let listOpen = false;
  let paragraph: string[] = [];
  const closeParagraph = (): void => {
    if (paragraph.length === 0) return;
    output.push(`<p>${renderInline(paragraph.join(' '), sourceById)}</p>`);
    paragraph = [];
  };
  const closeList = (): void => {
    if (!listOpen) return;
    output.push('</ul>');
    listOpen = false;
  };
  for (const line of lines) {
    const heading = /^(#{1,4})\s+(.+)$/u.exec(line);
    if (heading) {
      closeParagraph();
      closeList();
      const level = Math.min(4, heading[1]!.length + 2);
      output.push(`<h${level}>${renderInline(heading[2]!, sourceById)}</h${level}>`);
      continue;
    }
    const item = /^[-*]\s+(.+)$/u.exec(line);
    if (item) {
      closeParagraph();
      if (!listOpen) {
        output.push('<ul>');
        listOpen = true;
      }
      output.push(`<li>${renderInline(item[1]!, sourceById)}</li>`);
      continue;
    }
    const quote = /^>\s?(.*)$/u.exec(line);
    if (quote) {
      closeParagraph();
      closeList();
      output.push(`<blockquote>${renderInline(quote[1]!, sourceById)}</blockquote>`);
      continue;
    }
    if (!line.trim()) {
      closeParagraph();
      closeList();
      continue;
    }
    paragraph.push(line.trim());
  }
  closeParagraph();
  closeList();
  return output.join('\n');
}

function renderBlock(
  block: NativeReportBlock,
  sourceById: ReadonlyMap<string, SourceReference>,
  assetUrl: NativeReportRenderInput['assetUrl'],
): string {
  let content: string;
  if (block.type === 'markdown') {
    content = `<div class="prose">${renderMarkdown(block.content, sourceById)}</div>`;
  } else if (block.type === 'table') {
    content = `<div class="table-wrap"><table><thead><tr>${block.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  } else if (block.type === 'metric-group') {
    content = `<div class="metrics">${block.metrics.map((metric) => `<article class="metric"><strong>${escapeHtml(metric.value)}</strong><span>${escapeHtml(metric.label)}</span>${metric.note ? `<small>${escapeHtml(metric.note)}</small>` : ''}</article>`).join('')}</div>`;
  } else if (block.type === 'image') {
    const url = assetUrl(block.assetId);
    if (!url || /^(?:data|javascript):/iu.test(url)) throw new NativeReportRenderError(`unsafe Asset URL for ${block.assetId}`);
    content = `<figure class="image ${block.display}"><img src="${escapeHtml(url)}" alt="${escapeHtml(block.altText)}"><figcaption>${escapeHtml(block.caption)}</figcaption></figure>`;
  } else if (block.type === 'quadrant') {
    content = `<div class="quadrant" aria-label="${escapeHtml(`${block.xAxis} 与 ${block.yAxis}`)}"><span class="axis axis-x">${escapeHtml(block.xAxis)}</span><span class="axis axis-y">${escapeHtml(block.yAxis)}</span>${block.points.map((point) => `<span class="point" style="left:${point.x}%;bottom:${point.y}%">${escapeHtml(point.label)}</span>`).join('')}</div>`;
  } else if (block.type === 'timeline') {
    content = `<ol class="timeline">${block.items.map((item) => `<li>${item.tag ? `<span class="tag">${escapeHtml(item.tag)}</span>` : ''}<strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.description)}</p></li>`).join('')}</ol>`;
  } else {
    content = `<article class="wireframe"><h4>${escapeHtml(block.title)}</h4>${block.elements.map((element) => `<div><strong>${escapeHtml(element.label)}</strong>${element.description ? `<span>${escapeHtml(element.description)}</span>` : ''}</div>`).join('')}</article>`;
  }
  return `<div class="report-block">${content}${sourceMarks(block.sourceIds, sourceById)}</div>`;
}

function renderSummary(document: NativeReportDocumentV1): string {
  if (!document.summary) return '';
  return `<section class="summary"><p class="conclusion">${escapeHtml(document.summary.conclusion)}</p><div><h2>关键发现</h2><ul>${document.summary.findings.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div><div><h2>建议行动</h2><ul>${document.summary.actions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div></section>`;
}

function renderAppendices(sources: readonly SourceReference[], gaps: readonly string[]): string {
  const sourceItems = sources.map((source) => {
    const title = source.url
      ? `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title)}</a>`
      : escapeHtml(source.title);
    return `<li>${title}</li>`;
  }).join('');
  const gapItems = gaps.map((gap) => `<li>${escapeHtml(gap)}</li>`).join('');
  return `${sourceItems ? `<section class="appendix"><h2>来源</h2><ul>${sourceItems}</ul></section>` : ''}${gapItems ? `<section class="appendix"><h2>资料缺口</h2><ul>${gapItems}</ul></section>` : ''}`;
}

function styles(tabCount: number): string {
  const activeLabels = Array.from({ length: tabCount }, (_, index) => (
    `.tab-radio:nth-of-type(${index + 1}):checked~.tab-labels label:nth-child(${index + 1})`
  )).join(',');
  const activePanels = Array.from({ length: tabCount }, (_, index) => (
    `.tab-radio:nth-of-type(${index + 1}):checked~.panels .tab-panel:nth-child(${index + 1})`
  )).join(',');
  return `:root{color-scheme:light;--bg:#f4f1ec;--card:#fff;--ink:#171717;--muted:#6b665f;--line:#ddd5ca;--accent:#c9342f;--soft:#f7f4ef}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1180px;margin:32px auto;padding:32px}.hero{padding:32px;border-radius:20px;background:#1d1d1d;color:#fff}.hero h1{margin:0;font-size:2.25rem;line-height:1.2}.hero p{margin:.7rem 0 0;color:#d7d2cb}.summary{display:grid;grid-template-columns:2fr 1fr 1fr;gap:16px;margin:20px 0}.summary>div,.conclusion{margin:0;padding:18px;border:1px solid var(--line);border-radius:14px;background:var(--card)}.summary h2{margin:0 0 8px;font-size:1rem}.summary ul{margin:0;padding-left:20px}.tabs{margin-top:20px}.tab-radio{position:absolute;opacity:0;pointer-events:none}.tab-labels{display:flex;gap:8px;overflow:auto;padding-bottom:8px}.tab-label{padding:9px 14px;border:1px solid var(--line);border-radius:999px;background:var(--card);white-space:nowrap;cursor:pointer}.tab-panel{display:none}${activeLabels}{background:var(--ink);color:#fff}${activePanels}{display:block}.section{margin:18px 0;padding:24px;border:1px solid var(--line);border-radius:16px;background:var(--card)}.section h2{margin:0 0 14px;font-size:1.35rem}.report-block+.report-block{margin-top:18px}.prose h3,.prose h4{margin:1.3rem 0 .5rem}.prose p{margin:.6rem 0}.prose blockquote{margin:1rem 0;padding:.7rem 1rem;border-left:4px solid var(--accent);background:var(--soft);color:var(--muted)}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:.92rem}th,td{padding:10px 12px;border:1px solid var(--line);text-align:left;vertical-align:top}th{background:var(--soft)}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.metric{display:flex;flex-direction:column;padding:16px;border-radius:12px;background:var(--soft)}.metric strong{font-size:1.7rem;color:var(--accent)}.metric small{color:var(--muted)}figure{margin:0}.image img{display:block;max-width:100%;height:auto;margin:auto;border:1px solid var(--line);border-radius:12px}.image.phone-frame img{max-height:640px;border:10px solid #202020;border-radius:24px}.image.thumbnail img{max-height:300px}.image figcaption{margin-top:7px;text-align:center;color:var(--muted);font-size:.86rem}.quadrant{position:relative;min-height:380px;margin:30px 20px 24px 40px;border-left:2px solid var(--ink);border-bottom:2px solid var(--ink);background:linear-gradient(90deg,transparent 49.8%,var(--line) 50%,transparent 50.2%),linear-gradient(0deg,transparent 49.8%,var(--line) 50%,transparent 50.2%)}.point{position:absolute;transform:translate(-50%,50%);padding:4px 8px;border-radius:999px;background:var(--accent);color:#fff;font-size:.78rem;white-space:nowrap}.axis{position:absolute;color:var(--muted);font-size:.8rem}.axis-x{right:0;bottom:-26px}.axis-y{left:-35px;top:0;writing-mode:vertical-rl}.timeline{list-style:none;margin:0;padding:0}.timeline li{position:relative;margin-left:8px;padding:0 0 20px 24px;border-left:2px solid var(--line)}.timeline li:before{content:"";position:absolute;left:-6px;top:5px;width:10px;height:10px;border-radius:50%;background:var(--accent)}.timeline p{margin:4px 0;color:var(--muted)}.tag{margin-right:8px;padding:2px 7px;border-radius:99px;background:var(--soft);font-size:.75rem}.wireframe{padding:16px;border:1px dashed #8a8277;border-radius:14px;background:#faf9f7}.wireframe>div{display:flex;gap:12px;margin-top:8px;padding:12px;border:1px solid var(--line);background:#fff}.wireframe span{color:var(--muted)}.source-marks{display:flex;gap:6px;margin-top:8px;color:var(--accent);font-size:.78rem}.appendix{margin-top:20px;padding:20px;border:1px solid var(--line);border-radius:14px;background:var(--card)}.citation{color:var(--accent);font-weight:650}@media(max-width:760px){main{padding:16px}.summary{grid-template-columns:1fr}.hero{padding:24px}.section{padding:18px}}@media print{body{background:#fff}main{max-width:none;margin:0;padding:0}.hero{color:#000;background:#fff;border:1px solid var(--line)}.tab-labels,.tab-radio{display:none!important}.tab-panel{display:block!important;break-before:page}.section{break-inside:avoid;box-shadow:none}}`;
}

export function renderNativeReportDocumentHtml(input: NativeReportRenderInput): string {
  const document = parseNativeReportDocument(input.document);
  const sourceById = assertBindings(document, input.sources);
  const controls = document.tabs.map((tab, index) => (
    `<input class="tab-radio" type="radio" name="native-report-tabs" id="tab-${escapeHtml(tab.id)}"${index === 0 ? ' checked' : ''}>`
  )).join('');
  const labels = document.tabs.map((tab) => (
    `<label class="tab-label" for="tab-${escapeHtml(tab.id)}">${escapeHtml(tab.title)}</label>`
  )).join('');
  const panels = document.tabs.map((tab) => (
    `<section class="tab-panel" id="panel-${escapeHtml(tab.id)}"><h2>${escapeHtml(tab.title)}</h2>${tab.sections.map((section) => `<section class="section" id="section-${escapeHtml(section.id)}"><h2>${escapeHtml(section.title)}</h2>${section.blocks.map((block) => renderBlock(block, sourceById, input.assetUrl)).join('')}</section>`).join('')}</section>`
  )).join('');
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'none'; script-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(document.title)}</title>
<style>${styles(document.tabs.length)}</style>
</head>
<body><main data-report-version="${document.version}"><header class="hero"><h1>${escapeHtml(document.title)}</h1>${document.subtitle ? `<p>${escapeHtml(document.subtitle)}</p>` : ''}</header>${renderSummary(document)}<div class="tabs">${controls}<nav class="tab-labels" aria-label="报告章节">${labels}</nav><div class="panels">${panels}</div></div>${renderAppendices(input.sources, input.gaps)}</main></body>
</html>`;
  if (Buffer.byteLength(html, 'utf8') > MAX_RENDERED_HTML_BYTES) {
    throw new NativeReportRenderError('rendered HTML exceeds 5 MiB');
  }
  return html;
}

function safeBundleName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new NativeReportRenderError(`unsafe bundle asset file name ${value}`);
  }
  return value;
}

export function renderNativeReportBundle(input: {
  document: NativeReportDocumentV1;
  sources: readonly SourceReference[];
  gaps: readonly string[];
  assets: readonly NativeReportBundleAsset[];
}): Uint8Array {
  const byId = new Map(input.assets.map((asset) => [asset.assetId, asset]));
  if (byId.size !== input.assets.length) throw new NativeReportRenderError('bundle Asset ID is duplicated');
  const document = parseNativeReportDocument(input.document);
  const missing = document.assetIds.find((assetId) => !byId.has(assetId));
  if (missing) throw new NativeReportRenderError(`bundle Asset ${missing} is unavailable`);
  const html = renderNativeReportDocumentHtml({
    document,
    sources: input.sources,
    gaps: input.gaps,
    assetUrl(assetId) {
      return `assets/${safeBundleName(byId.get(assetId)!.fileName)}`;
    },
  });
  const entries: Record<string, Uint8Array> = { 'index.html': strToU8(html) };
  for (const asset of [...input.assets].sort((left, right) => left.fileName.localeCompare(right.fileName))) {
    const path = `assets/${safeBundleName(asset.fileName)}`;
    if (entries[path]) throw new NativeReportRenderError(`bundle Asset path ${path} is duplicated`);
    entries[path] = new Uint8Array(asset.bytes);
  }
  return zipSync(entries, { level: 9, mtime: ZIP_TIMESTAMP });
}
