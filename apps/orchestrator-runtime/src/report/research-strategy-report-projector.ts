import type {
  FindingGraph,
  ReportLayoutBlueprintV1,
  ResearchDeliverableCoverage,
  ResearchStrategyContentBlockV2,
  ResearchStrategyReportPayloadV2,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type {
  ReportAnswerBlock,
  ReportDocument,
  ReportSection,
} from './report-document-composer.ts';
import {
  assertProjectionCoverage,
  assertSemanticUnitProjectionCoverage,
  requiredPayloadPointers,
} from './report-projection.ts';

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
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
  return { findingIds: [...findingIds], summaryIds: [...summaryIds] };
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

function reportKind(kind: ResearchStrategyContentBlockV2['kind']): ReportAnswerBlock['kind'] {
  if (kind === 'narrative') return 'evidence_finding';
  if (kind === 'design_principles') return 'design_principle';
  if (kind === 'opportunity_backlog') return 'opportunity';
  if (kind === 'prioritized_actions') return 'priority_matrix';
  if (kind === 'channel_strategies') return 'comparison_matrix';
  return kind;
}

function mindEdgeProjectionId(blockId: string, index: number): string {
  return `${blockId}-edge-${String(index + 1).padStart(3, '0')}`;
}

export function researchStrategyProjectionUnitIds(
  payload: ResearchStrategyReportPayloadV2,
): string[] {
  return [
    ...payload.directAnswers.map(({ questionId }) => questionId),
    ...payload.evidenceFindings.map(({ id }) => id),
    ...payload.contentBlocks.flatMap((block) => {
      const parent = [block.id];
      if (block.kind === 'narrative') return parent;
      if (block.kind === 'comparison_matrix' || block.kind === 'strategy_map') {
        return [...parent, ...block.cells.map(({ id }) => id)];
      }
      if (block.kind === 'mind_model') {
        return [
          ...parent,
          ...block.nodes.map(({ id }) => id),
          ...block.edges.map((_, index) => mindEdgeProjectionId(block.id, index)),
        ];
      }
      if ('items' in block) return [...parent, ...block.items.map(({ id }) => id)];
      return parent;
    }),
    ...payload.limitations.map((_, index) => `limitation-${String(index + 1).padStart(3, '0')}`),
    ...payload.openQuestions.map((_, index) => `open-question-${String(index + 1).padStart(3, '0')}`),
    ...payload.riskDisclosures.map(({ id }) => id),
  ];
}

function projectedBlocks(input: {
  block: ResearchStrategyContentBlockV2;
  findingGraph: FindingGraph;
  coverage: ResearchDeliverableCoverage;
}): ReportAnswerBlock[] {
  const { block } = input;
  const create = (value: Omit<ReportAnswerBlock, 'type' | 'summary' | 'findingIds' | 'summaryIds'> & {
    sourceNodeIds?: string[];
    summary?: boolean;
  }): ReportAnswerBlock => answerBlock({
    ...value,
    ...canonicalProvenance(input.findingGraph, input.coverage, value.evidenceIds, value.questionIds),
  });
  if (block.kind === 'narrative') {
    return [create({
      id: `report-${block.id}`,
      kind: reportKind(block.kind),
      title: block.title,
      text: block.content,
      items: [],
      questionIds: block.support.questionIds,
      evidenceIds: block.support.evidenceIds,
      confidence: block.support.confidence,
      sourcePointers: ['/contentBlocks'],
      sourceNodeIds: [block.id],
    })];
  }
  if (block.kind === 'comparison_matrix' || block.kind === 'strategy_map') {
    const questionIds = unique(block.cells.flatMap(({ support }) => support.questionIds));
    const evidenceIds = unique(block.cells.flatMap(({ support }) => support.evidenceIds));
    return [create({
      id: `report-${block.id}`,
      kind: reportKind(block.kind),
      title: block.title,
      text: block.kind === 'strategy_map' ? '证据约束的策略地图。' : '证据约束的比较矩阵。',
      items: block.cells.map((cell) => `${cell.row} × ${cell.column}：${cell.statement}`),
      questionIds,
      evidenceIds,
      confidence: Math.min(...block.cells.map(({ support }) => support.confidence)),
      sourcePointers: ['/contentBlocks'],
      sourceNodeIds: [block.id, ...block.cells.map(({ id }) => id)],
    })];
  }
  if (block.kind === 'mind_model') {
    const questionIds = unique(block.nodes.flatMap(({ support }) => support.questionIds));
    const evidenceIds = unique(block.nodes.flatMap(({ support }) => support.evidenceIds));
    return [create({
      id: `report-${block.id}`,
      kind: 'mind_model',
      title: block.title,
      text: block.nodes.map((node) => `${node.label}：${node.description}`).join('；'),
      items: block.edges.map((edge) => `${edge.from} → ${edge.to}：${edge.relationship}`),
      questionIds,
      evidenceIds,
      confidence: Math.min(...block.nodes.map(({ support }) => support.confidence)),
      sourcePointers: ['/contentBlocks'],
      sourceNodeIds: [
        block.id,
        ...block.nodes.map(({ id }) => id),
        ...block.edges.map((_, index) => mindEdgeProjectionId(block.id, index)),
      ],
    })];
  }
  if (block.kind === 'design_principles') {
    return block.items.map((item, index) => create({
      id: `report-${item.id}`,
      kind: 'design_principle',
      title: index === 0 ? `${block.title} · ${item.title}` : item.title,
      text: item.statement,
      items: [],
      questionIds: item.support.questionIds,
      evidenceIds: item.support.evidenceIds,
      confidence: item.support.confidence,
      sourcePointers: ['/contentBlocks'],
      sourceNodeIds: [...(index === 0 ? [block.id] : []), item.id],
    }));
  }
  if (block.kind === 'opportunity_backlog') {
    return block.items.map((item, index) => create({
      id: `report-${item.id}`,
      kind: 'opportunity',
      title: index === 0 ? `${block.title} · ${item.title}` : item.title,
      text: item.statement,
      items: [`影响：${item.impact}`, ...(item.support.validationNeeded ? [`验证：${item.support.validationNeeded}`] : [])],
      questionIds: item.support.questionIds,
      evidenceIds: item.support.evidenceIds,
      confidence: item.support.confidence,
      sourcePointers: ['/contentBlocks'],
      sourceNodeIds: [...(index === 0 ? [block.id] : []), item.id],
    }));
  }
  if (block.kind === 'prioritized_actions' || block.kind === 'action_plan') {
    return block.items.map((item, index) => create({
      id: `report-${item.id}`,
      kind: reportKind(block.kind),
      title: index === 0 ? `${block.title} · ${item.priority} · ${item.action}` : `${item.priority} · ${item.action}`,
      text: item.rationale,
      items: [`Owner：${item.ownerType}`, `验证：${item.validationMethod}`],
      questionIds: item.support.questionIds,
      evidenceIds: item.support.evidenceIds,
      confidence: item.support.confidence,
      sourcePointers: ['/contentBlocks'],
      sourceNodeIds: [...(index === 0 ? [block.id] : []), item.id],
      summary: item.priority === 'P0',
    }));
  }
  if (block.kind !== 'channel_strategies' || !('items' in block)) {
    throw new Error(`Unsupported research strategy Block ${(block as { kind?: unknown }).kind as string}`);
  }
  return block.items.map((item, index) => create({
    id: `report-${item.id}`,
    kind: 'comparison_matrix',
    title: index === 0 ? `${block.title} · ${item.channel}` : item.channel,
    text: item.role,
    items: item.strategies,
    questionIds: item.support.questionIds,
    evidenceIds: item.support.evidenceIds,
    confidence: item.support.confidence,
    sourcePointers: ['/contentBlocks'],
    sourceNodeIds: [...(index === 0 ? [block.id] : []), item.id],
  }));
}

function assertBlueprintReferences(
  payload: ResearchStrategyReportPayloadV2,
  blueprint: ReportLayoutBlueprintV1,
): void {
  const known = new Set(payload.contentBlocks.map(({ id }) => id));
  const refs = blueprint.sections.flatMap(({ blockRefs }) => blockRefs);
  if (refs.length !== known.size || new Set(refs).size !== refs.length) {
    throw new Error('Report Layout Blueprint must reference every Canonical Content Block exactly once');
  }
  for (const ref of refs) if (!known.has(ref)) throw new Error(`Report Layout Blueprint references unknown Block ${ref}`);
}

export function projectResearchStrategyReportV2(input: {
  payload: ResearchStrategyReportPayloadV2;
  blueprint: ReportLayoutBlueprintV1;
  layoutMode: 'model' | 'fallback';
  layoutWarnings: string[];
  deliverableArtifactId: string;
  payloadSchema: object;
  evidenceIndex: string[];
  evidenceIds: string[];
  findingGraph: FindingGraph;
  coverage: ResearchDeliverableCoverage;
}): ReportDocument {
  assertBlueprintReferences(input.payload, input.blueprint);
  const byId = new Map(input.payload.contentBlocks.map((block) => [block.id, block]));
  const block = (value: Parameters<typeof answerBlock>[0]): ReportAnswerBlock => answerBlock({
    ...value,
    ...canonicalProvenance(input.findingGraph, input.coverage, value.evidenceIds, value.questionIds),
  });
  const sections: ReportSection[] = [{
    id: 'executive-answers',
    title: '直接答案 / Executive Answers',
    prominence: 'primary',
    questionIds: unique(input.payload.directAnswers.map(({ questionId }) => questionId)),
    blocks: input.payload.directAnswers.map((answer, index) => block({
      id: `answer-${answer.questionId}`,
      kind: 'direct_answer',
      title: answer.question,
      text: answer.answer,
      items: [
        `业务含义：${answer.businessImplication}`,
        `建议行动：${answer.recommendedAction}`,
        ...(answer.validationNeeded ? [`仍需验证：${answer.validationNeeded}`] : []),
      ],
      questionIds: [answer.questionId],
      evidenceIds: answer.evidenceIds,
      confidence: answer.confidence,
      answerStatus: answer.answerStatus,
      sourcePointers: index === 0
        ? ['/schemaVersion', '/title', '/decisionContext', '/executiveAnswer', '/directAnswers']
        : ['/directAnswers'],
      sourceNodeIds: [answer.questionId],
      summary: true,
    })),
  }];

  input.blueprint.sections.forEach((section, index) => {
    const reportBlocks = section.blockRefs.flatMap((id) => projectedBlocks({
      block: byId.get(id)!,
      findingGraph: input.findingGraph,
      coverage: input.coverage,
    }));
    sections.push({
      id: `model-section-${String(index + 1).padStart(3, '0')}`,
      title: section.title,
      prominence: section.prominence,
      questionIds: unique(reportBlocks.flatMap(({ questionIds }) => questionIds)),
      blocks: reportBlocks,
    });
  });

  const evidenceBlocks = input.payload.evidenceFindings.map((finding) => block({
    id: `report-${finding.id}`,
    kind: 'evidence_finding',
    title: finding.id,
    text: finding.statement,
    items: [],
    questionIds: finding.support.questionIds,
    evidenceIds: finding.support.evidenceIds,
    confidence: finding.support.confidence,
    sourcePointers: ['/evidenceFindings'],
    sourceNodeIds: [finding.id],
  }));
  sections.push({
    id: 'evidence-confidence',
    title: '证据与置信度 / Evidence and Confidence',
    prominence: 'supporting',
    questionIds: unique(evidenceBlocks.flatMap(({ questionIds }) => questionIds)),
    blocks: evidenceBlocks,
  });

  sections.push({
    id: 'limitations',
    title: '局限与待解决问题 / Limitations and Open Questions',
    prominence: 'supporting',
    questionIds: [],
    blocks: [block({
      id: 'risk-disclosure-index',
      kind: 'risk',
      title: '风险与不确定性',
      text: input.payload.riskDisclosures.length > 0
        ? '以下内容保留其 Canonical 来源身份。'
        : '当前没有必须传播的风险来源。',
      items: [
        ...input.payload.limitations.map((value) => `局限：${value}`),
        ...input.payload.openQuestions.map((value) => `待解决：${value}`),
        ...input.payload.riskDisclosures.map((risk) => `${risk.sourceType}:${risk.sourceId} · ${risk.statement}`),
      ],
      questionIds: [],
      evidenceIds: [],
      sourcePointers: ['/limitations', '/openQuestions', '/riskDisclosures'],
      sourceNodeIds: [
        ...input.payload.limitations.map((_, index) => `limitation-${String(index + 1).padStart(3, '0')}`),
        ...input.payload.openQuestions.map((_, index) => `open-question-${String(index + 1).padStart(3, '0')}`),
        ...input.payload.riskDisclosures.map(({ id }) => id),
      ],
    })],
  });

  sections.push({
    id: 'evidence-appendix',
    title: '证据附录 / Evidence Appendix',
    prominence: 'appendix',
    questionIds: [],
    blocks: [block({
      id: 'evidence-index',
      kind: 'evidence_finding',
      title: 'Evidence 与请求交付物绑定',
      text: '已验证 Evidence 与 Canonical Content Block 的确定性绑定。',
      items: [
        ...input.evidenceIndex,
        ...input.payload.requestedArtifactBindings.map((binding) => (
          `${binding.artifactType}：${binding.blockIds.join('、')}；问题 ${binding.questionIds.join('、')}；证据 ${binding.evidenceIds.join('、')}`
        )),
      ],
      questionIds: [],
      evidenceIds: input.evidenceIds,
      sourcePointers: ['/requestedArtifactBindings'],
    })],
  });

  const coveredPointers = unique(sections.flatMap(({ blocks }) => blocks.flatMap((candidate) => (
    candidate.type === 'answer' ? candidate.sourcePointers : []
  ))));
  assertProjectionCoverage(requiredPayloadPointers(input.payloadSchema), {
    sourceDeliverableArtifactId: input.deliverableArtifactId,
    projectionMode: 'full',
    coveredPointers,
    omittedPointers: [],
  });
  const document: ReportDocument = {
    version: 'report-document-v2',
    title: input.payload.title,
    subtitle: 'Evidence-bound model-directed research strategy report',
    executiveSummary: input.payload.executiveAnswer,
    sections,
    sourceDeliverableArtifactId: input.deliverableArtifactId,
    projectionMode: 'full',
    coveredPointers,
    omittedPointers: [],
    layoutMode: input.layoutMode,
    layoutWarnings: input.layoutWarnings,
  };
  assertSemanticUnitProjectionCoverage(researchStrategyProjectionUnitIds(input.payload), document);
  return document;
}
