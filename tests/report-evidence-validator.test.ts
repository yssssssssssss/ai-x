import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EvidenceService,
  type EvidenceArtifactResolver,
  type EvidenceManifest,
  type FindingGraph,
} from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import {
  CurrentReportValidationError,
  ReportEvidenceValidator,
  type CurrentEvidenceReport,
} from '../apps/orchestrator-runtime/src/evidence/report-evidence-validator.ts';

const evidenceService = new EvidenceService();
const artifactId = 'artifact-report-source-1';
const artifactContentSha256 = `sha256:${'4'.repeat(64)}`;
const sourceUrl = 'https://example.test/source';
const artifactOutput = { results: [{ title: 'source', url: sourceUrl }] };
const redactedOutputHash = `sha256:${createHash('sha256').update(JSON.stringify(artifactOutput)).digest('hex')}`;
const resolver: EvidenceArtifactResolver = {
  resolveArtifact: (candidateId) => candidateId === artifactId
    ? {
        artifact: { id: artifactId, contentSha256: artifactContentSha256 },
        value: {
          output: artifactOutput,
          redactedOutputHash,
        },
      }
    : null,
};
const manifest: EvidenceManifest = evidenceService.createManifest({
  taskId: 'task-1',
  planVersionId: 'plan-1',
  attemptId: 'attempt-1',
  collectedAt: '2026-08-09T00:00:00.000Z',
  entries: [{
    id: 'E1',
    kind: 'tool_output',
    evidenceClass: 'public_source',
    artifactId,
    artifactContentSha256,
    jsonPointer: '/output/results/0',
    sourceUrl,
    stepNo: 1,
    toolProof: { implementationId: 'tavily', executionMode: 'real', redactedOutputHash },
    sensitivity: 'public',
    redaction: 'masked',
  }],
}, resolver);

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

function deliverableReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 'research-deliverable-v1',
    taskId: 'task-1',
    planVersionId: 'plan-1',
    attemptId: 'attempt-1',
    deliverableType: 'research_plan',
    evidenceManifestArtifactId: 'artifact-evidence-manifest-1',
    methodSummary: '公开网页检索',
    findingGraph: graph,
    payload: {},
    recommendations: [{ id: 'R1', summaryIds: ['S1'], statement: '建议继续验证' }],
    risksAndOpenIssues: [],
    capabilityProvenance: [{ id: 'tavily', type: 'tool' }],
    ...overrides,
  };
}

function assertInvalidFindingGraph(findingGraph: unknown): void {
  const validator = new ReportEvidenceValidator(evidenceService);
  assert.throws(
    () => validator.validate({ manifest, report: { ...report(), findingGraph }, resolver }),
    CurrentReportValidationError,
  );
}

test('accepts a current report rooted in valid evidence and finding graph', () => {
  const validator = new ReportEvidenceValidator(evidenceService);
  assert.doesNotThrow(() => validator.validate({ manifest, report: report(), resolver }));
});

test('rejects a current report whose task does not match the evidence manifest', () => {
  const validator = new ReportEvidenceValidator(evidenceService);
  assert.throws(
    () => validator.validate({ manifest, report: { ...report(), taskId: 'task-2' }, resolver }),
    CurrentReportValidationError,
  );
});

test('rejects a deliverable whose plan version does not match the evidence manifest', () => {
  const validator = new ReportEvidenceValidator(evidenceService);
  assert.throws(
    () => validator.validate({
      manifest,
      report: deliverableReport({ planVersionId: 'plan-2' }),
      resolver,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CurrentReportValidationError);
      assert.match(error.message, /planVersionId/);
      return true;
    },
  );
});

test('rejects a deliverable whose attempt does not match the evidence manifest', () => {
  const validator = new ReportEvidenceValidator(evidenceService);
  assert.throws(
    () => validator.validate({
      manifest,
      report: deliverableReport({ attemptId: 'attempt-2' }),
      resolver,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CurrentReportValidationError);
      assert.match(error.message, /attemptId/);
      return true;
    },
  );
});

test('rejects an empty finding graph with the typed report validation error', () => {
  assertInvalidFindingGraph({});
});

const findingGraphArrayFields = [
  'findings',
  'analyses',
  'subQuestionSummaries',
  'overallConclusions',
] as const;

for (const field of findingGraphArrayFields) {
  test(`rejects a finding graph missing ${field} with the typed report validation error`, () => {
    const malformed: Record<string, unknown> = { ...graph };
    delete malformed[field];
    assertInvalidFindingGraph(malformed);
  });

  test(`rejects a finding graph whose ${field} is not an array with the typed report validation error`, () => {
    assertInvalidFindingGraph({ ...graph, [field]: { invalid: true } });
  });
}

test('rejects recommendations and conclusions without summary roots', () => {
  const validator = new ReportEvidenceValidator(evidenceService);
  const invalid = report();
  invalid.recommendations = [{ id: 'R1', summaryIds: [], statement: '无根建议' }];
  assert.throws(() => validator.validate({ manifest, report: invalid, resolver }), CurrentReportValidationError);
});

test('rejects legacy report shapes from the current evidence contract', () => {
  const validator = new ReportEvidenceValidator(evidenceService);
  assert.throws(
    () => validator.validate({ manifest, report: { findings: [{ source_ref: 'https://example.test' }] }, resolver }),
    CurrentReportValidationError,
  );
});
