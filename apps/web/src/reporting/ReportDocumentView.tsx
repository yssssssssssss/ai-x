import { useEffect, useId, useMemo, useReducer, useRef } from 'react';
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
  visibleSectionIds?: readonly string[];
  actions?: React.ReactNode;
}

const ANSWER_KIND_LABELS: Record<NonNullable<ReportViewBlock['answerKind']>, string> = {
  direct_answer: '直接回答',
  evidence_finding: '证据发现',
  strategy_map: '策略地图',
  mind_model: '心智模型',
  comparison_matrix: '对比分析',
  design_principle: '设计原则',
  opportunity: '机会点',
  priority_matrix: '优先行动',
  action_plan: '行动计划',
  risk: '风险提示',
};

const ANSWER_STATUS_LABELS: Record<NonNullable<ReportViewBlock['answerStatus']>, string> = {
  supported: '证据支持',
  provisional: '待验证',
  unanswered: '尚待回答',
};

function AnswerDetailList({ items }: { items: string[] }) {
  return (
    <details className="report-answer-details">
      <summary>展开详细要点 <span>{items.length}</span></summary>
      <ul className="report-list">
        {items.map((item) => {
          const match = /^([^：:]{1,12})[：:]\s*(.+)$/u.exec(item);
          return (
            <li key={item}>
              {match ? <><strong>{match[1]}</strong><span>{match[2]}</span></> : item}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function AnswerProvenance({ block }: { block: ReportViewBlock }) {
  const findingIds = block.findingIds ?? [];
  const summaryIds = block.summaryIds ?? [];
  if (findingIds.length === 0 && summaryIds.length === 0) return null;
  return (
    <details className="report-answer-provenance">
      <summary>内容溯源</summary>
      <dl>
        {findingIds.length > 0 ? (
          <><dt>Findings</dt><dd>{findingIds.map((id) => <code key={id}>{id}</code>)}</dd></>
        ) : null}
        {summaryIds.length > 0 ? (
          <><dt>Summaries</dt><dd>{summaryIds.map((id) => <code key={id}>{id}</code>)}</dd></>
        ) : null}
      </dl>
    </details>
  );
}

function QuestionBinding({ questionIds }: { questionIds: string[] }) {
  return (
    <details className="report-question-binding">
      <summary>关联研究问题 {questionIds.length} 个</summary>
      <p>{questionIds.map((id) => <code key={id}>{id}</code>)}</p>
    </details>
  );
}

function splitExecutiveSummary(summary: string): string[] {
  const paragraphs = summary.split(/\n+/u).map((part) => part.trim()).filter(Boolean);
  const lead = paragraphs[0];
  if (!lead) return paragraphs;
  const characters = Array.from(lead);
  if (characters.length <= 96) return paragraphs;
  let splitAt = -1;
  for (let index = 56; index < Math.min(characters.length, 96); index += 1) {
    if (/[，；。！？]/u.test(characters[index]!)) {
      splitAt = index + 1;
      break;
    }
  }
  if (splitAt < 0) splitAt = Math.min(characters.length, 96);
  return [characters.slice(0, splitAt).join(''), characters.slice(splitAt).join('').trim(), ...paragraphs.slice(1)].filter(Boolean);
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
    const answerKind = block.answerKind ?? 'direct_answer';
    return (
      <article className={`report-answer report-answer-${answerKind}`} data-block-id={block.id}>
        <div className="report-answer-meta">
          <span className="report-answer-kind">{ANSWER_KIND_LABELS[answerKind]}</span>
          {block.answerStatus ? (
            <span className={`report-answer-status report-answer-status-${block.answerStatus}`}>
              {ANSWER_STATUS_LABELS[block.answerStatus]}
            </span>
          ) : null}
          {typeof block.confidence === 'number' ? (
            <span className="report-answer-confidence">置信度 {Math.round(block.confidence * 100)}%</span>
          ) : null}
        </div>
        <h3>{block.label}</h3>
        <p className="report-answer-summary">{block.text}</p>
        {block.items && block.items.length > 0 ? <AnswerDetailList items={block.items} /> : null}
        <div className="report-answer-audit">
          <EvidenceDisclosure
            evidenceIds={block.evidenceIds}
            expanded={interaction.expandedEvidence.has(block.id)}
            onToggle={() => dispatch({ type: 'toggle-evidence', blockId: block.id })}
          />
          <AnswerProvenance block={block} />
        </div>
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
  visibleSectionIds,
  actions,
}: ReportDocumentViewProps) {
  const model = useMemo(
    () => createReportDocumentViewModel({ document, visualAssetManifests, assetUrl }),
    [assetUrl, document, visualAssetManifests],
  );
  const visibleSections = useMemo(() => {
    if (!visibleSectionIds) return model.sections;
    const visible = new Set(visibleSectionIds);
    return model.sections.filter(({ id }) => visible.has(id));
  }, [model.sections, visibleSectionIds]);
  const navigation = useMemo(() => visibleSections.map(({ id, title }) => ({ id, title })), [visibleSections]);
  const executiveSummaryParts = useMemo(
    () => splitExecutiveSummary(model.executiveSummary),
    [model.executiveSummary],
  );
  const [executiveSummaryLead = '', ...executiveSummaryDetails] = executiveSummaryParts;
  const showTableOfContents = navigation.length > 1;
  const reportRef = useRef<HTMLElement>(null);
  const printOpenedDetailsRef = useRef<HTMLDetailsElement[]>([]);
  useEffect(() => {
    const openDetailsForPrint = () => {
      const root = reportRef.current;
      if (!root || printOpenedDetailsRef.current.length > 0) return;
      const closedDetails = Array.from(root.querySelectorAll<HTMLDetailsElement>('details:not([open])'));
      printOpenedDetailsRef.current = closedDetails;
      for (const detail of closedDetails) detail.open = true;
    };
    const restoreDetailsAfterPrint = () => {
      for (const detail of printOpenedDetailsRef.current) detail.open = false;
      printOpenedDetailsRef.current = [];
    };
    window.addEventListener('beforeprint', openDetailsForPrint);
    window.addEventListener('afterprint', restoreDetailsAfterPrint);
    return () => {
      window.removeEventListener('beforeprint', openDetailsForPrint);
      window.removeEventListener('afterprint', restoreDetailsAfterPrint);
      restoreDetailsAfterPrint();
    };
  }, []);
  const [interaction, dispatch] = useReducer(
    reduceReportDocumentInteraction,
    undefined,
    createReportDocumentInteractionState,
  );

  return (
    <article ref={reportRef} className="report-document" aria-labelledby="report-title">
      <header className="report-header" aria-hidden="true">{model.title}</header>
      <footer className="report-footer" aria-hidden="true">可信研究报告 · {taskId}</footer>
      <header className="report-cover" data-print-role="cover">
        <p className="report-kicker">研究报告</p>
        <h1 id="report-title">{model.title}</h1>
        <p className="report-subtitle">{model.subtitle}</p>
        <p className="report-summary">{executiveSummaryLead}</p>
        {executiveSummaryDetails.length > 0 ? (
          <details className="report-summary-details">
            <summary>展开完整摘要</summary>
            <p>{executiveSummaryDetails.join('\n')}</p>
          </details>
        ) : null}
        <div className="report-actions">{actions}</div>
      </header>
      <div className={`report-layout${showTableOfContents ? '' : ' report-layout-single'}`}>
        {showTableOfContents ? (
          <nav className="report-toc" data-print-role="toc" aria-label="报告章节">
            <h2>目录 / Contents</h2>
            <ol>{navigation.map((item) => <li key={item.id}><a href={`#${item.id}`}>{item.title}</a></li>)}</ol>
          </nav>
        ) : null}
        <div className="report-body">
          {visibleSections.map((section) => (
            <section className="report-section" id={section.id} key={section.id}>
              <h2>{section.title}</h2>
              {section.questionIds.length > 0 ? <QuestionBinding questionIds={section.questionIds} /> : null}
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
