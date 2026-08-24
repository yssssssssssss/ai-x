import type {
  ProblemGraph,
  ResearchStrategyContentBlockDraftV2,
  ResearchStrategyContentDraftV2,
  ResearchStrategyContentPatchV1,
  ResearchStrategyContentPatchOperationV1,
  ResearchStrategyDirectAnswer,
  ResearchStrategyEvidenceFindingDraftV2,
  ResearchStrategySupportBindingV2,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type { RequestedArtifact } from '../../../../packages/api-contract/plan.ts';
import type { EvidenceManifest } from '../evidence/evidence-service.ts';
import {
  assertSemanticRevisionFidelity,
  assertStructuralRepairFidelity,
  type ResearchStrategyContentFidelityResult,
} from './research-strategy-content-fidelity.ts';
import { canonicalResearchQuestionId } from './research-strategy-reference-normalizer.ts';

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

const BLOCK_KIND_BY_ARTIFACT: Partial<Record<RequestedArtifact, ResearchStrategyContentBlockDraftV2['kind'][]>> = {
  research_report: ['narrative', 'comparison_matrix'],
  strategy_map: ['strategy_map'],
  mind_model: ['mind_model'],
  design_principles: ['design_principles'],
  opportunity_backlog: ['opportunity_backlog'],
  prioritized_actions: ['prioritized_actions'],
  channel_strategies: ['channel_strategies'],
  action_plan: ['action_plan'],
};

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

function validateEvidenceIds(evidenceIds: string[], knownEvidenceIds: ReadonlySet<string>): string[] {
  const normalized = unique(evidenceIds);
  for (const evidenceId of normalized) {
    if (!knownEvidenceIds.has(evidenceId)) fail(`unknown Evidence ${evidenceId}`);
  }
  return normalized;
}

function normalizedSupport(input: {
  support: ResearchStrategySupportBindingV2;
  previousStatus?: ResearchStrategySupportBindingV2['status'];
  previousConfidence?: number;
  knownQuestionIds: readonly string[];
  knownEvidenceIds: ReadonlySet<string>;
}): ResearchStrategySupportBindingV2 {
  if (input.previousStatus === 'provisional' && input.support.status === 'supported') {
    fail('structural repair cannot promote provisional support to supported');
  }
  if (input.previousConfidence !== undefined && input.support.confidence > input.previousConfidence) {
    fail('structural repair cannot increase confidence');
  }
  const support = {
    ...input.support,
    questionIds: normalizeQuestionIds(input.support.questionIds, input.knownQuestionIds),
    evidenceIds: validateEvidenceIds(input.support.evidenceIds, input.knownEvidenceIds),
  };
  if (support.status === 'supported' && support.evidenceIds.length === 0) {
    fail('supported content requires Evidence');
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
  knownEvidenceIds: ReadonlySet<string>;
}): ResearchStrategyDirectAnswer {
  const questionId = canonicalResearchQuestionId(input.answer.questionId, input.knownQuestionIds)
    ?? fail(`unknown Question ${input.answer.questionId}`);
  if (input.draft.directAnswers.some((answer) => answer.questionId === questionId)) {
    fail(`Direct Answer ${questionId} already exists`);
  }
  const evidenceIds = validateEvidenceIds(input.answer.evidenceIds, input.knownEvidenceIds);
  if (input.answer.answerStatus === 'supported' && evidenceIds.length === 0) {
    fail(`supported Direct Answer ${questionId} requires Evidence`);
  }
  if (input.answer.answerStatus !== 'supported' && !input.answer.validationNeeded.trim()) {
    fail(`${input.answer.answerStatus} Direct Answer ${questionId} requires validationNeeded`);
  }
  return { ...structuredClone(input.answer), questionId, evidenceIds };
}

function validateAppendedFinding(input: {
  finding: ResearchStrategyEvidenceFindingDraftV2;
  draft: ResearchStrategyContentDraftV2;
  knownQuestionIds: readonly string[];
  knownEvidenceIds: ReadonlySet<string>;
}): ResearchStrategyEvidenceFindingDraftV2 {
  if (input.draft.evidenceFindings.some(({ key }) => key === input.finding.key)) {
    fail(`Evidence Finding ${input.finding.key} already exists`);
  }
  return {
    ...structuredClone(input.finding),
    support: normalizedSupport({
      support: input.finding.support,
      knownQuestionIds: input.knownQuestionIds,
      knownEvidenceIds: input.knownEvidenceIds,
    }),
  };
}

function validateAppendedBlock(input: {
  block: ResearchStrategyContentBlockDraftV2;
  draft: ResearchStrategyContentDraftV2;
  requestedArtifacts: readonly RequestedArtifact[];
  knownQuestionIds: readonly string[];
  knownEvidenceIds: ReadonlySet<string>;
}): ResearchStrategyContentBlockDraftV2 {
  if (input.draft.contentBlocks.some(({ key }) => key === input.block.key)) {
    fail(`Content Block ${input.block.key} already exists`);
  }
  const allowedKinds = new Set(input.requestedArtifacts.flatMap((artifact) => BLOCK_KIND_BY_ARTIFACT[artifact] ?? []));
  if (!allowedKinds.has(input.block.kind)) {
    fail(`Content Block ${input.block.kind} was not requested`);
  }
  if (input.draft.contentBlocks.some(({ kind }) => kind === input.block.kind)) {
    fail(`Content Block kind ${input.block.kind} is already materialized`);
  }
  const block = structuredClone(input.block);
  for (const support of contentSupports(block)) {
    Object.assign(support, normalizedSupport({
      support,
      knownQuestionIds: input.knownQuestionIds,
      knownEvidenceIds: input.knownEvidenceIds,
    }));
  }
  return block;
}

function replaceSupport(input: {
  draft: ResearchStrategyContentDraftV2;
  operation: Extract<ResearchStrategyContentPatchOperationV1, { op: 'replace_support' }>;
  knownQuestionIds: readonly string[];
  knownEvidenceIds: ReadonlySet<string>;
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
  const replacement = normalizedSupport({
    support: input.operation.support,
    previousStatus: current.status,
    previousConfidence: current.confidence,
    knownQuestionIds: input.knownQuestionIds,
    knownEvidenceIds: input.knownEvidenceIds,
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

function applyOperation(input: {
  draft: ResearchStrategyContentDraftV2;
  operation: ResearchStrategyContentPatchOperationV1;
  mode: ResearchStrategyContentPatchV1['mode'];
  knownQuestionIds: readonly string[];
  knownEvidenceIds: ReadonlySet<string>;
  requestedArtifacts: readonly RequestedArtifact[];
  changedSemanticUnitKeys: Set<string>;
}): void {
  const { operation } = input;
  if (operation.op === 'replace_direct_answer_binding') {
    const questionId = canonicalResearchQuestionId(operation.questionId, input.knownQuestionIds)
      ?? fail(`unknown Question ${operation.questionId}`);
    const answer = input.draft.directAnswers.find((candidate) => candidate.questionId === questionId);
    if (!answer) fail(`Direct Answer ${questionId} does not exist`);
    if (answer.answerStatus !== 'supported' && operation.answerStatus === 'supported') {
      fail('structural repair cannot promote a Direct Answer to supported');
    }
    if (operation.confidence > answer.confidence) fail('structural repair cannot increase Direct Answer confidence');
    const evidenceIds = validateEvidenceIds(operation.evidenceIds, input.knownEvidenceIds);
    if (operation.answerStatus === 'supported' && evidenceIds.length === 0) {
      fail(`supported Direct Answer ${questionId} requires Evidence`);
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
      knownEvidenceIds: input.knownEvidenceIds,
    });
    return;
  }
  if (operation.op === 'append_direct_answer') {
    input.draft.directAnswers.push(validateAppendedAnswer({
      answer: operation.answer,
      draft: input.draft,
      knownQuestionIds: input.knownQuestionIds,
      knownEvidenceIds: input.knownEvidenceIds,
    }));
    return;
  }
  if (operation.op === 'append_evidence_finding') {
    input.draft.evidenceFindings.push(validateAppendedFinding({
      finding: operation.finding,
      draft: input.draft,
      knownQuestionIds: input.knownQuestionIds,
      knownEvidenceIds: input.knownEvidenceIds,
    }));
    return;
  }
  if (operation.op === 'append_content_block') {
    input.draft.contentBlocks.push(validateAppendedBlock({
      block: operation.block,
      draft: input.draft,
      requestedArtifacts: input.requestedArtifacts,
      knownQuestionIds: input.knownQuestionIds,
      knownEvidenceIds: input.knownEvidenceIds,
    }));
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
  if (input.mode !== 'semantic_revision') fail('structural repair cannot replace semantic text');
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
}): AppliedResearchStrategyContentPatch {
  if (input.patch.version !== 'research-strategy-content-patch-v1') fail('patch version is invalid');
  if (input.patch.mode !== input.mode) fail(`patch mode ${input.patch.mode} does not match ${input.mode}`);
  if (input.patch.operations.length === 0) fail('patch has no operations');
  const draft = structuredClone(input.source);
  const knownQuestionIds = input.problemGraph.questions.map(({ id }) => id);
  const knownEvidenceIds = new Set(input.evidenceManifest.entries.map(({ id }) => id));
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
      knownEvidenceIds,
      requestedArtifacts: input.requestedArtifacts,
      changedSemanticUnitKeys,
    });
  }
  const fidelity = input.mode === 'structural_repair'
    ? assertStructuralRepairFidelity(input.source, draft)
    : assertSemanticRevisionFidelity(input.source, draft, changedSemanticUnitKeys);
  return { draft, changedSemanticUnitKeys: [...changedSemanticUnitKeys], fidelity };
}
