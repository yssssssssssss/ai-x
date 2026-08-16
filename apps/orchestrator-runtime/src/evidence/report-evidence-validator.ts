import type {
  ResearchDeliverableCoverage,
  ResearchDeliverableEnvelope,
} from '../../../../packages/api-contract/research-deliverable.ts';
import { SchemaValidator } from '../schema/validator.ts';
import {
  resolveDeliverableContractById,
  type DeliverableContractResources,
} from '../report/deliverable-registry.ts';

import {
  EvidenceGraphValidationError,
  EvidenceService,
  type EvidenceArtifactResolver,
  type EvidenceManifest,
  type FindingGraph,
} from './evidence-service.ts';

export interface CurrentRecommendation {
  id: string;
  summaryIds: string[];
  statement: string;
}

export interface CurrentEvidenceReport {
  version: 'current-evidence-report-v1';
  taskId: string;
  researchGoal: string;
  methodSummary: string;
  findingGraph: FindingGraph;
  recommendations: CurrentRecommendation[];
  risksAndOpenIssues: string[];
}

export class CurrentReportValidationError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message, { cause });
    this.name = 'CurrentReportValidationError';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function nonEmptyUniqueIds(value: unknown): value is string[] {
  return strings(value)
    && value.length > 0
    && value.every((entry) => entry.trim().length > 0)
    && new Set(value).size === value.length;
}

function nodeIds(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.flatMap((candidate) => {
    const node = record(candidate);
    return node && typeof node.id === 'string' && node.id.trim().length > 0 ? [node.id] : [];
  }));
}

export function validateReportCoverage(reportValue: unknown): ResearchDeliverableCoverage {
  const report = record(reportValue);
  const coverage = record(report?.coverage);
  if (!coverage || !exactKeys(coverage, ['questionBindings', 'successCriterionBindings'])) {
    throw new CurrentReportValidationError('report coverage shape is invalid');
  }
  if (
    !Array.isArray(coverage.questionBindings)
    || coverage.questionBindings.length === 0
    || !Array.isArray(coverage.successCriterionBindings)
    || coverage.successCriterionBindings.length === 0
  ) {
    throw new CurrentReportValidationError('report coverage requires question and success criterion bindings');
  }

  const graph = record(report?.findingGraph);
  const summaries = nodeIds(graph?.subQuestionSummaries);
  const conclusions = nodeIds(graph?.overallConclusions);
  const recommendations = nodeIds(report?.recommendations);
  const questionIds = new Set<string>();
  const questionBindings: ResearchDeliverableCoverage['questionBindings'] = [];
  for (const candidate of coverage.questionBindings) {
    const binding = record(candidate);
    if (
      !binding
      || !exactKeys(binding, ['questionId', 'summaryIds'])
      || typeof binding.questionId !== 'string'
      || binding.questionId.trim().length === 0
      || !nonEmptyUniqueIds(binding.summaryIds)
    ) {
      throw new CurrentReportValidationError('question coverage binding shape is invalid');
    }
    if (questionIds.has(binding.questionId)) {
      throw new CurrentReportValidationError(`duplicate question coverage binding ${binding.questionId}`);
    }
    for (const summaryId of binding.summaryIds) {
      if (!summaries.has(summaryId)) {
        throw new CurrentReportValidationError(`question ${binding.questionId} references unknown summary ${summaryId}`);
      }
    }
    questionIds.add(binding.questionId);
    questionBindings.push({ questionId: binding.questionId, summaryIds: [...binding.summaryIds] });
  }

  const successCriterionIds = new Set<string>();
  const successCriterionBindings: ResearchDeliverableCoverage['successCriterionBindings'] = [];
  for (const candidate of coverage.successCriterionBindings) {
    const binding = record(candidate);
    if (
      !binding
      || !exactKeys(binding, ['successCriterionId', 'conclusionIds', 'recommendationIds'])
      || typeof binding.successCriterionId !== 'string'
      || binding.successCriterionId.trim().length === 0
      || !nonEmptyUniqueIds(binding.conclusionIds)
      || !nonEmptyUniqueIds(binding.recommendationIds)
    ) {
      throw new CurrentReportValidationError('success criterion coverage binding shape is invalid');
    }
    if (successCriterionIds.has(binding.successCriterionId)) {
      throw new CurrentReportValidationError(
        `duplicate success criterion coverage binding ${binding.successCriterionId}`,
      );
    }
    for (const conclusionId of binding.conclusionIds) {
      if (!conclusions.has(conclusionId)) {
        throw new CurrentReportValidationError(
          `success criterion ${binding.successCriterionId} references unknown conclusion ${conclusionId}`,
        );
      }
    }
    for (const recommendationId of binding.recommendationIds) {
      if (!recommendations.has(recommendationId)) {
        throw new CurrentReportValidationError(
          `success criterion ${binding.successCriterionId} references unknown recommendation ${recommendationId}`,
        );
      }
    }
    successCriterionIds.add(binding.successCriterionId);
    successCriterionBindings.push({
      successCriterionId: binding.successCriterionId,
      conclusionIds: [...binding.conclusionIds],
      recommendationIds: [...binding.recommendationIds],
    });
  }

  return { questionBindings, successCriterionBindings };
}

