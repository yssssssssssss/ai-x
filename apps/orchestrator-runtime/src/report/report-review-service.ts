import type { ControlExecutionLease } from '../../../../database/control-plane.ts';
import {
  ANSWER_QUALITY_REVIEW_DIMENSION_IDS,
  REPORT_REVIEW_DIMENSION_IDS,
  REPORT_REVIEW_V2_DIMENSION_IDS,
  type ReportReviewArtifact,
  type ReportReviewDimension,
  type ReportReviewDimensionId,
} from '../../../../packages/api-contract/control-workflow.ts';
import type { ResearchTaskV2 } from '../../../../packages/api-contract/plan.ts';
export type {
  ReportReviewArtifact,
  ReportReviewDimension,
  ReportReviewDimensionId,
  ReportReviewVerdict,
} from '../../../../packages/api-contract/control-workflow.ts';
import type { ArtifactWriteInput } from '../control/artifact-store.ts';
import { redactSensitiveValue } from '../runtime/redaction.ts';
import type { LLMResult, StructuredLLMCallOptions } from '../runtime/llm-client.ts';
import { SchemaValidator } from '../schema/validator.ts';
import {
  CurrentReportValidationError,
  validateReportCoverage,
} from '../evidence/report-evidence-validator.ts';
import {
  resolveDeliverableContractById,
  type DeliverableContractResources,
} from './deliverable-registry.ts';


export interface ReportReviewResult extends ReportReviewArtifact {
  status: 'completed' | 'paused';
  artifactId: string;
}

export interface ReportReviewLlm {
  generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>>;
}

export interface ReportReviewEvidence {
  validate?(input: {
    taskId: string;
    planVersionId: string;
    attemptId: string;
    deliverable: unknown;
    evidenceIds: readonly string[];
  }): void | Promise<void>;
}

export interface DeliverableComposer {
  revise(input: {
    taskId: string;
    planVersionId: string;
    attemptId: string;
    deliverable: unknown;
    review: ReportReviewArtifact;
    revisionRound: 1;
    activeLease: ControlExecutionLease;
  }): Promise<{ deliverable: unknown; deliverableArtifactId: string }>;
}

export interface ReportReviewInput {
  task: { id: string };
  plan: { id: string };
  attempt: { id: string };
  deliverableArtifactId: string;
  deliverable: unknown;
  successCriterionIds: readonly string[];
  questionIds: readonly string[];
  evidenceIds: readonly string[];
  requirement?: ResearchTaskV2;
  expectedModel: string;
  activeLease: ControlExecutionLease;
  revisionRound?: 0 | 1;
}

interface ReviewArtifactWriter {
  writeJson(input: ArtifactWriteInput): Promise<{ id: string; state: string }>;
}

interface ReviewDependencies {
  llm: ReportReviewLlm;
  artifacts: ReviewArtifactWriter;
  evidence?: ReportReviewEvidence;
  composer?: DeliverableComposer;
  validator?: Pick<SchemaValidator, 'validateOrThrow'>;
}

const REPORT_REVIEW_VALIDATOR = new SchemaValidator();

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function issueText(value: unknown): string {
  if (typeof value === 'string') return value;
  const candidate = record(value);
  for (const key of ['message', 'issue', 'statement', 'rationale']) {
    if (typeof candidate?.[key] === 'string' && candidate[key].trim()) return candidate[key] as string;
  }
  return JSON.stringify(redactSensitiveValue(value));
}

function activeDeliverableContract(deliverable: unknown): DeliverableContractResources {
  const value = record(deliverable);
  if (!value || typeof value.deliverableType !== 'string' || !value.deliverableType) {
    throw new Error('review deliverable has no Registry deliverableType');
  }
  const contract = resolveDeliverableContractById(value.deliverableType);
  if (value.deliverableType !== contract.entry.id) {
    throw new Error('review deliverableType does not match its active Registry contract');
  }
  if (value.version !== contract.entry.envelope_version) {
    throw new Error('review deliverable version does not match its active Registry contract');
  }
  return contract;
}

