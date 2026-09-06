import { createHash } from 'node:crypto';
import {
  DEFAULT_REPORT_PROMPT,
  NATIVE_FINAL_REPORT_VERSION,
  NATIVE_SKILL_RESULT_VERSION,
  parseNativeFinalReport,
  parseNativeSkillResult,
  nativeSkillResultPath,
  type NativeAttachment,
  type NativeFinalReport,
  type NativeOutput,
  type NativeOutputFormat,
  type NativeReportPolicy,
  type NativeSkillResult,
  type SourceReference,
} from '../../../../packages/api-contract/native-skill-orchestration.ts';
import type {
  ControlArtifact,
  ControlExecutionLease,
} from '../../../../database/control-plane.ts';
import {
  ArtifactInvalidationError,
  ArtifactPublicationGroup,
} from '../control/artifact-publication-group.ts';
import type { ControlArtifactStore } from '../control/artifact-store.ts';
import type { LLMClient } from '../runtime/llm-client.ts';

const CITATION = /\[(S(?:-|\d)[A-Za-z0-9._:-]*)\]/gu;
const URL_IN_TEXT = /https?:\/\/[^\s<>)\]]+/gu;
const MARKDOWN_LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu;
const MAX_REPORT_BYTES = 5 * 1024 * 1024;

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export class NativeReportError extends Error {
  constructor(message: string) {
    super(`native reporting failed: ${message}`);
    this.name = 'NativeReportError';
  }
}

export interface NativeSkillResultDraft {
  title: string;
  status: NativeSkillResult['status'];
  primary: {
    format: NativeOutputFormat;
    content: string;
  };
  attachments: Array<{
    path: string;
    mediaType: 'text/markdown' | 'text/html';
    content: string;
  }>;
  gaps: string[];
  missingInputKeys?: string[];
}

export const NATIVE_SKILL_RESULT_DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'status', 'primary', 'attachments', 'gaps'],
  properties: {
    title: { type: 'string', minLength: 1 },
    status: { enum: ['completed', 'completed_with_gaps', 'needs_input'] },
    primary: {
      type: 'object',
      additionalProperties: false,
      required: ['format', 'content'],
      properties: {
        format: { enum: ['markdown', 'html'] },
        content: { type: 'string', minLength: 1 },
      },
    },
    attachments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'mediaType', 'content'],
        properties: {
          path: { type: 'string', pattern: '^[^/\\\\][^\\\\]*$' },
          mediaType: { enum: ['text/markdown', 'text/html'] },
          content: { type: 'string', minLength: 1 },
        },
      },
    },
    gaps: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
    missingInputKeys: {
      type: 'array',
      items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' },
      minItems: 1,
      uniqueItems: true,
    },
  },
} as const;

function nativeOutput(format: NativeOutputFormat, content: string): NativeOutput {
  return { format, content, contentHash: digest(content) };
}

function nativeAttachments(
  values: NativeSkillResultDraft['attachments'],
  sources: readonly SourceReference[],
): NativeAttachment[] {
  return values.map((attachment) => {
    const content = attachment.mediaType === 'text/html'
      ? safeHtmlDocument(attachment.path, attachment.content, sources)
      : sanitizeGeneratedPrimary({ format: 'markdown', content: attachment.content }, sources).primary.content;
    return {
      ...attachment,
      content,
      contentHash: digest(content),
    };
  });
}

function sanitizeGeneratedPrimary(
  primary: NativeSkillResultDraft['primary'],
  sources: readonly SourceReference[],
): { primary: NativeSkillResultDraft['primary']; removed: boolean } {
  if (primary.format === 'html') {
    const content = sanitizeNativeHtml(primary.content, sources);
    return { primary: { ...primary, content }, removed: content !== primary.content };
  }
  const byId = sourceMap(sources);
  const allowedUrls = new Set(sources.flatMap(({ url }) => url ? [url] : []));
  let removed = false;
  let content = primary.content.replace(MARKDOWN_LINK, (full, label: string, url: string) => {
    if (allowedUrls.has(url)) return full;
    removed = true;
    return label;
  });
  content = content.replace(CITATION, (full, id: string) => {
    if (byId.has(id)) return full;
    removed = true;
    return '[未验证来源已移除]';
  });
  content = content.replace(URL_IN_TEXT, (raw) => {
    const trailing = /[.,;:!?。，；：！？]+$/u.exec(raw)?.[0] ?? '';
    const url = trailing ? raw.slice(0, -trailing.length) : raw;
    if (allowedUrls.has(url)) return raw;
    removed = true;
    return trailing;
  });
  return { primary: { ...primary, content }, removed };
}

