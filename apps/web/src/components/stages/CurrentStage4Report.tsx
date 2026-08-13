import type { CurrentResearchPlanResponse } from '../../current-report-markdown.ts';
import { currentResearchPlanToMarkdown } from '../../current-report-markdown.ts';
import { Header } from './Stage1Understand.tsx';

export function CurrentStage4Report({ report }: { report: CurrentResearchPlanResponse }) {
  const { deliverable, evidenceManifest } = report;
  const { payload, findingGraph } = deliverable;

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

      <div style={{ marginTop: 16 }}>
        <button type="button" className="btn-secondary" onClick={download}>导出 Markdown</button>
      </div>
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

function EvidenceReference({ id, report }: { id: string; report: CurrentResearchPlanResponse }) {
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
