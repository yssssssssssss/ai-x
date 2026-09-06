import { Marked, Renderer } from 'marked';

const CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeLink(value: string): string | null {
  if (value.startsWith('#')) return value;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function safeImage(value: string): string | null {
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(value) ? value : null;
}

function document(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light;--ink:#18201d;--muted:#5e6964;--line:#dfe5e1;--paper:#fff;--soft:#f4f7f5;--accent:#176b52}*{box-sizing:border-box}body{margin:0;background:var(--soft);color:var(--ink);font:16px/1.72 system-ui,-apple-system,"Segoe UI",sans-serif}.report{max-width:960px;margin:40px auto;background:var(--paper);padding:56px 64px;border:1px solid var(--line);border-radius:18px;box-shadow:0 12px 36px rgba(26,42,35,.08)}h1{font-size:36px;line-height:1.2}h2{font-size:24px;margin-top:42px;border-top:1px solid var(--line);padding-top:18px}h3{font-size:19px;margin-top:30px}a{color:var(--accent)}blockquote{margin-left:0;padding:2px 18px;border-left:4px solid var(--line);color:var(--muted)}pre,code{background:var(--soft);border-radius:6px}code{padding:.12em .35em}pre{padding:16px;overflow:auto}pre code{padding:0}table{border-collapse:collapse;width:100%;display:block;overflow:auto}th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}th{background:var(--soft)}img{max-width:100%;height:auto}hr{border:0;border-top:1px solid var(--line)}
@media(max-width:800px){.report{margin:0;border:0;border-radius:0;padding:32px 20px;box-shadow:none}h1{font-size:29px}}
@page{size:A4;margin:16mm}@media print{body{background:#fff}.report{border:0;box-shadow:none;padding:0;margin:0;max-width:none}a{color:inherit;text-decoration:none}section,figure,table{break-inside:avoid}}
</style>
</head>
<body><main class="report">${body}</main></body>
</html>`;
}

export function renderMarkdownHtml(
  markdown: string,
  title: string,
  options: { artifactUrl?: (artifactId: string) => string | null } = {},
): string {
  const renderer = new Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  renderer.link = function link({ href, title: linkTitle, tokens }) {
    const label = this.parser.parseInline(tokens);
    const safe = safeLink(href);
    if (!safe) return label;
    return `<a href="${escapeHtml(safe)}"${linkTitle ? ` title="${escapeHtml(linkTitle)}"` : ''} rel="noreferrer">${label}</a>`;
  };
  renderer.image = ({ href, title: imageTitle, text }) => {
    const artifactMatch = /^artifact:([^\s]+)$/u.exec(href);
    const resolved = artifactMatch ? options.artifactUrl?.(artifactMatch[1]!) ?? null : href;
    const safe = safeImage(resolved ?? '');
    if (!safe) return `<span>图片不可用：${escapeHtml(text)}</span>`;
    return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(text)}"${imageTitle ? ` title="${escapeHtml(imageTitle)}"` : ''} loading="lazy">`;
  };
  const marked = new Marked({ renderer, gfm: true, breaks: false });
  return document(title, marked.parse(markdown) as string);
}

export function previewHtmlArtifact(html: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
  if (/<head(?:\s[^>]*)?>/iu.test(html)) return html.replace(/<head(?:\s[^>]*)?>/iu, (head) => `${head}${csp}`);
  return `<!doctype html><html><head>${csp}</head><body>${html}</body></html>`;
}
