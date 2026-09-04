import type {
  ReportBlock,
  ReportResult,
  ReportSource,
} from '../../../../packages/api-contract/skill-native.ts';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeSourceUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function safeArtifactUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(url) ? url : null;
}

function markdownTableCell(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/\r\n?|\n/gu, '<br>');
}

function sourceMarks(ids: readonly string[] | undefined, sources: ReadonlyMap<string, ReportSource>): string {
  const valid = [...new Set(ids ?? [])].filter((id) => sources.has(id));
  if (valid.length === 0) return '';
  return `<span class="source-marks">${valid.map((id) => `<a href="#source-${escapeHtml(id)}">[${escapeHtml(id)}]</a>`).join(' ')}</span>`;
}

function renderBlock(
  block: ReportBlock,
  sources: ReadonlyMap<string, ReportSource>,
  artifactUrl: (artifactId: string) => string | null,
): string {
  const marks = sourceMarks(block.sourceIds, sources);
  if (block.type === 'text') return `<p>${escapeHtml(block.text)}${marks}</p>`;
  if (block.type === 'list') {
    return `<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>${marks}`;
  }
  if (block.type === 'table') {
    const columns = `<tr>${block.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr>`;
    const rows = block.rows.map((row) => (
      `<tr>${block.columns.map((_, index) => `<td>${escapeHtml(row[index] ?? '')}</td>`).join('')}</tr>`
    )).join('');
    return `<div class="table-scroll"><table><thead>${columns}</thead><tbody>${rows}</tbody></table></div>${marks}`;
  }
  const url = safeArtifactUrl(artifactUrl(block.artifactId));
  if (!url) {
    return `<p class="image-gap">图片不可用：${escapeHtml(block.alt)}</p>${marks}`;
  }
  return `<figure><img src="${escapeHtml(url)}" alt="${escapeHtml(block.alt)}" loading="lazy">${block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ''}</figure>${marks}`;
}

export function renderReportHtml(
  report: ReportResult,
  options: { artifactUrl?: (artifactId: string) => string | null } = {},
): string {
  const sources = new Map(report.sources.map((source) => [source.id, source]));
  const artifactUrl = options.artifactUrl ?? (() => null);
  const toc = report.sections.map((section) => (
    `<li><a href="#section-${escapeHtml(section.id)}">${escapeHtml(section.title)}</a></li>`
  )).join('');
  const sections = report.sections.map((section) => (
    `<section id="section-${escapeHtml(section.id)}"><h2>${escapeHtml(section.title)}</h2>${section.blocks.map((block) => renderBlock(block, sources, artifactUrl)).join('')}</section>`
  )).join('');
  const gaps = report.gaps.length === 0 ? '' : `<section class="gaps"><h2>信息缺口</h2><ul>${report.gaps.map((gap) => `<li>${escapeHtml(gap.message)}</li>`).join('')}</ul></section>`;
  const sourceList = report.sources.length === 0 ? '' : `<section><h2>来源</h2><ol class="sources">${report.sources.map((source) => {
    const url = safeSourceUrl(source.url);
    const label = escapeHtml(source.label);
    return `<li id="source-${escapeHtml(source.id)}"><code>${escapeHtml(source.id)}</code> ${url ? `<a href="${escapeHtml(url)}" rel="noreferrer">${label}</a>` : label}</li>`;
  }).join('')}</ol></section>`;
  const statusLabel = report.status === 'complete' ? '完整' : report.status === 'partial' ? '部分完成' : '失败';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(report.title)}</title>
