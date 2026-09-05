import { strToU8, zipSync } from 'fflate';
import type { CurrentReportPackageResponse } from '../../../../packages/api-contract/control-workflow.ts';
import {
  isReportDocumentV3,
  isReportDocumentV4,
  type ReadableReportDocument,
  type ReportBlockV1V2,
  type ReportBlockV3,
  type ReportBlockV4,
  type ReportDocumentV3,
  type ReportDocumentV4,
} from '../../../../packages/api-contract/report-document.ts';
import type {
  EvidenceManifest,
  VisualAssetManifest,
  VisualAssetReference,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type {
  ReportBlock,
} from '../../../orchestrator-runtime/src/report/report-document-composer.ts';
import type { ChartTableAlternative } from '../../../orchestrator-runtime/src/report/chart-renderer.ts';
import {
  safeContributionLedger,
  safeContributionSummary,
  safeReportDocumentV3,
  safeReportDocumentV4,
  safeReportReview,
} from '../../../../packages/report-rendering/report-export-projection.ts';
import {
  createReportRenderManifestV1,
  createReportRenderManifestV2,
} from '../../../../packages/report-rendering/report-render-manifest.ts';
import {
  assertReportDocumentV3Integrity,
  assertReportDocumentV4Integrity,
  visitReportDocumentV3,
  visitReportDocumentV4,
} from '../../../../packages/report-rendering/report-document-visitor.ts';
import { assertVisualAssetManifest } from '../report-package-response.ts';
import {
  currentResearchPlanToMarkdown,
  type CurrentResearchPlanResponse,
} from '../current-report-markdown.ts';

interface BundleAssetReadResult {
  bytes: Uint8Array;
  mediaType: VisualAssetManifest['mediaType'];
}

type BundleReportPackage = Exclude<CurrentReportPackageResponse, { presentationMode: 'legacy_text' }>;

export interface CreateReportBundleInput {
  report: BundleReportPackage;
  readAsset(input: { taskId: string; assetId: string }): Promise<BundleAssetReadResult>;
}

const MEDIA_EXTENSION: Record<VisualAssetManifest['mediaType'], string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

function reportBlocks(document: ReadableReportDocument): Array<ReportBlockV1V2 | ReportBlockV3 | ReportBlockV4> {
  if (isReportDocumentV4(document)) return document.sections.flatMap(({ blocks }) => blocks);
  if (isReportDocumentV3(document)) return document.sections.flatMap(({ blocks }) => blocks);
  return document.sections.flatMap(({ blocks }) => blocks);
}

function assetReferences(document: ReadableReportDocument): VisualAssetReference[] {
  const references: VisualAssetReference[] = [];
  const seen = new Set<string>();
  const manifestByAsset = new Map<string, string>();
  const append = (reference: VisualAssetReference): void => {
    const priorManifest = manifestByAsset.get(reference.assetId);
    if (priorManifest && priorManifest !== reference.manifestArtifactId) {
      throw new Error(`ReportDocument visual Asset ${reference.assetId} has conflicting Manifest references`);
    }
    manifestByAsset.set(reference.assetId, reference.manifestArtifactId);
    const key = `${reference.assetId}\u0000${reference.manifestArtifactId}`;
    if (seen.has(key)) return;
    seen.add(key);
    references.push(reference);
  };
  for (const block of reportBlocks(document)) {
    if (block.type === 'image') append(block.assetRef);
    if (block.type === 'image-comparison') {
      append(block.beforeAssetRef);
      append(block.afterAssetRef);
    }
    if (block.type === 'chart') append(block.chartRef);
  }
  return references;
}

function assertCompleteBundlePackage(
  report: CurrentReportPackageResponse,
): asserts report is BundleReportPackage {
  if (report.presentationMode === 'legacy_text') {
    throw new Error('report bundle requires the Current presentation mode');
  }
  const binding = report.deliverable;
  if (
    report.evidenceManifest.taskId !== binding.taskId
    || report.evidenceManifest.planVersionId !== binding.planVersionId
    || report.evidenceManifest.attemptId !== binding.attemptId
    || report.reportReview.taskId !== binding.taskId
    || report.reportReview.planVersionId !== binding.planVersionId
    || report.reportReview.attemptId !== binding.attemptId
  ) {
    throw new Error('report package Task, Plan, and Attempt binding is inconsistent');
  }
  if (report.presentationMode === 'current_text') return;
  if (
    !report.reportDocument
    || (
      report.reportDocument.version !== 'report-document-v1'
      && report.reportDocument.version !== 'report-document-v2'
      && report.reportDocument.version !== 'report-document-v3'
      && report.reportDocument.version !== 'report-document-v4'
    )
  ) {
    throw new Error('report bundle requires a complete ReportDocument');
  }
  if (report.reportDocument.version === 'report-document-v3') {
    assertReportDocumentV3Integrity(report.reportDocument);
  }
  if (isReportDocumentV4(report.reportDocument)) {
    assertReportDocumentV4Integrity(report.reportDocument);
  }
  if (!Array.isArray(report.visualAssetManifests)) {
    throw new Error('report bundle requires visual Asset Manifests');
  }
  const references = assetReferences(report.reportDocument);
  const referenceAssets = new Set(references.map(({ assetId }) => assetId));
  const manifestAssets = new Set<string>();
  for (const manifest of report.visualAssetManifests) {
    assertVisualAssetManifest(manifest, binding);
    if (manifestAssets.has(manifest.assetId)) {
      throw new Error('visual Asset Manifest set is invalid');
    }
    manifestAssets.add(manifest.assetId);
  }
  if (
    manifestAssets.size !== referenceAssets.size
    || [...referenceAssets].some((assetId) => !manifestAssets.has(assetId))
  ) {
    throw new Error('visual Asset Manifest set does not exactly match ReportDocument references');
  }
}

function deterministicAssetPath(manifest: VisualAssetManifest): string {
  const extension = MEDIA_EXTENSION[manifest.mediaType];
  const stem = manifest.assetId
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/^\.+|\.+$/gu, '')
    .slice(0, 96) || 'asset';
  const withoutExtension = Object.values(MEDIA_EXTENSION).some((candidate) => stem.toLowerCase().endsWith(candidate))
    ? stem.slice(0, stem.lastIndexOf('.'))
    : stem;
  return `assets/${withoutExtension}${extension}`;
}