const REPORT_REVIEW_DIMENSION_ID_SET: ReadonlySet<string> = new Set(
  REPORT_REVIEW_V2_DIMENSION_IDS,
);

function reviewDimensionIds(version: ReportReviewArtifact['version']): readonly ReportReviewDimensionId[] {
  return version === 'report-review-v2' ? REPORT_REVIEW_V2_DIMENSION_IDS : REPORT_REVIEW_DIMENSION_IDS;
}

export function assertReportReviewInvariant(
  review: Pick<ReportReviewArtifact, 'version' | 'verdict' | 'dimensions'>,
): void {
  const requiredDimensionIds = reviewDimensionIds(review.version);
  if (review.dimensions.length !== requiredDimensionIds.length) {
    throw new Error('Review dimensions must contain every required dimension exactly once');
  }
  const seen = new Set<ReportReviewDimensionId>();
  for (const dimension of review.dimensions) {
    if (!requiredDimensionIds.includes(dimension.id) || !REPORT_REVIEW_DIMENSION_ID_SET.has(dimension.id) || seen.has(dimension.id)) {
      throw new Error('Review dimensions must contain every required dimension exactly once');
    }
    seen.add(dimension.id);
    if (review.verdict === 'pass' && (!dimension.passed || dimension.issues.length !== 0)) {
      throw new Error('Review verdict pass requires every dimension to pass without issues');
    }
  }
}

export function assertValidReportReviewArtifact(
  review: unknown,
  validator: Pick<SchemaValidator, 'validateOrThrow'> = REPORT_REVIEW_VALIDATOR,
): asserts review is ReportReviewArtifact {
  validator.validateOrThrow('report-review', review);
  assertReportReviewInvariant(review as ReportReviewArtifact);
}


function issueDimension(id: ReportReviewDimensionId, issues: string[]): ReportReviewDimension {
  return { id, passed: issues.length === 0, issues };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US');
}

