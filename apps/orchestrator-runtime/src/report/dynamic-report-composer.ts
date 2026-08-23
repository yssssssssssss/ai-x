import type { RequestedArtifact } from '../../../../packages/api-contract/plan.ts';
import type {
  FindingGraph,
  ResearchDeliverableCoverage,
  ResearchStrategyReportPayload,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type { ReportAnswerBlock, ReportDocument, ReportSection } from './report-document-composer.ts';
import { assertProjectionCoverage, requiredPayloadPointers } from './report-projection.ts';

function answerKind(type: ResearchStrategyReportPayload['dynamicSections'][number]['blocks'][number]['type']): ReportAnswerBlock['kind'] {
  if (type === 'narrative') return 'evidence_finding';
  if (type === 'design_principles') return 'design_principle';
  if (type === 'opportunity_backlog') return 'opportunity';
  return type;
}

function answerBlock(input: Omit<ReportAnswerBlock, 'type' | 'summary' | 'findingIds' | 'summaryIds'> & {
  findingIds?: string[];
  summaryIds?: string[];
  summary?: boolean;
}): ReportAnswerBlock {
  return {
    ...input,
    type: 'answer',
    findingIds: input.findingIds ?? [],
    summaryIds: input.summaryIds ?? [],
    summary: input.summary ?? false,
  };
}

function canonicalProvenance(
  findingGraph: FindingGraph,
  coverage: ResearchDeliverableCoverage,
  evidenceIds: readonly string[],
  questionIds: readonly string[],
): { findingIds: string[]; summaryIds: string[] } {
  const evidence = new Set(evidenceIds);
  const findingIds = new Set<string>();
  for (const finding of findingGraph.findings) {
    if (finding.kind === 'fact' && finding.evidenceIds.some((id) => evidence.has(id))) findingIds.add(finding.id);
  }
  const summaryIds = new Set(coverage.questionBindings
    .filter(({ questionId }) => questionIds.includes(questionId))
    .flatMap(({ summaryIds: ids }) => ids));
  for (const summary of findingGraph.subQuestionSummaries) {
    if (summaryIds.has(summary.id)) for (const id of summary.findingIds) findingIds.add(id);
  }
  const analysisIds = new Set(findingGraph.analyses
    .filter(({ findingIds: ids }) => ids.some((id) => findingIds.has(id)))
    .map(({ id }) => id));
  for (const summary of findingGraph.subQuestionSummaries) {
    if (summary.findingIds.some((id) => findingIds.has(id)) || summary.analysisIds.some((id) => analysisIds.has(id))) {
      summaryIds.add(summary.id);
      for (const id of summary.findingIds) findingIds.add(id);
    }
  }
  return { findingIds: [...findingIds], summaryIds: [...summaryIds] };
}

function nonEmptySection(id: string, title: string, blocks: ReportAnswerBlock[]): ReportSection | null {
  return blocks.length > 0
    ? { id, title, questionIds: [...new Set(blocks.flatMap(({ questionIds }) => questionIds))], blocks }
    : null;
}

function bindingQuestionIds(
  payload: ResearchStrategyReportPayload,
  ...artifactTypes: RequestedArtifact[]
): string[] {
  const selected = new Set(artifactTypes);
  return [...new Set(payload.requestedArtifactBindings
    .filter(({ artifactType }) => selected.has(artifactType))
    .flatMap(({ questionIds }) => questionIds))];
}

function bindingSummary(payload: ResearchStrategyReportPayload): string[] {
  return payload.requestedArtifactBindings.map((binding) => (
    `${binding.artifactType}：${binding.status}；来源 ${binding.sourceField}；内容 ${binding.blockIds.join('、')}；问题 ${binding.questionIds.join('、')}；证据 ${binding.evidenceIds.join('、')}`
  ));
}

export function composeResearchStrategyDocument(input: {
  payload: ResearchStrategyReportPayload;
  deliverableArtifactId: string;
  payloadSchema: object;
  evidenceIndex: string[];
  evidenceIds?: string[];
  findingGraph: FindingGraph;
  coverage: ResearchDeliverableCoverage;
  envelopeRisksAndOpenIssues: string[];
}): ReportDocument {
  const { payload } = input;
  const disclosedRiskStatements = new Set(payload.riskDisclosures.map(({ statement }) => statement.trim()));
  for (const risk of input.envelopeRisksAndOpenIssues) {
    if (!disclosedRiskStatements.has(risk.trim())) {
      throw new Error(`research strategy report omits envelope risk: ${risk}`);
    }
  }
  const block = (value: Parameters<typeof answerBlock>[0]): ReportAnswerBlock => answerBlock({
    ...value,
    ...canonicalProvenance(input.findingGraph, input.coverage, value.evidenceIds, value.questionIds),
  });
  const strategyMapQuestionIds = bindingQuestionIds(payload, 'strategy_map');
  const mindModelQuestionIds = bindingQuestionIds(payload, 'mind_model');
  const principleQuestionIds = bindingQuestionIds(payload, 'design_principles');
  const opportunityQuestionIds = bindingQuestionIds(payload, 'opportunity_backlog');
  const actionQuestionIds = bindingQuestionIds(payload, 'prioritized_actions', 'action_plan');
  const channelQuestionIds = bindingQuestionIds(payload, 'channel_strategies');
  const sections: Array<ReportSection | null> = [
    nonEmptySection('executive-answers', '直接答案 / Executive Answers', payload.directAnswers.map((answer, index) => block({
      id: `answer-${answer.questionId}`,
      kind: 'direct_answer',
      title: answer.question,
      text: answer.answer,
      items: [
        `状态：${answer.answerStatus}`,
        `业务含义：${answer.businessImplication}`,
        `建议行动：${answer.recommendedAction}`,
        ...(answer.validationNeeded ? [`仍需验证：${answer.validationNeeded}`] : []),
      ],
      questionIds: [answer.questionId],
      evidenceIds: answer.evidenceIds,
      confidence: answer.confidence,
      answerStatus: answer.answerStatus,
      sourcePointers: index === 0
        ? ['/title', '/executiveAnswer', '/directAnswers']
        : ['/directAnswers'],
      sourceNodeIds: [answer.questionId],
      summary: true,
    }))),
    nonEmptySection('priority-actions', '优先行动 / Priority Actions', [
      block({
        id: 'priority-matrix',
        kind: 'priority_matrix',
        title: '行动优先级',
        text: '按 P0、P1、P2 排列的证据约束行动矩阵。',
        items: payload.prioritizedActions.map((action) => `${action.priority} · ${action.action} · ${action.ownerType}`),
        questionIds: actionQuestionIds,
        evidenceIds: [...new Set(payload.prioritizedActions.flatMap(({ evidenceIds }) => evidenceIds))],
        confidence: Math.min(...payload.prioritizedActions.map(({ confidence }) => confidence)),
        sourcePointers: ['/prioritizedActions'],
        sourceNodeIds: payload.prioritizedActions.map(({ id }) => id),
        summary: true,
      }),
      ...payload.prioritizedActions.map((action) => block({
        id: `action-${action.id}`,
        kind: 'action_plan',
        title: `${action.priority} · ${action.action}`,
        text: action.rationale,
        items: [`Owner：${action.ownerType}`, `验证：${action.validationMethod}`],
        questionIds: actionQuestionIds,
        evidenceIds: action.evidenceIds,
        confidence: action.confidence,
        sourcePointers: ['/prioritizedActions'],
        sourceNodeIds: [action.id],
      })),
    ]),
    ...payload.dynamicSections.map((section): ReportSection => ({
      id: `topic-${section.id}`,
      title: section.title,
      questionIds: [...new Set(section.blocks.flatMap(({ questionIds }) => questionIds))],
      blocks: section.blocks.map((dynamicBlock) => block({
        id: `dynamic-${section.id}-${dynamicBlock.id}`,
        kind: answerKind(dynamicBlock.type),
        title: dynamicBlock.title,
        text: dynamicBlock.content,
        items: [],
        questionIds: dynamicBlock.questionIds,
        evidenceIds: dynamicBlock.evidenceIds,
        confidence: dynamicBlock.confidence,
        sourcePointers: ['/dynamicSections'],
        sourceNodeIds: [dynamicBlock.id],
      })),
    })),
    nonEmptySection('strategy-map', '策略地图 / Strategy Map', [block({
      id: 'strategy-map-content', kind: 'strategy_map', title: payload.strategyMap.title,
      text: '按行列组织的证据约束策略地图。',
      items: payload.strategyMap.cells.map((cell) => `${cell.row} × ${cell.column}：${cell.statement}`),
      questionIds: strategyMapQuestionIds,
      evidenceIds: [...new Set(payload.strategyMap.cells.flatMap(({ evidenceIds }) => evidenceIds))],
      confidence: Math.min(...payload.strategyMap.cells.map(({ confidence }) => confidence)),
      sourcePointers: ['/strategyMap'],
      sourceNodeIds: payload.strategyMap.cells.map(({ id }) => id),
    })]),
    nonEmptySection('mind-model', '心智模型 / Mind Model', [block({
      id: 'mind-model-content', kind: 'mind_model', title: payload.mindModel.title,
      text: payload.mindModel.nodes.map((node) => `${node.label}：${node.description}`).join('；'),
      items: payload.mindModel.edges.map((edge) => `${edge.from} → ${edge.to}：${edge.relationship}`),
      questionIds: mindModelQuestionIds,
      evidenceIds: [...new Set(payload.mindModel.nodes.flatMap(({ evidenceIds }) => evidenceIds))],
      confidence: payload.mindModel.confidence,
      sourcePointers: ['/mindModel'],
      sourceNodeIds: payload.mindModel.nodes.map(({ id }) => id),
    })]),
    nonEmptySection('design-principles', '设计原则 / Design Principles', payload.designPrinciples.map((principle) => block({
      id: `principle-${principle.id}`, kind: 'design_principle', title: principle.title, text: principle.statement,
      items: [], questionIds: principleQuestionIds, evidenceIds: principle.evidenceIds, confidence: principle.confidence,
      sourcePointers: ['/designPrinciples'], sourceNodeIds: [principle.id],
    }))),
    nonEmptySection('opportunities', '机会点 / Opportunities', payload.opportunities.map((opportunity) => block({
      id: `opportunity-${opportunity.id}`, kind: 'opportunity', title: opportunity.title, text: opportunity.statement,
      items: [`影响：${opportunity.impact}`], questionIds: opportunityQuestionIds, evidenceIds: opportunity.evidenceIds,
      confidence: opportunity.confidence, sourcePointers: ['/opportunities'], sourceNodeIds: [opportunity.id],
    }))),
    nonEmptySection('channel-strategies', '场域策略 / Channel Strategies', payload.channelStrategies.map((channel) => block({
      id: `channel-${channel.id}`, kind: 'comparison_matrix', title: channel.channel, text: channel.role,
      items: channel.strategies, questionIds: channelQuestionIds, evidenceIds: channel.evidenceIds,
      confidence: channel.confidence,
      sourcePointers: ['/channelStrategies'], sourceNodeIds: [channel.id],
    }))),
    nonEmptySection('evidence-confidence', '证据与置信度 / Evidence and Confidence', payload.evidenceBackedFindings.map((finding) => block({
      id: `evidence-${finding.id}`, kind: 'evidence_finding', title: finding.id, text: finding.statement,
      items: [], questionIds: [], evidenceIds: finding.evidenceIds, confidence: finding.confidence,
      sourcePointers: ['/evidenceBackedFindings'], sourceNodeIds: [finding.id],
    }))),
    nonEmptySection('limitations', '局限与待解决问题 / Limitations and Open Questions', [
      block({
        id: 'risk-disclosure-index',
        kind: 'risk',
        title: '风险披露来源',
        text: payload.riskDisclosures.length > 0
          ? '以下局限与待解决问题保留其Canonical来源身份。'
          : 'Canonical Deliverable未声明需要传播的风险来源。',
        items: payload.riskDisclosures.map((risk) => `${risk.id} · ${risk.sourceType}:${risk.sourceId} · ${risk.disposition} · ${risk.statement}`),
        questionIds: [],
        evidenceIds: [],
        sourcePointers: ['/limitations', '/openQuestions', '/riskDisclosures'],
        sourceNodeIds: payload.riskDisclosures.map(({ id }) => id),
      }),
      ...payload.limitations.map((text, index) => block({ id: `limitation-${index + 1}`, kind: 'risk', title: '局限', text, items: [], questionIds: [], evidenceIds: [], sourcePointers: ['/limitations'] })),
      ...payload.openQuestions.map((text, index) => block({ id: `open-question-${index + 1}`, kind: 'risk', title: '待解决问题', text, items: [], questionIds: [], evidenceIds: [], sourcePointers: ['/openQuestions'] })),
    ]),
    nonEmptySection('analysis-notes', '分析底稿 / Analysis Notes', [block({
      id: 'decision-context', kind: 'evidence_finding', title: '决策背景', text: payload.decisionContext,
      items: payload.recommendations, questionIds: [], evidenceIds: [],
      sourcePointers: ['/decisionContext', '/recommendations'],
    })]),
    nonEmptySection('evidence-appendix', '证据附录 / Evidence Appendix', [block({
      id: 'evidence-index', kind: 'evidence_finding', title: 'Evidence 与请求交付物绑定', text: '报告使用的已验证证据及结构化交付绑定。',
      items: [...input.evidenceIndex, ...bindingSummary(payload)], questionIds: [], evidenceIds: input.evidenceIds ?? [],
      sourcePointers: ['/requestedArtifactBindings'],
    })]),
  ];
  const finalSections = sections.filter((section): section is ReportSection => section !== null);
  const coveredPointers = [...new Set(finalSections.flatMap(({ blocks }) => blocks.flatMap((block) => block.type === 'answer' ? block.sourcePointers : [])))];
  const required = requiredPayloadPointers(input.payloadSchema);
  assertProjectionCoverage(required, {
    sourceDeliverableArtifactId: input.deliverableArtifactId,
    projectionMode: 'full',
    coveredPointers,
    omittedPointers: [],
  });
  return {
    version: 'report-document-v2',
    title: payload.title,
    subtitle: 'Evidence-bound research strategy report',
    executiveSummary: payload.executiveAnswer,
    sections: finalSections,
    sourceDeliverableArtifactId: input.deliverableArtifactId,
    projectionMode: 'full',
    coveredPointers,
    omittedPointers: [],
  };
}
