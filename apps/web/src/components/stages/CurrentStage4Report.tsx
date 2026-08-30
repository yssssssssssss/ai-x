import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isReportDocumentV3,
  isReportDocumentV4,
  type ReadableReportDocument,
  type ReportDocumentV1V2,
  type ReportViewIdV1,
} from '../../../../../packages/api-contract/report-document.ts';
import type { CurrentResearchPlanResponse } from '../../current-report-markdown.ts';
import { currentResearchPlanToMarkdown } from '../../current-report-markdown.ts';
import {
  api,
  type ControlDeliverableResponse,
  type ControlVisualAssetResponse,
  type ZeroIntegrationStatusResponse,
  type ZeroPublicationResponse,
} from '../../api/client.ts';
import {
  transitionZeroPublicationConfirmation,
  zeroPublicationButtonLabel,
  zeroPublicationProgressLabel,
  zeroPublicationRequestForSubmit,
  type ZeroPublicationConfirmationState,
  type ZeroPublicationRequestIdentity,
  type ZeroPublicationUiState,
} from '../../zero-publication-ui.ts';
import { hasCompleteContributionSidecars } from '../../report-package-response.ts';
import { createReportBundle } from '../../reporting/report-bundle.ts';
import { ReportDocumentView } from '../../reporting/ReportDocumentView.tsx';
import { SkillContributionView } from '../SkillContributionView.tsx';
import { Header } from './Stage1Understand.tsx';

type MultimodalReportResponse = Extract<
  ControlDeliverableResponse,
  { presentationMode: 'multimodal' }
>;
type ResearchPlanResponse = CurrentResearchPlanResponse;
type GenericTextReportResponse = Exclude<
  ControlDeliverableResponse,
  { presentationMode: 'multimodal' }
>;

type LegacyStrategyReportView = Exclude<ReportViewIdV1, 'actions'> | 'artifacts';
type StrategyReportView = ReportViewIdV1 | 'artifacts';

const STRATEGY_TOPIC_SECTION_IDS = new Set([
  'strategy-map',
  'mind-model',
  'design-principles',
  'channel-strategies',
]);

const STRATEGY_ACTION_SECTION_IDS = new Set([
  'opportunities',
  'priority-actions',
  'action-plan',
]);

const STRATEGY_EVIDENCE_SECTION_IDS = new Set([
  'evidence-confidence',
  'limitations',
  'evidence-appendix',
]);

const STRATEGY_TOPIC_KINDS = new Set([
  'strategy_map',
  'mind_model',
  'comparison_matrix',
  'design_principle',
]);

const STRATEGY_ACTION_KINDS = new Set([
  'opportunity',
  'priority_matrix',
  'action_plan',
]);

const STRATEGY_REPORT_TABS: ReadonlyArray<{ id: StrategyReportView; label: string }> = [
  { id: 'answers', label: '答案概览' },
  { id: 'topics', label: '策略框架' },
  { id: 'actions', label: '机会与行动' },
  { id: 'evidence', label: '证据与局限' },
  { id: 'analysis', label: '分析底稿' },
];

function sectionAnswerKinds(section: ReportDocumentV1V2['sections'][number]): string[] {
  return section.blocks.flatMap((block) => block.type === 'answer' ? [block.kind] : []);
}

function strategyReportSectionView(section: ReportDocumentV1V2['sections'][number]): LegacyStrategyReportView | undefined {
  const kinds = sectionAnswerKinds(section);
  if (section.id === 'executive-answers' || kinds.includes('direct_answer')) return 'answers';
  if (STRATEGY_EVIDENCE_SECTION_IDS.has(section.id) || kinds.includes('risk')) return 'evidence';
  if (section.id === 'analysis-notes' || kinds.includes('evidence_finding')) return 'analysis';
  if (STRATEGY_ACTION_SECTION_IDS.has(section.id) || kinds.some((kind) => STRATEGY_ACTION_KINDS.has(kind))) {
    return 'artifacts';
  }
  if (
    STRATEGY_TOPIC_SECTION_IDS.has(section.id)
    || section.id.startsWith('topic-')
    || kinds.some((kind) => STRATEGY_TOPIC_KINDS.has(kind))
    || section.id.startsWith('model-section-')
  ) {
    return 'topics';
  }
  return undefined;
}