function safeDeliverable(deliverable: BundleReportPackage['deliverable']): Record<string, unknown> {
  return {
    version: deliverable.version,
    taskId: deliverable.taskId,
    planVersionId: deliverable.planVersionId,
    attemptId: deliverable.attemptId,
    deliverableType: deliverable.deliverableType,
    evidenceManifestArtifactId: deliverable.evidenceManifestArtifactId,
    methodSummary: deliverable.methodSummary,
    findingGraph: deliverable.findingGraph,
    payload: deliverable.payload,
    recommendations: deliverable.recommendations,
    coverage: deliverable.coverage,
    risksAndOpenIssues: deliverable.risksAndOpenIssues,
    capabilityProvenance: deliverable.capabilityProvenance,
  };
}

function safeEvidenceManifest(manifest: EvidenceManifest): Record<string, unknown> {
  return {
    version: manifest.version,
    taskId: manifest.taskId,
    planVersionId: manifest.planVersionId,
    attemptId: manifest.attemptId,
    collectedAt: manifest.collectedAt,
    entries: manifest.entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      evidenceClass: entry.evidenceClass,
      sensitivity: entry.sensitivity,
      redaction: entry.redaction,
    })),
  };
}

function safeAssetReference(reference: VisualAssetReference): Record<string, string> {
  return { assetId: reference.assetId };
}