export function createNativeSkillResult(input: {
  skillId: string;
  invocationId: string;
  draft: NativeSkillResultDraft;
  sources: SourceReference[];
  deterministicGaps?: string[];
}): NativeSkillResult {
  const sanitized = sanitizeGeneratedPrimary(input.draft.primary, input.sources);
  const gaps = [...new Set([
    ...input.draft.gaps,
    ...(input.deterministicGaps ?? []),
    ...(sanitized.removed ? ['模型输出中的未验证来源引用已移除。'] : []),
  ])];
  const status = input.draft.status === 'needs_input'
    ? 'needs_input'
    : gaps.length > 0 ? 'completed_with_gaps' : 'completed';
  return parseNativeSkillResult({
    version: NATIVE_SKILL_RESULT_VERSION,
    skillId: input.skillId,
    invocationId: input.invocationId,
    title: input.draft.title,
    status,
    primary: nativeOutput(sanitized.primary.format, sanitized.primary.content),
    attachments: nativeAttachments(input.draft.attachments, input.sources),
    sources: input.sources,
    gaps,
    ...(status === 'needs_input'
      ? { missingInputKeys: input.draft.missingInputKeys }
      : {}),
  });
}

export interface ReportWriterInput {
  requirement: unknown;
  results: NativeSkillResult[];
}

export interface NativeReportWriter {
  write(input: ReportWriterInput): Promise<string>;
}

export class LlmNativeReportWriter implements NativeReportWriter {
  constructor(
    private readonly llm: LLMClient,
    private readonly receipt: {
      attemptId: string;
      stepNo: number;
      stage: 'native_default_report' | 'native_multi_synthesis';
      expectedModel?: string;
      outputFormat?: NativeOutputFormat;
      instructions?: string;
    },
  ) {}