function answerQualityDimensionIssues(
  input: ReportReviewInput,
  report: Record<string, unknown>,
  issues: Record<ReportReviewDimensionId, string[]>,
): void {
  const payload = record(report.payload);
  if (!payload) {
    for (const id of ANSWER_QUALITY_REVIEW_DIMENSION_IDS) issues[id].push('research strategy payload must be an object');
    return;
  }
  const answers = Array.isArray(payload.directAnswers) ? payload.directAnswers.map(record).filter(Boolean) as Record<string, unknown>[] : [];
  const answersByQuestion = new Map(answers.map((answer) => [String(answer.questionId ?? ''), answer]));
  for (const questionId of input.questionIds) {
    const answer = answersByQuestion.get(questionId);
    if (!answer || answer.answerStatus === 'unanswered' || !nonEmptyString(answer.answer)) {
      issues.direct_answer_coverage.push(`required question ${questionId} has no direct answer`);
    }
  }
  const knownEvidence = new Set(input.evidenceIds);
  for (const answer of answers) {
    const questionId = String(answer.questionId ?? '');
    const evidenceIds = Array.isArray(answer.evidenceIds) ? answer.evidenceIds : [];
    if (answer.answerStatus === 'supported' && evidenceIds.length === 0) {
      issues.answer_evidence_strength.push(`supported answer ${questionId} has no evidence`);
    }
    for (const evidenceId of evidenceIds) {
      if (typeof evidenceId !== 'string' || !knownEvidence.has(evidenceId)) {
        issues.answer_evidence_strength.push(`answer ${questionId} references unknown evidence`);
      }
    }
    if (!nonEmptyString(answer.businessImplication) || !nonEmptyString(answer.recommendedAction)) {
      issues.decision_usefulness.push(`answer ${questionId} lacks a business implication or action`);
    }
    if (
      (answer.answerStatus !== 'supported' && answer.answerStatus !== 'provisional' && answer.answerStatus !== 'unanswered')
      || (answer.answerStatus !== 'supported' && !nonEmptyString(answer.validationNeeded))
    ) {
      issues.hypothesis_conclusion_clarity.push(`answer ${questionId} has an invalid status or validation need`);
    }
  }
  const actions = Array.isArray(payload.prioritizedActions) ? payload.prioritizedActions.map(record).filter(Boolean) as Record<string, unknown>[] : [];
  if (actions.length === 0) issues.decision_usefulness.push('prioritized actions are missing');
  for (const action of actions) {
    if (!nonEmptyString(action.action) || !nonEmptyString(action.ownerType) || !nonEmptyString(action.validationMethod)) {
      issues.decision_usefulness.push(`prioritized action ${String(action.id ?? '')} is not actionable`);
    }
  }
  const bindings = Array.isArray(payload.requestedArtifactBindings)
    ? payload.requestedArtifactBindings.map(record).filter(Boolean) as Record<string, unknown>[]
    : [];
  const bindingByType = new Map(bindings.map((binding) => [String(binding.artifactType ?? ''), binding]));
  if (!input.requirement) {
    issues.requested_artifact_presence.push('finalized requirement is required for answer review');
  } else {
    for (const artifact of input.requirement.requested_artifacts ?? []) {
      const binding = bindingByType.get(artifact);
      if (!binding || binding.status !== 'complete' || !Array.isArray(binding.blockIds) || binding.blockIds.length === 0) {
        issues.requested_artifact_presence.push(`requested artifact ${artifact} is missing or incomplete`);
      }
    }
  }

  const disclosures = Array.isArray(payload.riskDisclosures)
    ? payload.riskDisclosures.map(record).filter(Boolean) as Record<string, unknown>[]
    : [];
  const limitations = Array.isArray(payload.limitations) ? payload.limitations.filter(nonEmptyString).map(normalizedText) : [];
  const openQuestions = Array.isArray(payload.openQuestions) ? payload.openQuestions.filter(nonEmptyString).map(normalizedText) : [];
  const identities = new Set<string>();
  for (const disclosure of disclosures) {
    const identity = `${String(disclosure.sourceType ?? '')}:${String(disclosure.sourceId ?? '')}`;
    if (identities.has(identity)) issues.risk_consistency.push(`duplicate risk identity ${identity}`);
    identities.add(identity);
    if (!nonEmptyString(disclosure.statement)) {
      issues.risk_consistency.push(`risk disclosure ${identity} has no statement`);
      continue;
    }
    const destination = disclosure.disposition === 'open_question' ? openQuestions : limitations;
    if (!destination.includes(normalizedText(disclosure.statement))) {
      issues.risk_consistency.push(`risk disclosure ${identity} is absent from its report destination`);
    }
  }
  const envelopeRisks = Array.isArray(report.risksAndOpenIssues) ? report.risksAndOpenIssues.filter(nonEmptyString) : [];
  for (const risk of envelopeRisks) {
    const matching = disclosures.find((disclosure) => (
      disclosure.sourceType === 'envelope_risk'
      && nonEmptyString(disclosure.statement)
      && normalizedText(disclosure.statement) === normalizedText(risk)
    ));
    if (!matching) issues.risk_consistency.push(`envelope risk is omitted: ${risk}`);
  }
  for (const ambiguity of input.requirement?.ambiguities ?? []) {
    const identity = `requirement_ambiguity:${ambiguity.id}`;
    const matching = disclosures.find((disclosure) => `${String(disclosure.sourceType ?? '')}:${String(disclosure.sourceId ?? '')}` === identity);
    if (!matching || !nonEmptyString(matching.statement) || normalizedText(matching.statement) !== normalizedText(ambiguity.statement)) {
      issues.risk_consistency.push(`requirement ambiguity is omitted: ${ambiguity.id}`);
    }
  }
}