export function strategyReportSectionIds(document: ReadableReportDocument, view: StrategyReportView): string[] {
  if (isReportDocumentV3(document) || isReportDocumentV4(document)) {
    const structuredView = view === 'artifacts' ? 'actions' : view;
    return document.sections.filter((section) => section.view === structuredView).map(({ id }) => id);
  }
  const legacyView = view === 'actions' ? 'artifacts' : view;
  return document.sections
    .filter((section) => strategyReportSectionView(section) === legacyView)
    .map(({ id }) => id);
}

export function selectCurrentStage4Renderer(report: unknown): {
  component: 'CurrentTextReport' | 'GenericTextReport' | 'ReportDocumentView';
  reportDocument?: ReadableReportDocument;
} {
  if (
    report !== null
    && typeof report === 'object'
    && !Array.isArray(report)
  ) {
    const deliverable = (report as Record<string, unknown>).deliverable;
    if (
      deliverable !== null
      && typeof deliverable === 'object'
      && !Array.isArray(deliverable)
      && (deliverable as Record<string, unknown>).deliverableType === 'research_plan'
    ) {
      return { component: 'CurrentTextReport' };
    }
  }
  if (
    report !== null
    && typeof report === 'object'
    && !Array.isArray(report)
    && (report as Record<string, unknown>).presentationMode === 'multimodal'
  ) {
    const reportDocument = (report as Record<string, unknown>).reportDocument;
    if (reportDocument !== null && typeof reportDocument === 'object' && !Array.isArray(reportDocument)) {
      return { component: 'ReportDocumentView', reportDocument: reportDocument as ReadableReportDocument };
    }
  }
  return { component: 'GenericTextReport' };
}

export function CurrentStage4Report({
  report,
  taskState,
}: {
  report: ControlDeliverableResponse;
  taskState: 'completed' | 'completed_with_gaps';
}) {
  const selected = selectCurrentStage4Renderer(report);
  const contributionView = hasCompleteContributionSidecars(report)
    ? (
        <SkillContributionView
          summary={report.contributionSummary}
          ledger={report.contributionLedger}
          review={report.crossSkillReview}
        />
      )
    : null;
  if (selected.component === 'CurrentTextReport') {
    return (
      <>
        {report.presentationMode === 'multimodal'
          ? <MultimodalResearchPlanReport report={report as MultimodalReportResponse & ResearchPlanResponse} taskState={taskState} />
          : <CurrentTextReport report={report as ResearchPlanResponse} />}
        {contributionView}
      </>
    );
  }
  if (selected.component === 'ReportDocumentView' && report.presentationMode === 'multimodal') {
    return (
      <>
        <MultimodalCurrentReport report={report} taskState={taskState} />
        {contributionView}
      </>
    );
  }
  if (report.presentationMode === 'multimodal') {
    throw new Error('multimodal report package has no ReportDocument renderer');
  }
  return (
    <>
      <GenericTextReport report={report} />
      {contributionView}
    </>
  );
}

function MultimodalResearchPlanReport({
  report,
  taskState,
}: {
  report: MultimodalReportResponse & ResearchPlanResponse;
  taskState: 'completed' | 'completed_with_gaps';
}) {
  const [view, setView] = useState<'full' | 'summary'>('full');
  return (
    <>
      <nav className="report-view-toggle" aria-label="报告视图">
        <button type="button" className={view === 'full' ? 'is-active' : ''} onClick={() => setView('full')}>
          完整方案
        </button>
        <button type="button" className={view === 'summary' ? 'is-active' : ''} onClick={() => setView('summary')}>
          管理摘要
        </button>
      </nav>
      {view === 'full'
        ? <CurrentTextReport report={report} />
        : <MultimodalCurrentReport report={report} taskState={taskState} />}
    </>
  );
}

