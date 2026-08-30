import type {
  RenderableReportDocument,
  ReportAnswerKindV3,
  ReportAuditAppendixV1,
  ReportBlockV3,
  ReportBlockV4,
  ReportCardGridBlockV4,
  ReportChartTableAlternativeV3,
  ReportDocumentV1V2,
  ReportDocumentV3,
  ReportDocumentV4,
  ReportEditorialCopyFragmentV4,
  ReportGraphBlockV3,
  ReportNoticeV1,
  ReportPriorityBoardBlockV3,
  ReportRecordTableBlockV3,
  ReportSectionV1V2,
  ReportSemanticManifestV1,
  ReportSemanticManifestV2,
  ReportStageFlowBlockV4,
  ReportViewIdV1,
  ReportVisibilityV1,
} from '../../../../packages/api-contract/report-document.ts';
import {
  isReportDocumentV3,
  isReportDocumentV4,
} from '../../../../packages/api-contract/report-document.ts';
import type {
  ChartSpec,
  VisualAssetManifest,
} from '../../../../packages/api-contract/research-deliverable.ts';
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

export type ReportViewBlockKind =
  | 'paragraph'
  | 'metric'
  | 'table'
  | 'record-table'
  | 'graph'
  | 'priority-board'
  | 'card-grid'
  | 'stage-flow'
  | 'chart'
  | 'image'
  | 'comparison'
  | 'evidence'
  | 'recommendation'
  | 'risk'
  | 'answer'
  | 'list';

export interface ReportViewListItem {
  id: string;
  leafRef: string;
  label?: string;
  text: string;
}

export interface ReportViewBlock {
  id: string;
  kind: ReportViewBlockKind;
  title?: string;
  visibility?: ReportVisibilityV1;
  unitRefs?: string[];
  leafRefs?: string[];
  primaryLeafRef?: string;
  text?: string;
  label?: string;
  value?: number;
  unit?: string;
  items?: string[];
  listItems?: ReportViewListItem[];
  ordered?: boolean;
  evidenceIds?: string[];
  findingIds?: string[];
  summaryIds?: string[];
  answerKind?: ReportAnswerKindV3;
  confidence?: number;
  answerStatus?: 'supported' | 'provisional' | 'unanswered';
  spec?: ChartSpec;
  table?: ReportChartTableAlternativeV3;
  recordTable?: Pick<ReportRecordTableBlockV3, 'columns' | 'rows'>;
  graph?: Pick<ReportGraphBlockV3, 'variant' | 'nodes' | 'edges'>;
  priorityGroups?: ReportPriorityBoardBlockV3['groups'];
  cards?: ReportCardGridBlockV4['cards'];
  stages?: ReportStageFlowBlockV4['stages'];
  digest?: ReportEditorialCopyFragmentV4;
  assetId?: string;
  assetSrc?: string;
  originalAssetId?: string;
  annotationAssetId?: string;
  originalSrc?: string;
  annotationSrc?: string;
  caption?: string;
  altText?: string;
}

export interface ReportDocumentViewModel {
  title: string;
  subtitle: string;
  executiveSummary: string;
  version?: 'report-document-v3' | 'report-document-v4';
  style?: ReportDocumentV3['style'];
  density?: ReportDocumentV3['density'];
  copyMode?: ReportDocumentV4['copyMode'];
  titleCopy?: ReportEditorialCopyFragmentV4;
  executiveSummaryCopy?: ReportEditorialCopyFragmentV4;
  navigation: Array<{ id: string; title: string; view?: ReportViewIdV1 }>;
  sections: Array<{
    id: string;
    title: string;
    view?: ReportViewIdV1;
    prominence?: 'primary' | 'supporting' | 'appendix';
    titleCopy?: ReportEditorialCopyFragmentV4;
    lead?: ReportEditorialCopyFragmentV4;
    transition?: ReportEditorialCopyFragmentV4;
    questionIds: string[];
    blocks: ReportViewBlock[];
  }>;
  notices?: ReportNoticeV1[];
  auditAppendix?: ReportAuditAppendixV1;
  semantics?: ReportSemanticManifestV1 | ReportSemanticManifestV2;
  renderManifest?: ReportRenderManifestV1 | ReportRenderManifestV2;
}

export interface ReportDocumentViewModelInput {
  document: RenderableReportDocument;
  visualAssetManifests: VisualAssetManifest[];
  assetUrl(input: { assetId: string }): string;
  sourceReportDocumentContentSha256?: string;
}

export interface ReportTableShape {
  headers: Array<{ id: string; label: string; scope: 'col' }>;
  rows: Array<{
    key: string;
    header: { id: string; label: string; scope: 'row'; headers: string[] };
    cells: Array<{ value: number | null; headers: string[] }>;
  }>;
}

