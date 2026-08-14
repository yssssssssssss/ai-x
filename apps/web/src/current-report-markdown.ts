import type { CurrentReportPackageResponse } from '../../../packages/api-contract/control-workflow.ts';
import type { ResearchPlanPayload } from '../../../packages/api-contract/research-deliverable.ts';

export type CurrentResearchPlanResponse = CurrentReportPackageResponse<ResearchPlanPayload>;

export type TextCurrentResearchPlanResponse = Extract<
  CurrentResearchPlanResponse,
  { presentationMode: 'legacy_text' | 'current_text' }
>;

export function assertCurrentReportTextMode(
  input: CurrentResearchPlanResponse,
): asserts input is TextCurrentResearchPlanResponse {
  if (input.presentationMode === 'multimodal') {
    throw new Error('multimodal report packages require the Phase 5 renderer');
  }
}

function appendList(lines: string[], items: string[]): void {
  for (const item of items) lines.push(`- ${item}`);
  lines.push('');
}
function assertReference(ids: Set<string>, reference: string, type: string, owner: string): void {
  if (!ids.has(reference)) {
    throw new Error(`Dangling ${type} reference ${reference} in ${owner}`);
  }
}

function assertFindingGraphReferences(input: TextCurrentResearchPlanResponse): void {
  const { findingGraph } = input.deliverable;
  const evidenceIds = new Set(input.evidenceManifest.entries.map((entry) => entry.id));
  const findingIds = new Set(findingGraph.findings.map((finding) => finding.id));
  const analysisIds = new Set(findingGraph.analyses.map((analysis) => analysis.id));
  const summaryIds = new Set(findingGraph.subQuestionSummaries.map((summary) => summary.id));

  for (const finding of findingGraph.findings) {
    if (finding.kind === 'fact') {
      for (const id of finding.evidenceIds) assertReference(evidenceIds, id, 'evidence', finding.id);
    } else {
      for (const id of finding.findingIds) assertReference(findingIds, id, 'finding', finding.id);
    }
  }
  for (const analysis of findingGraph.analyses) {
    for (const id of analysis.findingIds) assertReference(findingIds, id, 'finding', analysis.id);
  }
  for (const summary of findingGraph.subQuestionSummaries) {
    for (const id of summary.findingIds) assertReference(findingIds, id, 'finding', summary.id);
    for (const id of summary.analysisIds) assertReference(analysisIds, id, 'analysis', summary.id);
  }
  for (const conclusion of findingGraph.overallConclusions) {
    for (const id of conclusion.summaryIds) assertReference(summaryIds, id, 'summary', conclusion.id);
  }
  for (const recommendation of input.deliverable.recommendations) {
    for (const id of recommendation.summaryIds) {
      assertReference(summaryIds, id, 'summary', `recommendation ${recommendation.id}`);
    }
  }
}