function MultimodalCurrentReport({
  report,
  taskState,
}: {
  report: MultimodalReportResponse;
  taskState: 'completed' | 'completed_with_gaps';
}) {
  const [bundleStatus, setBundleStatus] = useState<'idle' | 'working' | 'error'>('idle');
  const [htmlBundleStatus, setHtmlBundleStatus] = useState<'idle' | 'working' | 'error'>('idle');
  const [showcaseStatus, setShowcaseStatus] = useState<'idle' | 'working' | 'error'>('idle');
  const [strategyView, setStrategyView] = useState<StrategyReportView>('answers');
  const [zeroStatus, setZeroStatus] = useState<ZeroIntegrationStatusResponse | null>(null);
  const [zeroPublication, setZeroPublication] = useState<ZeroPublicationResponse | null>(null);
  const [zeroUiState, setZeroUiState] = useState<ZeroPublicationUiState>('idle');
  const [zeroConfirmation, setZeroConfirmation] = useState<ZeroPublicationConfirmationState>('closed');
  const [zeroRequest, setZeroRequest] = useState<ZeroPublicationRequestIdentity | null>(null);
  const [zeroError, setZeroError] = useState<string | null>(null);
  const zeroPublishButtonRef = useRef<HTMLButtonElement>(null);
  const taskId = report.deliverable.taskId;
  const standaloneHtml = report.reportPackage?.version === 'report-package-v2'
    ? report.reportPackage.standaloneHtml
    : undefined;
  const editorialShowcase = report.editorialShowcase?.showcase;
  useEffect(() => {
    setStrategyView('answers');
  }, [taskId]);
  const loadVisualAsset = useMemo(() => {
    const cache = new Map<string, Promise<ControlVisualAssetResponse>>();
    return (assetId: string) => {
      const cached = cache.get(assetId);
      if (cached) return cached;
      const pending = api.controlVisualAsset(taskId, assetId).catch((error: unknown) => {
        cache.delete(assetId);
        throw error;
      });
      cache.set(assetId, pending);
      return pending;
    };
  }, [taskId]);
  const loadAsset = useCallback(async (assetId: string) => {
    const { blob } = await loadVisualAsset(assetId);
    return blob;
  }, [loadVisualAsset]);
  const assetUrl = useCallback(
    ({ assetId }: { assetId: string }) => `/api/control-tasks/${encodeURIComponent(taskId)}/assets/${encodeURIComponent(assetId)}`,
    [taskId],
  );
  const estimatedSliceCount = useMemo(() => {
    const manifests = new Map(report.visualAssetManifests.map((manifest) => [manifest.assetId, manifest]));
    let count = 0;
    for (const section of report.reportDocument.sections) {
      for (const block of section.blocks) {
        const references = block.type === 'chart'
          ? [{ assetId: block.chartRef.assetId, chart: true }]
          : block.type === 'image'
            ? [{ assetId: block.assetRef.assetId, chart: false }]
            : block.type === 'image-comparison'
              ? [
                  { assetId: block.beforeAssetRef.assetId, chart: false },
                  { assetId: block.afterAssetRef.assetId, chart: false },
                ]
              : [];
        for (const reference of references) {
          const manifest = manifests.get(reference.assetId);
          if (!manifest) continue;
          count += reference.chart
            ? 1
            : Math.max(1, Math.ceil(manifest.height / (manifest.width * 3)));
        }
      }
    }
    return count;
  }, [report.reportDocument.sections, report.visualAssetManifests]);

  useEffect(() => {
    let active = true;
    void api.zeroStatus()
      .then((status) => { if (active) setZeroStatus(status); })
      .catch(() => { if (active) setZeroStatus({ available: false, authenticated: false, reason: 'offline' }); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!zeroPublication || zeroPublication.status === 'completed' || zeroPublication.status === 'failed') return;
    let active = true;
    const poll = async () => {
      try {
        const next = await api.zeroPublication(taskId, zeroPublication.id);
        if (!active) return;
        setZeroPublication(next);
        setZeroError(null);
        if (next.status === 'completed') setZeroUiState('completed');
        else if (next.status === 'failed') {
          setZeroUiState('failed');
          setZeroError(next.failure?.message ?? '发送到 Zero 失败');
        } else setZeroUiState('running');
      } catch {
        if (active) {
          setZeroError('暂时无法读取发布进度，正在重试…');
        }
      }
    };
    const timer = window.setInterval(() => { void poll(); }, 1_000);
    void poll();
    return () => { active = false; window.clearInterval(timer); };
  }, [taskId, zeroPublication?.id, zeroPublication?.status]);

  function openZeroConfirmation() {
    const transition = transitionZeroPublicationConfirmation(zeroConfirmation, 'request');
    setZeroConfirmation(transition.state);
  }

  function cancelZeroConfirmation() {
    const transition = transitionZeroPublicationConfirmation(zeroConfirmation, 'cancel');
    setZeroConfirmation(transition.state);
    window.requestAnimationFrame(() => zeroPublishButtonRef.current?.focus());
  }

  async function confirmZeroPublication() {
    const transition = transitionZeroPublicationConfirmation(zeroConfirmation, 'confirm');
    setZeroConfirmation(transition.state);
    if (!transition.submit) return;

    const request = zeroPublicationRequestForSubmit({
      uiState: zeroUiState,
      previousRequest: zeroRequest,
      expectedTaskState: taskState,
      idempotencyKey: crypto.randomUUID(),
    });
    setZeroRequest(request);
    setZeroUiState('creating');
    setZeroError(null);
    try {
      const publication = await api.createZeroPublication(
        taskId,
        request.body,
        request.idempotencyKey,
      );
      setZeroPublication(publication);
      setZeroUiState(publication.status === 'completed' ? 'completed' : 'running');
    } catch (error) {
      setZeroUiState('failed');
      setZeroError(error instanceof Error ? error.message : '发送到 Zero 失败');
    }
  }

  const zeroReady = zeroStatus?.available === true
    && zeroStatus.authenticated === true
    && typeof zeroStatus.currentPageId === 'string';
  const zeroBusy = zeroUiState === 'creating' || zeroUiState === 'running';
  const zeroStatusHint = zeroStatus === null
    ? '正在检查 Zero…'
    : zeroReady
      ? `目标：${zeroStatus.currentPageName ?? zeroStatus.currentPageId}`
      : zeroStatus.reason === 'disabled'
        ? 'Zero 发布未启用'
        : zeroStatus.reason === 'unauthenticated'
          ? '请先在 Zero 桌面端登录'
          : zeroStatus.reason === 'no_design_tab'
            ? '请先打开一个 Zero 设计页面'
            : 'Zero 桌面端未连接';

  async function downloadBundle() {
    setBundleStatus('working');
    try {
      const bytes = await createReportBundle({
        report,
        readAsset: async ({ assetId }) => {
          const { blob, mediaType } = await loadVisualAsset(assetId);
          return { bytes: new Uint8Array(await blob.arrayBuffer()), mediaType };
        },
      });
      const ownedBytes = new Uint8Array(bytes.byteLength);
      ownedBytes.set(bytes);
      const url = URL.createObjectURL(new Blob([ownedBytes.buffer], { type: 'application/zip' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `research-report-${taskId}.zip`;
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setBundleStatus('idle');
    } catch {
      setBundleStatus('error');
    }
  }

  async function downloadHtmlBundle() {
    setHtmlBundleStatus('working');
    try {
      const { blob } = await api.controlHtmlBundle(taskId, report.deliverable.attemptId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `offline-html-report-${taskId}.zip`;
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setHtmlBundleStatus('idle');
    } catch {
      setHtmlBundleStatus('error');
    }
  }

  async function downloadEditorialShowcase() {
    setShowcaseStatus('working');
    try {
      const { blob } = await api.controlEditorialShowcase(taskId, report.deliverable.attemptId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `editorial-showcase-${taskId}.html`;
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setShowcaseStatus('idle');
    } catch {
      setShowcaseStatus('error');
    }
  }

  const isStrategyReport = report.deliverable.deliverableType === 'research_strategy_report';
  const strategyTabs = useMemo(
    () => isStrategyReport
      ? STRATEGY_REPORT_TABS.filter(({ id }) => strategyReportSectionIds(report.reportDocument, id).length > 0)
      : [],
    [isStrategyReport, report.reportDocument],
  );
  const activeStrategyView = strategyTabs.some(({ id }) => id === strategyView)
    ? strategyView
    : strategyTabs[0]?.id ?? 'answers';
  const visibleSectionIds = useMemo(
    () => isStrategyReport ? strategyReportSectionIds(report.reportDocument, activeStrategyView) : undefined,
    [activeStrategyView, isStrategyReport, report.reportDocument],
  );

  return (
    <>
      {isStrategyReport ? (
        <nav className="report-view-toggle" aria-label="研究报告内容导航">
          {strategyTabs.map(({ id, label }) => (
            <button key={id} type="button" className={activeStrategyView === id ? 'is-active' : ''} aria-pressed={activeStrategyView === id} onClick={() => setStrategyView(id)}>
              {label}
            </button>
          ))}
        </nav>
      ) : null}
      <ReportDocumentView
      document={report.reportDocument}
      sourceReportDocumentContentSha256={report.reportDocumentContentSha256}
      visibleSectionIds={visibleSectionIds}
      visualAssetManifests={report.visualAssetManifests}
      taskId={taskId}
      assetUrl={assetUrl}
      loadAsset={loadAsset}
      actions={(
        <>
          <button type="button" className="btn-ghost" onClick={() => window.print()}>打印 / PDF</button>
          <button type="button" className="btn-ghost" onClick={() => void downloadBundle()} disabled={bundleStatus === 'working'}>
            {bundleStatus === 'working' ? '正在打包…' : '下载 Markdown ZIP'}
          </button>
          {editorialShowcase?.status === 'ready' ? (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => void downloadEditorialShowcase()}
              disabled={showcaseStatus === 'working'}
            >
              {showcaseStatus === 'working' ? '正在下载…' : '下载编辑展示版'}
            </button>
          ) : null}
          {standaloneHtml?.status === 'ready' ? (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => void downloadHtmlBundle()}
              disabled={htmlBundleStatus === 'working'}
            >
              {htmlBundleStatus === 'working' ? '正在下载…' : '下载离线 HTML'}
            </button>
          ) : standaloneHtml?.status === 'unavailable' ? (
            <span
              role="status"
              style={{ alignSelf: 'center', color: 'var(--text-dim)', fontSize: 12 }}
            >
              离线 HTML 暂不可用，仍可下载 Markdown ZIP
            </span>
          ) : null}
          <button
            ref={zeroPublishButtonRef}
            type="button"
            className="btn-ghost"
            onClick={openZeroConfirmation}
            disabled={!zeroReady || zeroBusy || zeroUiState === 'completed'}
            title={zeroStatusHint}
            aria-haspopup="dialog"
            aria-expanded={zeroConfirmation === 'open'}
            aria-controls={zeroConfirmation === 'open' ? 'zero-publication-confirmation' : undefined}
          >
            {zeroPublicationButtonLabel(zeroUiState)}
          </button>
          <span
            style={{ color: zeroError ? 'var(--danger)' : 'var(--text-dim)', fontSize: 12 }}
            role={zeroError ? 'alert' : 'status'}
            aria-live="polite"
          >
            {zeroError
              ?? (zeroPublication && zeroBusy
                ? zeroPublicationProgressLabel(zeroPublication.stage, zeroPublication.progress)
                : zeroPublication?.status === 'completed'
                  ? `已发送 · 节点 ${zeroPublication.finalRootNodeId ?? '已创建'}`
                  : zeroStatusHint)}
          </span>
          {zeroConfirmation === 'open' ? (
            <section
              id="zero-publication-confirmation"
              className="zero-publication-confirmation"
              role="dialog"
              aria-labelledby="zero-publication-confirmation-title"
              aria-describedby="zero-publication-confirmation-description"
              onKeyDown={(event) => {
                if (event.key === 'Escape') cancelZeroConfirmation();
              }}
            >
              <h2 id="zero-publication-confirmation-title">确认发送到 Zero</h2>
              <p>{isReportDocumentV4(report.reportDocument)
                ? report.reportDocument.title.text
                : report.reportDocument.title}</p>
              <dl>
                <dt>目标文件</dt>
                <dd>{zeroStatus?.currentFileKey ?? '当前 Zero 文件'}</dd>
                <dt>目标页面</dt>
                <dd>{zeroStatus?.currentPageName ?? zeroStatus?.currentPageId}</dd>
                <dt>发布类型</dt>
                <dd>新建稿件</dd>
                <dt>视觉资产</dt>
                <dd>{report.visualAssetManifests.length} 个，预计至少 {estimatedSliceCount} 个切片</dd>
              </dl>
              <p id="zero-publication-confirmation-description">确认后会将可编辑稿件写入当前 Zero 页面；取消不会创建发布记录。</p>
              <div>
                <button
                  autoFocus
                  type="button"
                  className="btn-primary"
                  onClick={() => void confirmZeroPublication()}
                  disabled={!zeroReady || zeroBusy}
                >
                  确认发送
                </button>
                <button type="button" className="btn-ghost" onClick={cancelZeroConfirmation} disabled={zeroBusy}>
                  取消
                </button>
              </div>
            </section>
          ) : null}
          {bundleStatus === 'error' ? <span role="alert">报告包生成失败，请重试</span> : null}
          {htmlBundleStatus === 'error' ? <span role="alert">离线 HTML 下载失败，请重试</span> : null}
          {showcaseStatus === 'error' ? <span role="alert">编辑展示版下载失败，请重试</span> : null}
        </>
      )}
    />
    </>
  );
}

function CurrentTextReport({ report }: { report: ResearchPlanResponse }) {
  const { deliverable, evidenceManifest } = report;
  const { payload, findingGraph } = deliverable;
  const [bundleStatus, setBundleStatus] = useState<'idle' | 'working' | 'error'>('idle');

  async function downloadBundle() {
    setBundleStatus('working');
    try {
      if (report.presentationMode !== 'current_text') {
        throw new Error('ZIP report packages require the Current report format');
      }
      const bytes = await createReportBundle({
        report,
        async readAsset() { throw new Error('current-text report cannot reference visual assets'); },
      });
      const ownedBytes = new Uint8Array(bytes.byteLength);
      ownedBytes.set(bytes);
      const url = URL.createObjectURL(new Blob([ownedBytes.buffer], { type: 'application/zip' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `research-report-${deliverable.taskId}.zip`;
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setBundleStatus('idle');
    } catch {
      setBundleStatus('error');
    }
  }

  function download() {
    const blob = new Blob([currentResearchPlanToMarkdown(report)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `research-plan-${deliverable.taskId}.md`;
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <article className="stage-card">
      <Header n="4" title="可信研究计划" note="Current deliverable，可反查发现与证据" />

      <ReportSection title={payload.title}>
        <p>{payload.researchGoal}</p>
        <p style={{ color: 'var(--text-dim)' }}>{deliverable.methodSummary}</p>
        <dl style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '6px 12px', margin: 0 }}>
          <dt>市场</dt><dd style={{ margin: 0 }}>{payload.scope.market}</dd>
          <dt>研究对象</dt><dd style={{ margin: 0 }}>{payload.scope.subjects.join('、')}</dd>
          <dt>时间范围</dt><dd style={{ margin: 0 }}>{payload.scope.timeWindow}</dd>
        </dl>
      </ReportSection>

      <ReportSection title="竞品抽样">
        <p>{payload.competitorSampling.strategy}；目标样本数 {payload.competitorSampling.targetCount}</p>
        <ListGroup title="准入标准" items={payload.competitorSampling.inclusionCriteria} />
        <ListGroup title="排除标准" items={payload.competitorSampling.exclusionCriteria} />
      </ReportSection>

      <ReportSection title="研究问题">
        <TextList items={payload.researchQuestions} />
      </ReportSection>

      <ReportSection title="比较维度">
        {payload.comparisonDimensions.map((dimension) => (
          <section key={dimension.id} style={{ marginBottom: 12 }}>
            <h4 style={{ margin: '0 0 4px' }}>{dimension.name}</h4>
            <p style={{ margin: '0 0 4px' }}>{dimension.purpose}</p>
            <div style={{ color: 'var(--text-dim)' }}>采集字段：{dimension.collectionFields.join('、')}</div>
          </section>
        ))}
      </ReportSection>

      <ReportSection title="来源计划">
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {payload.sourcePlan.map((source, index) => (
            <li key={`${source.evidenceClass}-${index}`}>
              <b>{source.evidenceClass}</b>：{source.sourceTypes.join('、')}；{source.purpose}
            </li>
          ))}
        </ul>
      </ReportSection>

      <ReportSection title="执行计划">
        {payload.executionPlan.map((phase, index) => (
          <section key={`${phase.phase}-${index}`} style={{ marginBottom: 12 }}>
            <h4 style={{ margin: '0 0 4px' }}>{phase.phase} · {phase.duration}</h4>
            <div>活动：{phase.activities.join('；')}</div>
            <div style={{ color: 'var(--text-dim)' }}>产出：{phase.outputs.join('；')}</div>
          </section>
        ))}
      </ReportSection>

      <ReportSection title="采集模板">
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {payload.collectionTemplate.map((field) => (
            <li key={field.field}>
              <b>{field.field}</b>：{field.description}（{field.evidenceRequired ? '需要证据' : '无需证据'}）
            </li>
          ))}
        </ul>
      </ReportSection>

      <ReportSection title="分析、交付与质量">
        <ListGroup title="分析方法" items={payload.analysisMethods} />
        <ListGroup title="交付物" items={payload.deliverables} />
        <ListGroup title="质量检查" items={payload.qualityChecks} />
      </ReportSection>

      <ReportSection title="发现图谱">
        <h4 style={{ margin: '0 0 6px' }}>事实与推断</h4>
        <ul style={{ margin: '0 0 12px', paddingLeft: 20 }}>
          {findingGraph.findings.map((finding) => (
            <li key={finding.id}>
              <code>{finding.id}</code> {finding.statement}{' '}
              {finding.kind === 'fact'
                ? finding.evidenceIds.map((id) => <EvidenceReference key={id} id={id} report={report} />)
                : <span style={{ color: 'var(--text-dim)' }}>依据 {finding.findingIds.join('、')}</span>}
            </li>
          ))}
        </ul>
        <h4 style={{ margin: '0 0 6px' }}>分析</h4>
        <ul style={{ margin: '0 0 12px', paddingLeft: 20 }}>
          {findingGraph.analyses.map((analysis) => (
            <li key={analysis.id}><code>{analysis.id}</code> {analysis.statement}（依据 {analysis.findingIds.join('、')}）</li>
          ))}
        </ul>
        <h4 style={{ margin: '0 0 6px' }}>子问题总结</h4>
        <ul style={{ margin: '0 0 12px', paddingLeft: 20 }}>
          {findingGraph.subQuestionSummaries.map((summary) => (
            <li key={summary.id}><code>{summary.id}</code> {summary.summary}（发现 {summary.findingIds.join('、')}；分析 {summary.analysisIds.join('、')}）</li>
          ))}
        </ul>
        <h4 style={{ margin: '0 0 6px' }}>总体结论</h4>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {findingGraph.overallConclusions.map((conclusion) => (
            <li key={conclusion.id}><code>{conclusion.id}</code> {conclusion.statement}（总结 {conclusion.summaryIds.join('、')}）</li>
          ))}
        </ul>
      </ReportSection>

      <ReportSection title="证据清单">
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {evidenceManifest.entries.map((evidence) => (
            <li key={evidence.id}>
              <code>{evidence.id}</code> · {evidence.evidenceClass} · {evidence.kind}
              {evidence.sourceUrl ? <> · <SafeExternalLink url={evidence.sourceUrl} /></> : null}
              <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                artifact {evidence.artifactId} · {evidence.jsonPointer} · {evidence.redaction}
              </div>
            </li>
          ))}
        </ul>
      </ReportSection>

      <ReportSection title="建议">
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {deliverable.recommendations.map((recommendation) => (
            <li key={recommendation.id}>{recommendation.statement}（依据 {recommendation.summaryIds.join('、')}）</li>
          ))}
        </ul>
      </ReportSection>

      <ReportSection title="风险与待解决问题">
        {deliverable.risksAndOpenIssues.length > 0
          ? <TextList items={deliverable.risksAndOpenIssues} />
          : <p style={{ color: 'var(--text-dim)' }}>当前交付物未记录开放风险。</p>}
      </ReportSection>

      <ReportSection title="能力来源与追溯">
        <ul style={{ margin: '0 0 10px', paddingLeft: 20 }}>
          {deliverable.capabilityProvenance.map((capability) => (
            <li key={`${capability.type}-${capability.id}`}><b>{capability.type}</b>：{capability.id}</li>
          ))}
        </ul>
        <div className="mono" style={{ color: 'var(--text-faint)', fontSize: 11 }}>
          {deliverable.version} · {deliverable.deliverableType}<br />
          task {deliverable.taskId} · plan {deliverable.planVersionId} · attempt {deliverable.attemptId}<br />
          evidence artifact {deliverable.evidenceManifestArtifactId}<br />
          evidence manifest {evidenceManifest.manifestHash} · collected {evidenceManifest.collectedAt}
        </div>
      </ReportSection>

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button type="button" className="btn-ghost" onClick={() => window.print()}>打印 / PDF</button>
        <button type="button" className="btn-secondary" onClick={download}>导出 Markdown</button>
        {report.presentationMode === 'current_text' ? (
          <button type="button" className="btn-secondary" onClick={() => void downloadBundle()} disabled={bundleStatus === 'working'}>
            {bundleStatus === 'working' ? '正在打包…' : '下载报告包 (.zip)'}
          </button>
        ) : null}
        {bundleStatus === 'error' ? <span role="alert">报告包生成失败，请重试</span> : null}
      </div>
    </article>
  );
}

function GenericTextReport({ report }: { report: GenericTextReportResponse }) {
  const { deliverable, evidenceManifest } = report;
  const payload = JSON.stringify(deliverable.payload, null, 2) ?? 'null';
  const deliverableLabel = deliverable.deliverableType
    .replace(/[_-]+/gu, ' ')
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());

  return (
    <article className="stage-card">
      <Header n="4" title="历史结构化报告" note="兼容展示原始交付内容与追溯信息" />

      <ReportSection title={deliverableLabel}>
        <p>{deliverable.methodSummary}</p>
        <p style={{ color: 'var(--text-dim)' }}>
          此历史任务没有可用的多模态版式，以下内容按已验证的原始结构展示。
        </p>
      </ReportSection>

      <ReportSection title="交付内容">
        <pre
          className="mono"
          style={{
            margin: 0,
            padding: 14,
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            borderRadius: 10,
            background: 'var(--bg-card-hi)',
            border: '1px solid var(--border-soft)',
            fontSize: 12,
          }}
        >
          {payload}
        </pre>
      </ReportSection>

      <ReportSection title="证据清单">
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {evidenceManifest.entries.map((evidence) => (
            <li key={evidence.id}>
              <code>{evidence.id}</code> · {evidence.evidenceClass} · {evidence.kind}
              {evidence.sourceUrl ? <> · <SafeExternalLink url={evidence.sourceUrl} /></> : null}
            </li>
          ))}
        </ul>
      </ReportSection>

      <ReportSection title="建议">
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {deliverable.recommendations.map((recommendation) => (
            <li key={recommendation.id}>
              {recommendation.statement}（依据 {recommendation.summaryIds.join('、')}）
            </li>
          ))}
        </ul>
      </ReportSection>

      <ReportSection title="风险与待解决问题">
        {deliverable.risksAndOpenIssues.length > 0
          ? <TextList items={deliverable.risksAndOpenIssues} />
          : <p style={{ color: 'var(--text-dim)' }}>当前交付物未记录开放风险。</p>}
      </ReportSection>

      <ReportSection title="能力来源与追溯">
        <ul style={{ margin: '0 0 10px', paddingLeft: 20 }}>
          {deliverable.capabilityProvenance.map((capability) => (
            <li key={`${capability.type}-${capability.id}`}><b>{capability.type}</b>：{capability.id}</li>
          ))}
        </ul>
        <div className="mono" style={{ color: 'var(--text-faint)', fontSize: 11 }}>
          {deliverable.version} · {deliverable.deliverableType}<br />
          task {deliverable.taskId} · plan {deliverable.planVersionId} · attempt {deliverable.attemptId}<br />
          evidence manifest {evidenceManifest.manifestHash} · collected {evidenceManifest.collectedAt}
        </div>
      </ReportSection>
    </article>
  );
}

function ReportSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 18 }}>
      <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>{title}</h3>
      <div style={{ fontSize: 13.5, lineHeight: 1.7 }}>{children}</div>
    </section>
  );
}

function ListGroup({ title, items }: { title: string; items: string[] }) {
  return (
    <section style={{ marginBottom: 10 }}>
      <h4 style={{ margin: '0 0 4px' }}>{title}</h4>
      <TextList items={items} />
    </section>
  );
}

function TextList({ items }: { items: string[] }) {
  return <ul style={{ margin: 0, paddingLeft: 20 }}>{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>;
}

function EvidenceReference({ id, report }: { id: string; report: ControlDeliverableResponse }) {
  const evidence = report.evidenceManifest.entries.find((entry) => entry.id === id);
  if (!evidence?.sourceUrl) return <code style={{ marginLeft: 4 }}>[{id}]</code>;
  return <span style={{ marginLeft: 4 }}>[<SafeExternalLink url={evidence.sourceUrl} label={id} />]</span>;
}

function SafeExternalLink({ url, label }: { url: string; label?: string }) {
  let safeUrl: URL | null = null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') safeUrl = parsed;
  } catch {
    safeUrl = null;
  }
  if (!safeUrl) return <span>{label ?? url}</span>;
  return <a href={safeUrl.href} target="_blank" rel="noopener noreferrer">{label ?? safeUrl.href}</a>;
}