export function createReportTableShape(
  table: ReportChartTableAlternativeV3,
  idPrefix = 'report-table',
): ReportTableShape {
  if (table.columns.length === 0) throw new Error('report table requires at least one sealed column');
  const headers = table.columns.map((label, index) => ({
    id: `${idPrefix}-column-${index + 1}`,
    label,
    scope: 'col' as const,
  }));
  return {
    headers,
    rows: table.rows.map((row, rowIndex) => {
      if (row.cells.length + 1 !== headers.length) {
        throw new Error(`report table row ${row.key} does not match its sealed column count`);
      }
      const header = {
        id: `${idPrefix}-row-${rowIndex + 1}`,
        label: row.label,
        scope: 'row' as const,
        headers: [headers[0]!.id],
      };
      return {
        key: row.key,
        header,
        cells: row.cells.map((value, index) => ({
          value,
          headers: [header.id, headers[index + 1]!.id],
        })),
      };
    }),
  };
}

function sectionParagraphKind(section: ReportSectionV1V2): ReportViewBlockKind {
  if (section.id === 'recommendations') return 'recommendation';
  if (section.id === 'risks') return 'risk';
  return 'paragraph';
}

function createAssetUrlResolver(
  visualAssetManifests: readonly VisualAssetManifest[],
  assetUrl: (input: { assetId: string }) => string,
): (assetId: string) => string | undefined {
  const manifests = new Map(visualAssetManifests.map((manifest) => [manifest.assetId, manifest]));
  return (assetId) => {
    const manifest = manifests.get(assetId);
    return manifest && manifest.exportPolicy !== 'block' ? assetUrl({ assetId }) : undefined;
  };
}