function safeReportBlock(
  block: ReportBlock,
  evidenceIndexItems?: readonly string[],
): Record<string, unknown> {
  if (block.type === 'paragraph') return { id: block.id, type: block.type, text: block.text };
  if (block.type === 'fact') {
    return { id: block.id, type: block.type, text: block.text, evidenceIds: block.evidenceIds };
  }
  if (block.type === 'metric') {
    return { id: block.id, type: block.type, label: block.label, value: block.value, evidenceIds: block.evidenceIds };
  }
  if (block.type === 'list' || block.type === 'projection-list') {
    return {
      id: block.id,
      type: block.type,
      items: evidenceIndexItems ? [...evidenceIndexItems] : block.items,
      ...(block.type === 'projection-list' ? {
        sourcePointers: block.sourcePointers,
        ...(block.sourceNodeIds ? { sourceNodeIds: block.sourceNodeIds } : {}),
        summary: block.summary,
      } : {}),
    };
  }
  if (block.type === 'answer') {
    return {
      id: block.id,
      type: block.type,
      kind: block.kind,
      title: block.title,
      text: block.text,
      items: block.items,
      questionIds: block.questionIds,
      evidenceIds: block.evidenceIds,
      findingIds: block.findingIds,
      summaryIds: block.summaryIds,
      ...(typeof block.confidence === 'number' ? { confidence: block.confidence } : {}),
      ...(block.answerStatus ? { answerStatus: block.answerStatus } : {}),
      sourcePointers: block.sourcePointers,
      ...(block.sourceNodeIds ? { sourceNodeIds: block.sourceNodeIds } : {}),
      summary: block.summary,
    };
  }
  if (block.type === 'image') {
    return {
      id: block.id,
      type: block.type,
      assetRef: safeAssetReference(block.assetRef),
      caption: block.caption,
      altText: block.altText,
      ...(block.evidenceIds ? { evidenceIds: block.evidenceIds } : {}),
    };
  }
  if (block.type === 'image-comparison') {
    return {
      id: block.id,
      type: block.type,
      beforeAssetRef: safeAssetReference(block.beforeAssetRef),
      afterAssetRef: safeAssetReference(block.afterAssetRef),
      caption: block.caption,
      altText: block.altText,
      ...(block.evidenceIds ? { evidenceIds: block.evidenceIds } : {}),
    };
  }
  return {
    id: block.id,
    type: block.type,
    chartRef: { chartId: block.chartRef.chartId, assetId: block.chartRef.assetId },
    spec: block.spec,
    table: block.table,
    caption: block.caption,
    altText: block.altText,
  };
}

function safeReportDocument(
  document: ReadableReportDocument,
  exportableAssetIds: ReadonlySet<string>,
  evidenceIndexItems: readonly string[],
): Record<string, unknown> {
  if (isReportDocumentV4(document)) return safeReportDocumentV4(document);
  if (isReportDocumentV3(document)) return safeReportDocumentV3(document);
  const include = (block: ReportBlock): boolean => {
    if (block.type === 'image') return exportableAssetIds.has(block.assetRef.assetId);
    if (block.type === 'image-comparison') {
      return exportableAssetIds.has(block.beforeAssetRef.assetId)
        && exportableAssetIds.has(block.afterAssetRef.assetId);
    }
    if (block.type === 'chart') return exportableAssetIds.has(block.chartRef.assetId);
    return true;
  };
  return {
    version: document.version,
    title: document.title,
    subtitle: document.subtitle,
    executiveSummary: document.executiveSummary,
    ...(document.version === 'report-document-v2'
      ? {
          sourceDeliverableArtifactId: document.sourceDeliverableArtifactId,
          projectionMode: document.projectionMode,
          coveredPointers: document.coveredPointers,
          omittedPointers: document.omittedPointers,
        }
      : {}),
    sections: document.sections.map((section) => ({
      id: section.id,
      title: section.title,
      questionIds: section.questionIds,
      blocks: section.blocks.filter(include).map((block) => safeReportBlock(
        block,
        section.id === 'appendix' && block.type === 'list' && block.id === 'evidence-index'
          ? evidenceIndexItems
          : undefined,
      )),
    })),
  };
}

function jsonBytes(value: unknown): Uint8Array {
  return strToU8(`${JSON.stringify(value, null, 2)}\n`);
}