<style>
:root{color-scheme:light;--ink:#18201d;--muted:#5e6964;--line:#dfe5e1;--paper:#fff;--soft:#f4f7f5;--accent:#176b52}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--soft);color:var(--ink);font:16px/1.72 system-ui,-apple-system,"Segoe UI",sans-serif}.layout{display:grid;grid-template-columns:220px minmax(0,960px);gap:36px;justify-content:center;padding:40px 24px}.toc{position:sticky;top:24px;align-self:start;font-size:13px}.toc ol{padding-left:20px}.toc a,.sources a,.source-marks a{color:var(--accent);text-decoration:none}.report{background:var(--paper);padding:56px 64px;border:1px solid var(--line);border-radius:18px;box-shadow:0 12px 36px rgba(26,42,35,.08)}h1{font-size:36px;line-height:1.2;margin:0 0 16px}h2{font-size:22px;margin:42px 0 14px;padding-top:4px;border-top:1px solid var(--line)}.summary{font-size:18px;color:var(--muted)}.status{display:inline-block;padding:3px 9px;border-radius:999px;background:var(--soft);font-size:12px;font-weight:700}.status-partial{color:#8a5a00;background:#fff3cf}.status-failed{color:#a12929;background:#ffe8e8}.source-marks{margin-left:6px;font-size:11px;white-space:nowrap}.table-scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}th{background:var(--soft)}figure{margin:24px 0}img{display:block;max-width:100%;height:auto}figcaption,.sources,.image-gap{color:var(--muted);font-size:13px}.gaps{border:1px solid #ead59c;background:#fffaf0;padding:0 20px 14px;border-radius:12px}.gaps h2{margin-top:20px;border:0}
@media(max-width:800px){.layout{display:block;padding:0}.toc{position:static;padding:18px 20px}.report{border:0;border-radius:0;padding:32px 20px;box-shadow:none}h1{font-size:29px}}
@page{size:A4;margin:16mm}@media print{body{background:#fff}.layout{display:block;padding:0}.toc{position:static;page-break-after:always}.report{border:0;box-shadow:none;padding:0;max-width:none}a{color:inherit;text-decoration:none}section,figure,table{break-inside:avoid}.table-scroll{overflow:visible}table{font-size:10pt}}
</style>
</head>
<body><div class="layout"><nav class="toc" aria-label="目录"><strong>目录</strong><ol>${toc}</ol></nav><main class="report"><header><span class="status status-${report.status}">${statusLabel}</span><h1>${escapeHtml(report.title)}</h1><p class="summary">${escapeHtml(report.summary)}</p></header>${sections}${gaps}${sourceList}</main></div></body>
</html>`;
}

export function renderReportMarkdown(
  report: ReportResult,
  options: { artifactUrl?: (artifactId: string) => string | null } = {},
): string {
  const artifactUrl = options.artifactUrl ?? (() => null);
  const lines = [`# ${report.title}`, '', report.summary, '', `状态：${report.status}`];
  for (const section of report.sections) {
    lines.push('', `## ${section.title}`, '');
    for (const block of section.blocks) {
      if (block.type === 'text') lines.push(block.text, '');
      else if (block.type === 'list') lines.push(...block.items.map((item) => `- ${item}`), '');
      else if (block.type === 'table') {
        lines.push(`| ${block.columns.map(markdownTableCell).join(' | ')} |`);
        lines.push(`| ${block.columns.map(() => '---').join(' | ')} |`);
        lines.push(...block.rows.map((row) => `| ${block.columns.map((_, index) => markdownTableCell(row[index] ?? '')).join(' | ')} |`), '');
      } else {
        const url = safeArtifactUrl(artifactUrl(block.artifactId));
        lines.push(
          url ? `![${block.alt}](${url})` : `图片不可用：${block.alt}`,
          block.caption ?? '',
          '',
        );
      }
    }
  }
  if (report.gaps.length > 0) lines.push('', '## 信息缺口', '', ...report.gaps.map((gap) => `- ${gap.message}`));
  if (report.sources.length > 0) lines.push('', '## 来源', '', ...report.sources.map((source) => `- [${source.id}] ${source.label}${source.url ? ` ${source.url}` : ''}`));
  return `${lines.join('\n').trim()}\n`;
}
