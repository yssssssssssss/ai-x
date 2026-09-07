import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INDUSTRY_REPORT_REVIEW_DIMENSION_IDS,
  type ReportReviewArtifact,
} from '../packages/api-contract/control-workflow.ts';
import { assertValidReportReviewArtifact } from '../apps/orchestrator-runtime/src/report/report-review-service.ts';

function review(): ReportReviewArtifact {
  return {
    version: 'report-review-v3',
    taskId: 'task-industry',
    planVersionId: 'plan-industry',
    attemptId: 'attempt-industry',
    deliverableArtifactId: 'deliverable-industry',
    verdict: 'pass',
    dimensions: INDUSTRY_REPORT_REVIEW_DIMENSION_IDS.map((id) => ({
      id,
      passed: true,
      issues: [],
    })),
    revisionRound: 0,
  };
}

test('Industry report-review-v3 requires every Industry review dimension exactly once', () => {
  assert.doesNotThrow(() => assertValidReportReviewArtifact(review()));
  const missing = review();
  missing.dimensions.pop();
  assert.throws(
    () => assertValidReportReviewArtifact(missing),
    /every required dimension exactly once|validation failed/u,
  );
});
