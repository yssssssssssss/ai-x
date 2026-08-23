import { useId, useMemo, useReducer } from 'react';
import type { VisualAssetManifest } from '../../../../packages/api-contract/research-deliverable.ts';
import type { ReportDocument } from '../../../orchestrator-runtime/src/report/report-document-composer.ts';
import type { ChartTableAlternative } from '../../../orchestrator-runtime/src/report/chart-renderer.ts';
import { ChartBlock } from './ChartBlock.tsx';
import { ImageBlock, VerifiedAssetImage, type ReportAssetLoader } from './ImageBlock.tsx';
import { ImageComparisonBlock } from './ImageComparisonBlock.tsx';
import {
  createReportDocumentViewModel,
  createReportTableShape,
  type ReportViewBlock,
} from './report-document-view-model.ts';

export { createReportDocumentViewModel, createReportTableShape };
export type {
  ReportDocumentViewModel,
  ReportDocumentViewModelInput,
  ReportTableShape,
  ReportViewBlock,
  ReportViewBlockKind,
} from './report-document-view-model.ts';

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
  return (
    <section className="report-finding" data-block-id={block.id}>
      <p>{block.text}</p>
      <EvidenceDisclosure evidenceIds={block.evidenceIds} expanded={expanded} onToggle={onToggle} />
    </section>
  );
}

function EvidenceDisclosure({
  evidenceIds,
  expanded,
  onToggle,
}: {
  evidenceIds?: string[];
  expanded: boolean;
  onToggle(): void;
}) {
  const ids = evidenceIds ?? [];
  if (ids.length === 0) return null;
  return (
    <div className="report-evidence-disclosure">
      <button type="button" className="report-evidence-toggle" aria-expanded={expanded} onClick={onToggle}>
        {expanded ? '收起证据' : `查看证据（${ids.length}）`}
      </button>
      <ul
        className={`report-evidence-list${expanded ? '' : ' report-chart-print'}`}
        aria-label="证据编号"
      >
        {ids.map((id) => <li key={id}><code>{id}</code></li>)}
      </ul>
    </div>
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
  if (block.kind === 'answer') {
    return (
      <article className={`report-answer report-answer-${block.answerKind ?? 'content'}`} data-block-id={block.id}>
        <div className="report-answer-meta">
          <span>{(block.answerKind ?? 'answer').replaceAll('_', ' ')}</span>
          {typeof block.confidence === 'number' ? <span>置信度 {Math.round(block.confidence * 100)}%</span> : null}
        </div>
        <h3>{block.label}</h3>
        <p>{block.text}</p>
        {block.items && block.items.length > 0 ? <ul className="report-list">{block.items.map((item) => <li key={item}>{item}</li>)}</ul> : null}
        <EvidenceDisclosure
          evidenceIds={block.evidenceIds}
          expanded={interaction.expandedEvidence.has(block.id)}
          onToggle={() => dispatch({ type: 'toggle-evidence', blockId: block.id })}
        />
      </article>
    );
  }
  if (block.kind === 'image' && block.assetId && block.altText && block.caption) {
    return (
      <div className="report-visual-evidence">
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
        <EvidenceDisclosure
          evidenceIds={block.evidenceIds}
          expanded={interaction.expandedEvidence.has(block.id)}
          onToggle={() => dispatch({ type: 'toggle-evidence', blockId: block.id })}
        />
      </div>
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
      <div className="report-visual-evidence">
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
        <EvidenceDisclosure
          evidenceIds={block.evidenceIds}
          expanded={interaction.expandedEvidence.has(block.id)}
          onToggle={() => dispatch({ type: 'toggle-evidence', blockId: block.id })}
        />
      </div>
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
          <h2>目录 / Contents</h2>
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