function markdownCell(value: string | number | boolean | null): string {
  return String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function tableMarkdown(table: ChartTableAlternative): string[] {
  if (table.columns.length === 0) throw new Error('Markdown table requires at least one sealed column');
  const lines = [
    `*${table.caption}*`,
    '',
    `| ${table.columns.map(markdownCell).join(' | ')} |`,
    `| ${table.columns.map(() => '---').join(' | ')} |`,
  ];
  for (const row of table.rows) {
    const cells = [row.label, ...row.cells];
    if (cells.length !== table.columns.length) {
      throw new Error(`Markdown table row ${row.key} does not match its sealed column count`);
    }
    lines.push(`| ${cells.map(markdownCell).join(' | ')} |`);
    const evidenceIds = [...new Set(row.evidenceIds.flat())];
    if (evidenceIds.length > 0) lines.push(`Evidence: ${evidenceIds.join(', ')}`);
  }
  return [...lines, ''];
}

function evidenceMarkdown(evidenceIds?: readonly string[]): string[] {
  return evidenceIds && evidenceIds.length > 0
    ? [`Evidence: ${evidenceIds.join(', ')}`, '']
    : [];
}

function structuredTraceMarkdown(
  document: ReportDocumentV3 | ReportDocumentV4,
  leafRefs: readonly string[],
): string[] {
  const traces = leafRefs.map((leafRef) => document.traceIndex[leafRef]!);
  const evidenceIds = [...new Set(traces.flatMap(({ evidenceIds }) => evidenceIds))];
  const findingIds = [...new Set(traces.flatMap(({ findingIds }) => findingIds))];
  const summaryIds = [...new Set(traces.flatMap(({ summaryIds }) => summaryIds))];
  return [
    ...(evidenceIds.length > 0 ? [`Evidence: ${evidenceIds.join(', ')}`] : []),
    ...(findingIds.length > 0 ? [`Findings: ${findingIds.join(', ')}`] : []),
    ...(summaryIds.length > 0 ? [`Summaries: ${summaryIds.join(', ')}`] : []),
    ...(evidenceIds.length + findingIds.length + summaryIds.length > 0 ? [''] : []),
  ];
}

function recordTableMarkdown(block: Extract<ReportBlockV3, { type: 'record-table' }>): string[] {
  const includeRowLabel = block.rows.some(({ label }) => label);
  const headers = [
    ...(includeRowLabel ? ['项目'] : []),
    ...block.columns.map(({ label }) => label),
  ];
  const lines = [
    ...(block.title ? [`### ${block.title}`, ''] : []),
    `| ${headers.map(markdownCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ];
  for (const row of block.rows) {
    const cells = new Map(row.cells.map((cell) => [cell.columnKey, cell.value]));
    lines.push(`| ${[
      ...(includeRowLabel ? [row.label ?? '—'] : []),
      ...block.columns.map(({ key }) => cells.get(key) ?? null),
    ].map(markdownCell).join(' | ')} |`);
  }
  return [...lines, ''];
}

function reportBlockMarkdownStructured(
  document: ReportDocumentV3 | ReportDocumentV4,
  block: ReportBlockV4,
  assetPaths: ReadonlyMap<string, string>,
): string[] {
  const heading = block.title ? [`### ${block.title}`, ''] : [];
  const digest = block.digest ? [block.digest.text, ''] : [];
  let lines: string[];
  switch (block.type) {
    case 'paragraph':
    case 'fact':
      lines = [...heading, block.text, ''];
      break;
    case 'metric':
      lines = [...heading, `**${block.label}: ${block.value}${block.unit ? ` ${block.unit}` : ''}**`, ''];
      break;
    case 'list':
      lines = [
        ...heading,
        ...block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : '-'} ${item.label ? `**${item.label}：** ` : ''}${item.text}`),
        '',
      ];
      break;
    case 'answer':
      lines = [
        ...heading,
        block.text,
        '',
        ...block.items.map((item) => `- ${item.label ? `**${item.label}：** ` : ''}${item.text}`),
        ...(block.items.length > 0 ? [''] : []),
        ...(block.answerStatus ? [`Status: ${block.answerStatus}`, ''] : []),
      ];
      break;
    case 'image':
      lines = [
        ...heading,
        `![${block.altText}](${assetPaths.get(block.assetRef.assetId) ?? ''})`,
        '',
        `*${block.caption}*`,
        '',
      ];
      break;
    case 'image-comparison':
      lines = [
        ...heading,
        `![${block.altText} — 原图](${assetPaths.get(block.beforeAssetRef.assetId) ?? ''})`,
        '',
        `![${block.altText} — 标注图](${assetPaths.get(block.afterAssetRef.assetId) ?? ''})`,
        '',
        `*${block.caption}*`,
        '',
      ];
      break;
    case 'chart':
      lines = [
        ...heading,
        `![${block.altText}](${assetPaths.get(block.chartRef.assetId) ?? ''})`,
        '',
        ...tableMarkdown(block.table),
      ];
      break;
    case 'record-table':
      lines = recordTableMarkdown(block);
      break;
    case 'graph': {
      const nodeLabels = new Map(block.nodes.map((node) => [node.id, node.label]));
      lines = [
        ...heading,
        ...block.nodes.map((node) => `- **${node.label}**${node.description ? `：${node.description}` : ''}`),
        ...(block.edges.length > 0 ? ['', '**关系**', ''] : []),
        ...block.edges.map((edge) => `- ${nodeLabels.get(edge.from)} → ${nodeLabels.get(edge.to)}${edge.label ? `：${edge.label}` : ''}`),
        '',
      ];
      break;
    }
    case 'priority-board':
      lines = [
        ...heading,
        ...block.groups.flatMap((group) => [
          `#### ${group.priority}`,
          '',
          ...group.items.map((item) => `- **${item.action}**${item.owner ? ` · 负责人：${item.owner}` : ''}${item.rationale ? ` · ${item.rationale}` : ''}${item.validationMethod ? ` · 验证：${item.validationMethod}` : ''}`),
          '',
        ]),
      ];
      break;
    case 'card-grid':
      lines = [
        ...heading,
        ...block.cards.flatMap((card) => [
          `#### ${card.title}`,
          '',
          ...(card.status ? [`**状态：** ${card.status}`, ''] : []),
          ...(card.body ? [card.body, ''] : []),
        ]),
      ];
      break;
    case 'stage-flow':
      lines = [
        ...heading,
        ...block.stages.map((stage, index) => (
          `${index + 1}. **${stage.label}**${stage.timeLabel ? ` · ${stage.timeLabel}` : ''}${stage.description ? ` — ${stage.description}` : ''}`
        )),
        '',
      ];
      break;
  }
  return [...digest, ...lines, ...structuredTraceMarkdown(document, block.leafRefs)];
}