export function currentResearchPlanToMarkdown(input: CurrentResearchPlanResponse): string {
  assertCurrentReportTextMode(input);
  assertFindingGraphReferences(input);
  const { deliverable, evidenceManifest } = input;
  const { payload } = deliverable;
  const lines: string[] = [`# ${payload.title}`, ''];

  lines.push('## 研究目标', '', payload.researchGoal, '');

  lines.push(
    '## 研究范围',
    '',
    `- **市场：** ${payload.scope.market}`,
    `- **研究对象：** ${payload.scope.subjects.join('、')}`,
    `- **时间范围：** ${payload.scope.timeWindow}`,
    '',
  );

  lines.push(
    '## 样本策略',
    '',
    `- **抽样策略：** ${payload.competitorSampling.strategy}`,
    `- **目标样本数：** ${payload.competitorSampling.targetCount}`,
    '',
    '### 准入标准',
    '',
  );
  appendList(lines, payload.competitorSampling.inclusionCriteria);
  lines.push('### 排除标准', '');
  appendList(lines, payload.competitorSampling.exclusionCriteria);

  lines.push('## 研究问题', '');
  appendList(lines, payload.researchQuestions);

  lines.push('## 比较维度', '');
  for (const dimension of payload.comparisonDimensions) {
    lines.push(
      `### ${dimension.name}`,
      '',
      `- **维度 ID：** ${dimension.id}`,
      `- **目的：** ${dimension.purpose}`,
      `- **采集字段：** ${dimension.collectionFields.join('、')}`,
      '',
    );
  }

  lines.push('## 来源计划', '');
  for (const source of payload.sourcePlan) {
    lines.push(
      `- **证据类型：** ${source.evidenceClass}`,
      `  - **来源类型：** ${source.sourceTypes.join('、')}`,
      `  - **用途：** ${source.purpose}`,
    );
  }
  lines.push('');

  lines.push('## 执行阶段', '');
  for (const phase of payload.executionPlan) {
    lines.push(
      `### ${phase.phase}`,
      '',
      `- **持续时间：** ${phase.duration}`,
      '- **活动：**',
      ...phase.activities.map((activity) => `  - ${activity}`),
      '- **产出：**',
      ...phase.outputs.map((output) => `  - ${output}`),
      '',
    );
  }

  lines.push('## 采集模板', '');
  for (const field of payload.collectionTemplate) {
    const evidenceLabel = field.evidenceRequired ? '需要证据' : '无需证据';
    lines.push(`- **${field.field}：** ${field.description}（${evidenceLabel}）`);
  }
  lines.push('');

  lines.push('## 分析方法', '');
  appendList(lines, payload.analysisMethods);

  lines.push('## 交付物', '');
  appendList(lines, payload.deliverables);

  lines.push('## 质量检查', '');
  appendList(lines, payload.qualityChecks);

  lines.push('## 关键发现', '');
  for (const finding of deliverable.findingGraph.findings) {
    if (finding.kind === 'fact') {
      const citations = finding.evidenceIds.map((id) => `[${id}]`).join(' ');
      lines.push(`- [${finding.id}] ${finding.statement}${citations ? ` ${citations}` : ''}`);
      continue;
    }
    const findingReferences = finding.findingIds.map((id) => `[${id}]`).join(' ');
    lines.push(`- [${finding.id}] ${finding.statement}${findingReferences ? `（基于 ${findingReferences}）` : ''}`);
  }
  lines.push('');

  lines.push('## 分析节点', '');
  for (const analysis of deliverable.findingGraph.analyses) {
    const findingReferences = analysis.findingIds.map((id) => `[${id}]`).join(' ');
    lines.push(`- [${analysis.id}] ${analysis.statement}${findingReferences ? `（基于 ${findingReferences}）` : ''}`);
  }
  lines.push('');

  lines.push('## 子问题摘要', '');
  for (const summary of deliverable.findingGraph.subQuestionSummaries) {
    const references = [...summary.findingIds, ...summary.analysisIds]
      .map((id) => `[${id}]`)
      .join(' ');
    lines.push(`- [${summary.id}] ${summary.summary}${references ? `（基于 ${references}）` : ''}`);
  }
  lines.push('');

  lines.push('## 总体结论', '');
  for (const conclusion of deliverable.findingGraph.overallConclusions) {
    const summaryReferences = conclusion.summaryIds.map((id) => `[${id}]`).join(' ');
    lines.push(`- [${conclusion.id}] ${conclusion.statement}${summaryReferences ? `（基于 ${summaryReferences}）` : ''}`);
  }
  lines.push('');

  lines.push('## 公开来源', '');
  for (const evidence of evidenceManifest.entries) {
    if (evidence.evidenceClass !== 'public_source' || !evidence.sourceUrl) continue;
    lines.push(`- [${evidence.id}] [${evidence.sourceUrl}](${evidence.sourceUrl})`);
  }
  lines.push('');

  lines.push('## 建议', '');
  for (const recommendation of deliverable.recommendations) {
    const summaryReferences = recommendation.summaryIds.map((id) => `[${id}]`).join(' ');
    lines.push(
      `- [${recommendation.id}] ${recommendation.statement}${summaryReferences ? `（依据 ${summaryReferences}）` : ''}`,
    );
  }
  lines.push('');

  if (deliverable.risksAndOpenIssues.length > 0) {
    lines.push('## 风险与待解决问题', '');
    appendList(lines, deliverable.risksAndOpenIssues);
  }

  lines.push('## 能力来源', '');
  for (const capability of deliverable.capabilityProvenance) {
    lines.push(`- **${capability.type}：** ${capability.id}`);
  }
  lines.push('');

  return lines.join('\n');
}
