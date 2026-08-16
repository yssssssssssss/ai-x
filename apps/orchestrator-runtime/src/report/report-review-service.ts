import type { ControlExecutionLease } from '../../../../database/control-plane.ts';
import {
  REPORT_REVIEW_DIMENSION_IDS,
  type ReportReviewArtifact,
  type ReportReviewDimension,
  type ReportReviewDimensionId,
} from '../../../../packages/api-contract/control-workflow.ts';
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

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['version', 'taskId', 'planVersionId', 'attemptId', 'deliverableArtifactId', 'verdict', 'dimensions', 'revisionRound'],
};

const REPORT_REVIEW_VALIDATOR = new SchemaValidator();

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
  REPORT_REVIEW_DIMENSION_IDS,
);

export function assertReportReviewInvariant(
  review: Pick<ReportReviewArtifact, 'verdict' | 'dimensions'>,
): void {
  if (review.dimensions.length !== REPORT_REVIEW_DIMENSION_IDS.length) {
    throw new Error('Review dimensions must contain every required dimension exactly once');
  }
  const seen = new Set<ReportReviewDimensionId>();
  for (const dimension of review.dimensions) {
    if (!REPORT_REVIEW_DIMENSION_ID_SET.has(dimension.id) || seen.has(dimension.id)) {
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

function deterministicDimensions(input: ReportReviewInput, deliverable: unknown): ReportReviewDimension[] {
  const issues: Record<ReportReviewDimensionId, string[]> = {
    requirement_coverage: [],
    question_coverage: [],
    evidence_coverage: [],
    reasoning_quality: [],
    recommendation_quality: [],
    visual_quality: [],
    risk_disclosure: [],
  };
  const report = record(deliverable);
  if (!report) {
    issues.reasoning_quality.push('deliverable must be an object');
    return REPORT_REVIEW_DIMENSION_IDS.map((id) => issueDimension(id, issues[id]));
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
  return REPORT_REVIEW_DIMENSION_IDS.map((id) => issueDimension(id, issues[id]));
}

function deterministicFailure(dimensions: readonly ReportReviewDimension[]): boolean {
  return dimensions.some((dimension) => (
    dimension.id === 'requirement_coverage' || dimension.id === 'question_coverage'
      || dimension.id === 'evidence_coverage' || dimension.id === 'reasoning_quality'
      || dimension.id === 'recommendation_quality'
  ) && !dimension.passed);
}

export class ReportReviewService {
  private readonly validator: Pick<SchemaValidator, 'validateOrThrow'>;

  constructor(private readonly dependencies: ReviewDependencies) {
    this.validator = dependencies.validator ?? new SchemaValidator();
  }

  async review(input: ReportReviewInput, composerOverride?: DeliverableComposer): Promise<ReportReviewResult> {
    if (input.activeLease.taskId !== input.task.id || input.activeLease.planVersionId !== input.plan.id || input.activeLease.attemptId !== input.attempt.id) throw new Error('review lease identity does not match input');
    const contract = activeDeliverableContract(input.deliverable);
    const round = input.revisionRound ?? 0;
    const dimensions = deterministicDimensions(input, input.deliverable);
    if (this.dependencies.evidence?.validate && !deterministicFailure(dimensions)) await this.dependencies.evidence.validate({
      taskId: input.task.id, planVersionId: input.plan.id, attemptId: input.attempt.id,
      deliverable: input.deliverable, evidenceIds: input.evidenceIds,
    });
    if (deterministicFailure(dimensions)) return this.seal(input, {
      version: 'report-review-v1', taskId: input.task.id, planVersionId: input.plan.id,
      attemptId: input.attempt.id, deliverableArtifactId: input.deliverableArtifactId,
      verdict: 'block', dimensions, revisionRound: round,
    }, 'paused');
    const artifact = await this.semanticReview(input, dimensions, round, contract);
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
  ): Promise<ReportReviewArtifact> {
    const generated = await this.dependencies.llm.generateStructured<Partial<ReportReviewArtifact>>({
      prompt: 'Review the current deliverable against the selected Registry review rubric. Return only a report-review-v1 artifact.',
      schema: REVIEW_SCHEMA,
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
    const artifact: ReportReviewArtifact = {
      version: 'report-review-v1', taskId: input.task.id, planVersionId: input.plan.id,
      attemptId: input.attempt.id, deliverableArtifactId: input.deliverableArtifactId,
      verdict: value.verdict, dimensions: value.dimensions as ReportReviewDimension[], revisionRound,
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
      schemaVersion: 'report-review-v1', sensitivity: 'internal', redactionPolicyVersion: 'v1', activeLease: input.activeLease,
    });
    if (sealed.state !== 'SEALED') throw new Error('review artifact was not sealed');
    return { ...artifact, status, artifactId: sealed.id };
  }
}
