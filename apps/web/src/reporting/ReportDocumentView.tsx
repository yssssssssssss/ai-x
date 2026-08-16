import { useId, useMemo, useReducer } from 'react';
import type { ChartSpec, VisualAssetManifest } from '../../../../packages/api-contract/research-deliverable.ts';
import type {
  ReportDocument,
  ReportSection,
} from '../../../orchestrator-runtime/src/report/report-document-composer.ts';
import type { ChartTableAlternative } from '../../../orchestrator-runtime/src/report/chart-renderer.ts';
import { ChartBlock } from './ChartBlock.tsx';
import { ImageBlock, VerifiedAssetImage, type ReportAssetLoader } from './ImageBlock.tsx';
import { ImageComparisonBlock } from './ImageComparisonBlock.tsx';
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

interface ReportDocumentViewModelInput {
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
        } else if (block.type === 'list') {
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

export interface ReportDocumentInteractionState {
  expandedEvidence: ReadonlySet<string>;
  imageVariants: Readonly<Record<string, 'original' | 'annotation'>>;
  imageZoom: Readonly<Record<string, number>>;
}

export type ReportDocumentInteractionAction =
  | { type: 'toggle-evidence'; blockId: string }
  | { type: 'select-image-variant'; blockId: string; variant: 'original' | 'annotation' }
  | { type: 'set-image-zoom'; blockId: string; zoom: number };

export function createReportDocumentInteractionState(): ReportDocumentInteractionState {
  return { expandedEvidence: new Set(), imageVariants: {}, imageZoom: {} };
}

export function reduceReportDocumentInteraction(
  state: ReportDocumentInteractionState,
  action: ReportDocumentInteractionAction,
): ReportDocumentInteractionState {
  if (action.type === 'toggle-evidence') {
    const expandedEvidence = new Set(state.expandedEvidence);
    if (expandedEvidence.has(action.blockId)) expandedEvidence.delete(action.blockId);
    else expandedEvidence.add(action.blockId);
    return { ...state, expandedEvidence };
  }
  if (action.type === 'select-image-variant') {
    return { ...state, imageVariants: { ...state.imageVariants, [action.blockId]: action.variant } };
  }
  return {
    ...state,
    imageZoom: { ...state.imageZoom, [action.blockId]: Math.min(3, Math.max(1, action.zoom)) },
  };
}

export interface ReportDocumentViewProps {
  document: ReportDocument;
  visualAssetManifests: VisualAssetManifest[];
  taskId: string;
  assetUrl?: (input: { assetId: string }) => string;
  loadAsset?: ReportAssetLoader;
  actions?: React.ReactNode;
}

function EvidenceBlock({
  block,
  expanded,
  onToggle,
}: {
  block: ReportViewBlock;
  expanded: boolean;
  onToggle(): void;
}) {
  if (block.items) return <ul className="report-list">{block.items.map((item) => <li key={item}>{item}</li>)}</ul>;
  const ids = block.evidenceIds ?? [];
  return (
    <section className="report-finding" data-block-id={block.id}>
      <p>{block.text}</p>
      {ids.length > 0 ? (
        <button type="button" className="report-evidence-toggle" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? '收起证据' : `查看证据（${ids.length}）`}
        </button>
      ) : null}
      {expanded ? <ul className="report-evidence-list">{ids.map((id) => <li key={id}><code>{id}</code></li>)}</ul> : null}
    </section>
  );
}

