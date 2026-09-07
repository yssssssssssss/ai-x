import type {
  ProblemGraph,
  ResearchStrategyContentBlockDraftV2,
  ResearchStrategyContentDraftV2,
  ResearchStrategyContentPatchV1,
  ResearchStrategyContentPatchOperationV1,
  ResearchStrategyDirectAnswer,
  ResearchStrategySupportBindingV2,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type { RequestedArtifact } from '../../../../packages/api-contract/plan.ts';
import {
  isFactualEvidenceClass,
  type EvidenceClass,
  type EvidenceManifest,
} from '../evidence/evidence-service.ts';
import {
  assertSemanticRevisionFidelity,
  assertStructuralRepairFidelity,
  type ResearchStrategyContentFidelityResult,
} from './research-strategy-content-fidelity.ts';
import { canonicalResearchQuestionId } from './research-strategy-reference-normalizer.ts';
import {
  contentBlockMatchesRequestedArtifact,
  requestedArtifactHasContentBlock,
} from './research-strategy-artifact-coverage.ts';

export class ResearchStrategyContentPatchError extends Error {
  constructor(message: string) {
    super(`Research strategy content patch failed: ${message}`);
    this.name = 'ResearchStrategyContentPatchError';
  }
}

export interface AppliedResearchStrategyContentPatch {
  draft: ResearchStrategyContentDraftV2;
  changedSemanticUnitKeys: string[];
  fidelity: ResearchStrategyContentFidelityResult;
}

function fail(message: string): never {
  throw new ResearchStrategyContentPatchError(message);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function normalizeQuestionIds(questionIds: string[], knownQuestionIds: readonly string[]): string[] {
  return unique(questionIds.map((questionId) => (
    canonicalResearchQuestionId(questionId, knownQuestionIds)
      ?? fail(`unknown Question ${questionId}`)
  )));
}

function validateEvidenceIds(
  evidenceIds: string[],
  evidenceClassById: ReadonlyMap<string, EvidenceClass>,
): string[] {
  const normalized = unique(evidenceIds);
  for (const evidenceId of normalized) {
    if (!evidenceClassById.has(evidenceId)) fail(`unknown Evidence ${evidenceId}`);
  }
  return normalized;
}

function isFactualEvidenceId(
  evidenceId: string,
  evidenceClassById: ReadonlyMap<string, EvidenceClass>,
): boolean {
  const evidenceClass = evidenceClassById.get(evidenceId);
  return evidenceClass !== undefined && isFactualEvidenceClass(evidenceClass);
}

function normalizedSupport(input: {
  support: ResearchStrategySupportBindingV2;
  previousStatus?: ResearchStrategySupportBindingV2['status'];
  previousConfidence?: number;
  knownQuestionIds: readonly string[];
  evidenceClassById: ReadonlyMap<string, EvidenceClass>;
}): ResearchStrategySupportBindingV2 {
  const evidenceIds = validateEvidenceIds(input.support.evidenceIds, input.evidenceClassById);
  const support = {
    ...input.support,
    questionIds: normalizeQuestionIds(input.support.questionIds, input.knownQuestionIds),
    evidenceIds,
  };
  if (
    support.status === 'supported'
    && !evidenceIds.some((evidenceId) => isFactualEvidenceId(evidenceId, input.evidenceClassById))
  ) {
    support.status = 'provisional';
    if (!support.validationNeeded.trim() || support.validationNeeded === 'not_applicable') {
      support.validationNeeded = 'This method-grounded statement requires factual validation.';
    }
  }
  if (input.previousStatus === 'provisional' && support.status === 'supported') {
    fail('structural repair cannot promote provisional support to supported');
  }
  if (input.previousConfidence !== undefined && support.confidence > input.previousConfidence) {
    fail('structural repair cannot increase confidence');
  }
  if (support.status === 'supported' && !evidenceIds.some((evidenceId) => (
    isFactualEvidenceId(evidenceId, input.evidenceClassById)
  ))) {
    fail('supported content requires factual Evidence');
  }
  if (support.status === 'provisional' && !support.validationNeeded.trim()) {
    fail('provisional content requires validationNeeded');
  }
  return support;
}

function contentItem(
  block: ResearchStrategyContentBlockDraftV2,
  key: string,
): Record<string, unknown> | null {
  if (block.kind === 'comparison_matrix' || block.kind === 'strategy_map') {
    return block.cells.find((candidate) => candidate.key === key) as unknown as Record<string, unknown> | undefined ?? null;
  }
  if (block.kind === 'mind_model') {
    return block.nodes.find((candidate) => candidate.key === key) as unknown as Record<string, unknown> | undefined ?? null;
  }
  if ('items' in block) {
    return block.items.find((candidate) => candidate.key === key) as unknown as Record<string, unknown> | undefined ?? null;
  }
  return null;
}

function contentSupports(block: ResearchStrategyContentBlockDraftV2): ResearchStrategySupportBindingV2[] {
  if (block.kind === 'narrative') return [block.support];
  if (block.kind === 'comparison_matrix' || block.kind === 'strategy_map') {
    return block.cells.map(({ support }) => support);
  }
  if (block.kind === 'mind_model') return block.nodes.map(({ support }) => support);
  if ('items' in block) return block.items.map(({ support }) => support);
  return [];
}

function validateAppendedAnswer(input: {
  answer: ResearchStrategyDirectAnswer;
  draft: ResearchStrategyContentDraftV2;
  knownQuestionIds: readonly string[];
  requiredQuestionIds: ReadonlySet<string>;
  evidenceClassById: ReadonlyMap<string, EvidenceClass>;
}): ResearchStrategyDirectAnswer {
  const questionId = canonicalResearchQuestionId(input.answer.questionId, input.knownQuestionIds)
    ?? fail(`unknown Question ${input.answer.questionId}`);
  if (!input.requiredQuestionIds.has(questionId)) {
    fail(`Direct Answer ${questionId} is not a missing required question`);
  }
  if (input.draft.directAnswers.some((answer) => answer.questionId === questionId)) {
    fail(`Direct Answer ${questionId} already exists`);
  }
  const evidenceIds = validateEvidenceIds(input.answer.evidenceIds, input.evidenceClassById);
  if (
    input.answer.answerStatus === 'supported'
    && !evidenceIds.some((evidenceId) => isFactualEvidenceId(evidenceId, input.evidenceClassById))
  ) {
    fail(`supported Direct Answer ${questionId} requires factual Evidence`);
  }
  if (input.answer.answerStatus !== 'supported' && !input.answer.validationNeeded.trim()) {
    fail(`${input.answer.answerStatus} Direct Answer ${questionId} requires validationNeeded`);
  }
  return { ...structuredClone(input.answer), questionId, evidenceIds };
}

function validateAppendedBlock(input: {
  block: ResearchStrategyContentBlockDraftV2;
  draft: ResearchStrategyContentDraftV2;
  requestedArtifacts: readonly RequestedArtifact[];
  knownQuestionIds: readonly string[];
  evidenceClassById: ReadonlyMap<string, EvidenceClass>;
}): ResearchStrategyContentBlockDraftV2 {
  if (input.draft.contentBlocks.some(({ key }) => key === input.block.key)) {
    fail(`Content Block ${input.block.key} already exists`);
  }
  const satisfiesMissingArtifact = input.requestedArtifacts.some((artifact) => (
    !requestedArtifactHasContentBlock(artifact, input.draft.contentBlocks)
    && contentBlockMatchesRequestedArtifact(artifact, input.block.kind)
  ));
  if (!satisfiesMissingArtifact) {
    fail(`Content Block ${input.block.kind} does not satisfy a missing requested artifact`);
  }
  if (input.draft.contentBlocks.some(({ kind }) => kind === input.block.kind)) {
    fail(`Content Block kind ${input.block.kind} is already materialized`);
  }
  const block = structuredClone(input.block);
  for (const support of contentSupports(block)) {
    Object.assign(support, normalizedSupport({
      support,
      knownQuestionIds: input.knownQuestionIds,
      evidenceClassById: input.evidenceClassById,
    }));
  }
  return block;
}

function replaceSupport(input: {
  draft: ResearchStrategyContentDraftV2;
  operation: Extract<ResearchStrategyContentPatchOperationV1, { op: 'replace_support' }>;
  knownQuestionIds: readonly string[];
  evidenceClassById: ReadonlyMap<string, EvidenceClass>;
}): void {
  const { target } = input.operation;
  let current: ResearchStrategySupportBindingV2 | null = null;
  if (target.entity === 'evidence_finding') {
    current = input.draft.evidenceFindings.find(({ key }) => key === target.key)?.support ?? null;
  } else if (target.entity === 'content_block') {
    const block = input.draft.contentBlocks.find(({ key }) => key === target.key);
    current = block?.kind === 'narrative' ? block.support : null;
  } else {
    const block = input.draft.contentBlocks.find(({ key }) => key === target.blockKey);
    const item = block ? contentItem(block, target.key) : null;
    current = item?.support as ResearchStrategySupportBindingV2 | undefined ?? null;
  }
  if (!current) fail(`support target ${JSON.stringify(target)} does not exist`);
  const proposed = structuredClone(input.operation.support);
  if (
    target.entity === 'evidence_finding'
    && proposed.status === 'supported'
    && proposed.evidenceIds.some((evidenceId) => {
      const evidenceClass = input.evidenceClassById.get(evidenceId);
      return evidenceClass !== undefined && !isFactualEvidenceClass(evidenceClass);
    })
  ) {
    proposed.status = 'provisional';
    if (!proposed.validationNeeded.trim() || proposed.validationNeeded === 'not_applicable') {
      proposed.validationNeeded = 'This method-grounded statement requires factual validation.';
    }
  }
  const replacement = normalizedSupport({
    support: proposed,
    previousStatus: current.status,
    previousConfidence: current.confidence,
    knownQuestionIds: input.knownQuestionIds,
    evidenceClassById: input.evidenceClassById,
  });
  Object.assign(current, replacement);
}

function semanticTarget(input: {
  draft: ResearchStrategyContentDraftV2;
  operation: Extract<ResearchStrategyContentPatchOperationV1, { op: 'replace_semantic_text' }>;
}): { record: Record<string, unknown>; unitKey: string; allowedFields: ReadonlySet<string> } {
  const { target } = input.operation;
  if (target.entity === 'draft') {
    if (target.key !== 'root') fail('draft semantic target key must be root');
    return {
      record: input.draft as unknown as Record<string, unknown>,
      unitKey: `root:${target.field}`,
      allowedFields: new Set(['title', 'decisionContext', 'executiveAnswer', 'methodSummary']),
    };
  }
  if (target.entity === 'direct_answer') {
    const index = input.draft.directAnswers.findIndex(({ questionId }) => questionId === target.key);
    if (index === -1) fail(`Direct Answer ${target.key} does not exist`);
    return {
      record: input.draft.directAnswers[index] as unknown as Record<string, unknown>,
      unitKey: `direct-answer:${String(index + 1).padStart(3, '0')}`,
      allowedFields: new Set(['question', 'answer', 'businessImplication', 'recommendedAction']),
    };
  }
  if (target.entity === 'evidence_finding') {
    const finding = input.draft.evidenceFindings.find(({ key }) => key === target.key);
    if (!finding) fail(`Evidence Finding ${target.key} does not exist`);
    return {
      record: finding as unknown as Record<string, unknown>,
      unitKey: `evidence-finding:${target.key}`,
      allowedFields: new Set(['statement']),
    };
  }
  const blockKey = target.entity === 'content_block' ? target.key : target.parentKey;
  const block = input.draft.contentBlocks.find(({ key }) => key === blockKey);
  if (!block) fail(`Content Block ${String(blockKey)} does not exist`);
  if (target.entity === 'content_block') {
    return {
      record: block as unknown as Record<string, unknown>,
      unitKey: target.field === 'content' ? `content-block:${block.key}:content` : `content-block:${block.key}`,
      allowedFields: new Set(block.kind === 'narrative' ? ['title', 'content'] : ['title']),
    };
  }
  const item = contentItem(block, target.key);
  if (!item) fail(`Content item ${target.key} does not exist in ${block.key}`);
  const allowedFields = block.kind === 'comparison_matrix' || block.kind === 'strategy_map'
    ? new Set(['row', 'column', 'statement'])
    : block.kind === 'mind_model'
      ? new Set(['label', 'description'])
      : block.kind === 'design_principles'
        ? new Set(['title', 'statement'])
        : block.kind === 'opportunity_backlog'
          ? new Set(['title', 'statement', 'impact'])
          : block.kind === 'prioritized_actions' || block.kind === 'action_plan'
            ? new Set(['priority', 'action', 'ownerType', 'rationale', 'validationMethod'])
            : new Set(['channel', 'role', 'strategies']);
  const itemKind = block.kind === 'comparison_matrix' || block.kind === 'strategy_map' ? 'cell'
    : block.kind === 'mind_model' ? 'node' : 'item';
  return {
    record: item,
    unitKey: `content-block:${block.key}:${itemKind}:${target.key}`,
    allowedFields,
  };
}

function reviewAuthorizationTarget(
  operation: ResearchStrategyContentPatchOperationV1,
): string | null {
  if (operation.op === 'replace_direct_answer_binding') return operation.questionId;
  if (operation.op === 'replace_support') return operation.target.key;
  if (operation.op === 'replace_semantic_text') {
    return operation.target.entity === 'draft' ? 'root' : operation.target.key;
  }
  if (operation.op === 'append_block_item') return operation.blockKey;
  if (operation.op === 'append_limitation') return 'limitations';
  if (operation.op === 'append_open_question') return 'openQuestions';
  return null;
}

function assertModeAuthorization(input: {
  operation: ResearchStrategyContentPatchOperationV1;
  mode: ResearchStrategyContentPatchV1['mode'];
  allowedReviewIssueTargets?: ReadonlyMap<string, ReadonlySet<string>>;
}): void {
  const { operation } = input;
  if (input.mode === 'structural_repair') {
    if (operation.op === 'replace_semantic_text') fail('structural repair cannot replace semantic text');
    if (operation.op === 'append_block_item') fail('structural repair cannot append items to existing Blocks');
    return;
  }
  if (
    operation.op === 'append_direct_answer'
    || operation.op === 'append_content_block'
  ) fail(`semantic revision cannot use ${operation.op}`);
  const reviewIssueId = 'reviewIssueId' in operation ? operation.reviewIssueId : undefined;
  const reason = 'reason' in operation ? operation.reason : undefined;
  if (typeof reviewIssueId !== 'string' || !reviewIssueId.trim() || typeof reason !== 'string' || !reason.trim()) {
    fail(`semantic operation ${operation.op} requires reviewIssueId and reason`);
  }
  const target = reviewAuthorizationTarget(operation);
  const allowedTargets = input.allowedReviewIssueTargets?.get(reviewIssueId);
  if (!target || !allowedTargets?.has(target)) {
    fail(`review issue ${reviewIssueId} does not authorize target ${String(target)}`);
  }
}

function appendBlockItem(input: {
  draft: ResearchStrategyContentDraftV2;
  operation: Extract<ResearchStrategyContentPatchOperationV1, { op: 'append_block_item' }>;
  knownQuestionIds: readonly string[];
  evidenceClassById: ReadonlyMap<string, EvidenceClass>;
}): void {
  const block = input.draft.contentBlocks.find(({ key }) => key === input.operation.blockKey);
  if (!block) fail(`Content Block ${input.operation.blockKey} does not exist`);
  if (contentItem(block, input.operation.item.key)) {
    fail(`Content item ${input.operation.item.key} already exists in ${block.key}`);
  }
  const item = structuredClone(input.operation.item);
  const support = 'support' in item ? item.support : null;
  if (!support) fail('appended content item has no support');
  Object.assign(support, normalizedSupport({
    support,
    knownQuestionIds: input.knownQuestionIds,
    evidenceClassById: input.evidenceClassById,
  }));
  if ((block.kind === 'comparison_matrix' || block.kind === 'strategy_map') && 'row' in item && 'column' in item && 'statement' in item) {
    block.cells.push(item);
    return;
  }
  if (block.kind === 'mind_model' && 'label' in item && 'description' in item) {
    block.nodes.push(item);
    return;
  }
  if (block.kind === 'design_principles' && 'title' in item && 'statement' in item && !('impact' in item)) {
    block.items.push(item);
    return;
  }
  if (block.kind === 'opportunity_backlog' && 'title' in item && 'statement' in item && 'impact' in item) {
    block.items.push(item);
    return;
  }
  if ((block.kind === 'prioritized_actions' || block.kind === 'action_plan') && 'priority' in item && 'action' in item) {
    block.items.push(item);
    return;
  }
  if (block.kind === 'channel_strategies' && 'channel' in item && 'role' in item && 'strategies' in item) {
    block.items.push(item);
    return;
  }
  fail(`appended item ${item.key} does not match Block kind ${block.kind}`);
}

function applyOperation(input: {
  draft: ResearchStrategyContentDraftV2;
  operation: ResearchStrategyContentPatchOperationV1;
  mode: ResearchStrategyContentPatchV1['mode'];
  knownQuestionIds: readonly string[];
  requiredQuestionIds: ReadonlySet<string>;
  evidenceClassById: ReadonlyMap<string, EvidenceClass>;
  requestedArtifacts: readonly RequestedArtifact[];
  allowedReviewIssueTargets?: ReadonlyMap<string, ReadonlySet<string>>;
  changedSemanticUnitKeys: Set<string>;
}): void {
  const { operation } = input;
  assertModeAuthorization({
    operation,
    mode: input.mode,
    ...(input.allowedReviewIssueTargets ? { allowedReviewIssueTargets: input.allowedReviewIssueTargets } : {}),
  });
  if (operation.op === 'replace_direct_answer_binding') {
    const questionId = canonicalResearchQuestionId(operation.questionId, input.knownQuestionIds)
      ?? fail(`unknown Question ${operation.questionId}`);
    const answer = input.draft.directAnswers.find((candidate) => candidate.questionId === questionId);
    if (!answer) fail(`Direct Answer ${questionId} does not exist`);
    if (answer.answerStatus !== 'supported' && operation.answerStatus === 'supported') {
      fail('structural repair cannot promote a Direct Answer to supported');
    }
    if (operation.confidence > answer.confidence) fail('structural repair cannot increase Direct Answer confidence');
    const evidenceIds = validateEvidenceIds(operation.evidenceIds, input.evidenceClassById);
    if (
      operation.answerStatus === 'supported'
      && !evidenceIds.some((evidenceId) => isFactualEvidenceId(evidenceId, input.evidenceClassById))
    ) {
      fail(`supported Direct Answer ${questionId} requires factual Evidence`);
    }
    if (operation.answerStatus !== 'supported' && !operation.validationNeeded.trim()) {
      fail(`${operation.answerStatus} Direct Answer ${questionId} requires validationNeeded`);
    }
    Object.assign(answer, {
      answerStatus: operation.answerStatus,
      evidenceIds,
      confidence: operation.confidence,
      validationNeeded: operation.validationNeeded,
    });
    return;
  }
  if (operation.op === 'replace_support') {
    replaceSupport({
      draft: input.draft,
      operation,
      knownQuestionIds: input.knownQuestionIds,
      evidenceClassById: input.evidenceClassById,
    });
    return;
  }
  if (operation.op === 'append_direct_answer') {
    input.draft.directAnswers.push(validateAppendedAnswer({
      answer: operation.answer,
      draft: input.draft,
      knownQuestionIds: input.knownQuestionIds,
      requiredQuestionIds: input.requiredQuestionIds,
      evidenceClassById: input.evidenceClassById,
    }));
    return;
  }
  if (operation.op === 'append_content_block') {
    input.draft.contentBlocks.push(validateAppendedBlock({
      block: operation.block,
      draft: input.draft,
      requestedArtifacts: input.requestedArtifacts,
      knownQuestionIds: input.knownQuestionIds,
      evidenceClassById: input.evidenceClassById,
    }));
    return;
  }
  if (operation.op === 'append_block_item') {
    appendBlockItem({
      draft: input.draft,
      operation,
      knownQuestionIds: input.knownQuestionIds,
      evidenceClassById: input.evidenceClassById,
    });
    return;
  }
  if (operation.op === 'append_limitation') {
    if (!input.draft.limitations.includes(operation.value)) input.draft.limitations.push(operation.value);
    return;
  }
  if (operation.op === 'append_open_question') {
    if (!input.draft.openQuestions.includes(operation.value)) input.draft.openQuestions.push(operation.value);
    return;
  }
  const target = semanticTarget({ draft: input.draft, operation });
  if (!target.allowedFields.has(operation.target.field)) {
    fail(`field ${operation.target.field} is not allowed for ${operation.target.entity}`);
  }
  const expectsList = operation.target.field === 'strategies';
  if ((expectsList && !Array.isArray(operation.value)) || (!expectsList && typeof operation.value !== 'string')) {
    fail(`field ${operation.target.field} has an incompatible replacement value`);
  }
  target.record[operation.target.field] = structuredClone(operation.value);
  input.changedSemanticUnitKeys.add(target.unitKey);
}

export function applyResearchStrategyContentPatch(input: {
  source: ResearchStrategyContentDraftV2;
  patch: ResearchStrategyContentPatchV1;
  mode: ResearchStrategyContentPatchV1['mode'];
  problemGraph: ProblemGraph;
  evidenceManifest: EvidenceManifest;
  requestedArtifacts: readonly RequestedArtifact[];
  allowedReviewIssueTargets?: ReadonlyMap<string, ReadonlySet<string>>;
}): AppliedResearchStrategyContentPatch {
  if (input.patch.version !== 'research-strategy-content-patch-v1') fail('patch version is invalid');
  if (input.patch.mode !== input.mode) fail(`patch mode ${input.patch.mode} does not match ${input.mode}`);
  if (input.patch.operations.length === 0) fail('patch has no operations');
  const draft = structuredClone(input.source);
  const knownQuestionIds = input.problemGraph.questions.map(({ id }) => id);
  const requiredQuestionIds = new Set(input.problemGraph.questions
    .filter(({ priority }) => priority === 'required')
    .map(({ id }) => id)
    .filter((questionId) => !input.source.directAnswers.some((answer) => answer.questionId === questionId)));
  const evidenceClassById = new Map(input.evidenceManifest.entries.map(({ id, evidenceClass }) => [id, evidenceClass]));
  const operationKeys = new Set<string>();
  const changedSemanticUnitKeys = new Set<string>();
  for (const operation of input.patch.operations) {
    const operationKey = JSON.stringify(operation.op === 'replace_semantic_text'
      ? { op: operation.op, target: operation.target }
      : operation.op === 'replace_support'
        ? { op: operation.op, target: operation.target }
        : operation.op === 'replace_direct_answer_binding'
          ? { op: operation.op, questionId: operation.questionId }
          : operation);
    if (operationKeys.has(operationKey)) fail(`duplicate patch operation ${operationKey}`);
    operationKeys.add(operationKey);
    applyOperation({
      draft,
      operation,
      mode: input.mode,
      knownQuestionIds,
      requiredQuestionIds,
      evidenceClassById,
      requestedArtifacts: input.requestedArtifacts,
      ...(input.allowedReviewIssueTargets ? { allowedReviewIssueTargets: input.allowedReviewIssueTargets } : {}),
      changedSemanticUnitKeys,
    });
  }
  const fidelity = input.mode === 'structural_repair'
    ? assertStructuralRepairFidelity(input.source, draft)
    : assertSemanticRevisionFidelity(input.source, draft, changedSemanticUnitKeys);
  return { draft, changedSemanticUnitKeys: [...changedSemanticUnitKeys], fidelity };
}