function reportMarkdownV3(
  document: ReportDocumentV3,
  assetPaths: ReadonlyMap<string, string>,
): string {
  const traversal = visitReportDocumentV3(document, {
    visitBlock(block) {
      return reportBlockMarkdownStructured(document, block, assetPaths);
    },
    visitSection(section, blocks) {
      return [`## ${section.title}`, '', ...blocks.flat()];
    },
    visitNotice({ code }) {
      return `- ${code}`;
    },
    visitAuditRecord(record) {
      return `| ${markdownCell(record.sourceUnitKey)} | ${record.disposition} | ${markdownCell(record.canonicalNodeIds.join('、') || '—')} | ${markdownCell(record.reasonCode ?? '—')} |`;
    },
  });
  const lines = [
    `# ${document.title}`,
    '',
    document.subtitle,
    '',
    '## 执行摘要 / Executive Summary',
    '',
    document.executiveSummary,
    '',
    ...(traversal.notices.length > 0 ? [
      '## 生成说明',
      '',
      ...traversal.notices,
      '',
    ] : []),
    ...traversal.sections.flat(),
    ...(traversal.auditRecords.length > 0 ? [
      '## 分析审计附录',
      '',
      '| 来源单元 | 处理结果 | Canonical 映射 | 说明 |',
      '| --- | --- | --- | --- |',
      ...traversal.auditRecords,
      '',
    ] : []),
  ];
  return `${lines.join('\n').trim()}\n`;
}

function reportMarkdownV4(
  document: ReportDocumentV4,
  assetPaths: ReadonlyMap<string, string>,
): string {
  const traversal = visitReportDocumentV4(document, {
    visitBlock(block) {
      return reportBlockMarkdownStructured(document, block, assetPaths);
    },
    visitSection(section, blocks) {
      return [
        `## ${section.title.text}`,
        '',
        ...(section.lead ? [section.lead.text, ''] : []),
        ...blocks.flat(),
        ...(section.transition ? [section.transition.text, ''] : []),
      ];
    },
    visitNotice({ code }) {
      return `- ${code}`;
    },
    visitAuditRecord(record) {
      return `| ${markdownCell(record.sourceUnitKey)} | ${record.disposition} | ${markdownCell(record.canonicalNodeIds.join('、') || '—')} | ${markdownCell(record.reasonCode ?? '—')} |`;
    },
  });
  const lines = [
    `# ${document.title.text}`,
    '',
    document.subtitle,
    '',
    '## 执行摘要 / Executive Summary',
    '',
    document.executiveSummary.text,
    '',
    ...(traversal.notices.length > 0 ? [
      '## 生成说明',
      '',
      ...traversal.notices,
      '',
    ] : []),
    ...traversal.sections.flat(),
    ...(traversal.auditRecords.length > 0 ? [
      '## 分析审计附录',
      '',
      '| 来源单元 | 处理结果 | Canonical 映射 | 说明 |',
      '| --- | --- | --- | --- |',
      ...traversal.auditRecords,
      '',
    ] : []),
  ];
  return `${lines.join('\n').trim()}\n`;
}

