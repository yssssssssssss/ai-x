import { strToU8, zipSync } from 'fflate';
import type { CurrentReportPackageResponse } from '../../../../packages/api-contract/control-workflow.ts';
import type {
  EvidenceManifest,
  VisualAssetManifest,
  VisualAssetReference,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type {
  ReportBlock,
  ReportDocument,
} from '../../../orchestrator-runtime/src/report/report-document-composer.ts';
import type { ChartTableAlternative } from '../../../orchestrator-runtime/src/report/chart-renderer.ts';
import { assertVisualAssetManifest } from '../report-package-response.ts';

interface BundleAssetReadResult {
  bytes: Uint8Array;
  mediaType: VisualAssetManifest['mediaType'];
}

type MultimodalReportPackage = Extract<CurrentReportPackageResponse, { presentationMode: 'multimodal' }>;

export interface CreateReportBundleInput {
  report: MultimodalReportPackage;
  readAsset(input: { taskId: string; assetId: string }): Promise<BundleAssetReadResult>;
}

const MEDIA_EXTENSION: Record<VisualAssetManifest['mediaType'], string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

function assetReferences(document: ReportDocument): VisualAssetReference[] {
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
  for (const block of document.sections.flatMap(({ blocks }) => blocks)) {
    if (block.type === 'image') append(block.assetRef);
    if (block.type === 'image-comparison') {
      append(block.beforeAssetRef);
      append(block.afterAssetRef);
    }
    if (block.type === 'chart') append(block.chartRef);
  }
  return references;
}

function assertCompleteMultimodalPackage(report: MultimodalReportPackage): void {
  if (report.presentationMode !== 'multimodal') {
    throw new Error('report bundle requires multimodal presentation mode');
  }
  if (!report.reportDocument || report.reportDocument.version !== 'report-document-v1') {
    throw new Error('report bundle requires a complete ReportDocument');
  }
  if (!Array.isArray(report.visualAssetManifests)) {
    throw new Error('report bundle requires visual Asset Manifests');
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

function safeReview(review: MultimodalReportPackage['reportReview']): Record<string, unknown> {
  return {
    version: review.version,
    taskId: review.taskId,
    planVersionId: review.planVersionId,
    attemptId: review.attemptId,
    verdict: review.verdict,
    dimensions: review.dimensions.map(({ id, passed, issues }) => ({ id, passed, issues })),
    revisionRound: review.revisionRound,
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
  if (block.type === 'list') {
    return {
      id: block.id,
      type: block.type,
      items: evidenceIndexItems ? [...evidenceIndexItems] : block.items,
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
  document: ReportDocument,
  exportableAssetIds: ReadonlySet<string>,
  evidenceIndexItems: readonly string[],
): Record<string, unknown> {
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

function markdownCell(value: string | number | null): string {
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

function reportMarkdown(
  document: ReportDocument,
  manifests: ReadonlyMap<string, VisualAssetManifest>,
  assetPaths: ReadonlyMap<string, string>,
  evidenceIndexItems: readonly string[],
): string {
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
      if (block.type === 'list') {
        const items = section.id === 'appendix' && block.id === 'evidence-index'
          ? evidenceIndexItems
          : block.items;
        sectionLines.push(...items.map((item) => `- ${item}`), '');
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

export async function createReportBundle({ report, readAsset }: CreateReportBundleInput): Promise<Uint8Array> {
  assertCompleteMultimodalPackage(report);
  const taskId = report.deliverable.taskId;
  if (typeof taskId !== 'string' || !taskId) throw new Error('report bundle requires a Task binding');
  const manifests = [...report.visualAssetManifests]
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
  const manifestByAsset = new Map(manifests.map((manifest) => [manifest.assetId, manifest]));
  const exportable = manifests.filter(({ exportPolicy }) => exportPolicy === 'allow' || exportPolicy === 'mask');
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
  const entries = new Map<string, Uint8Array>([
    ['assets/', new Uint8Array()],
    ...readAssets.map(({ path, bytes }) => [path, bytes] as const),
    ['evidence-manifest.json', jsonBytes(safeEvidenceManifest(report.evidenceManifest))],
    ['report-document.json', jsonBytes(safeReportDocument(
      report.reportDocument,
      new Set(exportable.map(({ assetId }) => assetId)),
      evidenceIndexItems,
    ))],
    ['report-review.json', jsonBytes(safeReview(report.reportReview))],
    ['report.md', strToU8(reportMarkdown(
      report.reportDocument,
      manifestByAsset,
      assetPaths,
      evidenceIndexItems,
    ))],
    ['visual-assets.json', jsonBytes(visualAssets)],
  ]);
  const sortedEntries = Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
  return zipSync(sortedEntries, { level: 9, mtime: new Date('1980-01-01T00:00:00.000Z') });
}