function findingGraph(value: unknown): value is FindingGraph {
  const graph = record(value);
  if (
    !graph
    || !Array.isArray(graph.findings)
    || !Array.isArray(graph.analyses)
    || !Array.isArray(graph.subQuestionSummaries)
    || !Array.isArray(graph.overallConclusions)
  ) return false;

  const findingsValid = graph.findings.every((candidate) => {
    const finding = record(candidate);
    if (!finding || typeof finding.id !== 'string' || typeof finding.statement !== 'string') return false;
    return finding.kind === 'fact'
      ? strings(finding.evidenceIds)
      : finding.kind === 'inference' && strings(finding.findingIds);
  });
  const analysesValid = graph.analyses.every((candidate) => {
    const analysis = record(candidate);
    return !!analysis
      && typeof analysis.id === 'string'
      && typeof analysis.statement === 'string'
      && strings(analysis.findingIds);
  });
  const summariesValid = graph.subQuestionSummaries.every((candidate) => {
    const summary = record(candidate);
    return !!summary
      && typeof summary.id === 'string'
      && typeof summary.summary === 'string'
      && strings(summary.findingIds)
      && strings(summary.analysisIds);
  });
  const conclusionsValid = graph.overallConclusions.every((candidate) => {
    const conclusion = record(candidate);
    return !!conclusion
      && typeof conclusion.id === 'string'
      && typeof conclusion.statement === 'string'
      && strings(conclusion.summaryIds);
  });
  return findingsValid && analysesValid && summariesValid && conclusionsValid;
}

type EvidenceReport = CurrentEvidenceReport | (
  Omit<ResearchDeliverableEnvelope<unknown>, 'coverage'>
  & { coverage?: ResearchDeliverableCoverage }
);

export class ReportEvidenceValidator {
  constructor(
    private readonly evidence: Pick<EvidenceService, 'validateFindingGraph'>,
    private readonly schemas: Pick<SchemaValidator, 'validateSchemaOrThrow'> = new SchemaValidator(),
  ) {}