function reportMarkdown(
  document: ReadableReportDocument,
  manifests: ReadonlyMap<string, VisualAssetManifest>,
  assetPaths: ReadonlyMap<string, string>,
  evidenceIndexItems: readonly string[],
): string {
  if (isReportDocumentV4(document)) return reportMarkdownV4(document, assetPaths);
  if (isReportDocumentV3(document)) return reportMarkdownV3(document, assetPaths);
  const lines = [
    `# ${document.title}`,
    '',
    document.subtitle,
    '',
    '## 执行摘要 / Executive Summary',
    '',
    document.executiveSummary,
    '',
  ];
  const exportable = (assetId: string): boolean => {
    const manifest = manifests.get(assetId);
    return Boolean(manifest && manifest.exportPolicy !== 'block' && assetPaths.has(assetId));
  };
  for (const section of document.sections) {
    const sectionLines: string[] = [];
    for (const block of section.blocks) {
      if (block.type === 'paragraph') sectionLines.push(block.text, '');
      if (block.type === 'fact') {
        sectionLines.push(block.text, '', `Evidence: ${block.evidenceIds.join(', ')}`, '');
      }
      if (block.type === 'metric') {
        sectionLines.push(`**${block.label}: ${block.value}**`, '', `Evidence: ${block.evidenceIds.join(', ')}`, '');
      }
      if (block.type === 'list' || block.type === 'projection-list') {
        const items = section.id === 'appendix' && block.id === 'evidence-index'
          ? evidenceIndexItems
          : block.items;
        sectionLines.push(...items.map((item) => `- ${item}`), '');
      }
      if (block.type === 'answer') {
        sectionLines.push(`### ${block.title}`, '', block.text, '');
        if (block.items.length > 0) sectionLines.push(...block.items.map((item) => `- ${item}`), '');
        if (block.answerStatus) sectionLines.push(`Status: ${block.answerStatus}`, '');
        if (block.evidenceIds.length > 0) sectionLines.push(`Evidence: ${block.evidenceIds.join(', ')}`, '');
        if (block.findingIds.length > 0) sectionLines.push(`Findings: ${block.findingIds.join(', ')}`, '');
        if (block.summaryIds.length > 0) sectionLines.push(`Summaries: ${block.summaryIds.join(', ')}`, '');
        if (typeof block.confidence === 'number') sectionLines.push(`Confidence: ${Math.round(block.confidence * 100)}%`, '');
      }
      if (block.type === 'image' && exportable(block.assetRef.assetId)) {
        sectionLines.push(
          `![${block.altText}](${assetPaths.get(block.assetRef.assetId)})`,
          '',
          `*${block.caption}*`,
          '',
          ...evidenceMarkdown(block.evidenceIds),
        );
      }
      if (
        block.type === 'image-comparison'
        && exportable(block.beforeAssetRef.assetId)
        && exportable(block.afterAssetRef.assetId)
      ) {
        sectionLines.push(
          `![${block.altText} — original](${assetPaths.get(block.beforeAssetRef.assetId)})`,
          '',
          `![${block.altText} — annotation](${assetPaths.get(block.afterAssetRef.assetId)})`,
          '',
          `*${block.caption}*`,
          '',
          ...evidenceMarkdown(block.evidenceIds),
        );
      }
      if (block.type === 'chart' && exportable(block.chartRef.assetId)) {
        sectionLines.push(
          `![${block.altText}](${assetPaths.get(block.chartRef.assetId)})`,
          '',
          ...tableMarkdown(block.table),
        );
      }
    }
    if (sectionLines.length > 0) lines.push(`## ${section.title}`, '', ...sectionLines);
  }
  return `${lines.join('\n').trim()}\n`;
}

