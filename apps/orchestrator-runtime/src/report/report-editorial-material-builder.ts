import type { ControlArtifact } from '../../../../database/control-plane.ts';
import type { PassedReportReviewArtifact } from '../../../../packages/api-contract/control-workflow.ts';
import type {
  EditorialLeafTrace,
  ReportAuditAppendixMaterialV1,
  ReportEditorialMaterialV1,
  ReportEditorialPresentationUnitV1,
  ReportPresentationV1,
} from '../../../../packages/api-contract/report-editorial.ts';
import type {
  ContributionLedgerV1,
  ResearchDeliverableEnvelope,
  ResearchPlanPayload,
  ResearchStrategyReportPayloadV2,
} from '../../../../packages/api-contract/research-deliverable.ts';
import {
  assertReportAuditAppendixMaterialIntegrity,
  assertReportEditorialMaterialIntegrity,
  isPresentationCompatible,
} from '../../../../packages/report-rendering/report-editorial-validation.ts';

interface VerifiedArtifactValue<T> {
  artifact: ControlArtifact;
  value: T;
}

interface EditorialMaterialInput<TPayload> {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  requiredQuestionIds: readonly string[];
  deliverable: VerifiedArtifactValue<ResearchDeliverableEnvelope<TPayload>>;
  review: VerifiedArtifactValue<PassedReportReviewArtifact>;
}

export interface ResearchStrategyEditorialMaterialInput
  extends EditorialMaterialInput<ResearchStrategyReportPayloadV2> {}

export interface ResearchPlanEditorialMaterialInput
  extends EditorialMaterialInput<ResearchPlanPayload> {}

