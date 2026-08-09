import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EvidenceService, type EvidenceManifest, type FindingGraph } from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import {
  CurrentReportValidationError,
  ReportEvidenceValidator,
  type CurrentEvidenceReport,
} from '../apps/orchestrator-runtime/src/evidence/report-evidence-validator.ts';

const evidenceService = new EvidenceService();
const manifest: EvidenceManifest = evidenceService.createManifest({
  taskId: 'task-1',
  planVersionId: 'plan-1',
  attemptId: 'attempt-1',
  collectedAt: '2026-08-09T00:00:00.000Z',
  entries: [{
    id: 'E1',
    kind: 'tool_output',
    evidenceClass: 'public_source',
    artifactHash: 'sha256:output',
    jsonPointer: '/results/0',
    sourceUrl: 'https://example.test/source',
    stepNo: 1,
    toolProof: { implementationId: 'tavily', executionMode: 'real', outputHash: 'sha256:output' },
    sensitivity: 'public',
    redaction: 'masked',
  }],
});

const graph: FindingGraph = {
  findings: [{ id: 'F1', kind: 'fact', evidenceIds: ['E1'], statement: '公开来源支持该事实' }],
  analyses: [{ id: 'A1', findingIds: ['F1'], statement: '基于事实的分析' }],
  subQuestionSummaries: [{ id: 'S1', findingIds: ['F1'], analysisIds: ['A1'], summary: '问题小结' }],
  overallConclusions: [{ id: 'C1', summaryIds: ['S1'], statement: '总体结论' }],
};

function report(): CurrentEvidenceReport {
  return {
    version: 'current-evidence-report-v1',
    taskId: 'task-1',
    researchGoal: '验证报告合同',
    methodSummary: '公开网页检索',
    findingGraph: graph,
    recommendations: [{ id: 'R1', summaryIds: ['S1'], statement: '建议继续验证' }],
    risksAndOpenIssues: [],
  };
}

test('accepts a current report rooted in valid evidence and finding graph', () => {
  const validator = new ReportEvidenceValidator(evidenceService);
  assert.doesNotThrow(() => validator.validate({ manifest, report: report() }));
});

test('rejects recommendations and conclusions without summary roots', () => {
  const validator = new ReportEvidenceValidator(evidenceService);
  const invalid = report();
  invalid.recommendations = [{ id: 'R1', summaryIds: [], statement: '无根建议' }];
  assert.throws(() => validator.validate({ manifest, report: invalid }), CurrentReportValidationError);
});

test('rejects legacy report shapes from the current evidence contract', () => {
  const validator = new ReportEvidenceValidator(evidenceService);
  assert.throws(
    () => validator.validate({ manifest, report: { findings: [{ source_ref: 'https://example.test' }] } }),
    CurrentReportValidationError,
  );
});