function answerBlocksMarkdown(document: ReadableReportDocument, includeAnalysis: boolean): string {
  if (isReportDocumentV4(document)) {
    const lines = [`# ${document.title.text}`, ''];
    for (const section of document.sections) {
      const blocks = section.blocks.filter((block) => block.type === 'answer' && (
        includeAnalysis
          ? block.kind === 'evidence_finding' || block.kind === 'risk'
          : block.kind !== 'evidence_finding' && block.kind !== 'risk'
      ));
      if (blocks.length === 0) continue;
      lines.push(`## ${section.title.text}`, '');
      if (section.lead) lines.push(section.lead.text, '');
      for (const block of blocks) {
        if (block.type !== 'answer') continue;
        if (block.digest) lines.push(block.digest.text, '');
        if (block.title) lines.push(`### ${block.title}`, '');
        lines.push(block.text, '');
        lines.push(...block.items.map((item) => `- ${item.label ? `**${item.label}：** ` : ''}${item.text}`), '');
        if (block.answerStatus) lines.push(`Status: ${block.answerStatus}`, '');
      }
      if (section.transition) lines.push(section.transition.text, '');
    }
    return `${lines.join('\n').trim()}\n`;
  }
  if (isReportDocumentV3(document)) {
    const lines = [`# ${document.title}`, ''];
    for (const section of document.sections) {
      const blocks = section.blocks.filter((block) => block.type === 'answer' && (
        includeAnalysis
          ? block.kind === 'evidence_finding' || block.kind === 'risk'
          : block.kind !== 'evidence_finding' && block.kind !== 'risk'
      ));
      if (blocks.length === 0) continue;
      lines.push(`## ${section.title}`, '');
      for (const block of blocks) {
        if (block.type !== 'answer') continue;
        if (block.title) lines.push(`### ${block.title}`, '');
        lines.push(block.text, '');
        lines.push(...block.items.map((item) => `- ${item.label ? `**${item.label}：** ` : ''}${item.text}`), '');
        if (block.answerStatus) lines.push(`Status: ${block.answerStatus}`, '');
      }
    }
    return `${lines.join('\n').trim()}\n`;
  }
  const lines = [`# ${document.title}`, ''];
  for (const section of document.sections) {
    const blocks = section.blocks.filter((block) => block.type === 'answer' && (
      includeAnalysis
        ? block.kind === 'evidence_finding' || block.kind === 'risk'
        : block.kind !== 'evidence_finding' && block.kind !== 'risk'
    ));
    if (blocks.length === 0) continue;
    lines.push(`## ${section.title}`, '');
    for (const block of blocks) {
      if (block.type !== 'answer') continue;
      lines.push(`### ${block.title}`, '', block.text, '');
      lines.push(...block.items.map((item) => `- ${item}`), '');
      if (block.answerStatus) lines.push(`Status: ${block.answerStatus}`, '');
      if (block.evidenceIds.length > 0) lines.push(`Evidence: ${block.evidenceIds.join(', ')}`, '');
      if (block.findingIds.length > 0) lines.push(`Findings: ${block.findingIds.join(', ')}`, '');
      if (block.summaryIds.length > 0) lines.push(`Summaries: ${block.summaryIds.join(', ')}`, '');
      if (typeof block.confidence === 'number') lines.push(`Confidence: ${Math.round(block.confidence * 100)}%`, '');
    }
  }
  return `${lines.join('\n').trim()}\n`;
}

function createMarkdownRenderManifest(
  document: ReadableReportDocument,
  sourceReportDocumentContentSha256: string,
) {
  if (isReportDocumentV4(document)) {
    const semantics = visitReportDocumentV4(document, {
      visitBlock(block) { return block.id; },
      visitSection(section, blocks) { return `${section.id}:${blocks.join(',')}`; },
      visitNotice(notice) { return notice.id; },
      visitAuditRecord(record) { return record.id; },
    }).semantics;
    return createReportRenderManifestV2({
      renderer: 'markdown',
      rendererVersion: 'markdown-bundle-v2',
      sourceReportDocumentContentSha256,
      document,
      semantics,
    });
  }
  if (!isReportDocumentV3(document)) return undefined;
  const semantics = visitReportDocumentV3(document, {
    visitBlock(block) { return block.id; },
    visitSection(section, blocks) { return `${section.id}:${blocks.join(',')}`; },
    visitNotice(notice) { return notice.id; },
    visitAuditRecord(record) { return record.id; },
  }).semantics;
  return createReportRenderManifestV1({
    renderer: 'markdown',
    rendererVersion: 'markdown-bundle-v1',
    sourceReportDocumentContentSha256,
    document,
    semantics,
  });
}