function createLegacyViewModel(
  document: ReportDocumentV1V2,
  presentationUrl: (assetId: string) => string | undefined,
): ReportDocumentViewModel {
  return {
    title: document.title,
    subtitle: document.subtitle,
    executiveSummary: document.executiveSummary,
    navigation: document.sections.map(({ id, title }) => ({ id, title })),
    sections: document.sections.map((section) => {
      const blocks: ReportViewBlock[] = [];
      for (const block of section.blocks) {
        if (block.type === 'paragraph') {
          blocks.push({ id: block.id, kind: sectionParagraphKind(section), text: block.text });
        } else if (block.type === 'fact') {
          blocks.push({ id: block.id, kind: 'evidence', text: block.text, evidenceIds: block.evidenceIds });
        } else if (block.type === 'metric') {
          blocks.push({
            id: block.id,
            kind: 'metric',
            label: block.label,
            value: block.value,
            evidenceIds: block.evidenceIds,
          });
        } else if (block.type === 'list' || block.type === 'projection-list') {
          blocks.push({
            id: block.id,
            kind: section.id === 'appendix' ? 'evidence' : 'list',
            items: block.items,
          });
        } else if (block.type === 'answer') {
          blocks.push({
            id: block.id,
            kind: 'answer',
            label: block.title,
            text: block.text,
            items: block.items,
            evidenceIds: block.evidenceIds,
            findingIds: block.findingIds,
            summaryIds: block.summaryIds,
            answerKind: block.kind,
            answerStatus: block.answerStatus,
            confidence: block.confidence,
          });
        } else if (block.type === 'image') {
          blocks.push({
            id: block.id,
            kind: 'image',
            assetId: block.assetRef.assetId,
            assetSrc: presentationUrl(block.assetRef.assetId),
            caption: block.caption,
            altText: block.altText,
            ...(block.evidenceIds ? { evidenceIds: block.evidenceIds } : {}),
          });
        } else if (block.type === 'image-comparison') {
          blocks.push({
            id: block.id,
            kind: 'comparison',
            originalAssetId: block.beforeAssetRef.assetId,
            annotationAssetId: block.afterAssetRef.assetId,
            originalSrc: presentationUrl(block.beforeAssetRef.assetId),
            annotationSrc: presentationUrl(block.afterAssetRef.assetId),
            caption: block.caption,
            altText: block.altText,
            ...(block.evidenceIds ? { evidenceIds: block.evidenceIds } : {}),
          });
        } else if (block.type === 'chart') {
          blocks.push({
            id: block.id,
            kind: 'chart',
            spec: block.spec,
            table: block.table,
            assetId: block.chartRef.assetId,
            assetSrc: presentationUrl(block.chartRef.assetId),
            caption: block.caption,
            altText: block.altText,
            evidenceIds: [...new Set(block.spec.series.flatMap(({ evidenceIds }) => evidenceIds.flat()))],
          });
          blocks.push({ id: `${block.id}-table`, kind: 'table', table: block.table });
        }
      }
      return { id: section.id, title: section.title, questionIds: section.questionIds, blocks };
    }),
  };
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function traceSummary(document: ReportDocumentV3 | ReportDocumentV4, leafRefs: readonly string[]): Pick<
  ReportViewBlock,
  'answerStatus' | 'confidence' | 'evidenceIds' | 'findingIds' | 'summaryIds'
> & { questionIds: string[] } {
  const traces = leafRefs.map((leafRef) => document.traceIndex[leafRef]!);
  const confidences = traces.flatMap(({ confidence }) => confidence === undefined ? [] : [confidence]);
  const statuses = traces.flatMap(({ status }) => status === undefined ? [] : [status]);
  const answerStatus = statuses.includes('unanswered')
    ? 'unanswered'
    : statuses.includes('provisional')
      ? 'provisional'
      : statuses.includes('supported')
        ? 'supported'
        : undefined;
  return {
    evidenceIds: stableUnique(traces.flatMap(({ evidenceIds }) => evidenceIds)),
    findingIds: stableUnique(traces.flatMap(({ findingIds }) => findingIds)),
    summaryIds: stableUnique(traces.flatMap(({ summaryIds }) => summaryIds)),
    questionIds: stableUnique(traces.flatMap(({ questionIds }) => questionIds)),
    ...(confidences.length > 0 ? { confidence: Math.min(...confidences) } : {}),
    ...(answerStatus ? { answerStatus } : {}),
  };
}

function createStructuredBlockView(
  document: ReportDocumentV3 | ReportDocumentV4,
  block: ReportBlockV3 | ReportBlockV4,
  presentationUrl: (assetId: string) => string | undefined,
): ReportViewBlock {
  const trace = traceSummary(document, block.leafRefs);
  const base: ReportViewBlock = {
    id: block.id,
    kind: 'paragraph',
    title: block.title,
    visibility: block.visibility,
    unitRefs: block.unitRefs,
    leafRefs: block.leafRefs,
    evidenceIds: trace.evidenceIds,
    findingIds: trace.findingIds,
    summaryIds: trace.summaryIds,
    confidence: trace.confidence,
    answerStatus: trace.answerStatus,
    ...('digest' in block && block.digest ? { digest: block.digest } : {}),
  };
  switch (block.type) {
    case 'paragraph':
      return { ...base, kind: 'paragraph', primaryLeafRef: block.leafRef, text: block.text };
    case 'fact':
      return { ...base, kind: 'evidence', primaryLeafRef: block.leafRef, text: block.text };
    case 'metric':
      return {
        ...base,
        kind: 'metric',
        primaryLeafRef: block.leafRef,
        label: block.label,
        value: block.value,
        unit: block.unit,
      };
    case 'list':
      return {
        ...base,
        kind: 'list',
        ordered: block.ordered,
        items: block.items.map(({ text }) => text),
        listItems: block.items,
      };
    case 'answer':
      return {
        ...base,
        kind: 'answer',
        label: block.title,
        primaryLeafRef: block.textLeafRef,
        text: block.text,
        items: block.items.map(({ text }) => text),
        listItems: block.items,
        answerKind: block.kind,
        answerStatus: block.answerStatus ?? trace.answerStatus,
      };
    case 'image':
      return {
        ...base,
        kind: 'image',
        primaryLeafRef: block.leafRef,
        assetId: block.assetRef.assetId,
        assetSrc: presentationUrl(block.assetRef.assetId),
        caption: block.caption,
        altText: block.altText,
      };
    case 'image-comparison':
      return {
        ...base,
        kind: 'comparison',
        originalAssetId: block.beforeAssetRef.assetId,
        annotationAssetId: block.afterAssetRef.assetId,
        originalSrc: presentationUrl(block.beforeAssetRef.assetId),
        annotationSrc: presentationUrl(block.afterAssetRef.assetId),
        caption: block.caption,
        altText: block.altText,
      };
    case 'chart':
      return {
        ...base,
        kind: 'chart',
        primaryLeafRef: block.leafRef,
        spec: block.spec,
        table: block.table,
        assetId: block.chartRef.assetId,
        assetSrc: presentationUrl(block.chartRef.assetId),
        caption: block.caption,
        altText: block.altText,
      };
    case 'record-table':
      return {
        ...base,
        kind: 'record-table',
        recordTable: { columns: block.columns, rows: block.rows },
      };
    case 'graph':
      return {
        ...base,
        kind: 'graph',
        graph: { variant: block.variant, nodes: block.nodes, edges: block.edges },
      };
    case 'priority-board':
      return { ...base, kind: 'priority-board', priorityGroups: block.groups };
    case 'card-grid':
      return { ...base, kind: 'card-grid', cards: block.cards };
    case 'stage-flow':
      return { ...base, kind: 'stage-flow', stages: block.stages };
  }
}

function createV3ViewModel(
  document: ReportDocumentV3,
  presentationUrl: (assetId: string) => string | undefined,
  sourceReportDocumentContentSha256?: string,
): ReportDocumentViewModel {
  const traversal = visitReportDocumentV3<
    ReportViewBlock,
    ReportDocumentViewModel['sections'][number],
    ReportNoticeV1,
    ReportAuditAppendixV1['records'][number]
  >(document, {
    visitBlock(block) {
      return createStructuredBlockView(document, block, presentationUrl);
    },
    visitSection(section, blocks) {
      const questionIds = stableUnique(section.blocks.flatMap((block) => (
        traceSummary(document, block.leafRefs).questionIds
      )));
      return {
        id: section.id,
        title: section.title,
        view: section.view,
        prominence: section.prominence,
        questionIds,
        blocks,
      };
    },
    visitNotice(notice) {
      return notice;
    },
    visitAuditRecord(record) {
      return record;
    },
  });

  return {
    title: document.title,
    subtitle: document.subtitle,
    executiveSummary: document.executiveSummary,
    version: document.version,
    style: document.style,
    density: document.density,
    navigation: document.sections.map(({ id, title, view }) => ({ id, title, view })),
    sections: traversal.sections,
    notices: traversal.notices,
    auditAppendix: document.auditAppendix
      ? { ...document.auditAppendix, records: traversal.auditRecords }
      : undefined,
    semantics: traversal.semantics,
    ...(sourceReportDocumentContentSha256 === undefined ? {} : {
      renderManifest: createReportRenderManifestV1({
        renderer: 'react',
        rendererVersion: 'react-report-document-v3',
        sourceReportDocumentContentSha256,
        document,
        semantics: traversal.semantics,
      }),
    }),
  };
}

function createV4ViewModel(
  document: ReportDocumentV4,
  presentationUrl: (assetId: string) => string | undefined,
  sourceReportDocumentContentSha256?: string,
): ReportDocumentViewModel {
  const traversal = visitReportDocumentV4<
    ReportViewBlock,
    ReportDocumentViewModel['sections'][number],
    ReportNoticeV1,
    ReportAuditAppendixV1['records'][number]
  >(document, {
    visitBlock(block) {
      return createStructuredBlockView(document, block, presentationUrl);
    },
    visitSection(section, blocks) {
      const questionIds = stableUnique(section.blocks.flatMap((block) => (
        traceSummary(document, block.leafRefs).questionIds
      )));
      return {
        id: section.id,
        title: section.title.text,
        titleCopy: section.title,
        lead: section.lead,
        transition: section.transition,
        view: section.view,
        prominence: section.prominence,
        questionIds,
        blocks,
      };
    },
    visitNotice(notice) {
      return notice;
    },
    visitAuditRecord(record) {
      return record;
    },
  });

  return {
    title: document.title.text,
    subtitle: document.subtitle,
    executiveSummary: document.executiveSummary.text,
    version: document.version,
    style: document.style,
    density: document.density,
    copyMode: document.copyMode,
    titleCopy: document.title,
    executiveSummaryCopy: document.executiveSummary,
    navigation: document.sections.map(({ id, title, view }) => ({ id, title: title.text, view })),
    sections: traversal.sections,
    notices: traversal.notices,
    auditAppendix: document.auditAppendix
      ? { ...document.auditAppendix, records: traversal.auditRecords }
      : undefined,
    semantics: traversal.semantics,
    ...(sourceReportDocumentContentSha256 === undefined ? {} : {
      renderManifest: createReportRenderManifestV2({
        renderer: 'react',
        rendererVersion: 'react-report-document-v4',
        sourceReportDocumentContentSha256,
        document,
        semantics: traversal.semantics,
      }),
    }),
  };
}

export function createReportDocumentViewModel({
  document,
  visualAssetManifests,
  assetUrl,
  sourceReportDocumentContentSha256,
}: ReportDocumentViewModelInput): ReportDocumentViewModel {
  const presentationUrl = createAssetUrlResolver(visualAssetManifests, assetUrl);
  if (isReportDocumentV4(document)) {
    return createV4ViewModel(document, presentationUrl, sourceReportDocumentContentSha256);
  }
  if (isReportDocumentV3(document)) {
    return createV3ViewModel(document, presentationUrl, sourceReportDocumentContentSha256);
  }
  return createLegacyViewModel(document, presentationUrl);
}
