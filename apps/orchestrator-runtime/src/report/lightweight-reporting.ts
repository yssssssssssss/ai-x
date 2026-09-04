import {
  FINAL_REPORT_VERSION,
  parseFinalReport,
  parseSkillReport,
  type FinalReport,
  type SourceReference,
  type SkillReport,
} from '../../../../packages/api-contract/lightweight-orchestration.ts';
import type { LLMClient } from '../runtime/llm-client.ts';

const CITATION = /\[(S-[A-Za-z0-9._:-]+)\]/gu;
const URL_IN_TEXT = /https?:\/\/[^\s<>)\]]+/gu;
const MARKDOWN_LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

export class LightweightReportError extends Error {
  constructor(message: string) {
    super(`lightweight reporting failed: ${message}`);
    this.name = 'LightweightReportError';
  }
}

export interface MultiSynthesisInput {
  requirement: unknown;
  reports: SkillReport[];
}

export interface MultiReportSynthesizer {
  synthesize(input: MultiSynthesisInput): Promise<string>;
}

export class LlmMultiReportSynthesizer implements MultiReportSynthesizer {
  constructor(
    private readonly llm: LLMClient,
    private readonly receipt: {
      attemptId: string;
      stepNo: number;
      contextManifestHash?: string;
      expectedModel?: string;
    },
  ) {}

  async synthesize(input: MultiSynthesisInput): Promise<string> {
    const result = await this.llm.generateText({
      systemPrompt: [
        '你负责把多个 Skill 的原始 Markdown 报告综合为一份最终 Markdown。',
        '只使用输入报告中的事实、来源 ID 和 URL；不得新增事实、数字、来源或 URL。',
        '保留冲突、资料缺口和待验证项。只输出 Markdown，不输出 HTML、CSS 或 JavaScript。',
        '来源与资料缺口附录由系统生成，不要自行创建来源列表。',
      ].join('\n'),
      prompt: '请围绕用户目标形成直接答案、跨 Skill 结论和可执行建议。',
      context: {
        requirement: input.requirement,
        reports: input.reports.map((report) => ({
          skillId: report.skillId,
          invocationId: report.invocationId,
          title: report.title,
          status: report.status,
          markdown: report.markdown,
          sourceIds: report.sources.map(({ id }) => id),
          gaps: report.gaps,
        })),
      },
      receipt: {
        stage: 'lightweight_report_synthesis',
        attemptId: this.receipt.attemptId,
        stepNo: this.receipt.stepNo,
        ...(this.receipt.contextManifestHash === undefined
          ? {}
          : { contextManifestHash: this.receipt.contextManifestHash }),
        ...(this.receipt.expectedModel === undefined
          ? {}
          : { expectedModel: this.receipt.expectedModel }),
      },
    });
    return result.text;
  }
}

function sameSource(left: SourceReference, right: SourceReference): boolean {
  return left.id === right.id
    && left.title === right.title
    && left.type === right.type
    && left.url === right.url;
}

function sourceMap(sources: readonly SourceReference[]): Map<string, SourceReference> {
  const byId = new Map<string, SourceReference>();
  for (const source of sources) {
    const existing = byId.get(source.id);
    if (existing && !sameSource(existing, source)) {
      throw new LightweightReportError(`source ${source.id} has conflicting definitions`);
    }
    byId.set(source.id, source);
  }
  return byId;
}

function assertReportSources(
  report: SkillReport,
  verifiedById: ReadonlyMap<string, SourceReference>,
): void {
  for (const source of report.sources) {
    const verified = verifiedById.get(source.id);
    if (!verified || !sameSource(source, verified)) {
      throw new LightweightReportError(`Skill ${report.skillId} references an unverified source ${source.id}`);
    }
  }
  assertMarkdownReferences(report.markdown, verifiedById);
}

export function assertMarkdownReferences(
  markdown: string,
  sources: ReadonlyMap<string, SourceReference> | readonly SourceReference[],
): void {
  const byId: ReadonlyMap<string, SourceReference> = Array.isArray(sources)
    ? sourceMap(sources)
    : sources as ReadonlyMap<string, SourceReference>;
  for (const match of markdown.matchAll(CITATION)) {
    if (!byId.has(match[1]!)) {
      throw new LightweightReportError(`Markdown references unknown source ${match[1]}`);
    }
  }
  const allowedUrls = new Set(
    [...byId.values()].flatMap(({ url }) => url === undefined ? [] : [url]),
  );
  for (const match of markdown.matchAll(URL_IN_TEXT)) {
    const url = match[0].replace(/[.,;:!?]+$/u, '');
    if (!allowedUrls.has(url)) {
      throw new LightweightReportError(`Markdown references unverified URL ${url}`);
    }
  }
}