function deterministicDimensions(
  input: ReportReviewInput,
  deliverable: unknown,
  dimensionIds: readonly ReportReviewDimensionId[],
): ReportReviewDimension[] {
  const issues = Object.fromEntries(
    REPORT_REVIEW_V2_DIMENSION_IDS.map((id) => [id, [] as string[]]),
  ) as Record<ReportReviewDimensionId, string[]>;
  const report = record(deliverable);
  if (!report) {
    issues.reasoning_quality.push('deliverable must be an object');
    return dimensionIds.map((id) => issueDimension(id, issues[id]));
  }
  if (report.taskId !== input.task.id) issues.reasoning_quality.push('deliverable task identity mismatch');
  if (report.planVersionId !== input.plan.id) issues.reasoning_quality.push('deliverable plan identity mismatch');
  if (report.attemptId !== input.attempt.id) issues.reasoning_quality.push('deliverable attempt identity mismatch');

  const graph = record(report.findingGraph);
  const findings = Array.isArray(graph?.findings) ? graph.findings : [];
  const analyses = Array.isArray(graph?.analyses) ? graph.analyses : [];
  const summaries = Array.isArray(graph?.subQuestionSummaries) ? graph.subQuestionSummaries : [];
  const conclusions = Array.isArray(graph?.overallConclusions) ? graph.overallConclusions : [];
  if (findings.length === 0 || !findings.some((entry) => record(entry)?.kind === 'fact')) issues.evidence_coverage.push('finding graph requires a fact root');
  if (analyses.length === 0) issues.reasoning_quality.push('finding graph requires an analysis root');
  if (summaries.length === 0) issues.reasoning_quality.push('finding graph requires a summary root');
  if (conclusions.length === 0) issues.reasoning_quality.push('finding graph requires a conclusion root');

  const knownEvidence = new Set(input.evidenceIds);
  try {
    const coverage = validateReportCoverage(report);
    const coveredSuccessCriteria = new Set(
      coverage.successCriterionBindings.map((binding) => binding.successCriterionId),
    );
    const coveredQuestions = new Set(
      coverage.questionBindings.map((binding) => binding.questionId),
    );
    for (const successCriterionId of input.successCriterionIds) {
      if (!coveredSuccessCriteria.has(successCriterionId)) {
        issues.requirement_coverage.push(`missing success criterion ${successCriterionId}`);
      }
    }
    for (const questionId of input.questionIds) {
      if (!coveredQuestions.has(questionId)) {
        issues.question_coverage.push(`missing question ${questionId}`);
      }
    }
  } catch (error) {
    if (!(error instanceof CurrentReportValidationError)) throw error;
    issues.requirement_coverage.push(error.message);
    issues.question_coverage.push(error.message);
  }
  for (const finding of findings) {
    const value = record(finding);
    if (value?.kind !== 'fact') continue;
    const findingEvidence = Array.isArray(value.evidenceIds) ? value.evidenceIds : [];
    if (findingEvidence.length === 0) issues.evidence_coverage.push(`fact ${String(value.id ?? '')} has no evidence`);
    for (const evidenceId of findingEvidence) if (typeof evidenceId !== 'string' || !knownEvidence.has(evidenceId)) issues.evidence_coverage.push(`fact ${String(value.id ?? '')} references unknown evidence`);
  }
  const recommendations = Array.isArray(report.recommendations) ? report.recommendations : [];
  const summaryIds = new Set(summaries.map((entry) => record(entry)?.id).filter((id): id is string => typeof id === 'string'));
  if (recommendations.length === 0) issues.recommendation_quality.push('at least one recommendation is required');
  for (const recommendation of recommendations) {
    const value = record(recommendation);
    const roots = Array.isArray(value?.summaryIds) ? value.summaryIds : [];
    if (roots.length === 0) issues.recommendation_quality.push(`recommendation ${String(value?.id ?? '')} has no summary root`);
    for (const summaryId of roots) if (typeof summaryId !== 'string' || !summaryIds.has(summaryId)) issues.recommendation_quality.push(`recommendation ${String(value?.id ?? '')} references unknown summary`);
  }
  if (dimensionIds.includes('direct_answer_coverage')) answerQualityDimensionIssues(input, report, issues);
  return dimensionIds.map((id) => issueDimension(id, issues[id]));
}