  validate(input: {
    manifest: EvidenceManifest;
    report: unknown;
    resolver: EvidenceArtifactResolver;
    requireCoverage?: boolean;
    validatePayloadSchema?: boolean;
  }): asserts input is {
    manifest: EvidenceManifest;
    report: EvidenceReport;
    resolver: EvidenceArtifactResolver;
    requireCoverage?: boolean;
  } {
    const report = record(input.report);
    if (!report) {
      throw new CurrentReportValidationError('report is not a current evidence report');
    }
    const isCurrentEvidenceReport = report.version === 'current-evidence-report-v1';
    let deliverableContract: DeliverableContractResources | null = null;
    if (!isCurrentEvidenceReport) {
      if (typeof report.deliverableType !== 'string' || !report.deliverableType) {
        throw new CurrentReportValidationError('report deliverableType is invalid');
      }
      try {
        deliverableContract = resolveDeliverableContractById(report.deliverableType);
      } catch (error) {
        throw new CurrentReportValidationError(
          `report deliverable contract is invalid: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error : undefined,
        );
      }
      if (report.deliverableType !== deliverableContract.entry.id) {
        throw new CurrentReportValidationError('report deliverableType does not match the active Registry contract');
      }
      if (report.version !== deliverableContract.entry.envelope_version) {
        throw new CurrentReportValidationError('report version does not match the active deliverable contract');
      }
    }
    const isDeliverable = deliverableContract !== null;
    if (
      typeof report.taskId !== 'string'
      || typeof report.methodSummary !== 'string'
      || !Array.isArray(report.recommendations)
      || report.recommendations.length === 0
      || !strings(report.risksAndOpenIssues)
      || (!isDeliverable && typeof report.researchGoal !== 'string')
      || (isDeliverable && (
        typeof report.planVersionId !== 'string'
        || typeof report.attemptId !== 'string'
        || typeof report.deliverableType !== 'string'
        || !report.deliverableType
        || typeof report.evidenceManifestArtifactId !== 'string'
        || !Object.hasOwn(report, 'payload')
        || !Array.isArray(report.capabilityProvenance)
        || !report.capabilityProvenance.every((candidate) => {
          const provenance = record(candidate);
          return !!provenance
            && typeof provenance.id === 'string'
            && typeof provenance.type === 'string';
        })
      ))
    ) {
      throw new CurrentReportValidationError('report shape is invalid');
    }
    if (deliverableContract && input.validatePayloadSchema === true) {
      try {
        const payloadSchema = Object.fromEntries(
          Object.entries(deliverableContract.payloadSchema)
            .filter(([key]) => key !== '$schema' && key !== '$id'),
        );
        this.schemas.validateSchemaOrThrow(
          payloadSchema,
          report.payload,
          `${deliverableContract.entry.id} payload`,
        );
      } catch (error) {
        throw new CurrentReportValidationError(
          `report payload does not match the active deliverable contract: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error : undefined,
        );
      }
    }
    if (report.taskId !== input.manifest.taskId) {
      throw new CurrentReportValidationError('report taskId does not match evidence manifest');
    }
    if (isDeliverable && report.planVersionId !== input.manifest.planVersionId) {
      throw new CurrentReportValidationError('report planVersionId does not match evidence manifest');
    }
    if (isDeliverable && report.attemptId !== input.manifest.attemptId) {
      throw new CurrentReportValidationError('report attemptId does not match evidence manifest');
    }
    if (!findingGraph(report.findingGraph)) {
      throw new CurrentReportValidationError('finding graph shape is invalid');
    }
    const graph = report.findingGraph;
    if (
      graph.findings.length === 0
      || !graph.findings.some((finding) => finding.kind === 'fact')
      || graph.analyses.length === 0
      || graph.subQuestionSummaries.length === 0
      || graph.overallConclusions.length === 0
    ) {
      throw new CurrentReportValidationError('finding graph requires fact, analysis, summary, and conclusion roots');
    }
    try {
      this.evidence.validateFindingGraph({ manifest: input.manifest, graph, resolver: input.resolver });
    } catch (error) {
      if (error instanceof EvidenceGraphValidationError) {
        throw new CurrentReportValidationError(error.message, error);
      }
      throw error;
    }
    const summaries = new Set(graph.subQuestionSummaries.map((summary) => summary.id));
    const recommendationIds = new Set<string>();
    for (const recommendation of report.recommendations) {
      if (
        !record(recommendation)
        || typeof recommendation.id !== 'string'
        || typeof recommendation.statement !== 'string'
        || !strings(recommendation.summaryIds)
      ) {
        throw new CurrentReportValidationError('recommendation shape is invalid');
      }
      if (recommendationIds.has(recommendation.id)) throw new CurrentReportValidationError(`duplicate recommendation ${recommendation.id}`);
      recommendationIds.add(recommendation.id);
      if (recommendation.summaryIds.length === 0) throw new CurrentReportValidationError(`recommendation ${recommendation.id} has no summary roots`);
      for (const summaryId of recommendation.summaryIds) {
        if (!summaries.has(summaryId)) {
          throw new CurrentReportValidationError(`recommendation ${recommendation.id} references unknown summary ${summaryId}`);
        }
      }
    }
    if (input.requireCoverage || report.coverage !== undefined) validateReportCoverage(report);
  }
}