export interface ReportAuditAppendixMaterialInput {
  material: ReportEditorialMaterialV1;
  contributionLedger: VerifiedArtifactValue<ContributionLedgerV1>;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function pad(index: number): string {
  return String(index + 1).padStart(3, '0');
}

function unitId(kind: string, sourceId: string): string {
  return `${kind}:${sourceId}`;
}

function leafId(kind: string, sourceId: string): string {
  return `leaf:${kind}:${sourceId}`;
}

function edgeSourceId(blockId: string, index: number): string {
  return `${blockId}-edge-${pad(index)}`;
}

function assertSha256(value: string | null, label: string): asserts value is string {
  if (!value || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must have a sealed SHA-256 hash`);
  }
}

function assertBoundSealedArtifact(
  artifact: ControlArtifact,
  input: { taskId: string; planVersionId: string; attemptId: string },
  kind: string,
): asserts artifact is ControlArtifact & { contentSha256: string; byteSize: number } {
  if (
    artifact.state !== 'SEALED'
    || artifact.kind !== kind
    || artifact.taskId !== input.taskId
    || artifact.planVersionId !== input.planVersionId
    || artifact.attemptId !== input.attemptId
    || artifact.byteSize === null
  ) {
    throw new Error(`${kind} Artifact must be SEALED and match the Task, Plan, and Attempt binding`);
  }
  assertSha256(artifact.contentSha256, `${kind} Artifact`);
}

function assertInputBinding(input: ResearchStrategyEditorialMaterialInput): void {
  assertBoundSealedArtifact(input.deliverable.artifact, input, 'deliverable');
  assertBoundSealedArtifact(input.review.artifact, input, 'report_review');
  const deliverable = input.deliverable.value;
  const review = input.review.value;
  if (
    deliverable.version !== 'research-deliverable-v1'
    || deliverable.taskId !== input.taskId
    || deliverable.planVersionId !== input.planVersionId
    || deliverable.attemptId !== input.attemptId
    || deliverable.deliverableType !== 'research_strategy_report'
    || deliverable.payload.schemaVersion !== 'research-strategy-content-v2'
  ) {
    throw new Error('Material Builder requires a bound research_strategy_report Content v2 Deliverable');
  }
  if (
    review.verdict !== 'pass'
    || review.taskId !== input.taskId
    || review.planVersionId !== input.planVersionId
    || review.attemptId !== input.attemptId
    || review.deliverableArtifactId !== input.deliverable.artifact.id
    || input.review.artifact.schemaVersion !== review.version
  ) {
    throw new Error('Material Builder requires a sealed final pass Review bound to the Deliverable');
  }
}

function assertResearchPlanInputBinding(input: ResearchPlanEditorialMaterialInput): void {
  assertBoundSealedArtifact(input.deliverable.artifact, input, 'deliverable');
  assertBoundSealedArtifact(input.review.artifact, input, 'report_review');
  const deliverable = input.deliverable.value;
  const review = input.review.value;
  if (
    deliverable.version !== 'research-deliverable-v1'
    || deliverable.taskId !== input.taskId
    || deliverable.planVersionId !== input.planVersionId
    || deliverable.attemptId !== input.attemptId
    || deliverable.deliverableType !== 'research_plan'
  ) {
    throw new Error('Research Plan Material Builder requires a bound research_plan Deliverable');
  }
  if (
    review.verdict !== 'pass'
    || review.taskId !== input.taskId
    || review.planVersionId !== input.planVersionId
    || review.attemptId !== input.attemptId
    || review.deliverableArtifactId !== input.deliverable.artifact.id
    || input.review.artifact.schemaVersion !== review.version
  ) {
    throw new Error('Research Plan Material Builder requires a sealed final pass Review bound to the Deliverable');
  }
}

function sourcePointer(...tokens: Array<string | number>): string {
  return `/${tokens.map((token) => String(token).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}

function sourceSchemaVersion<TPayload>(input: EditorialMaterialInput<TPayload>): string {
  const payloadVersion = (input.deliverable.value.payload as { schemaVersion?: unknown }).schemaVersion;
  return typeof payloadVersion === 'string' && payloadVersion.trim()
    ? payloadVersion
    : input.deliverable.artifact.schemaVersion;
}

function traceOrigin<TPayload>(
  input: EditorialMaterialInput<TPayload>,
  pointer: string,
  sourceNodeIds: string[],
) {
  return {
    artifactId: input.deliverable.artifact.id,
    contentSha256: input.deliverable.artifact.contentSha256!,
    schemaVersion: sourceSchemaVersion(input),
    jsonPointer: pointer,
    sourceNodeIds: unique(sourceNodeIds),
    reviewState: 'passed' as const,
  };
}

function canonicalSupport<TPayload>(input: EditorialMaterialInput<TPayload>, support: {
  questionIds: readonly string[];
  evidenceIds: readonly string[];
  status?: 'supported' | 'provisional' | 'unanswered';
  confidence?: number;
}, explicitFindingIds: readonly string[] = []): EditorialLeafTrace['support'] {
  const evidenceIds = unique(support.evidenceIds);
  const questionIds = unique(support.questionIds);
  const evidence = new Set(evidenceIds);
  const findingIds = new Set(explicitFindingIds);
  for (const finding of input.deliverable.value.findingGraph.findings) {
    if (finding.kind === 'fact' && finding.evidenceIds.some((id) => evidence.has(id))) {
      findingIds.add(finding.id);
    }
  }
  const summaryIds = unique(input.deliverable.value.coverage.questionBindings
    .filter(({ questionId }) => questionIds.includes(questionId))
    .flatMap(({ summaryIds: ids }) => ids));
  for (const summary of input.deliverable.value.findingGraph.subQuestionSummaries) {
    if (!summaryIds.includes(summary.id)) continue;
    for (const id of summary.findingIds) findingIds.add(id);
  }
  return {
    questionIds,
    evidenceIds,
    findingIds: [...findingIds],
    summaryIds,
    ...(support.status === undefined ? {} : { status: support.status }),
    ...(support.confidence === undefined ? {} : { confidence: support.confidence }),
  };
}

function trace<TPayload>(input: EditorialMaterialInput<TPayload>, options: {
  pointer: string;
  sourceNodeIds: string[];
  supportMode: EditorialLeafTrace['supportMode'];
  support?: Parameters<typeof canonicalSupport>[1];
  findingIds?: string[];
}): EditorialLeafTrace {
  return {
    supportMode: options.supportMode,
    origins: [traceOrigin(input, options.pointer, options.sourceNodeIds)],
    support: canonicalSupport(
      input,
      options.support ?? { questionIds: [], evidenceIds: [] },
      options.findingIds,
    ),
  };
}

function profiles(unit: ReportEditorialPresentationUnitV1): ReportPresentationV1[] {
  const candidates: ReportPresentationV1[] = (() => {
    if (unit.shape === 'text') {
      return unit.semanticKind === 'evidence_finding'
        || unit.semanticKind === 'limitation'
        || unit.semanticKind === 'open_question'
        || unit.semanticKind === 'risk'
        ? ['fact', 'list', 'paragraph']
        : ['paragraph', 'fact', 'list'];
    }
    if (unit.shape === 'record') {
      return unit.semanticKind === 'direct_answer'
        ? ['answer', 'record-table', 'list']
        : ['record-table', 'answer', 'list'];
    }
    if (unit.shape === 'matrix') return ['record-table', 'list'];
    if (unit.shape === 'graph') return ['graph', 'list'];
    if (unit.shape === 'actions') {
      return unit.semanticKind === 'prioritized_action'
        ? ['priority-board', 'record-table', 'list']
        : ['record-table', 'list', 'priority-board'];
    }
    if (unit.shape === 'records') return ['card-grid', 'list'];
    if (unit.shape === 'stages') return ['stage-flow', 'list'];
    if (unit.shape === 'asset') return ['image'];
    if (unit.shape === 'asset_pair') return ['image-comparison'];
    return ['chart', 'record-table'];
  })();
  return candidates.filter((candidate) => isPresentationCompatible(unit, candidate));
}

function recordUnit(input: {
  id: string;
  semanticKind: Extract<ReportEditorialPresentationUnitV1, { shape: 'record' }>['semanticKind'];
  title: string;
  leafId: string;
  fields: Extract<ReportEditorialPresentationUnitV1, { shape: 'record' }>['fields'];
}): ReportEditorialPresentationUnitV1 {
  return { ...input, shape: 'record', leafIds: [input.leafId] };
}

function textUnit(input: {
  id: string;
  semanticKind: Extract<ReportEditorialPresentationUnitV1, { shape: 'text' }>['semanticKind'];
  title: string;
  leafId: string;
  text: string;
}): ReportEditorialPresentationUnitV1 {
  return { ...input, shape: 'text', leafIds: [input.leafId] };
}

export function buildResearchStrategyEditorialMaterialV1(
  input: ResearchStrategyEditorialMaterialInput,
): ReportEditorialMaterialV1 {
  assertInputBinding(input);
  const payload = input.deliverable.value.payload;
  const directAnswerBindingIds = new Set(payload.directAnswers.map(({ questionId }) => `answer-${questionId}`));
  const contentBlockIds = new Set(payload.contentBlocks.map(({ id }) => id));
  const questionIds = new Set(payload.directAnswers.map(({ questionId }) => questionId));
  for (const binding of payload.requestedArtifactBindings) {
    const allowedBlockIds = binding.sourceField === '/directAnswers'
      ? directAnswerBindingIds
      : contentBlockIds;
    if (binding.blockIds.some((id) => !allowedBlockIds.has(id))) {
      throw new Error(`requested artifact ${binding.artifactType} references an unknown Canonical Block`);
    }
    if (binding.questionIds.some((id) => !questionIds.has(id))) {
      throw new Error(`requested artifact ${binding.artifactType} references an unknown Canonical question`);
    }
  }
  const presentationUnits: ReportEditorialPresentationUnitV1[] = [];
  const leafTraceIndex: Record<string, EditorialLeafTrace> = {};

  const add = (unit: ReportEditorialPresentationUnitV1, traces: Record<string, EditorialLeafTrace>): void => {
    presentationUnits.push(unit);
    for (const [id, value] of Object.entries(traces)) {
      if (leafTraceIndex[id]) throw new Error(`duplicate Material leaf ${id}`);
      leafTraceIndex[id] = value;
    }
  };

  payload.directAnswers.forEach((answer, index) => {
    const id = unitId('direct-answer', answer.questionId);
    const leaf = leafId('direct-answer', answer.questionId);
    const fields = [
      { key: 'answer', label: '答案', value: answer.answer },
      { key: 'business_implication', label: '业务含义', value: answer.businessImplication },
      { key: 'recommended_action', label: '建议行动', value: answer.recommendedAction },
      ...(answer.validationNeeded
        ? [{ key: 'validation_needed', label: '仍需验证', value: answer.validationNeeded }]
        : []),
    ];
    add(recordUnit({ id, semanticKind: 'direct_answer', title: answer.question, leafId: leaf, fields }), {
      [leaf]: trace(input, {
        pointer: sourcePointer('payload', 'directAnswers', index),
        sourceNodeIds: [answer.questionId],
        supportMode: answer.evidenceIds.length > 0 ? 'direct' : 'none',
        support: {
          questionIds: [answer.questionId],
          evidenceIds: answer.evidenceIds,
          status: answer.answerStatus,
          confidence: answer.confidence,
        },
      }),
    });
  });

  payload.evidenceFindings.forEach((finding, index) => {
    const id = unitId('evidence-finding', finding.id);
    const leaf = leafId('evidence-finding', finding.id);
    add(textUnit({
      id,
      semanticKind: 'evidence_finding',
      title: finding.id,
      leafId: leaf,
      text: finding.statement,
    }), {
      [leaf]: trace(input, {
        pointer: sourcePointer('payload', 'evidenceFindings', index),
        sourceNodeIds: [finding.id],
        supportMode: finding.support.evidenceIds.length > 0 ? 'direct' : 'none',
        support: finding.support,
      }),
    });
  });

  payload.contentBlocks.forEach((block, blockIndex) => {
    const blockPointer = sourcePointer('payload', 'contentBlocks', blockIndex);
    if (block.kind === 'narrative') {
      const leaf = leafId('content', block.id);
      add(textUnit({
        id: unitId('content', block.id),
        semanticKind: 'narrative',
        title: block.title,
        leafId: leaf,
        text: block.content,
      }), {
        [leaf]: trace(input, {
          pointer: blockPointer,
          sourceNodeIds: [block.id],
          supportMode: block.support.evidenceIds.length > 0 ? 'direct' : 'none',
          support: block.support,
        }),
      });
      return;
    }
    if (block.kind === 'comparison_matrix' || block.kind === 'strategy_map') {
      const traces: Record<string, EditorialLeafTrace> = {};
      const cells = block.cells.map((cell, cellIndex) => {
        const leaf = leafId('matrix-cell', `${block.id}:${cell.id}`);
        traces[leaf] = trace(input, {
          pointer: sourcePointer('payload', 'contentBlocks', blockIndex, 'cells', cellIndex),
          sourceNodeIds: [block.id, cell.id],
          supportMode: cell.support.evidenceIds.length > 0 ? 'direct' : 'none',
          support: cell.support,
        });
        return { leafId: leaf, row: cell.row, column: cell.column, value: cell.statement };
      });
      add({
        id: unitId('content', block.id),
        semanticKind: block.kind,
        title: block.title,
        shape: 'matrix',
        leafIds: cells.map(({ leafId: id }) => id),
        rows: [...block.rows],
        columns: [...block.columns],
        cells,
      }, traces);
      return;
    }
    if (block.kind === 'mind_model') {
      const traces: Record<string, EditorialLeafTrace> = {};
      const nodes = block.nodes.map((node, nodeIndex) => {
        const leaf = leafId('graph-node', `${block.id}:${node.id}`);
        traces[leaf] = trace(input, {
          pointer: sourcePointer('payload', 'contentBlocks', blockIndex, 'nodes', nodeIndex),
          sourceNodeIds: [block.id, node.id],
          supportMode: node.support.evidenceIds.length > 0 ? 'direct' : 'none',
          support: node.support,
        });
        return { id: node.id, leafId: leaf, label: node.label, description: node.description };
      });
      const edges = block.edges.map((edge, edgeIndex) => {
        const edgeId = edgeSourceId(block.id, edgeIndex);
        const leaf = leafId('graph-edge', edgeId);
        traces[leaf] = trace(input, {
          pointer: sourcePointer('payload', 'contentBlocks', blockIndex, 'edges', edgeIndex),
          sourceNodeIds: [block.id, edgeId],
          supportMode: 'none',
        });
        return {
          id: edgeId,
          leafId: leaf,
          from: edge.from,
          to: edge.to,
          label: edge.relationship,
        };
      });
      add({
        id: unitId('content', block.id),
        semanticKind: 'mind_model',
        title: block.title,
        shape: 'graph',
        leafIds: [...nodes.map(({ leafId: id }) => id), ...edges.map(({ leafId: id }) => id)],
        nodes,
        edges,
      }, traces);
      return;
    }
    if (block.kind === 'prioritized_actions' || block.kind === 'action_plan') {
      const traces: Record<string, EditorialLeafTrace> = {};
      const actions = block.items.map((item, itemIndex) => {
        const leaf = leafId('action', `${block.id}:${item.id}`);
        traces[leaf] = trace(input, {
          pointer: sourcePointer('payload', 'contentBlocks', blockIndex, 'items', itemIndex),
          sourceNodeIds: [block.id, item.id],
          supportMode: item.support.evidenceIds.length > 0 ? 'direct' : 'none',
          support: item.support,
        });
        return {
          leafId: leaf,
          priority: item.priority,
          action: item.action,
          owner: item.ownerType,
          rationale: item.rationale,
          validationMethod: item.validationMethod,
        };
      });
      add({
        id: unitId('content', block.id),
        semanticKind: block.kind === 'prioritized_actions' ? 'prioritized_action' : 'action_plan',
        title: block.title,
        shape: 'actions',
        leafIds: actions.map(({ leafId: id }) => id),
        actions,
      }, traces);
      return;
    }

    if (block.kind === 'design_principles') {
      block.items.forEach((item, itemIndex) => {
        const leaf = leafId('content-item', `${block.id}:${item.id}`);
        const pointer = sourcePointer('payload', 'contentBlocks', blockIndex, 'items', itemIndex);
        add(recordUnit({
          id: unitId('content-item', `${block.id}:${item.id}`),
          semanticKind: 'design_principle',
          title: block.title,
          leafId: leaf,
          fields: [
            { key: 'title', label: '原则', value: item.title },
            { key: 'statement', label: '说明', value: item.statement },
          ],
        }), {
          [leaf]: trace(input, {
            pointer,
            sourceNodeIds: [block.id, item.id],
            supportMode: item.support.evidenceIds.length > 0 ? 'direct' : 'none',
            support: item.support,
          }),
        });
      });
      return;
    }
    if (block.kind === 'opportunity_backlog') {
      block.items.forEach((item, itemIndex) => {
        const leaf = leafId('content-item', `${block.id}:${item.id}`);
        const pointer = sourcePointer('payload', 'contentBlocks', blockIndex, 'items', itemIndex);
        add(recordUnit({
          id: unitId('content-item', `${block.id}:${item.id}`),
          semanticKind: 'opportunity',
          title: block.title,
          leafId: leaf,
          fields: [
            { key: 'title', label: '机会', value: item.title },
            { key: 'statement', label: '说明', value: item.statement },
            { key: 'impact', label: '影响', value: item.impact },
            ...(item.support.validationNeeded
              ? [{ key: 'validation_needed', label: '验证方式', value: item.support.validationNeeded }]
              : []),
          ],
        }), {
          [leaf]: trace(input, {
            pointer,
            sourceNodeIds: [block.id, item.id],
            supportMode: item.support.evidenceIds.length > 0 ? 'direct' : 'none',
            support: item.support,
          }),
        });
      });
      return;
    }
    if (block.kind === 'channel_strategies') {
      block.items.forEach((item, itemIndex) => {
        const leaf = leafId('content-item', `${block.id}:${item.id}`);
        const pointer = sourcePointer('payload', 'contentBlocks', blockIndex, 'items', itemIndex);
        add(recordUnit({
          id: unitId('content-item', `${block.id}:${item.id}`),
          semanticKind: 'channel_strategy',
          title: block.title,
          leafId: leaf,
          fields: [
            { key: 'channel', label: '渠道', value: item.channel },
            { key: 'role', label: '角色', value: item.role },
            { key: 'strategies', label: '策略', value: item.strategies.join('\n') },
          ],
        }), {
          [leaf]: trace(input, {
            pointer,
            sourceNodeIds: [block.id, item.id],
            supportMode: item.support.evidenceIds.length > 0 ? 'direct' : 'none',
            support: item.support,
          }),
        });
      });
      return;
    }
    throw new Error(`Unsupported research strategy Content Block ${String((block as { kind?: unknown }).kind)}`);
  });

  payload.limitations.forEach((value, index) => {
    const sourceId = pad(index);
    const leaf = leafId('limitation', sourceId);
    add(textUnit({
      id: unitId('limitation', sourceId),
      semanticKind: 'limitation',
      title: '局限',
      leafId: leaf,
      text: value,
    }), {
      [leaf]: trace(input, {
        pointer: sourcePointer('payload', 'limitations', index),
        sourceNodeIds: [`limitation-${sourceId}`],
        supportMode: 'none',
      }),
    });
  });

  payload.openQuestions.forEach((value, index) => {
    const sourceId = pad(index);
    const leaf = leafId('open-question', sourceId);
    add(textUnit({
      id: unitId('open-question', sourceId),
      semanticKind: 'open_question',
      title: '待解决问题',
      leafId: leaf,
      text: value,
    }), {
      [leaf]: trace(input, {
        pointer: sourcePointer('payload', 'openQuestions', index),
        sourceNodeIds: [`open-question-${sourceId}`],
        supportMode: 'none',
      }),
    });
  });

  payload.riskDisclosures.forEach((risk, index) => {
    const leaf = leafId('risk', risk.id);
    const answer = risk.sourceType === 'answer_uncertainty'
      ? payload.directAnswers.find(({ questionId }) => questionId === risk.sourceId)
      : undefined;
    add(textUnit({
      id: unitId('risk', risk.id),
      semanticKind: 'risk',
      title: '风险',
      leafId: leaf,
      text: risk.statement,
    }), {
      [leaf]: trace(input, {
        pointer: sourcePointer('payload', 'riskDisclosures', index),
        sourceNodeIds: [risk.id, risk.sourceId],
        supportMode: answer ? 'inherited' : 'none',
        ...(answer
          ? {
              support: {
                questionIds: [answer.questionId],
                evidenceIds: answer.evidenceIds,
                status: answer.answerStatus,
                confidence: answer.confidence,
              },
            }
          : {}),
      }),
    });
  });

  payload.requestedArtifactBindings.forEach((binding, index) => {
    const sourceId = pad(index);
    const leaf = leafId('requested-artifact-binding', sourceId);
    add(recordUnit({
      id: unitId('requested-artifact-binding', sourceId),
      semanticKind: 'requested_artifact_binding',
      title: binding.artifactType,
      leafId: leaf,
      fields: [
        { key: 'artifact_type', label: '交付物类型', value: binding.artifactType },
        { key: 'source_field', label: '来源字段', value: binding.sourceField },
        { key: 'status', label: '状态', value: binding.status },
        { key: 'block_ids', label: '内容绑定', value: binding.blockIds.join('、') },
        { key: 'question_ids', label: '问题绑定', value: binding.questionIds.join('、') },
        { key: 'evidence_ids', label: '证据绑定', value: binding.evidenceIds.join('、') },
      ],
    }), {
      [leaf]: trace(input, {
        pointer: sourcePointer('payload', 'requestedArtifactBindings', index),
        sourceNodeIds: binding.blockIds,
        supportMode: binding.evidenceIds.length > 0 ? 'direct' : 'none',
        support: { questionIds: binding.questionIds, evidenceIds: binding.evidenceIds },
      }),
    });
  });

  const requiredQuestionIds = unique(input.requiredQuestionIds);
  const answerQuestionIds = new Set(payload.directAnswers.map(({ questionId }) => questionId));
  for (const questionId of requiredQuestionIds) {
    if (!answerQuestionIds.has(questionId)) {
      throw new Error(`required question ${questionId} has no Canonical Direct Answer`);
    }
  }
  const material: ReportEditorialMaterialV1 = {
    version: 'report-editorial-material-v1',
    binding: {
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      attemptId: input.attemptId,
      deliverableArtifactId: input.deliverable.artifact.id,
      deliverableContentSha256: input.deliverable.artifact.contentSha256!,
      reportReviewArtifactId: input.review.artifact.id,
    },
    document: {
      title: payload.title,
      decisionContext: payload.decisionContext,
      executiveAnswer: payload.executiveAnswer,
      deliverableType: input.deliverable.value.deliverableType,
      requestedArtifactTypes: unique(payload.requestedArtifactBindings.map(({ artifactType }) => artifactType)),
    },
    presentationUnits,
    leafTraceIndex,
    constraints: {
      requiredQuestionIds,
      requiredPresentationUnitIds: presentationUnits.map(({ id }) => id),
      requiredLeafUnitIds: Object.keys(leafTraceIndex),
      allowedViews: ['answers', 'topics', 'actions', 'evidence', 'analysis'],
      projectionProfilesByUnitId: Object.fromEntries(
        presentationUnits.map((unit) => [unit.id, profiles(unit)]),
      ),
    },
  };
  assertReportEditorialMaterialIntegrity(material);
  return material;
}

function joinValues(values: readonly string[]): string {
  return values.join('、');
}

export function buildResearchPlanEditorialMaterialV1(
  input: ResearchPlanEditorialMaterialInput,
): ReportEditorialMaterialV1 {
  assertResearchPlanInputBinding(input);
  const deliverable = input.deliverable.value;
  const payload = deliverable.payload;
  const requiredQuestionIds = unique(input.requiredQuestionIds);
  const presentationUnits: ReportEditorialPresentationUnitV1[] = [];
  const leafTraceIndex: Record<string, EditorialLeafTrace> = {};

  const add = (unit: ReportEditorialPresentationUnitV1, traces: Record<string, EditorialLeafTrace>): void => {
    presentationUnits.push(unit);
    for (const [id, value] of Object.entries(traces)) {
      if (leafTraceIndex[id]) throw new Error(`duplicate Material leaf ${id}`);
      leafTraceIndex[id] = value;
    }
  };

  const planTrace = (options: {
    pointer: string;
    sourceNodeIds: string[];
    supportMode?: EditorialLeafTrace['supportMode'];
    questionIds?: string[];
    evidenceIds?: string[];
    findingIds?: string[];
  }): EditorialLeafTrace => trace(input, {
    pointer: options.pointer,
    sourceNodeIds: options.sourceNodeIds,
    supportMode: options.supportMode ?? 'none',
    support: {
      questionIds: options.questionIds ?? [],
      evidenceIds: options.evidenceIds ?? [],
    },
    findingIds: options.findingIds,
  });

  type RecordsUnit = Extract<ReportEditorialPresentationUnitV1, { shape: 'records' }>;
  const addRecords = (
    id: string,
    semanticKind: RecordsUnit['semanticKind'],
    title: string,
    records: RecordsUnit['records'],
    traces: Record<string, EditorialLeafTrace>,
  ): void => add({
    id,
    semanticKind,
    title,
    shape: 'records',
    leafIds: records.map(({ leafId: id }) => id),
    records,
  }, traces);

  const overviewTraces: Record<string, EditorialLeafTrace> = {};
  const goalLeaf = leafId('research-plan-goal', '001');
  const scopeLeaf = leafId('research-plan-scope', '001');
  const samplingLeaf = leafId('research-plan-sampling', '001');
  overviewTraces[goalLeaf] = planTrace({
    pointer: sourcePointer('payload', 'researchGoal'),
    sourceNodeIds: ['research-goal'],
    questionIds: requiredQuestionIds,
  });
  overviewTraces[scopeLeaf] = planTrace({
    pointer: sourcePointer('payload', 'scope'),
    sourceNodeIds: ['research-scope'],
  });
  overviewTraces[samplingLeaf] = planTrace({
    pointer: sourcePointer('payload', 'competitorSampling'),
    sourceNodeIds: ['competitor-sampling'],
  });
  addRecords('research-plan:overview', 'research_plan_overview', '研究目标与范围', [{
    id: 'research-goal',
    leafId: goalLeaf,
    title: '研究目标',
    body: payload.researchGoal,
    fields: [],
  }, {
    id: 'research-scope',
    leafId: scopeLeaf,
    title: '研究范围',
    fields: [
      { key: 'market', label: '市场', value: payload.scope.market },
      { key: 'subjects', label: '对象', value: joinValues(payload.scope.subjects) },
      { key: 'time_window', label: '时间范围', value: payload.scope.timeWindow },
    ],
  }, {
    id: 'competitor-sampling',
    leafId: samplingLeaf,
    title: '样本策略',
    body: payload.competitorSampling.strategy,
    fields: [
      { key: 'target_count', label: '目标数量', value: payload.competitorSampling.targetCount },
      { key: 'inclusion_criteria', label: '纳入标准', value: joinValues(payload.competitorSampling.inclusionCriteria) },
      { key: 'exclusion_criteria', label: '排除标准', value: joinValues(payload.competitorSampling.exclusionCriteria) },
    ],
  }], overviewTraces);

  const questionTraces: Record<string, EditorialLeafTrace> = {};
  const questionRecords: RecordsUnit['records'] = payload.researchQuestions.map((question, index) => {
    const sourceId = pad(index);
    const leaf = leafId('research-question', sourceId);
    questionTraces[leaf] = planTrace({
      pointer: sourcePointer('payload', 'researchQuestions', index),
      sourceNodeIds: [`research-question-${sourceId}`],
    });
    return {
      id: `research-question-${sourceId}`,
      leafId: leaf,
      title: `研究问题 ${index + 1}`,
      body: question,
      fields: [],
    };
  });
  addRecords(
    'research-plan:questions',
    'research_plan_questions',
    '研究问题',
    questionRecords,
    questionTraces,
  );

  const methodTraces: Record<string, EditorialLeafTrace> = {};
  const methodRecords: RecordsUnit['records'] = [];
  payload.comparisonDimensions.forEach((dimension, index) => {
    const leaf = leafId('comparison-dimension', dimension.id);
    methodTraces[leaf] = planTrace({
      pointer: sourcePointer('payload', 'comparisonDimensions', index),
      sourceNodeIds: [dimension.id],
    });
    methodRecords.push({
      id: `comparison-dimension-${dimension.id}`,
      leafId: leaf,
      title: dimension.name,
      body: dimension.purpose,
      fields: [
        { key: 'collection_fields', label: '采集字段', value: joinValues(dimension.collectionFields) },
      ],
    });
  });
  payload.sourcePlan.forEach((source, index) => {
    const sourceId = pad(index);
    const leaf = leafId('source-plan', sourceId);
    methodTraces[leaf] = planTrace({
      pointer: sourcePointer('payload', 'sourcePlan', index),
      sourceNodeIds: [`source-plan-${sourceId}`],
    });
    methodRecords.push({
      id: `source-plan-${sourceId}`,
      leafId: leaf,
      title: `来源：${source.evidenceClass}`,
      body: source.purpose,
      fields: [{ key: 'source_types', label: '来源类型', value: joinValues(source.sourceTypes) }],
    });
  });
  payload.collectionTemplate.forEach((field, index) => {
    const sourceId = pad(index);
    const leaf = leafId('collection-field', sourceId);
    methodTraces[leaf] = planTrace({
      pointer: sourcePointer('payload', 'collectionTemplate', index),
      sourceNodeIds: [`collection-field-${sourceId}`],
    });
    methodRecords.push({
      id: `collection-field-${sourceId}`,
      leafId: leaf,
      title: field.field,
      body: field.description,
      status: field.evidenceRequired ? '需要证据' : '无需证据',
      fields: [{ key: 'evidence_required', label: '证据要求', value: field.evidenceRequired }],
    });
  });
  payload.analysisMethods.forEach((method, index) => {
    const sourceId = pad(index);
    const leaf = leafId('analysis-method', sourceId);
    methodTraces[leaf] = planTrace({
      pointer: sourcePointer('payload', 'analysisMethods', index),
      sourceNodeIds: [`analysis-method-${sourceId}`],
    });
    methodRecords.push({
      id: `analysis-method-${sourceId}`,
      leafId: leaf,
      title: `分析方法 ${index + 1}`,
      body: method,
      fields: [],
    });
  });
  addRecords(
    'research-plan:methods',
    'research_plan_methods',
    '研究维度、来源与方法',
    methodRecords,
    methodTraces,
  );

  const stageTraces: Record<string, EditorialLeafTrace> = {};
  const stages: Extract<ReportEditorialPresentationUnitV1, { shape: 'stages' }>['stages']
    = payload.executionPlan.map((stage, index) => {
      const sourceId = pad(index);
      const leaf = leafId('execution-stage', sourceId);
      stageTraces[leaf] = planTrace({
        pointer: sourcePointer('payload', 'executionPlan', index),
        sourceNodeIds: [`execution-stage-${sourceId}`],
      });
      return {
        id: `execution-stage-${sourceId}`,
        leafId: leaf,
        label: stage.phase,
        activities: [...stage.activities],
        timeLabel: stage.duration,
        outputs: [...stage.outputs],
      };
    });
  add({
    id: 'research-plan:execution',
    semanticKind: 'research_plan_execution',
    title: '执行计划',
    shape: 'stages',
    leafIds: stages.map(({ leafId: id }) => id),
    stages,
  }, stageTraces);

  const deliverableTraces: Record<string, EditorialLeafTrace> = {};
  const deliverableRecords: RecordsUnit['records'] = payload.deliverables.map((value, index) => {
    const sourceId = pad(index);
    const leaf = leafId('planned-deliverable', sourceId);
    deliverableTraces[leaf] = planTrace({
      pointer: sourcePointer('payload', 'deliverables', index),
      sourceNodeIds: [`planned-deliverable-${sourceId}`],
    });
    return {
      id: `planned-deliverable-${sourceId}`,
      leafId: leaf,
      title: `交付物 ${index + 1}`,
      body: value,
      fields: [],
    };
  });
  addRecords(
    'research-plan:deliverables',
    'research_plan_deliverables',
    '计划交付物',
    deliverableRecords,
    deliverableTraces,
  );

  const qualityTraces: Record<string, EditorialLeafTrace> = {};
  const qualityRecords: RecordsUnit['records'] = payload.qualityChecks.map((value, index) => {
    const sourceId = pad(index);
    const leaf = leafId('quality-check', sourceId);
    qualityTraces[leaf] = planTrace({
      pointer: sourcePointer('payload', 'qualityChecks', index),
      sourceNodeIds: [`quality-check-${sourceId}`],
    });
    return {
      id: `quality-check-${sourceId}`,
      leafId: leaf,
      title: `质量检查 ${index + 1}`,
      body: value,
      status: '必检',
      fields: [],
    };
  });
  deliverable.coverage.questionBindings.forEach((binding, index) => {
    const sourceId = pad(index);
    const leaf = leafId('question-coverage', sourceId);
    qualityTraces[leaf] = planTrace({
      pointer: sourcePointer('coverage', 'questionBindings', index),
      sourceNodeIds: [binding.questionId, ...binding.summaryIds],
      questionIds: [binding.questionId],
    });
    qualityRecords.push({
      id: `question-coverage-${sourceId}`,
      leafId: leaf,
      title: `问题覆盖：${binding.questionId}`,
      fields: [{ key: 'summary_ids', label: '小结绑定', value: joinValues(binding.summaryIds) }],
    });
  });
  deliverable.coverage.successCriterionBindings.forEach((binding, index) => {
    const sourceId = pad(index);
    const leaf = leafId('success-criterion-coverage', sourceId);
    qualityTraces[leaf] = planTrace({
      pointer: sourcePointer('coverage', 'successCriterionBindings', index),
      sourceNodeIds: [
        binding.successCriterionId,
        ...binding.conclusionIds,
        ...binding.recommendationIds,
      ],
    });
    qualityRecords.push({
      id: `success-criterion-coverage-${sourceId}`,
      leafId: leaf,
      title: `成功标准：${binding.successCriterionId}`,
      fields: [
        { key: 'conclusion_ids', label: '结论绑定', value: joinValues(binding.conclusionIds) },
        { key: 'recommendation_ids', label: '建议绑定', value: joinValues(binding.recommendationIds) },
      ],
    });
  });
  addRecords(
    'research-plan:quality',
    'research_plan_quality',
    '质量与覆盖检查',
    qualityRecords,
    qualityTraces,
  );

  const findingsById = new Map(deliverable.findingGraph.findings.map((finding) => [finding.id, finding]));
  const evidenceForFinding = (findingId: string, visiting = new Set<string>()): string[] => {
    if (visiting.has(findingId)) return [];
    const finding = findingsById.get(findingId);
    if (!finding) return [];
    if (finding.kind === 'fact') return [...finding.evidenceIds];
    const next = new Set(visiting);
    next.add(findingId);
    return unique(finding.findingIds.flatMap((id) => evidenceForFinding(id, next)));
  };
  const analysesById = new Map(deliverable.findingGraph.analyses.map((analysis) => [analysis.id, analysis]));
  const summariesById = new Map(
    deliverable.findingGraph.subQuestionSummaries.map((summary) => [summary.id, summary]),
  );
  const questionIdsForSummary = (summaryId: string): string[] => unique(
    deliverable.coverage.questionBindings
      .filter(({ summaryIds }) => summaryIds.includes(summaryId))
      .map(({ questionId }) => questionId),
  );
  const findingIdsForSummary = (summaryId: string): string[] => {
    const summary = summariesById.get(summaryId);
    if (!summary) return [];
    return unique([
      ...summary.findingIds,
      ...summary.analysisIds.flatMap((id) => analysesById.get(id)?.findingIds ?? []),
    ]);
  };
  const evidenceForSummary = (summaryId: string): string[] => unique(
    findingIdsForSummary(summaryId).flatMap((id) => evidenceForFinding(id)),
  );
  const summaryIdsForFinding = (findingId: string): string[] => unique(
    deliverable.findingGraph.subQuestionSummaries
      .filter((summary) => findingIdsForSummary(summary.id).includes(findingId))
      .map(({ id }) => id),
  );

  deliverable.findingGraph.findings.forEach((finding, index) => {
    const leaf = leafId('finding', finding.id);
    const summaryIds = summaryIdsForFinding(finding.id);
    const evidenceIds = finding.kind === 'fact'
      ? finding.evidenceIds
      : unique(finding.findingIds.flatMap((id) => evidenceForFinding(id)));
    add(textUnit({
      id: unitId('finding', finding.id),
      semanticKind: finding.kind === 'fact' ? 'evidence_finding' : 'narrative',
      title: finding.kind === 'fact' ? '事实发现' : '推断',
      leafId: leaf,
      text: finding.statement,
    }), {
      [leaf]: planTrace({
        pointer: sourcePointer('findingGraph', 'findings', index),
        sourceNodeIds: [finding.id, ...(finding.kind === 'inference' ? finding.findingIds : [])],
        supportMode: finding.kind === 'fact' && evidenceIds.length > 0
          ? 'direct'
          : evidenceIds.length > 0 ? 'inherited' : 'none',
        questionIds: unique(summaryIds.flatMap(questionIdsForSummary)),
        evidenceIds,
        findingIds: [finding.id, ...(finding.kind === 'inference' ? finding.findingIds : [])],
      }),
    });
  });

  deliverable.findingGraph.analyses.forEach((analysis, index) => {
    const leaf = leafId('analysis', analysis.id);
    const summaryIds = deliverable.findingGraph.subQuestionSummaries
      .filter(({ analysisIds }) => analysisIds.includes(analysis.id))
      .map(({ id }) => id);
    const evidenceIds = unique(analysis.findingIds.flatMap((id) => evidenceForFinding(id)));
    add(textUnit({
      id: unitId('analysis', analysis.id),
      semanticKind: 'narrative',
      title: '分析',
      leafId: leaf,
      text: analysis.statement,
    }), {
      [leaf]: planTrace({
        pointer: sourcePointer('findingGraph', 'analyses', index),
        sourceNodeIds: [analysis.id, ...analysis.findingIds],
        supportMode: evidenceIds.length > 0 ? 'inherited' : 'none',
        questionIds: unique(summaryIds.flatMap(questionIdsForSummary)),
        evidenceIds,
        findingIds: analysis.findingIds,
      }),
    });
  });

  deliverable.findingGraph.subQuestionSummaries.forEach((summary, index) => {
    const leaf = leafId('summary', summary.id);
    const evidenceIds = evidenceForSummary(summary.id);
    add(textUnit({
      id: unitId('summary', summary.id),
      semanticKind: 'narrative',
      title: '问题小结',
      leafId: leaf,
      text: summary.summary,
    }), {
      [leaf]: planTrace({
        pointer: sourcePointer('findingGraph', 'subQuestionSummaries', index),
        sourceNodeIds: [summary.id, ...summary.findingIds, ...summary.analysisIds],
        supportMode: evidenceIds.length > 0 ? 'inherited' : 'none',
        questionIds: questionIdsForSummary(summary.id),
        evidenceIds,
        findingIds: findingIdsForSummary(summary.id),
      }),
    });
  });

  deliverable.findingGraph.overallConclusions.forEach((conclusion, index) => {
    const leaf = leafId('conclusion', conclusion.id);
    const evidenceIds = unique(conclusion.summaryIds.flatMap(evidenceForSummary));
    add(textUnit({
      id: unitId('conclusion', conclusion.id),
      semanticKind: 'narrative',
      title: '总体结论',
      leafId: leaf,
      text: conclusion.statement,
    }), {
      [leaf]: planTrace({
        pointer: sourcePointer('findingGraph', 'overallConclusions', index),
        sourceNodeIds: [conclusion.id, ...conclusion.summaryIds],
        supportMode: evidenceIds.length > 0 ? 'inherited' : 'none',
        questionIds: unique(conclusion.summaryIds.flatMap(questionIdsForSummary)),
        evidenceIds,
        findingIds: unique(conclusion.summaryIds.flatMap(findingIdsForSummary)),
      }),
    });
  });

  if (deliverable.methodSummary.trim()) {
    const leaf = leafId('method-summary', '001');
    add(textUnit({
      id: unitId('method-summary', '001'),
      semanticKind: 'narrative',
      title: '方法说明',
      leafId: leaf,
      text: deliverable.methodSummary,
    }), {
      [leaf]: planTrace({
        pointer: sourcePointer('methodSummary'),
        sourceNodeIds: ['method-summary'],
      }),
    });
  }

  if (deliverable.recommendations.length > 0) {
    const recommendationTraces: Record<string, EditorialLeafTrace> = {};
    const actions = deliverable.recommendations.map((recommendation, index) => {
      const leaf = leafId('recommendation', recommendation.id);
      const evidenceIds = unique(recommendation.summaryIds.flatMap(evidenceForSummary));
      recommendationTraces[leaf] = planTrace({
        pointer: sourcePointer('recommendations', index),
        sourceNodeIds: [recommendation.id, ...recommendation.summaryIds],
        supportMode: evidenceIds.length > 0 ? 'inherited' : 'none',
        questionIds: unique(recommendation.summaryIds.flatMap(questionIdsForSummary)),
        evidenceIds,
        findingIds: unique(recommendation.summaryIds.flatMap(findingIdsForSummary)),
      });
      return { leafId: leaf, action: recommendation.statement };
    });
    add({
      id: 'research-plan:recommendations',
      semanticKind: 'action_plan',
      title: '建议行动',
      shape: 'actions',
      leafIds: actions.map(({ leafId: id }) => id),
      actions,
    }, recommendationTraces);
  }

  deliverable.risksAndOpenIssues.forEach((value, index) => {
    const sourceId = pad(index);
    const leaf = leafId('risk', sourceId);
    add(textUnit({
      id: unitId('risk', sourceId),
      semanticKind: 'risk',
      title: '风险与待解决问题',
      leafId: leaf,
      text: value,
    }), {
      [leaf]: planTrace({
        pointer: sourcePointer('risksAndOpenIssues', index),
        sourceNodeIds: [`risk-${sourceId}`],
      }),
    });
  });

  const material: ReportEditorialMaterialV1 = {
    version: 'report-editorial-material-v1',
    binding: {
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      attemptId: input.attemptId,
      deliverableArtifactId: input.deliverable.artifact.id,
      deliverableContentSha256: input.deliverable.artifact.contentSha256!,
      reportReviewArtifactId: input.review.artifact.id,
    },
    document: {
      title: payload.title,
      decisionContext: payload.researchGoal,
      executiveAnswer: deliverable.findingGraph.overallConclusions[0]?.statement
        ?? payload.researchGoal,
      deliverableType: deliverable.deliverableType,
      requestedArtifactTypes: unique(payload.deliverables),
    },
    presentationUnits,
    leafTraceIndex,
    constraints: {
      requiredQuestionIds,
      requiredPresentationUnitIds: presentationUnits.map(({ id }) => id),
      requiredLeafUnitIds: Object.keys(leafTraceIndex),
      allowedViews: ['answers', 'topics', 'actions', 'evidence', 'analysis'],
      projectionProfilesByUnitId: Object.fromEntries(
        presentationUnits.map((unit) => [unit.id, profiles(unit)]),
      ),
    },
  };
  assertReportEditorialMaterialIntegrity(material);
  return material;
}

export function buildReportAuditAppendixMaterialV1(
  input: ReportAuditAppendixMaterialInput,
): ReportAuditAppendixMaterialV1 {
  assertReportEditorialMaterialIntegrity(input.material);
  const artifact = input.contributionLedger.artifact;
  const ledger = input.contributionLedger.value;
  assertBoundSealedArtifact(artifact, input.material.binding, 'contribution_ledger');
  if (
    artifact.schemaVersion !== 'contribution-ledger-v1'
    || ledger.version !== 'contribution-ledger-v1'
    || ledger.taskId !== input.material.binding.taskId
    || ledger.planVersionId !== input.material.binding.planVersionId
    || ledger.attemptId !== input.material.binding.attemptId
  ) {
    throw new Error('Audit Appendix requires a sealed bound Contribution Ledger');
  }
  const audit: ReportAuditAppendixMaterialV1 = {
    version: 'report-audit-appendix-material-v1',
    binding: { ...input.material.binding },
    records: ledger.entries.map((entry, index) => ({
      id: `audit-record-${pad(index)}`,
      contributionArtifactId: entry.contributionArtifactId,
      sourceUnitKey: entry.sourceUnitKey,
      sourceSemanticHash: entry.sourceSemanticHash,
      disposition: entry.disposition,
      canonicalNodeIds: [...entry.canonicalNodeIds],
      ...(entry.reason ? { reasonCode: `ledger_${entry.disposition}` } : {}),
      reviewIssueIds: [...entry.reviewIssueIds],
    })),
  };
  assertReportAuditAppendixMaterialIntegrity(input.material, audit);
  return audit;
}
