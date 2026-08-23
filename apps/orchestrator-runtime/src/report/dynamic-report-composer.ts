import type { RequestedArtifact } from '../../../../packages/api-contract/plan.ts';
import type { ResearchStrategyReportPayload } from '../../../../packages/api-contract/research-deliverable.ts';
import type { ReportAnswerBlock, ReportDocument, ReportSection } from './report-document-composer.ts';
import { assertProjectionCoverage, requiredPayloadPointers } from './report-projection.ts';

function answerKind(type: ResearchStrategyReportPayload['dynamicSections'][number]['blocks'][number]['type']): ReportAnswerBlock['kind'] {
  if (type === 'narrative') return 'evidence_finding';
  if (type === 'design_principles') return 'design_principle';
  if (type === 'opportunity_backlog') return 'opportunity';
  return type;
}

function answerBlock(input: Omit<ReportAnswerBlock, 'type' | 'summary'> & { summary?: boolean }): ReportAnswerBlock {
  return { ...input, type: 'answer', summary: input.summary ?? false };
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
}): ReportDocument {
  const { payload } = input;
  const strategyMapQuestionIds = bindingQuestionIds(payload, 'strategy_map');
  const mindModelQuestionIds = bindingQuestionIds(payload, 'mind_model');
  const principleQuestionIds = bindingQuestionIds(payload, 'design_principles');
  const opportunityQuestionIds = bindingQuestionIds(payload, 'opportunity_backlog');
  const actionQuestionIds = bindingQuestionIds(payload, 'prioritized_actions', 'action_plan');
  const channelQuestionIds = bindingQuestionIds(payload, 'channel_strategies');
  const sections: Array<ReportSection | null> = [
    nonEmptySection('executive-answers', '直接答案 / Executive Answers', payload.directAnswers.map((answer, index) => answerBlock({
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
      sourcePointers: index === 0
        ? ['/title', '/executiveAnswer', '/directAnswers']
        : ['/directAnswers'],
      sourceNodeIds: [answer.questionId],
      summary: true,
    }))),
    nonEmptySection('priority-actions', '优先行动 / Priority Actions', [
      answerBlock({
        id: 'priority-matrix',
        kind: 'priority_matrix',
        title: '行动优先级',
        text: '按 P0、P1、P2 排列的证据约束行动矩阵。',
        items: payload.prioritizedActions.map((action) => `${action.priority} · ${action.action} · ${action.ownerType}`),
        questionIds: actionQuestionIds,
        evidenceIds: [...new Set(payload.prioritizedActions.flatMap(({ evidenceIds }) => evidenceIds))],
        confidence: Math.min(...payload.prioritizedActions.map(({ evidenceIds }) => evidenceIds.length > 0 ? 0.75 : 0.4)),
        sourcePointers: ['/prioritizedActions'],
        sourceNodeIds: payload.prioritizedActions.map(({ id }) => id),
        summary: true,
      }),
      ...payload.prioritizedActions.map((action) => answerBlock({
        id: `action-${action.id}`,
        kind: 'action_plan',
        title: `${action.priority} · ${action.action}`,
        text: action.rationale,
        items: [`Owner：${action.ownerType}`, `验证：${action.validationMethod}`],
        questionIds: actionQuestionIds,
        evidenceIds: action.evidenceIds,
        confidence: action.evidenceIds.length > 0 ? 0.75 : 0.4,
        sourcePointers: ['/prioritizedActions'],
        sourceNodeIds: [action.id],
      })),
    ]),
    ...payload.dynamicSections.map((section): ReportSection => ({
      id: `topic-${section.id}`,
      title: section.title,
      questionIds: [...new Set(section.blocks.flatMap(({ questionIds }) => questionIds))],
      blocks: section.blocks.map((block) => answerBlock({
        id: `dynamic-${section.id}-${block.id}`,
        kind: answerKind(block.type),
        title: block.title,
        text: block.content,
        items: [],
        questionIds: block.questionIds,
        evidenceIds: block.evidenceIds,
        confidence: block.confidence,
        sourcePointers: ['/dynamicSections'],
        sourceNodeIds: [block.id],
      })),
    })),
    nonEmptySection('strategy-map', '策略地图 / Strategy Map', [answerBlock({
      id: 'strategy-map-content', kind: 'strategy_map', title: payload.strategyMap.title,
      text: '按行列组织的证据约束策略地图。',
      items: payload.strategyMap.cells.map((cell) => `${cell.row} × ${cell.column}：${cell.statement}`),
      questionIds: strategyMapQuestionIds,
      evidenceIds: [...new Set(payload.strategyMap.cells.flatMap(({ evidenceIds }) => evidenceIds))],
      confidence: Math.min(...payload.strategyMap.cells.map(({ confidence }) => confidence)),
      sourcePointers: ['/strategyMap'],
      sourceNodeIds: payload.strategyMap.cells.map(({ id }) => id),
    })]),
    nonEmptySection('mind-model', '心智模型 / Mind Model', [answerBlock({
      id: 'mind-model-content', kind: 'mind_model', title: payload.mindModel.title,
      text: payload.mindModel.nodes.map((node) => `${node.label}：${node.description}`).join('；'),
      items: payload.mindModel.edges.map((edge) => `${edge.from} → ${edge.to}：${edge.relationship}`),
      questionIds: mindModelQuestionIds,
      evidenceIds: [...new Set(payload.mindModel.nodes.flatMap(({ evidenceIds }) => evidenceIds))],
      confidence: 0.7,
      sourcePointers: ['/mindModel'],
      sourceNodeIds: payload.mindModel.nodes.map(({ id }) => id),
    })]),
    nonEmptySection('design-principles', '设计原则 / Design Principles', payload.designPrinciples.map((principle) => answerBlock({
      id: `principle-${principle.id}`, kind: 'design_principle', title: principle.title, text: principle.statement,
      items: [], questionIds: principleQuestionIds, evidenceIds: principle.evidenceIds, confidence: principle.confidence,
      sourcePointers: ['/designPrinciples'], sourceNodeIds: [principle.id],
    }))),
    nonEmptySection('opportunities', '机会点 / Opportunities', payload.opportunities.map((opportunity) => answerBlock({
      id: `opportunity-${opportunity.id}`, kind: 'opportunity', title: opportunity.title, text: opportunity.statement,
      items: [`影响：${opportunity.impact}`], questionIds: opportunityQuestionIds, evidenceIds: opportunity.evidenceIds,
      confidence: opportunity.confidence, sourcePointers: ['/opportunities'], sourceNodeIds: [opportunity.id],
    }))),
    nonEmptySection('channel-strategies', '场域策略 / Channel Strategies', payload.channelStrategies.map((channel) => answerBlock({
      id: `channel-${channel.id}`, kind: 'comparison_matrix', title: channel.channel, text: channel.role,
      items: channel.strategies, questionIds: channelQuestionIds, evidenceIds: channel.evidenceIds,
      confidence: channel.evidenceIds.length > 0 ? 0.75 : 0.4,
      sourcePointers: ['/channelStrategies'], sourceNodeIds: [channel.id],
    }))),
    nonEmptySection('evidence-confidence', '证据与置信度 / Evidence and Confidence', payload.evidenceBackedFindings.map((finding) => answerBlock({
      id: `evidence-${finding.id}`, kind: 'evidence_finding', title: finding.id, text: finding.statement,
      items: [], questionIds: [], evidenceIds: finding.evidenceIds, confidence: finding.confidence,
      sourcePointers: ['/evidenceBackedFindings'], sourceNodeIds: [finding.id],
    }))),
    nonEmptySection('limitations', '局限与待解决问题 / Limitations and Open Questions', [
      ...(payload.limitations.length > 0
        ? payload.limitations.map((text, index) => answerBlock({ id: `limitation-${index + 1}`, kind: 'risk', title: '局限', text, items: [], questionIds: [], evidenceIds: [], confidence: 1, sourcePointers: ['/limitations'] }))
        : [answerBlock({ id: 'limitations-none', kind: 'risk', title: '局限', text: 'Canonical Deliverable 未声明局限。', items: [], questionIds: [], evidenceIds: [], confidence: 1, sourcePointers: ['/limitations'] })]),
      ...(payload.openQuestions.length > 0
        ? payload.openQuestions.map((text, index) => answerBlock({ id: `open-question-${index + 1}`, kind: 'risk', title: '待解决问题', text, items: [], questionIds: [], evidenceIds: [], confidence: 1, sourcePointers: ['/openQuestions'] }))
        : [answerBlock({ id: 'open-questions-none', kind: 'risk', title: '待解决问题', text: 'Canonical Deliverable 未声明待解决问题。', items: [], questionIds: [], evidenceIds: [], confidence: 1, sourcePointers: ['/openQuestions'] })]),
    ]),
    nonEmptySection('analysis-notes', '分析底稿 / Analysis Notes', [answerBlock({
      id: 'decision-context', kind: 'evidence_finding', title: '决策背景', text: payload.decisionContext,
      items: payload.recommendations, questionIds: [], evidenceIds: [], confidence: 1,
      sourcePointers: ['/decisionContext', '/recommendations'],
    })]),
    nonEmptySection('evidence-appendix', '证据附录 / Evidence Appendix', [answerBlock({
      id: 'evidence-index', kind: 'evidence_finding', title: 'Evidence 与请求交付物绑定', text: '报告使用的已验证证据及结构化交付绑定。',
      items: [...input.evidenceIndex, ...bindingSummary(payload)], questionIds: [], evidenceIds: input.evidenceIds ?? [], confidence: 1,
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