function deterministicFailure(dimensions: readonly ReportReviewDimension[]): boolean {
  const blocking = new Set<ReportReviewDimensionId>([
    'requirement_coverage',
    'question_coverage',
    'evidence_coverage',
    'reasoning_quality',
    'recommendation_quality',
    ...ANSWER_QUALITY_REVIEW_DIMENSION_IDS,
  ]);
  return dimensions.some((dimension) => blocking.has(dimension.id) && !dimension.passed);
}

function assertRubricDimensionContract(
  contract: DeliverableContractResources,
  requiredDimensionIds: readonly ReportReviewDimensionId[],
): void {
  const rubric = record(contract.reviewRubric);
  const dimensions = Array.isArray(rubric?.dimensions) ? rubric.dimensions.map(record).filter(Boolean) as Record<string, unknown>[] : [];
  const ids = dimensions.map(({ id }) => id);
  if (
    ids.length !== requiredDimensionIds.length
    || ids.some((id, index) => id !== requiredDimensionIds[index])
    || dimensions.some(({ required }) => required !== true)
  ) throw new Error(`review rubric ${contract.entry.id} does not match ${requiredDimensionIds.length}-dimension review contract`);
}

export class ReportReviewService {
  private readonly validator: Pick<SchemaValidator, 'validateOrThrow'>;

  constructor(private readonly dependencies: ReviewDependencies) {
    this.validator = dependencies.validator ?? new SchemaValidator();
  }

  async review(input: ReportReviewInput, composerOverride?: DeliverableComposer): Promise<ReportReviewResult> {
    if (input.activeLease.taskId !== input.task.id || input.activeLease.planVersionId !== input.plan.id || input.activeLease.attemptId !== input.attempt.id) throw new Error('review lease identity does not match input');
    const contract = activeDeliverableContract(input.deliverable);
    const reviewVersion: ReportReviewArtifact['version'] = contract.entry.id === 'research_strategy_report'
      ? 'report-review-v2'
      : 'report-review-v1';
    const requiredDimensionIds = reviewDimensionIds(reviewVersion);
    if (reviewVersion === 'report-review-v2') assertRubricDimensionContract(contract, requiredDimensionIds);
    const round = input.revisionRound ?? 0;
    const dimensions = deterministicDimensions(input, input.deliverable, requiredDimensionIds);
    if (this.dependencies.evidence?.validate && !deterministicFailure(dimensions)) await this.dependencies.evidence.validate({
      taskId: input.task.id, planVersionId: input.plan.id, attemptId: input.attempt.id,
      deliverable: input.deliverable, evidenceIds: input.evidenceIds,
    });
    if (deterministicFailure(dimensions)) return this.seal(input, {
      version: reviewVersion, taskId: input.task.id, planVersionId: input.plan.id,
      attemptId: input.attempt.id, deliverableArtifactId: input.deliverableArtifactId,
      verdict: 'block', dimensions, revisionRound: round,
    }, 'paused');
    const artifact = await this.semanticReview(input, dimensions, round, contract, reviewVersion, requiredDimensionIds);
    if (artifact.verdict === 'pass') return this.seal(input, artifact, 'completed');
    const composer = composerOverride ?? this.dependencies.composer;
    if (artifact.verdict === 'block' || round === 1 || !composer) return this.seal(input, artifact, 'paused');
    const revised = await composer.revise({
      taskId: input.task.id, planVersionId: input.plan.id, attemptId: input.attempt.id,
      deliverable: input.deliverable, review: artifact, revisionRound: 1, activeLease: input.activeLease,
    });
    return this.review({ ...input, deliverable: revised.deliverable, deliverableArtifactId: revised.deliverableArtifactId, revisionRound: 1 }, composerOverride);
  }

