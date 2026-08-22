import type {
  ChartSpec,
  VisualAssetManifest,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type {
  ReportDocument,
  ReportSection,
} from '../../../orchestrator-runtime/src/report/report-document-composer.ts';
import type { ChartTableAlternative } from '../../../orchestrator-runtime/src/report/chart-renderer.ts';

export type ReportViewBlockKind =
  | 'paragraph'
  | 'metric'
  | 'table'
  | 'chart'
  | 'image'
  | 'comparison'
  | 'evidence'
  | 'recommendation'
  | 'risk'
  | 'list';

export interface ReportViewBlock {
  id: string;
  kind: ReportViewBlockKind;
  text?: string;
  label?: string;
  value?: number;
  items?: string[];
  evidenceIds?: string[];
  spec?: ChartSpec;
  table?: ChartTableAlternative;
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
  navigation: Array<{ id: string; title: string }>;
  sections: Array<{
    id: string;
    title: string;
    questionIds: string[];
    blocks: ReportViewBlock[];
  }>;
}

export interface ReportDocumentViewModelInput {
  document: ReportDocument;
  visualAssetManifests: VisualAssetManifest[];
  assetUrl(input: { assetId: string }): string;
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
  table: ChartTableAlternative,
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

function sectionParagraphKind(section: ReportSection): ReportViewBlockKind {
  if (section.id === 'recommendations') return 'recommendation';
  if (section.id === 'risks') return 'risk';
  return 'paragraph';
}

export function createReportDocumentViewModel({
  document,
  visualAssetManifests,
  assetUrl,
}: ReportDocumentViewModelInput): ReportDocumentViewModel {
  const manifests = new Map(visualAssetManifests.map((manifest) => [manifest.assetId, manifest]));
  const presentationUrl = (assetId: string): string | undefined => {
    const manifest = manifests.get(assetId);
    return manifest && manifest.exportPolicy !== 'block' ? assetUrl({ assetId }) : undefined;
  };
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