  async write(input: ReportWriterInput): Promise<string> {
    const result = await this.llm.generateText({
      systemPrompt: [
        ...(this.receipt.stage === 'native_default_report'
          ? [DEFAULT_REPORT_PROMPT]
          : [
              '你负责把多个 Skill 的原始结果综合为一份最终报告。',
              '只使用输入结果中的事实、Source ID 和 URL；不得新增事实、数字、来源或 URL。',
              '保留冲突、资料缺口和待验证项；来源与资料缺口附录由系统生成。',
              '自主决定最适合当前问题的章节和顺序。',
            ]),
        ...(this.receipt.instructions ? ['必须优先遵循以下原版 Skill 报告要求：', this.receipt.instructions] : []),
        this.receipt.outputFormat === 'html'
          ? '只输出安全的 HTML 正文，不输出 JavaScript、iframe、form 或运行时网络请求。'
          : '只输出 Markdown。',
      ].join('\n'),
      prompt: '请围绕用户目标形成直接答案、关键分析和可执行建议。',
      context: {
        requirement: input.requirement,
        results: input.results.map((item) => ({
          skillId: item.skillId,
          invocationId: item.invocationId,
          title: item.title,
          status: item.status,
          format: item.primary.format,
          content: item.primary.content,
          sourceIds: item.sources.map(({ id }) => id),
          gaps: item.gaps,
        })),
      },
      receipt: {
        stage: this.receipt.stage,
        attemptId: this.receipt.attemptId,
        stepNo: this.receipt.stepNo,
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
    && left.url === right.url
    && left.locator === right.locator
    && left.contentHash === right.contentHash;
}

function sourceMap(sources: readonly SourceReference[]): Map<string, SourceReference> {
  const byId = new Map<string, SourceReference>();
  for (const source of sources) {
    const existing = byId.get(source.id);
    if (existing && !sameSource(existing, source)) {
      throw new NativeReportError(`source ${source.id} has conflicting definitions`);
    }
    byId.set(source.id, source);
  }
  return byId;
}

export function assertNativeContentReferences(
  content: string,
  sources: ReadonlyMap<string, SourceReference> | readonly SourceReference[],
): void {
  const byId: ReadonlyMap<string, SourceReference> = Array.isArray(sources)
    ? sourceMap(sources)
    : sources as ReadonlyMap<string, SourceReference>;
  for (const match of content.matchAll(CITATION)) {
    if (!byId.has(match[1]!)) throw new NativeReportError(`content references unknown source ${match[1]}`);
  }
  const allowedUrls = new Set(
    [...byId.values()].flatMap(({ url }) => url === undefined ? [] : [url]),
  );
  for (const match of content.matchAll(URL_IN_TEXT)) {
    const url = match[0].replace(/[.,;:!?。，；：！？]+$/u, '');
    if (!allowedUrls.has(url)) throw new NativeReportError(`content references unverified URL ${url}`);
  }
}

function assertResultSources(
  result: NativeSkillResult,
  verifiedById: ReadonlyMap<string, SourceReference>,
): void {
  for (const source of result.sources) {
    const verified = verifiedById.get(source.id);
    if (!verified || !sameSource(source, verified)) {
      throw new NativeReportError(`Skill ${result.skillId} references an unverified source ${source.id}`);
    }
  }
  if (result.primary.format === 'html') sanitizeNativeHtml(result.primary.content, result.sources);
  else assertNativeContentReferences(result.primary.content, verifiedById);
}

function mergeSources(results: readonly NativeSkillResult[]): SourceReference[] {
  return [...sourceMap(results.flatMap(({ sources }) => sources)).values()];
}

function mergeGaps(results: readonly NativeSkillResult[], extra: readonly string[] = []): string[] {
  return [...new Set([...results.flatMap(({ gaps }) => gaps), ...extra].filter((gap) => gap.trim()))];
}

function sourceMarkdown(sources: readonly SourceReference[]): string {
  if (sources.length === 0) return '';
  return [
    '## 来源',
    '',
    ...sources.map((source) => {
      const target = source.url ? `[${source.title}](${source.url})` : source.title;
      const provenance = [source.locator, source.contentHash].filter(Boolean).join(' · ');
      return `- [${source.id}] ${target}${provenance ? ` — ${provenance}` : ''}`;
    }),
  ].join('\n');
}

function gapMarkdown(gaps: readonly string[]): string {
  if (gaps.length === 0) return '';
  return ['## 资料缺口', '', ...gaps.map((gap) => `- ${gap}`)].join('\n');
}

function appendMarkdownAppendices(
  markdown: string,
  sources: readonly SourceReference[],
  gaps: readonly string[],
): string {
  const appendices = [sourceMarkdown(sources), gapMarkdown(gaps)].filter(Boolean);
  return appendices.length === 0
    ? markdown
    : `${markdown}${markdown.endsWith('\n') ? '\n' : '\n\n'}${appendices.join('\n\n')}\n`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function appendHtmlAppendices(
  html: string,
  sources: readonly SourceReference[],
  gaps: readonly string[],
): string {
  const sourceItems = sources.map((source) => {
    const title = source.url
      ? `<a href="${escapeHtml(source.url)}">${escapeHtml(source.title)}</a>`
      : escapeHtml(source.title);
    const provenance = [source.locator, source.contentHash].filter(Boolean).join(' · ');
    return `<li><span class="citation">[${escapeHtml(source.id)}]</span> ${title}${provenance ? ` — ${escapeHtml(provenance)}` : ''}</li>`;
  }).join('');
  const gapItems = gaps.map((gap) => `<li>${escapeHtml(gap)}</li>`).join('');
  const appendix = `${sourceItems ? `<section><h2>来源</h2><ul>${sourceItems}</ul></section>` : ''}${gapItems ? `<section><h2>资料缺口</h2><ul>${gapItems}</ul></section>` : ''}`;
  if (!appendix) return html;
  return /<\/body>/iu.test(html)
    ? html.replace(/<\/body>/iu, `${appendix}</body>`)
    : `${html}${appendix}`;
}

export function sanitizeNativeHtml(html: string, sources: readonly SourceReference[]): string {
  let sanitized = html
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<\/?(?:script|iframe|frame|frameset|form|object|embed|link|meta|base)\b[^>]*>/giu, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, '')
    .replace(/\s+srcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, '')
    .replace(/@import\s+[^;]+;?/giu, '')
    .replace(/url\s*\([^)]*\)/giu, '')
    .replace(/expression\s*\([^)]*\)/giu, '');
  const allowedUrls = new Set(sources.flatMap(({ url }) => url ? [url] : []));
  sanitized = sanitized.replace(
    /\s+(href|src|srcset|poster|xlink:href|action|formaction)\s*=\s*(?:(["'])(.*?)\2|([^\s>]+))/giu,
    (_all, name: string, quote: string | undefined, quotedValue: string | undefined, bareValue: string | undefined) => {
      const value = quotedValue ?? bareValue ?? '';
      const normalizedName = name.toLowerCase();
      if (normalizedName === 'href' && quote && allowedUrls.has(value) && value.startsWith('https://')) {
        return ` href=${quote}${value}${quote}`;
      }
      if (normalizedName === 'src' && quote && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/u.test(value)) {
        return ` src=${quote}${value}${quote}`;
      }
      return '';
    },
  );
  if (/<\/?(?:script|iframe|frame|frameset|form|object|embed)\b|\son[a-z]+\s*=|\bsrcdoc\s*=|@import|url\s*\(|expression\s*\(|\bjavascript\s*:/iu.test(sanitized)) {
    throw new NativeReportError('HTML sanitizer left executable or network-bearing markup');
  }
  return sanitized;
}

function safeHtmlDocument(
  title: string,
  html: string,
  sources: readonly SourceReference[],
): string {
  const sanitized = sanitizeNativeHtml(html, sources)
    .replace(/<!doctype[^>]*>/giu, '')
    .replace(/<\/?(?:html|head|body)\b[^>]*>/giu, '')
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/giu, '');
  return wrapHtml(title, sanitized);
}

function finalSkillReferences(results: readonly NativeSkillResult[]): NativeFinalReport['skillResults'] {
  return results.map((result) => {
    if (result.status === 'needs_input') throw new NativeReportError(`Skill ${result.skillId} still needs input`);
    return {
      skillId: result.skillId,
      invocationId: result.invocationId,
      status: result.status,
      path: nativeSkillResultPath(result.invocationId),
    };
  });
}

function finalPrimary(
  result: NativeSkillResult,
  sources: readonly SourceReference[],
  gaps: readonly string[],
): NativeOutput {
  if (result.primary.format === 'html') {
    const body = appendHtmlAppendices(result.primary.content, sources, gaps);
    return nativeOutput('html', safeHtmlDocument(result.title, body, sources));
  }
  return nativeOutput('markdown', appendMarkdownAppendices(result.primary.content, sources, gaps));
}

export async function finalizeSingleNativeReport(input: {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  requirement: unknown;
  result: NativeSkillResult;
  verifiedSources: readonly SourceReference[];
  reportPolicy: 'skill_defined' | 'default_llm';
  defaultWriter?: NativeReportWriter;
  extraGaps?: readonly string[];
}): Promise<NativeFinalReport> {
  const result = parseNativeSkillResult(input.result);
  if (result.status === 'needs_input') throw new NativeReportError(`Skill ${result.skillId} still needs input`);
  const verifiedById = sourceMap(input.verifiedSources);
  assertResultSources(result, verifiedById);
  const gaps = mergeGaps([result], input.extraGaps);
  let primary: NativeOutput;
  if (input.reportPolicy === 'default_llm') {
    if (!input.defaultWriter) throw new NativeReportError('default report writer is unavailable');
    const markdown = await input.defaultWriter.write({ requirement: input.requirement, results: [result] });
    if (!markdown.trim()) throw new NativeReportError('default report writer returned empty Markdown');
    assertNativeContentReferences(markdown, verifiedById);
    primary = nativeOutput('markdown', appendMarkdownAppendices(markdown, result.sources, gaps));
  } else {
    primary = finalPrimary(result, result.sources, gaps);
  }
  return parseNativeFinalReport({
    version: NATIVE_FINAL_REPORT_VERSION,
    taskId: input.taskId,
    planVersionId: input.planVersionId,
    attemptId: input.attemptId,
    mode: 'single_skill',
    title: result.title,
    primary,
    attachments: result.attachments,
    sources: [...result.sources],
    gaps,
    skillResults: finalSkillReferences([result]),
  });
}

function synthesisFallback(results: readonly NativeSkillResult[]): string {
  return [
    '# 综合报告暂不可用',
    '',
    '> 自动综合未完成。以下内容为各 Skill 的原始结果，已完成的 Skill 不会重新执行。',
    '',
    ...results.flatMap((result) => [
      `## ${result.title}`,
      '',
      result.primary.format === 'markdown'
        ? result.primary.content
        : '该 Skill 生成了 HTML 结果，请在 Skill 明细中查看。',
      '',
    ]),
  ].join('\n').trimEnd();
}

export async function finalizeMultiNativeReport(input: {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  title: string;
  requirement: unknown;
  results: NativeSkillResult[];
  verifiedSources: readonly SourceReference[];
  writer: NativeReportWriter;
  reportPolicy: NativeReportPolicy;
  extraGaps?: readonly string[];
}): Promise<{ report: NativeFinalReport; synthesis: 'completed' | 'fallback' }> {
  if (input.results.length === 0) throw new NativeReportError('Multi report has no Skill results');
  const results = input.results.map(parseNativeSkillResult);
  if (results.some(({ status }) => status === 'needs_input')) {
    throw new NativeReportError('Multi report contains a Skill that still needs input');
  }
  const verifiedById = sourceMap(input.verifiedSources);
  for (const result of results) assertResultSources(result, verifiedById);
  const sources = mergeSources(results);
  let synthesis: 'completed' | 'fallback' = 'completed';
  let markdown: string;
  const extraGaps: string[] = [];
  try {
    markdown = await input.writer.write({ requirement: input.requirement, results });
    if (!markdown.trim()) throw new NativeReportError('synthesis returned empty Markdown');
    assertNativeContentReferences(markdown, verifiedById);
  } catch {
    synthesis = 'fallback';
    markdown = synthesisFallback(results);
    extraGaps.push('自动综合未完成；当前最终报告按 Skill 原始结果分组展示。');
  }
  const gaps = mergeGaps(results, [...(input.extraGaps ?? []), ...extraGaps]);
  const primary = input.reportPolicy.kind === 'skill_defined'
    && input.reportPolicy.outputFormat === 'html'
    ? nativeOutput('html', safeHtmlDocument(
        input.title,
        appendHtmlAppendices(markdown, sources, gaps),
        sources,
      ))
    : nativeOutput('markdown', appendMarkdownAppendices(markdown, sources, gaps));
  const report = parseNativeFinalReport({
    version: NATIVE_FINAL_REPORT_VERSION,
    taskId: input.taskId,
    planVersionId: input.planVersionId,
    attemptId: input.attemptId,
    mode: 'multi_skill',
    title: input.title,
    primary,
    attachments: results.flatMap((result) => result.attachments.map((attachment) => ({
      ...attachment,
      path: `${encodeURIComponent(result.invocationId)}/${attachment.path}`,
    }))),
    sources,
    gaps,
    skillResults: finalSkillReferences(results),
  });
  return { report, synthesis };
}

export interface SealedNativeSkillResult {
  result: NativeSkillResult;
  jsonArtifact: ControlArtifact;
  primaryArtifact: ControlArtifact;
  attachmentArtifacts: ControlArtifact[];
}

export interface SealedNativeFinalReport {
  report: NativeFinalReport;
  jsonArtifact: ControlArtifact;
  primaryArtifact: ControlArtifact;
  htmlArtifact: ControlArtifact;
  sourcesArtifact: ControlArtifact;
  attachmentArtifacts: ControlArtifact[];
}

function extension(format: NativeOutputFormat): 'md' | 'html' {
  return format === 'html' ? 'html' : 'md';
}

function mediaType(format: NativeOutputFormat): 'text/markdown; charset=utf-8' | 'text/html; charset=utf-8' {
  return format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8';
}

function attachmentRelativePath(base: string, path: string): string {
  return `${base}/${path}`;
}

export class NativeReportArtifactService {
  constructor(private readonly artifacts: ControlArtifactStore) {}

  async sealSkillResult(input: {
    activeLease: ControlExecutionLease;
    result: NativeSkillResult;
  }): Promise<SealedNativeSkillResult> {
    const result = parseNativeSkillResult(input.result);
    const publication = new ArtifactPublicationGroup(this.artifacts);
    try {
      const encoded = encodeURIComponent(result.invocationId);
      const primaryArtifact = await this.artifacts.writeText({
        taskId: input.activeLease.taskId,
        planVersionId: input.activeLease.planVersionId,
        attemptId: input.activeLease.attemptId,
        kind: 'skill_result_primary',
        relativePath: `skill-results/${encoded}/primary.${extension(result.primary.format)}`,
        content: result.primary.content,
        mediaType: mediaType(result.primary.format),
        maxByteSize: MAX_REPORT_BYTES,
        schemaVersion: NATIVE_SKILL_RESULT_VERSION,
        activeLease: input.activeLease,
      });
      publication.track(primaryArtifact.id);
      const attachmentArtifacts: ControlArtifact[] = [];
      for (const attachment of result.attachments) {
        const artifact = await this.artifacts.writeText({
          taskId: input.activeLease.taskId,
          planVersionId: input.activeLease.planVersionId,
          attemptId: input.activeLease.attemptId,
          kind: 'skill_result_attachment',
          relativePath: attachmentRelativePath(`skill-results/${encoded}/attachments`, attachment.path),
          content: attachment.content,
          mediaType: attachment.mediaType === 'text/html'
            ? 'text/html; charset=utf-8'
            : 'text/markdown; charset=utf-8',
          maxByteSize: MAX_REPORT_BYTES,
          schemaVersion: NATIVE_SKILL_RESULT_VERSION,
          activeLease: input.activeLease,
        });
        publication.track(artifact.id);
        attachmentArtifacts.push(artifact);
      }
      const jsonArtifact = await this.artifacts.writeJson({
        taskId: input.activeLease.taskId,
        planVersionId: input.activeLease.planVersionId,
        attemptId: input.activeLease.attemptId,
        kind: 'skill_result',
        relativePath: nativeSkillResultPath(result.invocationId),
        value: result,
        schemaVersion: NATIVE_SKILL_RESULT_VERSION,
        activeLease: input.activeLease,
      });
      publication.track(jsonArtifact.id);
      publication.commit();
      return { result, jsonArtifact, primaryArtifact, attachmentArtifacts };
    } catch (error) {
      try {
        await publication.compensate('Native Skill result publication did not complete');
      } catch (compensationError) {
        if (compensationError instanceof ArtifactInvalidationError) {
          throw new ArtifactInvalidationError(
            compensationError.failedArtifactIds,
            compensationError.invalidationReason,
            [error, ...compensationError.failures],
          );
        }
        throw compensationError;
      }
      throw error;
    }
  }

  async sealFinalReport(input: {
    activeLease: ControlExecutionLease;
    report: NativeFinalReport;
  }): Promise<SealedNativeFinalReport> {
    const report = parseNativeFinalReport(input.report);
    const displayHtml = renderNativeFinalReportHtml(report);
    const publication = new ArtifactPublicationGroup(this.artifacts);
    try {
      const primaryArtifact = await this.artifacts.writeText({
        taskId: input.activeLease.taskId,
        planVersionId: input.activeLease.planVersionId,
        attemptId: input.activeLease.attemptId,
        kind: 'final_report_primary',
        relativePath: `reports/primary.${extension(report.primary.format)}`,
        content: report.primary.content,
        mediaType: mediaType(report.primary.format),
        maxByteSize: MAX_REPORT_BYTES,
        schemaVersion: NATIVE_FINAL_REPORT_VERSION,
        activeLease: input.activeLease,
      });
      publication.track(primaryArtifact.id);
      const attachmentArtifacts: ControlArtifact[] = [];
      for (const attachment of report.attachments) {
        const artifact = await this.artifacts.writeText({
          taskId: input.activeLease.taskId,
          planVersionId: input.activeLease.planVersionId,
          attemptId: input.activeLease.attemptId,
          kind: 'final_report_attachment',
          relativePath: attachmentRelativePath('reports/attachments', attachment.path),
          content: attachment.content,
          mediaType: attachment.mediaType === 'text/html'
            ? 'text/html; charset=utf-8'
            : 'text/markdown; charset=utf-8',
          maxByteSize: MAX_REPORT_BYTES,
          schemaVersion: NATIVE_FINAL_REPORT_VERSION,
          activeLease: input.activeLease,
        });
        publication.track(artifact.id);
        attachmentArtifacts.push(artifact);
      }
      const htmlArtifact = await this.artifacts.writeText({
        taskId: input.activeLease.taskId,
        planVersionId: input.activeLease.planVersionId,
        attemptId: input.activeLease.attemptId,
        kind: 'final_report_html',
        relativePath: 'reports/report.html',
        content: displayHtml,
        mediaType: 'text/html; charset=utf-8',
        maxByteSize: MAX_REPORT_BYTES,
        schemaVersion: NATIVE_FINAL_REPORT_VERSION,
        activeLease: input.activeLease,
      });
      publication.track(htmlArtifact.id);
      const sourcesArtifact = await this.artifacts.writeJson({
        taskId: input.activeLease.taskId,
        planVersionId: input.activeLease.planVersionId,
        attemptId: input.activeLease.attemptId,
        kind: 'report_sources',
        relativePath: 'reports/sources.json',
        value: report.sources,
        schemaVersion: 'source-reference-list-v1',
        activeLease: input.activeLease,
      });
      publication.track(sourcesArtifact.id);
      const jsonArtifact = await this.artifacts.writeJson({
        taskId: input.activeLease.taskId,
        planVersionId: input.activeLease.planVersionId,
        attemptId: input.activeLease.attemptId,
        kind: 'final_report',
        relativePath: 'reports/final-report.json',
        value: report,
        schemaVersion: NATIVE_FINAL_REPORT_VERSION,
        activeLease: input.activeLease,
      });
      publication.track(jsonArtifact.id);
      publication.commit();
      return {
        report,
        jsonArtifact,
        primaryArtifact,
        htmlArtifact,
        sourcesArtifact,
        attachmentArtifacts,
      };
    } catch (error) {
      try {
        await publication.compensate('Native NativeFinalReport publication did not complete');
      } catch (compensationError) {
        if (compensationError instanceof ArtifactInvalidationError) {
          throw new ArtifactInvalidationError(
            compensationError.failedArtifactIds,
            compensationError.invalidationReason,
            [error, ...compensationError.failures],
          );
        }
        throw compensationError;
      }
      throw error;
    }
  }
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
      throw new NativeReportError(`HTML renderer received unverified URL ${url}`);
    }
    output += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>`;
    cursor = index + match[0].length;
  }
  output += escapeHtml(value.slice(cursor));
  return output.replace(CITATION, (_full, id: string) => {
    if (!sources.has(id)) throw new NativeReportError(`HTML renderer received unknown source ${id}`);
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

function wrapHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; script-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light;--bg:#f5f7fb;--card:#fff;--ink:#182033;--muted:#657089;--line:#dfe4ee;--accent:#d92f2f}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:980px;margin:40px auto;padding:48px;background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:0 14px 45px #1d2a4414}h1,h2,h3{line-height:1.3}h1{font-size:2rem}h2{margin-top:2.2rem;padding-top:.7rem;border-top:1px solid var(--line)}a{color:#1f57a8}.citation{color:var(--accent);font-weight:650}blockquote{margin:1rem 0;padding:.7rem 1rem;border-left:4px solid var(--accent);background:#fff6f6;color:var(--muted)}pre{overflow:auto;padding:16px;border-radius:10px;background:#111827;color:#f8fafc}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}@media print{body{background:#fff}main{margin:0;padding:0;border:0;box-shadow:none}}
</style>
</head>
<body><main data-report-version="${NATIVE_FINAL_REPORT_VERSION}">${body}</main></body>
</html>`;
}

export function renderNativeFinalReportHtml(reportValue: NativeFinalReport): string {
  const report = parseNativeFinalReport(reportValue);
  const sources = sourceMap(report.sources);
  const html = report.primary.format === 'html'
    ? safeHtmlDocument(report.title, report.primary.content, report.sources)
    : (() => {
        assertNativeContentReferences(report.primary.content, sources);
        return wrapHtml(report.title, renderMarkdownBody(report.primary.content, sources));
      })();
  if (Buffer.byteLength(html, 'utf8') > MAX_REPORT_BYTES) {
    throw new NativeReportError('rendered HTML exceeds 5 MiB');
  }
  return html;
}
