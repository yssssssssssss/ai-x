import {
  EvidenceGraphValidationError,
  EvidenceService,
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

export class ReportEvidenceValidator {
  constructor(private readonly evidence: EvidenceService) {}

  validate(input: { manifest: EvidenceManifest; report: unknown }): asserts input is { manifest: EvidenceManifest; report: CurrentEvidenceReport } {
    const report = record(input.report);
    if (!report || report.version !== 'current-evidence-report-v1') {
      throw new CurrentReportValidationError('report is not a current evidence report');
    }
    if (
      typeof report.taskId !== 'string'
      || typeof report.researchGoal !== 'string'
      || typeof report.methodSummary !== 'string'
      || !record(report.findingGraph)
      || !Array.isArray(report.recommendations)
      || !Array.isArray(report.risksAndOpenIssues)
    ) {
      throw new CurrentReportValidationError('report shape is invalid');
    }
    const graph = report.findingGraph as unknown as FindingGraph;
    try {
      this.evidence.validateFindingGraph({ manifest: input.manifest, graph });
    } catch (error) {
      if (error instanceof EvidenceGraphValidationError) {
        throw new CurrentReportValidationError(error.message, error);
      }
      throw error;
    }
    const summaries = new Set(graph.subQuestionSummaries.map((summary) => summary.id));
    const recommendationIds = new Set<string>();
    for (const recommendation of report.recommendations) {
      if (!record(recommendation) || typeof recommendation.id !== 'string' || typeof recommendation.statement !== 'string' || !Array.isArray(recommendation.summaryIds)) {
        throw new CurrentReportValidationError('recommendation shape is invalid');
      }
      if (recommendationIds.has(recommendation.id)) throw new CurrentReportValidationError(`duplicate recommendation ${recommendation.id}`);
      recommendationIds.add(recommendation.id);
      if (recommendation.summaryIds.length === 0) throw new CurrentReportValidationError(`recommendation ${recommendation.id} has no summary roots`);
      for (const summaryId of recommendation.summaryIds) {
        if (typeof summaryId !== 'string' || !summaries.has(summaryId)) {
          throw new CurrentReportValidationError(`recommendation ${recommendation.id} references unknown summary ${String(summaryId)}`);
        }
      }
    }
  }
}