function mergeSources(reports: readonly SkillReport[]): SourceReference[] {
  return [...sourceMap(reports.flatMap(({ sources }) => sources)).values()];
}

function mergeGaps(reports: readonly SkillReport[], extra: readonly string[] = []): string[] {
  return [...new Set([...reports.flatMap(({ gaps }) => gaps), ...extra].filter((gap) => gap.trim()))];
}

function sourceAppendix(sources: readonly SourceReference[]): string {
  if (sources.length === 0) return '';
  return [
    '## 来源',
    '',
    ...sources.map((source) => source.url
      ? `- [${source.id}] [${source.title}](${source.url})`
      : `- [${source.id}] ${source.title}`),
  ].join('\n');
}

function gapAppendix(gaps: readonly string[]): string {
  if (gaps.length === 0) return '';
  return ['## 资料缺口', '', ...gaps.map((gap) => `- ${gap}`)].join('\n');
}

export function appendDeterministicAppendices(
  markdown: string,
  sources: readonly SourceReference[],
  gaps: readonly string[],
): string {
  const appendices = [sourceAppendix(sources), gapAppendix(gaps)].filter(Boolean);
  return appendices.length === 0
    ? markdown
    : `${markdown}${markdown.endsWith('\n') ? '\n' : '\n\n'}${appendices.join('\n\n')}\n`;
}

function finalSkillReferences(reports: readonly SkillReport[]): FinalReport['skillReports'] {
  return reports.map((report) => {
    if (report.status === 'needs_input') {
      throw new LightweightReportError(`Skill ${report.skillId} still needs input`);
    }
    return {
      skillId: report.skillId,
      invocationId: report.invocationId,
      status: report.status,
      path: `skill-results/${report.invocationId}.json`,
    };
  });
}

export function finalizeSingleReport(input: {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  report: SkillReport;
  verifiedSources: readonly SourceReference[];
}): FinalReport {
  const report = parseSkillReport(input.report);
  if (report.status === 'needs_input') {
    throw new LightweightReportError(`Skill ${report.skillId} still needs input`);
  }
  const verifiedById = sourceMap(input.verifiedSources);
  assertReportSources(report, verifiedById);
  const finalReport: FinalReport = {
    version: FINAL_REPORT_VERSION,
    taskId: input.taskId,
    planVersionId: input.planVersionId,
    attemptId: input.attemptId,
    mode: 'single_skill',
    title: report.title,
    markdown: appendDeterministicAppendices(report.markdown, report.sources, report.gaps),
    sources: [...report.sources],
    gaps: [...report.gaps],
    skillReports: finalSkillReferences([report]),
  };
  return parseFinalReport(finalReport);
}

function synthesisFallback(reports: readonly SkillReport[]): string {
  return [
    '# 综合报告暂不可用',
    '',
    '> 自动综合未完成。以下内容为各 Skill 的原始报告，已完成的 Skill 不会重新执行。',
    '',
    ...reports.flatMap((report) => [
      `## ${report.title}`,
      '',
      report.markdown,
      '',
    ]),
  ].join('\n').trimEnd();
}

