import type {
  CapabilityProvenance,
  CurrentRecommendation,
  FindingGraph,
  ProblemGraph,
  ResearchDeliverableCoverage,
  ResearchDeliverableEnvelope,
  ResearchStrategyContentBlockDraftV2,
  ResearchStrategyContentBlockV2,
  ResearchStrategyContentDraftV2,
  ResearchStrategyEvidenceFindingV2,
  ResearchStrategyReportPayloadV2,
  ResearchStrategyRiskDisclosure,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type { ResearchTaskV2, RequestedArtifact } from '../../../../packages/api-contract/plan.ts';
import type { EvidenceManifest } from '../evidence/evidence-service.ts';
import { SchemaValidator } from '../schema/validator.ts';
import type { SynthesisMaterial } from './synthesis-materializer.ts';

const DRAFT_SCHEMA = 'schemas/skills/research-strategy-content-draft-v2.schema.json';
const PAYLOAD_SCHEMA = 'schemas/deliverables/research-strategy-report-v2.schema.json';
const FACTUAL_EVIDENCE_CLASSES = new Set(['public_source', 'screenshot', 'dataset']);

export class ResearchStrategyAssemblyError extends Error {
  constructor(message: string) {
    super(`Research strategy assembly failed: ${message}`);
    this.name = 'ResearchStrategyAssemblyError';
  }
}

function fail(message: string): never {
  throw new ResearchStrategyAssemblyError(message);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function appendUniqueText(values: string[], value: string): void {
  const normalized = normalizeText(value);
  if (!normalized || values.some((candidate) => normalizeText(candidate) === normalized)) return;
  values.push(value.trim());
}

function supportForBlock(block: ResearchStrategyContentBlockV2): Array<{
  questionIds: string[];
  evidenceIds: string[];
  confidence: number;
  status: 'supported' | 'provisional';
  validationNeeded: string;
}> {
  if (block.kind === 'narrative') return [block.support];
  if (block.kind === 'comparison_matrix' || block.kind === 'strategy_map') {
    return block.cells.map(({ support }) => support);
  }
  if (block.kind === 'mind_model') return block.nodes.map(({ support }) => support);
  if ('items' in block) return block.items.map(({ support }) => support);
  return fail(`unsupported content block kind ${(block as { kind?: unknown }).kind as string}`);
}

function normalizeBlock(
  block: ResearchStrategyContentBlockDraftV2,
  blockIndex: number,
): ResearchStrategyContentBlockV2 {
  const id = `content-block-${String(blockIndex + 1).padStart(3, '0')}`;
  if (block.kind === 'narrative') {
    const { key: _key, ...content } = block;
    return { ...content, id };
  }
  if (block.kind === 'comparison_matrix' || block.kind === 'strategy_map') {
    const { key: _key, cells, ...content } = block;
    return {
      ...content,
      rows: unique([...block.rows, ...cells.map(({ row }) => row)]),
      columns: unique([...block.columns, ...cells.map(({ column }) => column)]),
      id,
      cells: cells.map(({ key: _cellKey, ...cell }, itemIndex) => ({
        ...cell,
        id: `${id}-item-${String(itemIndex + 1).padStart(3, '0')}`,
      })),
    };
  }
  if (block.kind === 'mind_model') {
    const { key: _key, nodes, edges, ...content } = block;
    const idsByKey = new Map<string, string>();
    const normalizedNodes = nodes.map(({ key, ...node }, itemIndex) => {
      if (idsByKey.has(key)) fail(`mind model block ${block.key} duplicates node key ${key}`);
      const nodeId = `${id}-node-${String(itemIndex + 1).padStart(3, '0')}`;
      idsByKey.set(key, nodeId);
      return { ...node, id: nodeId };
    });
    return {
      ...content,
      id,
      nodes: normalizedNodes,
      edges: edges.map((edge) => {
        const from = idsByKey.get(edge.from);
        const to = idsByKey.get(edge.to);
        if (!from || !to) fail(`mind model block ${block.key} references an unknown node key`);
        return { ...edge, from, to };
      }),
    };
  }
  if (!('items' in block)) return fail(`unsupported content block kind ${(block as { kind?: unknown }).kind as string}`);
  const { key: _key, items, ...content } = block;
  return {
    ...content,
    id,
    items: items.map(({ key: _itemKey, ...item }, itemIndex) => ({
      ...item,
      id: `${id}-item-${String(itemIndex + 1).padStart(3, '0')}`,
    })),
  } as ResearchStrategyContentBlockV2;
}

function validateSupportBindings(input: {
  draft: ResearchStrategyContentDraftV2;
  problemGraph: ProblemGraph;
  evidenceManifest: EvidenceManifest;
}): void {
  const knownQuestions = new Set(input.problemGraph.questions.map(({ id }) => id));
  const knownEvidence = new Set(input.evidenceManifest.entries.map(({ id }) => id));
  if (new Set(input.draft.directAnswers.map(({ questionId }) => questionId)).size !== input.draft.directAnswers.length) {
    fail('direct answer question IDs must be unique');
  }
  const validate = (binding: {
    questionIds: string[];
    evidenceIds: string[];
    status: 'supported' | 'provisional';
    validationNeeded: string;
  }, label: string): void => {
    if (binding.questionIds.length === 0) fail(`${label} has no question binding`);
    for (const questionId of binding.questionIds) {
      if (!knownQuestions.has(questionId)) fail(`${label} references unknown question ${questionId}`);
    }
    for (const evidenceId of binding.evidenceIds) {
      if (!knownEvidence.has(evidenceId)) fail(`${label} references unknown Evidence ${evidenceId}`);
    }
    if (binding.status === 'supported' && binding.evidenceIds.length === 0) {
      fail(`${label} is supported without Evidence`);
    }
    if (binding.status === 'provisional' && !binding.validationNeeded.trim()) {
      fail(`${label} is provisional without a validation need`);
    }
  };

  for (const [index, finding] of input.draft.evidenceFindings.entries()) {
    validate(finding.support, `evidence finding ${index + 1}`);
    if (finding.support.status !== 'supported') continue;
    for (const evidenceId of finding.support.evidenceIds) {
      const entry = input.evidenceManifest.entries.find(({ id }) => id === evidenceId);
      if (!entry || !FACTUAL_EVIDENCE_CLASSES.has(entry.evidenceClass)) {
        fail(`evidence finding ${index + 1} is rooted in non-factual Evidence ${evidenceId}`);
      }
    }
  }
  for (const [index, block] of input.draft.contentBlocks.entries()) {
    for (const [supportIndex, support] of supportForBlock(normalizeBlock(block, index)).entries()) {
      validate(support, `content block ${index + 1} support ${supportIndex + 1}`);
    }
  }
}

function contentBlockIdsForArtifact(
  artifact: RequestedArtifact,
  blocks: readonly ResearchStrategyContentBlockV2[],
): string[] {
  if (artifact === 'research_report') return blocks.map(({ id }) => id);
  const kind = artifact === 'strategy_map' ? 'strategy_map'
    : artifact === 'mind_model' ? 'mind_model'
      : artifact === 'design_principles' ? 'design_principles'
        : artifact === 'opportunity_backlog' ? 'opportunity_backlog'
          : artifact === 'prioritized_actions' ? 'prioritized_actions'
            : artifact === 'channel_strategies' ? 'channel_strategies'
              : artifact === 'action_plan' ? 'action_plan'
                : null;
  return kind ? blocks.filter((block) => block.kind === kind).map(({ id }) => id) : [];
}

function graphAndCoverage(input: {
  draft: ResearchStrategyContentDraftV2;
  findings: ResearchStrategyEvidenceFindingV2[];
  blocks: ResearchStrategyContentBlockV2[];
  problemGraph: ProblemGraph;
  requirement: ResearchTaskV2;
  evidenceManifest: EvidenceManifest;
}): {
  findingGraph: FindingGraph;
  recommendations: CurrentRecommendation[];
  coverage: ResearchDeliverableCoverage;
} {
  const factIdsByQuestion = new Map<string, string[]>();
  const factIdsByEvidence = new Map<string, string[]>();
  const facts = input.findings
    .filter(({ support }) => support.status === 'supported')
    .map((finding) => {
      for (const questionId of finding.support.questionIds) {
        factIdsByQuestion.set(questionId, [...(factIdsByQuestion.get(questionId) ?? []), finding.id]);
      }
      for (const evidenceId of finding.support.evidenceIds) {
        factIdsByEvidence.set(evidenceId, [...(factIdsByEvidence.get(evidenceId) ?? []), finding.id]);
      }
      return {
        id: finding.id,
        kind: 'fact' as const,
        evidenceIds: finding.support.evidenceIds,
        statement: finding.statement,
      };
    });
  const evidenceById = new Map(input.evidenceManifest.entries.map((entry) => [entry.id, entry]));
  const factualRootsForEvidence = (evidenceId: string): string[] => {
    const existing = factIdsByEvidence.get(evidenceId) ?? [];
    if (existing.length > 0) return existing;
    const evidence = evidenceById.get(evidenceId);
    if (!evidence || !FACTUAL_EVIDENCE_CLASSES.has(evidence.evidenceClass)) return [];
    const anchorId = `evidence-anchor-${evidenceId}`;
    if (!facts.some(({ id }) => id === anchorId)) {
      facts.push({
        id: anchorId,
        kind: 'fact',
        evidenceIds: [evidenceId],
        statement: `Verified ${evidence.evidenceClass} Evidence ${evidenceId} was collected for this analysis.`,
      });
    }
    factIdsByEvidence.set(evidenceId, [anchorId]);
    return [anchorId];
  };
  for (const answer of input.draft.directAnswers) {
    const roots = unique(answer.evidenceIds.flatMap(factualRootsForEvidence));
    if (roots.length === 0) continue;
    factIdsByQuestion.set(answer.questionId, unique([
      ...(factIdsByQuestion.get(answer.questionId) ?? []),
      ...roots,
    ]));
  }
  const provisionalAnalyses = input.findings
    .filter(({ support }) => support.status === 'provisional')
    .map((finding) => {
      let relatedFacts = unique([
        ...finding.support.questionIds.flatMap((questionId) => factIdsByQuestion.get(questionId) ?? []),
        ...finding.support.evidenceIds.flatMap((evidenceId) => factIdsByEvidence.get(evidenceId) ?? []),
      ]);
      if (relatedFacts.length === 0) {
        relatedFacts = unique(finding.support.evidenceIds.flatMap(factualRootsForEvidence));
      }
      if (relatedFacts.length === 0) fail(`provisional evidence finding ${finding.id} has no factual Evidence root`);
      for (const questionId of finding.support.questionIds) {
        factIdsByQuestion.set(questionId, unique([
          ...(factIdsByQuestion.get(questionId) ?? []),
          ...relatedFacts,
        ]));
      }
      return {
        id: `analysis-${finding.id}`,
        findingIds: relatedFacts,
        statement: finding.statement,
        questionIds: finding.support.questionIds,
      };
    });
  if (facts.length === 0) fail('at least one factual Evidence root is required');

  const blockAnalyses = input.blocks.map((block) => {
    const supports = supportForBlock(block);
    const questionIds = unique(supports.flatMap(({ questionIds }) => questionIds));
    const evidenceIds = new Set(supports.flatMap(({ evidenceIds }) => evidenceIds));
    const relatedFacts = unique([
      ...questionIds.flatMap((questionId) => factIdsByQuestion.get(questionId) ?? []),
      ...[...evidenceIds].flatMap((evidenceId) => factIdsByEvidence.get(evidenceId) ?? []),
    ]);
    if (relatedFacts.length === 0) fail(`content block ${block.id} has no related evidence finding`);
    return {
      id: `analysis-${block.id}`,
      findingIds: unique(relatedFacts),
      statement: block.kind === 'narrative' ? block.content : block.title,
    };
  });
  const analyses = [
    ...provisionalAnalyses.map(({ questionIds: _questionIds, ...analysis }) => analysis),
    ...blockAnalyses,
  ];

  const answerByQuestion = new Map(input.draft.directAnswers.map((answer) => [answer.questionId, answer]));
  const analysisIdsByQuestion = new Map<string, string[]>();
  for (const analysis of provisionalAnalyses) {
    for (const questionId of analysis.questionIds) {
      analysisIdsByQuestion.set(questionId, [...(analysisIdsByQuestion.get(questionId) ?? []), analysis.id]);
    }
  }
  input.blocks.forEach((block, index) => {
    for (const questionId of unique(supportForBlock(block).flatMap(({ questionIds }) => questionIds))) {
      analysisIdsByQuestion.set(questionId, [
        ...(analysisIdsByQuestion.get(questionId) ?? []),
        blockAnalyses[index]!.id,
      ]);
    }
  });
  const requiredQuestions = input.problemGraph.questions.filter(({ priority }) => priority === 'required');
  for (const question of requiredQuestions) {
    const answer = answerByQuestion.get(question.id);
    if (!answer || answer.answerStatus === 'unanswered') fail(`required question ${question.id} has no usable direct answer`);
  }
  const answeredQuestions = input.problemGraph.questions.filter(({ id }) => answerByQuestion.has(id));
  const summaries = answeredQuestions.map((question) => {
    const answer = answerByQuestion.get(question.id)!;
    const analysisIds = unique(analysisIdsByQuestion.get(question.id) ?? []);
    const findingIds = unique([
      ...(factIdsByQuestion.get(question.id) ?? []),
      ...analysisIds.flatMap((analysisId) => analyses.find(({ id }) => id === analysisId)?.findingIds ?? []),
    ]);
    if (findingIds.length + analysisIds.length === 0) fail(`answered question ${question.id} has no content roots`);
    return {
      id: `summary-${question.id}`,
      findingIds,
      analysisIds,
      summary: answer.answer,
    };
  });
  const summaryByQuestion = new Map(answeredQuestions.map((question, index) => [question.id, summaries[index]!.id]));
  const conclusions = answeredQuestions.map((question) => ({
    id: `conclusion-${question.id}`,
    summaryIds: [summaryByQuestion.get(question.id)!],
    statement: answerByQuestion.get(question.id)!.answer,
  }));
  const recommendations = answeredQuestions.map((question) => ({
    id: `recommendation-${question.id}`,
    summaryIds: [summaryByQuestion.get(question.id)!],
    statement: answerByQuestion.get(question.id)!.recommendedAction,
  }));
  const conclusionByQuestion = new Map(answeredQuestions.map((question, index) => [question.id, conclusions[index]!.id]));
  const recommendationByQuestion = new Map(answeredQuestions.map((question, index) => [question.id, recommendations[index]!.id]));
  const successCriterionIds = input.requirement.success_criteria.map(({ id }) => id);
  const successCriterionBindings = successCriterionIds.map((successCriterionId) => {
    const questions = answeredQuestions.filter(({ success_criterion_ids }) => success_criterion_ids.includes(successCriterionId));
    if (questions.length === 0) fail(`success criterion ${successCriterionId} has no required question mapping`);
    return {
      successCriterionId,
      conclusionIds: questions.map(({ id }) => conclusionByQuestion.get(id)!),
      recommendationIds: questions.map(({ id }) => recommendationByQuestion.get(id)!),
    };
  });
  return {
    findingGraph: {
      findings: facts,
      analyses,
      subQuestionSummaries: summaries,
      overallConclusions: conclusions,
    },
    recommendations,
    coverage: {
      questionBindings: answeredQuestions.map(({ id }) => ({ questionId: id, summaryIds: [summaryByQuestion.get(id)!] })),
      successCriterionBindings,
    },
  };
}

function questionOrdinal(value: string): string | null {
  const match = /^q0*(\d+)(?:[_-]|$)/iu.exec(normalizeText(value));
  return match?.[1]?.replace(/^0+(?=\d)/u, '') ?? null;
}

function questionSkeleton(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
}

function canonicalizeQuestionAliases(
  draft: ResearchStrategyContentDraftV2,
  problemGraph: ProblemGraph,
): ResearchStrategyContentDraftV2 {
  const known = new Set(problemGraph.questions.map(({ id }) => id));
  const byOrdinal = new Map<string, string | null>();
  for (const questionId of known) {
    const ordinal = questionOrdinal(questionId);
    if (!ordinal) continue;
    const existing = byOrdinal.get(ordinal);
    byOrdinal.set(ordinal, existing === undefined || existing === questionId ? questionId : null);
  }
  const normalize = (questionId: string): string => {
    if (known.has(questionId)) return questionId;
    const ordinal = questionOrdinal(questionId);
    const candidate = ordinal ? byOrdinal.get(ordinal) : null;
    if (!candidate) return questionId;
    const aliasSkeleton = questionSkeleton(questionId);
    const candidateSkeleton = questionSkeleton(candidate);
    const ordinalSkeleton = `q${ordinal}`;
    const safelyEquivalent = aliasSkeleton === ordinalSkeleton
      || aliasSkeleton === candidateSkeleton
      || aliasSkeleton.startsWith(`${candidateSkeleton}_`)
      || candidateSkeleton.startsWith(`${aliasSkeleton}_`);
    return safelyEquivalent ? candidate : questionId;
  };
  const normalizeMany = (questionIds: string[]): string[] => unique(questionIds.map(normalize));
  for (const answer of draft.directAnswers) answer.questionId = normalize(answer.questionId);
  for (const finding of draft.evidenceFindings) {
    finding.support.questionIds = normalizeMany(finding.support.questionIds);
  }
  for (const block of draft.contentBlocks) {
    if (block.kind === 'narrative') block.support.questionIds = normalizeMany(block.support.questionIds);
    else if (block.kind === 'comparison_matrix' || block.kind === 'strategy_map') {
      for (const cell of block.cells) cell.support.questionIds = normalizeMany(cell.support.questionIds);
    } else if (block.kind === 'mind_model') {
      for (const node of block.nodes) node.support.questionIds = normalizeMany(node.support.questionIds);
    } else if ('items' in block) {
      for (const item of block.items) item.support.questionIds = normalizeMany(item.support.questionIds);
    } else {
      fail(`unsupported content block kind ${(block as { kind?: unknown }).kind as string}`);
    }
  }
  return draft;
}

function identifierOccursAt(source: string, identifier: string, index: number): boolean {
  const before = index === 0 ? '' : source[index - 1]!;
  const after = source[index + identifier.length] ?? '';
  return !/[A-Za-z0-9_:-]/u.test(before) && !/[A-Za-z0-9_:-]/u.test(after);
}

function questionEvidenceHints(input: {
  materials: readonly SynthesisMaterial[];
  problemGraph: ProblemGraph;
  evidenceManifest: EvidenceManifest;
}): Map<string, string[]> {
  const questionIds = input.problemGraph.questions.map(({ id }) => id);
  const evidenceIds = input.evidenceManifest.entries.map(({ id }) => id);
  const hints = new Map(questionIds.map((questionId) => [questionId, new Set<string>()]));
  const skillStepNo = input.materials
    .filter(({ actorType, actorId }) => actorType === 'skill' && actorId === 'research-strategy-synthesis')
    .reduce((lowest, { stepNo }) => Math.min(lowest, stepNo), Number.POSITIVE_INFINITY);
  for (const material of input.materials) {
    if (material.actorType !== 'llm' || material.stepNo >= skillStepNo) continue;
    const materialRecord = record(material.value);
    if (typeof materialRecord?.text !== 'string') continue;
    let currentQuestionId: string | null = null;
    for (const line of materialRecord.text.split(/\r?\n/u)) {
      const trimmed = line.trim();
      const headingQuestionId = questionIds.find((questionId) => {
        const index = trimmed.indexOf(questionId);
        if (index === -1 || !identifierOccursAt(trimmed, questionId, index)) return false;
        return /^#{0,6}\s*$/u.test(trimmed.slice(0, index));
      });
      if (headingQuestionId) currentQuestionId = headingQuestionId;
      if (!currentQuestionId) continue;
      const selected = hints.get(currentQuestionId)!;
      for (const evidenceId of evidenceIds) {
        let cursor = 0;
        while (cursor < line.length) {
          const evidenceIndex = line.indexOf(evidenceId, cursor);
          if (evidenceIndex === -1) break;
          if (identifierOccursAt(line, evidenceId, evidenceIndex)) {
            selected.add(evidenceId);
            break;
          }
          cursor = evidenceIndex + evidenceId.length;
        }
      }
    }
    if (material.questionIds.length === 1) {
      const selected = hints.get(material.questionIds[0]!);
      if (!selected) continue;
      for (const evidenceId of evidenceIds) {
        const index = materialRecord.text.indexOf(evidenceId);
        if (index !== -1 && identifierOccursAt(materialRecord.text, evidenceId, index)) selected.add(evidenceId);
      }
    }
  }
  return new Map([...hints].map(([questionId, ids]) => [questionId, [...ids]]));
}

function hydrateEmptyEvidenceBindings(input: {
  draft: ResearchStrategyContentDraftV2;
  materials: readonly SynthesisMaterial[];
  problemGraph: ProblemGraph;
  evidenceManifest: EvidenceManifest;
}): ResearchStrategyContentDraftV2 {
  const hints = questionEvidenceHints(input);
  const evidenceFor = (questionIds: string[]): string[] => unique(
    questionIds.flatMap((questionId) => hints.get(questionId) ?? []),
  );
  const hydrate = (support: {
    questionIds: string[];
    evidenceIds: string[];
    status: 'supported' | 'provisional';
  }): void => {
    if (support.status !== 'provisional' || support.evidenceIds.length > 0) return;
    support.evidenceIds = evidenceFor(support.questionIds);
  };
  for (const answer of input.draft.directAnswers) {
    if (answer.answerStatus === 'provisional' && answer.evidenceIds.length === 0) {
      answer.evidenceIds = evidenceFor([answer.questionId]);
    }
  }
  for (const finding of input.draft.evidenceFindings) hydrate(finding.support);
  for (const block of input.draft.contentBlocks) {
    if (block.kind === 'narrative') hydrate(block.support);
    else if (block.kind === 'comparison_matrix' || block.kind === 'strategy_map') {
      for (const cell of block.cells) hydrate(cell.support);
    } else if (block.kind === 'mind_model') {
      for (const node of block.nodes) hydrate(node.support);
    } else if ('items' in block) {
      for (const item of block.items) hydrate(item.support);
    } else {
      fail(`unsupported content block kind ${(block as { kind?: unknown }).kind as string}`);
    }
  }
  return input.draft;
}

function canonicalizeEvidenceAliases(
  source: ResearchStrategyContentDraftV2,
  manifest: EvidenceManifest,
): ResearchStrategyContentDraftV2 {
  const draft = structuredClone(source);
  const known = new Set(manifest.entries.map(({ id }) => id));
  const factual = manifest.entries.filter(({ evidenceClass }) => FACTUAL_EVIDENCE_CLASSES.has(evidenceClass));
  const aliases = new Map(factual.map((entry, index) => [`E${index + 1}`, entry.id]));
  for (const entry of manifest.entries) {
    const match = /^([EK])(\d+-\d+)$/u.exec(entry.id);
    if (!match) continue;
    aliases.set(`${match[1] === 'E' ? 'K' : 'E'}${match[2]}`, entry.id);
  }
  const normalize = (ids: string[]): string[] => unique(ids.map((id) => (
    known.has(id) ? id : aliases.get(id) ?? id
  )));
  for (const answer of draft.directAnswers) answer.evidenceIds = normalize(answer.evidenceIds);
  for (const finding of draft.evidenceFindings) {
    finding.support.evidenceIds = normalize(finding.support.evidenceIds);
    if (
      finding.support.status === 'supported'
      && !finding.support.evidenceIds.some((evidenceId) => {
        const entry = manifest.entries.find(({ id }) => id === evidenceId);
        return Boolean(entry && FACTUAL_EVIDENCE_CLASSES.has(entry.evidenceClass));
      })
    ) {
      finding.support.status = 'provisional';
      if (!finding.support.validationNeeded.trim() || finding.support.validationNeeded === 'not_applicable') {
        finding.support.validationNeeded = 'This method-grounded statement requires factual validation.';
      }
    }
  }
  for (const block of draft.contentBlocks) {
    if (block.kind === 'narrative') block.support.evidenceIds = normalize(block.support.evidenceIds);
    else if (block.kind === 'comparison_matrix' || block.kind === 'strategy_map') {
      for (const cell of block.cells) cell.support.evidenceIds = normalize(cell.support.evidenceIds);
    } else if (block.kind === 'mind_model') {
      for (const node of block.nodes) node.support.evidenceIds = normalize(node.support.evidenceIds);
    } else if ('items' in block) {
      for (const item of block.items) item.support.evidenceIds = normalize(item.support.evidenceIds);
    } else {
      fail(`unsupported content block kind ${(block as { kind?: unknown }).kind as string}`);
    }
  }
  return draft;
}

export function extractResearchStrategyContentDraft(
  materials: readonly SynthesisMaterial[],
): ResearchStrategyContentDraftV2 {
  const matches = materials.filter(({ actorType, actorId }) => (
    actorType === 'skill' && actorId === 'research-strategy-synthesis'
  ));
  if (matches.length !== 1) fail(`expected exactly one research-strategy-synthesis material, received ${matches.length}`);
  const skill = matches[0]!;
  const envelope = record(skill.value);
  if (envelope?.version !== 'skill-output-v2') fail('research strategy Skill output version is invalid');
  const finalReviews = materials
    .filter(({ actorType, stepNo }) => actorType === 'reviewer' && stepNo > skill.stepNo)
    .sort((left, right) => right.stepNo - left.stepNo);
  if (finalReviews.length === 0) fail('research strategy Skill output has no final Reviewer material');
  const review = record(finalReviews[0]!.value);
  if (review?.version !== 'reviewer-step-output-v1') fail('final research strategy Reviewer output is invalid');
  if (review.verdict !== 'pass' && review.verdict !== 'pass_with_conditions') {
    fail(`final research strategy Reviewer verdict ${String(review.verdict)} does not permit assembly`);
  }
  const payload = envelope.payload;
  if (!record(payload)) fail('research strategy Skill output has no payload');
  return payload as unknown as ResearchStrategyContentDraftV2;
}

export function assembleResearchStrategyDeliverable(input: {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  evidenceManifestArtifactId: string;
  requirement: ResearchTaskV2;
  problemGraph: ProblemGraph;
  evidenceManifest: EvidenceManifest;
  materials: readonly SynthesisMaterial[];
  draftOverride?: ResearchStrategyContentDraftV2;
  requiredRiskDisclosures: readonly ResearchStrategyRiskDisclosure[];
  capabilityProvenance: CapabilityProvenance[];
  validator?: Pick<SchemaValidator, 'validateFileOrThrow'>;
}): ResearchDeliverableEnvelope<ResearchStrategyReportPayloadV2> {
  const validator = input.validator ?? new SchemaValidator();
  const normalizedDraft = canonicalizeQuestionAliases(
    canonicalizeEvidenceAliases(
      input.draftOverride ?? extractResearchStrategyContentDraft(input.materials),
      input.evidenceManifest,
    ),
    input.problemGraph,
  );
  const draft = input.draftOverride
    ? hydrateEmptyEvidenceBindings({
        draft: normalizedDraft,
        materials: input.materials,
        problemGraph: input.problemGraph,
        evidenceManifest: input.evidenceManifest,
      })
    : normalizedDraft;
  validator.validateFileOrThrow(DRAFT_SCHEMA, draft);
  validateSupportBindings({ draft, problemGraph: input.problemGraph, evidenceManifest: input.evidenceManifest });

  const findings: ResearchStrategyEvidenceFindingV2[] = draft.evidenceFindings.map(({ key: _key, ...finding }, index) => ({
    ...finding,
    id: `evidence-finding-${String(index + 1).padStart(3, '0')}`,
  }));
  const blocks = draft.contentBlocks.map(normalizeBlock);
  const knownQuestions = new Set(input.problemGraph.questions.map(({ id }) => id));
  const knownEvidence = new Set(input.evidenceManifest.entries.map(({ id }) => id));
  for (const answer of draft.directAnswers) {
    if (!knownQuestions.has(answer.questionId)) fail(`direct answer references unknown question ${answer.questionId}`);
    for (const evidenceId of answer.evidenceIds) {
      if (!knownEvidence.has(evidenceId)) fail(`direct answer ${answer.questionId} references unknown Evidence ${evidenceId}`);
    }
    if (answer.answerStatus === 'supported' && answer.evidenceIds.length === 0) {
      fail(`supported answer ${answer.questionId} has no Evidence`);
    }
    if (answer.answerStatus !== 'supported' && !answer.validationNeeded.trim()) {
      fail(`${answer.answerStatus} answer ${answer.questionId} has no validation need`);
    }
  }

  const riskDisclosures = [...input.requiredRiskDisclosures];
  for (const answer of draft.directAnswers) {
    if (answer.answerStatus === 'supported') continue;
    riskDisclosures.push({
      id: `answer-uncertainty:${answer.questionId}`,
      sourceType: 'answer_uncertainty',
      sourceId: answer.questionId,
      statement: answer.validationNeeded,
      disposition: 'open_question',
    });
  }
  const uniqueRisks = [...new Map(riskDisclosures.map((risk) => [`${risk.sourceType}:${risk.sourceId}`, risk])).values()];
  const limitations = [...draft.limitations];
  const openQuestions = [...draft.openQuestions];
  for (const risk of uniqueRisks) {
    appendUniqueText(risk.disposition === 'limitation' ? limitations : openQuestions, risk.statement);
  }

  const requestedArtifactBindings = unique(input.requirement.requested_artifacts ?? []).map((artifactType) => {
    if (artifactType === 'executive_answers') {
      const evidenceIds = unique(draft.directAnswers.flatMap((answer) => answer.evidenceIds));
      if (draft.directAnswers.length === 0) fail('requested artifact executive_answers is not materialized');
      return {
        artifactType,
        sourceField: '/directAnswers' as const,
        blockIds: draft.directAnswers.map(({ questionId }) => `answer-${questionId}`),
        questionIds: unique(draft.directAnswers.map(({ questionId }) => questionId)),
        evidenceIds,
        status: 'complete' as const,
      };
    }
    const blockIds = contentBlockIdsForArtifact(artifactType, blocks);
    if (blockIds.length === 0) fail(`requested artifact ${artifactType} is not materialized`);
    const selected = blocks.filter(({ id }) => blockIds.includes(id));
    const supports = selected.flatMap(supportForBlock);
    const evidenceIds = unique(supports.flatMap(({ evidenceIds }) => evidenceIds));
    if (evidenceIds.length === 0) fail(`requested artifact ${artifactType} has no Evidence`);
    return {
      artifactType,
      sourceField: '/contentBlocks' as const,
      blockIds,
      questionIds: unique(supports.flatMap(({ questionIds }) => questionIds)),
      evidenceIds,
      status: 'complete' as const,
    };
  });

  const payload: ResearchStrategyReportPayloadV2 = {
    schemaVersion: 'research-strategy-content-v2',
    title: draft.title,
    decisionContext: draft.decisionContext,
    executiveAnswer: draft.executiveAnswer,
    directAnswers: draft.directAnswers,
    evidenceFindings: findings,
    contentBlocks: blocks,
    limitations,
    openQuestions,
    riskDisclosures: uniqueRisks,
    requestedArtifactBindings,
  };
  validator.validateFileOrThrow(PAYLOAD_SCHEMA, payload);
  const graph = graphAndCoverage({
    draft,
    findings,
    blocks,
    problemGraph: input.problemGraph,
    requirement: input.requirement,
    evidenceManifest: input.evidenceManifest,
  });
  const risksAndOpenIssues = unique(uniqueRisks
    .filter(({ sourceType }) => sourceType === 'envelope_risk')
    .map(({ statement }) => statement));
  return {
    version: 'research-deliverable-v1',
    taskId: input.taskId,
    planVersionId: input.planVersionId,
    attemptId: input.attemptId,
    deliverableType: 'research_strategy_report',
    evidenceManifestArtifactId: input.evidenceManifestArtifactId,
    methodSummary: draft.methodSummary,
    findingGraph: graph.findingGraph,
    payload,
    recommendations: graph.recommendations,
    coverage: graph.coverage,
    risksAndOpenIssues,
    capabilityProvenance: input.capabilityProvenance,
  };
}

export function researchStrategyContentDraftFromPayload(
  payload: ResearchStrategyReportPayloadV2,
  methodSummary: string,
): ResearchStrategyContentDraftV2 {
  const contentBlocks: ResearchStrategyContentBlockDraftV2[] = payload.contentBlocks.map((block) => {
    if (block.kind === 'narrative') {
      const { id, ...content } = block;
      return { ...content, key: id };
    }
    if (block.kind === 'comparison_matrix' || block.kind === 'strategy_map') {
      const { id, cells, ...content } = block;
      return {
        ...content,
        key: id,
        cells: cells.map(({ id: cellId, ...cell }) => ({ ...cell, key: cellId })),
      };
    }
    if (block.kind === 'mind_model') {
      const { id, nodes, ...content } = block;
      return {
        ...content,
        key: id,
        nodes: nodes.map(({ id: nodeId, ...node }) => ({ ...node, key: nodeId })),
      };
    }
    if (!('items' in block)) fail(`unsupported content block kind ${(block as { kind?: unknown }).kind as string}`);
    const { id, items, ...content } = block;
    return {
      ...content,
      key: id,
      items: items.map(({ id: itemId, ...item }) => ({ ...item, key: itemId })),
    } as ResearchStrategyContentBlockDraftV2;
  });
  return {
    schemaVersion: 'research-strategy-content-draft-v2',
    title: payload.title,
    decisionContext: payload.decisionContext,
    executiveAnswer: payload.executiveAnswer,
    methodSummary,
    directAnswers: structuredClone(payload.directAnswers),
    evidenceFindings: payload.evidenceFindings.map(({ id, ...finding }) => ({ ...finding, key: id })),
    contentBlocks,
    limitations: [...payload.limitations],
    openQuestions: [...payload.openQuestions],
  };
}

export function isResearchStrategyPayloadV2(value: unknown): value is ResearchStrategyReportPayloadV2 {
  return record(value)?.schemaVersion === 'research-strategy-content-v2';
}
