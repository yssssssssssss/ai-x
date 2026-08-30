import { useEffect, useId, useMemo, useReducer, useRef } from 'react';
import type {
  RenderableReportDocument,
  ReportAuditAppendixV1,
  ReportChartTableAlternativeV3,
  ReportEditorialCopyFragmentV4,
  ReportNoticeCodeV1,
  ReportNoticeV1,
} from '../../../../packages/api-contract/report-document.ts';
import type { VisualAssetManifest } from '../../../../packages/api-contract/research-deliverable.ts';
import { ChartBlock } from './ChartBlock.tsx';
import { ImageBlock, VerifiedAssetImage, type ReportAssetLoader } from './ImageBlock.tsx';
import { ImageComparisonBlock } from './ImageComparisonBlock.tsx';
import {
  createReportDocumentViewModel,
  createReportTableShape,
  type ReportDocumentViewModel,
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
  document: RenderableReportDocument;
  visualAssetManifests: VisualAssetManifest[];
  taskId: string;
  sourceReportDocumentContentSha256?: string;
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
  channel_strategy: '渠道策略',
  limitation: '研究局限',
  open_question: '待回答问题',
  risk: '风险提示',
};

const NOTICE_TEXT: Record<ReportNoticeCodeV1, string> = {
  layout_fallback: '结构编排已使用确定性排版，报告内容与来源覆盖不受影响。',
  copy_fallback: '编辑文案缺失或未通过校验的部分已使用受审原文。',
  data_policy_fallback: '当前数据策略未启用模型编排，已自动使用确定性排版。',
  editorial_adapter_fallback: '本报告已使用兼容的原始报告结构。',
  optional_visual_omitted: '部分可选视觉素材未纳入，文本内容保持完整。',
  requested_artifact_unfulfilled: '用户要求的部分交付物尚未完成。',
  visualization_linearized: '部分复杂结构已使用无损线性形式展示。',
  export_attachment_omitted: '部分可选审计附件未包含在此次导出中。',
  renderer_compatibility_fallback: '部分交互已改为始终展开，以保证兼容与完整。',
  html_unavailable: '离线 HTML 当前不可用，其他报告出口不受影响。',
  zero_unavailable: 'Zero 发布当前不可用，其他报告出口不受影响。',
  legacy_trace_incomplete: '历史报告的部分细粒度溯源信息不可用。',
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

function StructuredList({ block }: { block: ReportViewBlock }) {
  const Tag = block.ordered ? 'ol' : 'ul';
  const items = block.listItems ?? [];
  return (
    <Tag className="report-list report-structured-list">
      {items.map((item) => (
        <li className={item.label ? undefined : 'report-list-item-unlabeled'} key={item.id} data-leaf-ref={item.leafRef}>
          {item.label ? <strong>{item.label}</strong> : null}
          <span>{item.text}</span>
        </li>
      ))}
    </Tag>
  );
}

function BlockTitle({ block }: { block: ReportViewBlock }) {
  const title = block.title ?? (block.kind === 'answer' ? block.label : undefined);
  return title ? <h3 className="report-block-title">{title}</h3> : null;
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
  showTitle,
}: {
  block: ReportViewBlock;
  expanded: boolean;
  onToggle(): void;
  showTitle: boolean;
}) {
  if (block.items) return <ul className="report-list">{block.items.map((item) => <li key={item}>{item}</li>)}</ul>;
  return (
    <section className="report-finding" data-block-id={block.id}>
      {showTitle ? <BlockTitle block={block} /> : null}
      <p data-leaf-ref={block.primaryLeafRef}>{block.text}</p>
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

function TableBlock({ table }: { table: ReportChartTableAlternativeV3 }) {
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

function RecordTableBlock({ block }: { block: ReportViewBlock }) {
  const table = block.recordTable;
  const idPrefix = useId();
  if (!table) return null;
  const hasRowLabels = table.rows.some(({ label }) => Boolean(label));
  const headerIds = table.columns.map((_, index) => `${idPrefix}-column-${index + 1}`);
  return (
    <div className="report-table-wrap report-record-table-wrap">
      <table className="report-table report-record-table">
        {block.title ? <caption>{block.title}</caption> : null}
        <thead>
          <tr>
            {hasRowLabels ? <th id={`${idPrefix}-row-label`} scope="col">项目</th> : null}
            {table.columns.map((column, index) => (
              <th id={headerIds[index]} scope="col" key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => {
            const rowHeaderId = `${idPrefix}-row-${rowIndex + 1}`;
            const cells = new Map(row.cells.map((cell) => [cell.columnKey, cell]));
            return (
              <tr key={row.id}>
                {hasRowLabels ? (
                  <th id={rowHeaderId} scope="row" headers={`${idPrefix}-row-label`}>
                    {row.label ?? '—'}
                  </th>
                ) : null}
                {table.columns.map((column, columnIndex) => {
                  const cell = cells.get(column.key)!;
                  const value = cell.value === null
                    ? '—'
                    : typeof cell.value === 'boolean'
                      ? (cell.value ? '是' : '否')
                      : cell.value;
                  const headers = hasRowLabels
                    ? `${rowHeaderId} ${headerIds[columnIndex]}`
                    : headerIds[columnIndex];
                  return (
                    <td key={column.key} headers={headers} data-leaf-ref={cell.leafRef}>{value}</td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GraphBlock({ block }: { block: ReportViewBlock }) {
  const graph = block.graph;
  if (!graph) return null;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return (
    <div className={`report-graph report-graph-${graph.variant}`} data-graph-variant={graph.variant}>
      <ol className="report-graph-nodes">
        {graph.nodes.map((node) => (
          <li key={node.id} data-leaf-ref={node.leafRef}>
            <strong>{node.label}</strong>
            {node.description ? <span>{node.description}</span> : null}
          </li>
        ))}
      </ol>
      {graph.edges.length > 0 ? (
        <div className="report-graph-relations">
          <h4>关系</h4>
          <ul>
            {graph.edges.map((edge) => (
              <li key={edge.id} data-leaf-ref={edge.leafRef}>
                <span>{nodes.get(edge.from)!.label}</span>
                <b aria-hidden="true">→</b>
                <span>{nodes.get(edge.to)!.label}</span>
                {edge.label ? <em>{edge.label}</em> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function PriorityBoardBlock({ block }: { block: ReportViewBlock }) {
  const groups = block.priorityGroups ?? [];
  return (
    <div className="report-priority-board">
      {groups.map((group) => (
        <section className={`report-priority-group report-priority-${group.priority.toLowerCase()}`} key={group.priority}>
          <h4>{group.priority}</h4>
          <ol>
            {group.items.map((item) => (
              <li key={item.id} data-leaf-ref={item.leafRef}>
                <strong>{item.action}</strong>
                {item.rationale ? <p>{item.rationale}</p> : null}
                {item.owner || item.validationMethod ? (
                  <dl>
                    {item.owner ? <><dt>负责人</dt><dd>{item.owner}</dd></> : null}
                    {item.validationMethod ? <><dt>验证</dt><dd>{item.validationMethod}</dd></> : null}
                  </dl>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function copyDataAttributes(fragment: ReportEditorialCopyFragmentV4 | undefined) {
  return fragment ? {
    'data-copy-fragment-id': fragment.id,
    'data-copy-provenance': fragment.provenance,
    'data-source-leaf-ids': fragment.sourceLeafIds.join(' '),
  } : {};
}

function CardGridBlock({ block }: { block: ReportViewBlock }) {
  return (
    <ul className="report-card-grid">
      {block.cards?.map((card) => (
        <li className="report-card-grid-item" data-leaf-refs={card.leafRefs.join(' ')} key={card.id}>
          {card.status ? <span className="report-card-status">{card.status}</span> : null}
          <h4>{card.title}</h4>
          {card.body ? <p>{card.body}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function StageFlowBlock({ block }: { block: ReportViewBlock }) {
  return (
    <ol className="report-stage-flow">
      {block.stages?.map((stage) => (
        <li className="report-stage" data-leaf-refs={stage.leafRefs.join(' ')} key={stage.id}>
          {stage.timeLabel ? <span className="report-stage-time">{stage.timeLabel}</span> : null}
          <h4>{stage.label}</h4>
          {stage.description ? <p>{stage.description}</p> : null}
        </li>
      ))}
    </ol>
  );
}

function ReportBlockContent({
  block,
  interaction,
  dispatch,
  loadAsset,
  showTitle,
}: {
  block: ReportViewBlock;
  interaction: ReportDocumentInteractionState;
  dispatch: React.Dispatch<ReportDocumentInteractionAction>;
  loadAsset?: ReportAssetLoader;
  showTitle: boolean;
}) {
  if (block.kind === 'metric') {
    return (
      <>
        {showTitle ? <BlockTitle block={block} /> : null}
        <dl className="report-metric" data-block-id={block.id} data-leaf-ref={block.primaryLeafRef}>
          <dt>{block.label}</dt>
          <dd>{block.value}{block.unit ? <span>{block.unit}</span> : null}</dd>
        </dl>
      </>
    );
  }
  if (block.kind === 'evidence') {
    return (
      <EvidenceBlock
        block={block}
        expanded={interaction.expandedEvidence.has(block.id)}
        onToggle={() => dispatch({ type: 'toggle-evidence', blockId: block.id })}
        showTitle={showTitle}
      />
    );
  }
  if (block.kind === 'list') {
    if (block.listItems) {
      return <>{showTitle ? <BlockTitle block={block} /> : null}<StructuredList block={block} /></>;
    }
    return <ul className="report-list">{block.items?.map((item) => <li key={item}>{item}</li>)}</ul>;
  }
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
        {showTitle && block.label ? <h3>{block.label}</h3> : null}
        <p className="report-answer-summary" data-leaf-ref={block.primaryLeafRef}>{block.text}</p>
        {block.listItems && block.listItems.length > 0
          ? <StructuredList block={{ ...block, ordered: false }} />
          : block.items && block.items.length > 0
            ? <AnswerDetailList items={block.items} />
            : null}
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
        {showTitle ? <BlockTitle block={block} /> : null}
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
    && (block.visibility !== undefined || (block.originalSrc && block.annotationSrc))
  ) {
    return (
      <div className="report-visual-evidence">
        {showTitle ? <BlockTitle block={block} /> : null}
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
        {showTitle ? <BlockTitle block={block} /> : null}
        <div className="report-chart-interactive"><ChartBlock spec={block.spec} table={block.table} showTable={false} /></div>
        <VerifiedAssetImage
          assetId={block.assetId}
          src={block.assetSrc}
          alt={block.altText}
          className="report-chart-print"
          loadAsset={block.assetSrc ? loadAsset : undefined}
        />
        {block.visibility !== undefined ? <TableBlock table={block.table} /> : null}
      </div>
    );
  }
  if (block.kind === 'table' && block.table) return <TableBlock table={block.table} />;
  if (block.kind === 'record-table') return <RecordTableBlock block={block} />;
  if (block.kind === 'graph') {
    return <>{showTitle ? <BlockTitle block={block} /> : null}<GraphBlock block={block} /></>;
  }
  if (block.kind === 'priority-board') {
    return <>{showTitle ? <BlockTitle block={block} /> : null}<PriorityBoardBlock block={block} /></>;
  }
  if (block.kind === 'card-grid') {
    return <>{showTitle ? <BlockTitle block={block} /> : null}<CardGridBlock block={block} /></>;
  }
  if (block.kind === 'stage-flow') {
    return <>{showTitle ? <BlockTitle block={block} /> : null}<StageFlowBlock block={block} /></>;
  }
  if (block.kind === 'recommendation') return <p className="report-recommendation">{block.text}</p>;
  if (block.kind === 'risk') return <p className="report-risk">{block.text}</p>;
  return (
    <>
      {showTitle ? <BlockTitle block={block} /> : null}
      <p className="report-paragraph" data-leaf-ref={block.primaryLeafRef}>{block.text}</p>
    </>
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
  const content = (
    <ReportBlockContent
      block={block}
      interaction={interaction}
      dispatch={dispatch}
      loadAsset={loadAsset}
      showTitle={block.visibility !== 'collapsible'}
    />
  );
  const digest = block.digest ? (
    <p className="report-block-digest" {...copyDataAttributes(block.digest)}>{block.digest.text}</p>
  ) : null;
  if (block.visibility === undefined) return <>{digest}{content}</>;
  const commonProps = {
    'data-block-id': block.id,
    'data-unit-refs': block.unitRefs?.join(' '),
    'data-leaf-refs': block.leafRefs?.join(' '),
  };
  if (block.visibility === 'collapsible') {
    return (
      <>
        {digest}
        <details className={`report-v3-block report-v3-block-${block.kind} report-v3-collapsible`} {...commonProps}>
          <summary>{block.title ?? block.label ?? '查看详细内容'}</summary>
          <div className="report-v3-collapsible-body">{content}</div>
        </details>
      </>
    );
  }
  return (
    <>
      {digest}
      <div className={`report-v3-block report-v3-block-${block.kind}`} {...commonProps}>{content}</div>
    </>
  );
}

function ReportNotices({ notices }: { notices: readonly ReportNoticeV1[] }) {
  if (notices.length === 0) return null;
  return (
    <aside className="report-notices" aria-label="生成说明">
      <h2>生成说明</h2>
      <ul>
        {notices.map((notice) => (
          <li className={`report-notice-${notice.severity}`} data-notice-id={notice.id} key={notice.id}>
            {NOTICE_TEXT[notice.code]}
          </li>
        ))}
      </ul>
    </aside>
  );
}

function AuditAppendix({ appendix }: { appendix: ReportAuditAppendixV1 }) {
  return (
    <section className="report-section report-audit-appendix" id="report-audit-appendix">
      <details>
        <summary>分析审计附录 <span>{appendix.records.length}</span></summary>
        <div className="report-table-wrap">
          <table className="report-table report-audit-table">
            <caption>素材单元处理记录</caption>
            <thead>
              <tr>
                <th scope="col">来源单元</th>
                <th scope="col">处理结果</th>
                <th scope="col">Canonical 映射</th>
                <th scope="col">说明</th>
              </tr>
            </thead>
            <tbody>
              {appendix.records.map((record) => (
                <tr data-audit-record-id={record.id} key={record.id}>
                  <th scope="row">{record.sourceUnitKey}</th>
                  <td>{record.disposition}</td>
                  <td>{record.canonicalNodeIds.join('、') || '—'}</td>
                  <td>{record.reasonCode ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function ReportSectionView({
  section,
  isV4,
  hidden,
  interaction,
  dispatch,
  loadAsset,
}: {
  section: ReportDocumentViewModel['sections'][number];
  isV4: boolean;
  hidden: boolean;
  interaction: ReportDocumentInteractionState;
  dispatch: React.Dispatch<ReportDocumentInteractionAction>;
  loadAsset?: ReportAssetLoader;
}) {
  const body = (
    <>
      {section.lead ? (
        <p className="report-section-lead" {...copyDataAttributes(section.lead)}>{section.lead.text}</p>
      ) : null}
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
      {section.transition ? (
        <p className="report-section-transition" {...copyDataAttributes(section.transition)}>
          {section.transition.text}
        </p>
      ) : null}
    </>
  );
  const className = `report-section${hidden ? ' report-screen-hidden' : ''}`;
  const sectionData = {
    'data-report-view': section.view,
    'data-prominence': section.prominence,
  };
  if (isV4 && section.prominence !== 'primary') {
    return (
      <details className={`${className} report-section-disclosure`} id={section.id} {...sectionData}>
        <summary><h2 {...copyDataAttributes(section.titleCopy)}>{section.title}</h2></summary>
        <div className="report-section-disclosure-body">{body}</div>
      </details>
    );
  }
  return (
    <section className={className} id={section.id} {...sectionData}>
      <h2 {...copyDataAttributes(section.titleCopy)}>{section.title}</h2>
      {body}
    </section>
  );
}

export function ReportDocumentView({
  document,
  visualAssetManifests,
  taskId,
  sourceReportDocumentContentSha256,
  assetUrl = ({ assetId }) => `/api/control-tasks/${encodeURIComponent(taskId)}/assets/${encodeURIComponent(assetId)}`,
  loadAsset,
  visibleSectionIds,
  actions,
}: ReportDocumentViewProps) {
  const model = useMemo(
    () => createReportDocumentViewModel({
      document,
      visualAssetManifests,
      assetUrl,
      ...(sourceReportDocumentContentSha256 === undefined
        ? {}
        : { sourceReportDocumentContentSha256 }),
    }),
    [assetUrl, document, sourceReportDocumentContentSha256, visualAssetManifests],
  );
  const screenVisibleSectionIds = useMemo(
    () => visibleSectionIds ? new Set(visibleSectionIds) : undefined,
    [visibleSectionIds],
  );
  const navigation = useMemo(
    () => model.sections.map(({ id, title }) => ({ id, title })),
    [model.sections],
  );
  const screenVisibleSectionCount = screenVisibleSectionIds
    ? model.sections.filter(({ id }) => screenVisibleSectionIds.has(id)).length
    : model.sections.length;
  const executiveSummaryParts = useMemo(
    () => splitExecutiveSummary(model.executiveSummary),
    [model.executiveSummary],
  );
  const [executiveSummaryLead = '', ...executiveSummaryDetails] = executiveSummaryParts;
  const isV4 = model.version === 'report-document-v4';
  const isStructured = model.version === 'report-document-v3' || isV4;
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
    <article
      ref={reportRef}
      className={`report-document${model.style ? ` report-style-${model.style}` : ''}${model.density ? ` report-density-${model.density}` : ''}`}
      data-report-version={model.version}
      data-copy-mode={model.copyMode}
      data-report-style={model.style}
      data-report-density={model.density}
      aria-labelledby="report-title"
    >
      <header className="report-header" aria-hidden="true">{model.title}</header>
      <footer className="report-footer" aria-hidden="true">可信研究报告 · {taskId}</footer>
      <header className="report-cover" data-print-role="cover">
        <p className="report-kicker">研究报告</p>
        <h1 id="report-title" {...copyDataAttributes(model.titleCopy)}>{model.title}</h1>
        <p className="report-subtitle">{model.subtitle}</p>
        <p className="report-summary" {...copyDataAttributes(model.executiveSummaryCopy)}>
          {isStructured ? model.executiveSummary : executiveSummaryLead}
        </p>
        {!isStructured && executiveSummaryDetails.length > 0 ? (
          <details className="report-summary-details">
            <summary>展开完整摘要</summary>
            <p>{executiveSummaryDetails.join('\n')}</p>
          </details>
        ) : null}
        <div className="report-actions">{actions}</div>
      </header>
      <div className={`report-layout${showTableOfContents ? '' : ' report-layout-single'}`}>
        {showTableOfContents ? (
          <nav
            className={`report-toc${screenVisibleSectionCount > 1 ? '' : ' report-screen-hidden'}`}
            data-print-role="toc"
            aria-label="报告章节"
          >
            <h2>目录 / Contents</h2>
            <ol>
              {navigation.map((item) => (
                <li
                  className={screenVisibleSectionIds?.has(item.id) === false ? 'report-screen-hidden' : undefined}
                  key={item.id}
                >
                  <a href={`#${item.id}`}>{item.title}</a>
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
        <div className="report-body">
          {model.notices ? <ReportNotices notices={model.notices} /> : null}
          {model.sections.map((section) => (
            <ReportSectionView
              key={section.id}
              section={section}
              isV4={isV4}
              hidden={screenVisibleSectionIds?.has(section.id) === false}
              interaction={interaction}
              dispatch={dispatch}
              loadAsset={loadAsset}
            />
          ))}
          {model.auditAppendix ? <AuditAppendix appendix={model.auditAppendix} /> : null}
        </div>
      </div>
    </article>
  );
}