function TableBlock({ table }: { table: ChartTableAlternative }) {
  const idPrefix = useId();
  const shape = createReportTableShape(table, idPrefix);
  return (
    <div className="report-table-wrap">
      <table className="report-table">
        <caption>{table.caption}</caption>
        <thead>
          <tr>
            {shape.headers.map((header) => (
              <th id={header.id} scope={header.scope} key={header.id}>{header.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shape.rows.map((row) => (
            <tr key={row.key}>
              <th id={row.header.id} scope={row.header.scope} headers={row.header.headers.join(' ')}>
                {row.header.label}
              </th>
              {row.cells.map((cell, index) => (
                <td key={shape.headers[index + 1]!.id} headers={cell.headers.join(' ')}>
                  {cell.value === null ? '—' : cell.value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReportBlockView({
  block,
  interaction,
  dispatch,
  loadAsset,
}: {
  block: ReportViewBlock;
  interaction: ReportDocumentInteractionState;
  dispatch: React.Dispatch<ReportDocumentInteractionAction>;
  loadAsset?: ReportAssetLoader;
}) {
  if (block.kind === 'metric') {
    return <dl className="report-metric" data-block-id={block.id}><dt>{block.label}</dt><dd>{block.value}</dd></dl>;
  }
  if (block.kind === 'evidence') {
    return (
      <EvidenceBlock
        block={block}
        expanded={interaction.expandedEvidence.has(block.id)}
        onToggle={() => dispatch({ type: 'toggle-evidence', blockId: block.id })}
      />
    );
  }
  if (block.kind === 'list') return <ul className="report-list">{block.items?.map((item) => <li key={item}>{item}</li>)}</ul>;
  if (block.kind === 'image' && block.assetId && block.altText && block.caption) {
    return (
      <ImageBlock
        id={block.id}
        assetId={block.assetId}
        src={block.assetSrc}
        altText={block.altText}
        caption={block.caption}
        zoom={interaction.imageZoom[block.id] ?? 1}
        onZoom={(zoom) => dispatch({ type: 'set-image-zoom', blockId: block.id, zoom })}
        loadAsset={block.assetSrc ? loadAsset : undefined}
      />
    );
  }
  if (
    block.kind === 'comparison'
    && block.originalAssetId
    && block.annotationAssetId
    && block.altText
    && block.caption
    && block.originalSrc
    && block.annotationSrc
  ) {
    return (
      <ImageComparisonBlock
        id={block.id}
        originalAssetId={block.originalAssetId}
        annotationAssetId={block.annotationAssetId}
        originalSrc={block.originalSrc}
        annotationSrc={block.annotationSrc}
        altText={block.altText}
        caption={block.caption}
        variant={interaction.imageVariants[block.id] ?? 'annotation'}
        zoom={interaction.imageZoom[block.id] ?? 1}
        onVariantChange={(variant) => dispatch({ type: 'select-image-variant', blockId: block.id, variant })}
        onZoom={(zoom) => dispatch({ type: 'set-image-zoom', blockId: block.id, zoom })}
        loadAsset={block.originalSrc && block.annotationSrc ? loadAsset : undefined}
      />
    );
  }
  if (block.kind === 'chart' && block.spec && block.table && block.assetId && block.altText) {
    return (
      <div className="report-chart" data-block-id={block.id}>
        <div className="report-chart-interactive"><ChartBlock spec={block.spec} table={block.table} showTable={false} /></div>
        <VerifiedAssetImage
          assetId={block.assetId}
          src={block.assetSrc}
          alt={block.altText}
          className="report-chart-print"
          loadAsset={block.assetSrc ? loadAsset : undefined}
        />
      </div>
    );
  }
  if (block.kind === 'table' && block.table) return <TableBlock table={block.table} />;
  if (block.kind === 'recommendation') return <p className="report-recommendation">{block.text}</p>;
  if (block.kind === 'risk') return <p className="report-risk">{block.text}</p>;
  return <p className="report-paragraph">{block.text}</p>;
}

export function ReportDocumentView({
  document,
  visualAssetManifests,
  taskId,
  assetUrl = ({ assetId }) => `/api/control-tasks/${encodeURIComponent(taskId)}/assets/${encodeURIComponent(assetId)}`,
  loadAsset,
  actions,
}: ReportDocumentViewProps) {
  const model = useMemo(
    () => createReportDocumentViewModel({ document, visualAssetManifests, assetUrl }),
    [assetUrl, document, visualAssetManifests],
  );
  const [interaction, dispatch] = useReducer(
    reduceReportDocumentInteraction,
    undefined,
    createReportDocumentInteractionState,
  );

  return (
    <article className="report-document" aria-labelledby="report-title">
      <header className="report-header" aria-hidden="true">{model.title}</header>
      <footer className="report-footer" aria-hidden="true">可信研究报告 · {taskId}</footer>
      <header className="report-cover" data-print-role="cover">
        <p className="report-kicker">研究报告</p>
        <h1 id="report-title">{model.title}</h1>
        <p className="report-subtitle">{model.subtitle}</p>
        <p className="report-summary">{model.executiveSummary}</p>
        <div className="report-actions">{actions}</div>
      </header>
      <div className="report-layout">
        <nav className="report-toc" data-print-role="toc" aria-label="报告章节">
          <h2>目录</h2>
          <ol>{model.navigation.map((item) => <li key={item.id}><a href={`#${item.id}`}>{item.title}</a></li>)}</ol>
        </nav>
        <div className="report-body">
          {model.sections.map((section) => (
            <section className="report-section" id={section.id} key={section.id}>
              <h2>{section.title}</h2>
              {section.questionIds.length > 0 ? <p className="report-question-binding">覆盖问题：{section.questionIds.join('、')}</p> : null}
              {section.blocks.map((block) => (
                <ReportBlockView
                  key={block.id}
                  block={block}
                  interaction={interaction}
                  dispatch={dispatch}
                  loadAsset={loadAsset}
                />
              ))}
            </section>
          ))}
        </div>
      </div>
    </article>
  );
}