  private async semanticReview(
    input: ReportReviewInput,
    dimensions: ReportReviewDimension[],
    revisionRound: 0 | 1,
    contract: DeliverableContractResources,
    reviewVersion: ReportReviewArtifact['version'],
    requiredDimensionIds: readonly ReportReviewDimensionId[],
  ): Promise<ReportReviewArtifact> {
    const generated = await this.dependencies.llm.generateStructured<Partial<ReportReviewArtifact>>({
      prompt: `Review the current deliverable against the selected Registry review rubric. Return only a ${reviewVersion} artifact with every required dimension exactly once.`,
      // An empty override makes the gateway load the canonical registry schema.
      schema: {},
      schemaName: 'report-review',
      context: {
        taskId: input.task.id, planVersionId: input.plan.id, attemptId: input.attempt.id,
        deliverable: redactSensitiveValue(input.deliverable), deterministicDimensions: dimensions,
        deliverableContractId: contract.entry.id,
        reviewRubric: contract.reviewRubric,
      },
      receipt: { stage: 'deliverable_review', attemptId: input.attempt.id, expectedModel: input.expectedModel },
    });
    const value = record(generated.data);
    if (!value || (value.verdict !== 'pass' && value.verdict !== 'revise' && value.verdict !== 'block') || !Array.isArray(value.dimensions)) throw new Error('review output is missing required fields');
    const deterministicById = new Map(dimensions.map((dimension) => [dimension.id, dimension]));
    const projectedDimensions = value.dimensions.map((dimension) => {
      const candidate = record(dimension);
      if (!candidate) return dimension;
      const baseline = typeof candidate.id === 'string'
        ? deterministicById.get(candidate.id as ReportReviewDimensionId)
        : undefined;
      const providedIssues = Array.isArray(candidate.issues) ? candidate.issues.map(issueText) : null;
      const proposedPassed = typeof candidate.passed === 'boolean'
        ? candidate.passed
        : providedIssues
          ? providedIssues.length === 0
          : baseline?.passed ?? false;
      const issues = providedIssues
        ?? baseline?.issues
        ?? (proposedPassed ? [] : ['semantic review did not provide dimension issues']);
      const passed = proposedPassed && issues.length === 0;
      return { id: candidate.id, passed, issues };
    });
    const allDimensionsPass = projectedDimensions.length === requiredDimensionIds.length
      && projectedDimensions.every((dimension) => dimension.passed && dimension.issues.length === 0);
    const normalizedVerdict = value.verdict === 'pass' && !allDimensionsPass
      ? 'revise'
      : value.verdict;
    const artifact: ReportReviewArtifact = {
      version: reviewVersion, taskId: input.task.id, planVersionId: input.plan.id,
      attemptId: input.attempt.id, deliverableArtifactId: input.deliverableArtifactId,
      verdict: normalizedVerdict, dimensions: projectedDimensions as ReportReviewDimension[], revisionRound,
    };
    this.validator.validateOrThrow('report-review', artifact);
    assertReportReviewInvariant(artifact);
    return artifact;
  }

  private async seal(input: ReportReviewInput, artifact: ReportReviewArtifact, status: 'completed' | 'paused'): Promise<ReportReviewResult> {
    this.validator.validateOrThrow('report-review', artifact);
    assertReportReviewInvariant(artifact);
    const sealed = await this.dependencies.artifacts.writeJson({
      taskId: input.task.id, planVersionId: input.plan.id, attemptId: input.attempt.id,
      kind: 'report_review', relativePath: `reports/review-r${artifact.revisionRound}.json`, value: artifact,
      schemaVersion: artifact.version, sensitivity: 'internal', redactionPolicyVersion: 'v1', activeLease: input.activeLease,
    });
    if (sealed.state !== 'SEALED') throw new Error('review artifact was not sealed');
    return { ...artifact, status, artifactId: sealed.id };
  }
}
