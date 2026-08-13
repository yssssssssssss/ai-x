import type { ResearchDeliverableEnvelope } from '../../../../packages/api-contract/research-deliverable.ts';

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

type EvidenceReport = CurrentEvidenceReport | ResearchDeliverableEnvelope<unknown>;

export class ReportEvidenceValidator {
  constructor(private readonly evidence: Pick<EvidenceService, 'validateFindingGraph'>) {}

  validate(input: {
    manifest: EvidenceManifest;
    report: unknown;
    resolver: EvidenceArtifactResolver;
  }): asserts input is {
    manifest: EvidenceManifest;
    report: EvidenceReport;
    resolver: EvidenceArtifactResolver;
  } {
    const report = record(input.report);
    if (
      !report
      || (report.version !== 'current-evidence-report-v1' && report.version !== 'research-deliverable-v1')
    ) {
      throw new CurrentReportValidationError('report is not a current evidence report');
    }
    const isDeliverable = report.version === 'research-deliverable-v1';
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
        || report.deliverableType !== 'research_plan'
        || typeof report.evidenceManifestArtifactId !== 'string'
        || !record(report.payload)
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
  }
}