export async function finalizeMultiReport(input: {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  title: string;
  requirement: unknown;
  reports: SkillReport[];
  verifiedSources: readonly SourceReference[];
  synthesizer: MultiReportSynthesizer;
}): Promise<{ report: FinalReport; synthesis: 'completed' | 'fallback' }> {
  if (input.reports.length === 0) throw new LightweightReportError('Multi report has no Skill reports');
  const reports = input.reports.map(parseSkillReport);
  if (reports.some(({ status }) => status === 'needs_input')) {
    throw new LightweightReportError('Multi report contains a Skill that still needs input');
  }
  const verifiedById = sourceMap(input.verifiedSources);
  for (const report of reports) assertReportSources(report, verifiedById);
  const sources = mergeSources(reports);
  let synthesis: 'completed' | 'fallback' = 'completed';
  let markdown: string;
  const extraGaps: string[] = [];
  try {
    markdown = await input.synthesizer.synthesize({
      requirement: input.requirement,
      reports,
    });
    if (!markdown.trim()) throw new LightweightReportError('synthesis returned empty Markdown');
    assertMarkdownReferences(markdown, verifiedById);
  } catch {
    synthesis = 'fallback';
    markdown = synthesisFallback(reports);
    extraGaps.push('自动综合未完成；当前最终报告按 Skill 原始报告分组展示。');
  }
  const gaps = mergeGaps(reports, extraGaps);
  const finalReport: FinalReport = {
    version: FINAL_REPORT_VERSION,
    taskId: input.taskId,
    planVersionId: input.planVersionId,
    attemptId: input.attemptId,
    mode: 'multi_skill',
    title: input.title,
    markdown: appendDeterministicAppendices(markdown, sources, gaps),
    sources,
    gaps,
    skillReports: finalSkillReferences(reports),
  };
  return { report: parseFinalReport(finalReport), synthesis };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderInline(value: string, sources: ReadonlyMap<string, SourceReference>): string {
  let cursor = 0;
  let output = '';
  for (const match of value.matchAll(MARKDOWN_LINK)) {
    const index = match.index ?? 0;
    output += escapeHtml(value.slice(cursor, index));
    const title = match[1]!;
    const url = match[2]!;
    const verified = [...sources.values()].some((source) => source.url === url);
    if (!verified || !url.startsWith('https://')) {
      throw new LightweightReportError(`HTML renderer received unverified URL ${url}`);
    }
    output += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>`;
    cursor = index + match[0].length;
  }
  output += escapeHtml(value.slice(cursor));
  return output.replace(CITATION, (_full, id: string) => {
    if (!sources.has(id)) throw new LightweightReportError(`HTML renderer received unknown source ${id}`);
    return `<span class="citation">[${escapeHtml(id)}]</span>`;
  });
}

function renderMarkdownBody(markdown: string, sources: ReadonlyMap<string, SourceReference>): string {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const html: string[] = [];
  let inCode = false;
  let code: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let paragraph: string[] = [];
  const closeParagraph = (): void => {
    if (paragraph.length === 0) return;
    html.push(`<p>${renderInline(paragraph.join(' '), sources)}</p>`);
    paragraph = [];
  };
  const closeList = (): void => {
    if (!list) return;
    html.push(`</${list}>`);
    list = null;
  };
  for (const line of lines) {
    if (line.startsWith('```')) {
      closeParagraph();
      closeList();
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      closeParagraph();
      closeList();
      const level = heading[1]!.length;
      html.push(`<h${level}>${renderInline(heading[2]!, sources)}</h${level}>`);
      continue;
    }
    const unordered = /^[-*]\s+(.+)$/u.exec(line);
    const ordered = /^\d+[.)]\s+(.+)$/u.exec(line);
    if (unordered || ordered) {
      closeParagraph();
      const nextList = unordered ? 'ul' : 'ol';
      if (list !== nextList) {
        closeList();
        list = nextList;
        html.push(`<${list}>`);
      }
      html.push(`<li>${renderInline((unordered ?? ordered)![1]!, sources)}</li>`);
      continue;
    }
    const quote = /^>\s?(.*)$/u.exec(line);
    if (quote) {
      closeParagraph();
      closeList();
      html.push(`<blockquote>${renderInline(quote[1]!, sources)}</blockquote>`);
      continue;
    }
    if (!line.trim()) {
      closeParagraph();
      closeList();
      continue;
    }
    paragraph.push(line.trim());
  }
  if (inCode) html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  closeParagraph();
  closeList();
  return html.join('\n');
}

export function renderFinalReportHtml(reportValue: FinalReport): string {
  const report = parseFinalReport(reportValue);
  const sources = sourceMap(report.sources);
  assertMarkdownReferences(report.markdown, sources);
  const body = renderMarkdownBody(report.markdown, sources);
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; script-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(report.title)}</title>
<style>
:root{color-scheme:light;--bg:#f5f7fb;--card:#fff;--ink:#182033;--muted:#657089;--line:#dfe4ee;--accent:#d92f2f}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:980px;margin:40px auto;padding:48px;background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:0 14px 45px #1d2a4414}h1,h2,h3{line-height:1.3}h1{font-size:2rem}h2{margin-top:2.2rem;padding-top:.7rem;border-top:1px solid var(--line)}a{color:#1f57a8}.citation{color:var(--accent);font-weight:650}blockquote{margin:1rem 0;padding:.7rem 1rem;border-left:4px solid var(--accent);background:#fff6f6;color:var(--muted)}pre{overflow:auto;padding:16px;border-radius:10px;background:#111827;color:#f8fafc}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}@media print{body{background:#fff}main{margin:0;padding:0;border:0;box-shadow:none}}
</style>
</head>
<body><main data-report-version="${FINAL_REPORT_VERSION}">${body}</main></body>
</html>`;
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    throw new LightweightReportError('rendered HTML exceeds 5 MiB');
  }
  return html;
}