export async function createReportBundle({ report, readAsset }: CreateReportBundleInput): Promise<Uint8Array> {
  assertCompleteBundlePackage(report);
  const taskId = report.deliverable.taskId;
  if (typeof taskId !== 'string' || !taskId) throw new Error('report bundle requires a Task binding');
  const manifests = report.presentationMode === 'multimodal'
    ? [...report.visualAssetManifests].sort((left, right) => left.assetId.localeCompare(right.assetId))
    : [];
  const manifestByAsset = new Map(manifests.map((manifest) => [manifest.assetId, manifest]));
  const exportable = manifests;
  const assetPaths = new Map<string, string>();
  const usedPaths = new Set<string>();
  for (const manifest of exportable) {
    const path = deterministicAssetPath(manifest);
    if (usedPaths.has(path)) throw new Error(`sanitized visual Asset filename collision: ${path}`);
    usedPaths.add(path);
    assetPaths.set(manifest.assetId, path);
  }
  const readAssets = await Promise.all(exportable.map(async (manifest) => {
    const result = await readAsset({ taskId, assetId: manifest.assetId });
    if (result.mediaType !== manifest.mediaType) {
      throw new Error(`owner-read visual Asset ${manifest.assetId} media type does not match its Manifest`);
    }
    return { path: assetPaths.get(manifest.assetId)!, bytes: result.bytes };
  }));

  const visualAssets = exportable.map(({ assetId, byteSize, exportPolicy, height, mediaType, width }) => ({
    assetId,
    byteSize,
    exportPolicy,
    height,
    mediaType,
    width,
  }));
  const evidenceIndexItems = report.evidenceManifest.entries.map((entry) =>
    `${entry.id}: ${entry.evidenceClass} Evidence.`);
  const summaryMarkdown = report.presentationMode === 'multimodal'
    ? reportMarkdown(
        report.reportDocument,
        manifestByAsset,
        assetPaths,
        evidenceIndexItems,
      )
    : report.deliverable.deliverableType === 'research_plan'
      ? currentResearchPlanToMarkdown(report as unknown as CurrentResearchPlanResponse)
      : `# ${report.deliverable.deliverableType}\n\n${report.deliverable.methodSummary}\n\n\`\`\`json\n${JSON.stringify(report.deliverable.payload, null, 2)}\n\`\`\`\n`;
  const fullMarkdown = summaryMarkdown;
  const renderManifest = report.presentationMode === 'multimodal'
    ? createMarkdownRenderManifest(report.reportDocument, report.reportDocumentContentSha256)
    : undefined;
  const entries = new Map<string, Uint8Array>([
    ...(report.presentationMode === 'multimodal'
      ? [
          ['assets/', new Uint8Array()] as const,
          ...readAssets.map(({ path, bytes }) => [path, bytes] as const),
        ]
      : []),
    ['deliverable.json', jsonBytes(safeDeliverable(report.deliverable))],
    ['evidence-manifest.json', jsonBytes(safeEvidenceManifest(report.evidenceManifest))],
    ...(report.presentationMode === 'multimodal'
      ? [['report-document.json', jsonBytes(safeReportDocument(
          report.reportDocument,
          new Set(exportable.map(({ assetId }) => assetId)),
          evidenceIndexItems,
        ))] as const]
      : []),
    ['report-review.json', jsonBytes(safeReportReview(report.reportReview))],
    ...(report.contributionSummary
      ? [['contribution-summary.json', jsonBytes(safeContributionSummary(report.contributionSummary))] as const]
      : []),
    ...(report.contributionLedger
      ? [['contribution-ledger.json', jsonBytes(safeContributionLedger(report.contributionLedger))] as const]
      : []),
    ['full-report.md', strToU8(fullMarkdown)],
    ...(report.presentationMode === 'multimodal' && report.deliverable.deliverableType === 'research_strategy_report'
      ? [
          ['direct-answers.md', strToU8(answerBlocksMarkdown(report.reportDocument, false))] as const,
          ['analysis-notes.md', strToU8(answerBlocksMarkdown(report.reportDocument, true))] as const,
        ]
      : []),
    ['summary-report.md', strToU8(summaryMarkdown)],
    ['report.md', strToU8(fullMarkdown)],
    ...(report.presentationMode === 'multimodal'
      ? [['visual-assets.json', jsonBytes(visualAssets)] as const]
      : []),
    ...(renderManifest
      ? [['render-manifest.json', jsonBytes(renderManifest)] as const]
      : []),
  ]);
  const sortedEntries = Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
  return zipSync(sortedEntries, { level: 9, mtime: new Date('1980-01-01T00:00:00.000Z') });
}
