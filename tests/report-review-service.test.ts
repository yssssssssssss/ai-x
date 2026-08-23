import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ControlExecutionLease } from '../database/control-plane.ts';
import {
  ANSWER_QUALITY_REVIEW_DIMENSION_IDS,
  REPORT_REVIEW_V2_DIMENSION_IDS,
} from '../packages/api-contract/control-workflow.ts';
import type { ArtifactWriteInput } from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import { ModelDriftError, MissingModelReceiptError } from '../apps/orchestrator-runtime/src/runtime/receipt-llm-client.ts';
import type { LLMResult, StructuredLLMCallOptions } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import {
  ReportReviewService,
  type ReportReviewArtifact,
  type ReportReviewInput,
} from '../apps/orchestrator-runtime/src/report/report-review-service.ts';
import { SchemaValidationError, SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

const lease: ControlExecutionLease = {
  taskId: 'task-1',
  planVersionId: 'plan-1',
  attemptId: 'attempt-1',
  leaseOwner: 'worker-1',
  leaseToken: 'lease-token',
};
const REQUIRED_REVIEW_DIMENSIONS = [
  'requirement_coverage',
  'question_coverage',
  'evidence_coverage',
  'reasoning_quality',
  'recommendation_quality',
  'visual_quality',
  'risk_disclosure',
] as const satisfies readonly ReportReviewArtifact['dimensions'][number]['id'][];

function passingReviewDimensions(): ReportReviewArtifact['dimensions'] {
  return REQUIRED_REVIEW_DIMENSIONS.map((id) => ({ id, passed: true, issues: [] }));
}

function passingAnswerReviewDimensions(): ReportReviewArtifact['dimensions'] {
  return REPORT_REVIEW_V2_DIMENSION_IDS.map((id) => ({ id, passed: true, issues: [] }));
}

const INVALID_PASS_DIMENSION_CASES: Array<{
  name: string;
  dimensions: () => ReportReviewArtifact['dimensions'];
}> = [{
  name: 'a missing required dimension',
  dimensions: () => passingReviewDimensions().slice(1),
}, {
  name: 'a duplicate dimension',
  dimensions: () => {
    const dimensions = passingReviewDimensions();
    return [...dimensions, { ...dimensions[0]! }];
  },
}, {
  name: 'an unknown dimension',
  dimensions: () => [
    ...passingReviewDimensions().slice(1),
    { id: 'unknown_dimension', passed: true, issues: [] },
  ] as unknown as ReportReviewArtifact['dimensions'],
}, {
  name: 'a failed dimension',
  dimensions: () => passingReviewDimensions().map((dimension, index) => (
    index === 0 ? { ...dimension, passed: false } : dimension
  )),
}, {
  name: 'issues on a passed dimension',
  dimensions: () => passingReviewDimensions().map((dimension, index) => (
    index === 0 ? { ...dimension, issues: ['unresolved issue'] } : dimension
  )),
}];

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 'research-deliverable-v1',
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    deliverableType: 'research_plan',
    evidenceManifestArtifactId: 'evidence-manifest-1',
    methodSummary: 'Evidence comparison',
    findingGraph: {
      findings: [{ id: 'f-1', kind: 'fact', statement: 'A fact', evidenceIds: ['e-1'] }],
      analyses: [{ id: 'a-1', statement: 'An analysis', findingIds: ['f-1'] }],
      subQuestionSummaries: [{ id: 's-1', summary: 'A summary', findingIds: ['f-1'], analysisIds: ['a-1'] }],
      overallConclusions: [{ id: 'c-1', statement: 'A conclusion', summaryIds: ['s-1'] }],
    },
    recommendations: [{ id: 'r-1', statement: 'Act', summaryIds: ['s-1'] }],
    coverage: {
      questionBindings: [{ questionId: 'q-1', summaryIds: ['s-1'] }],
      successCriterionBindings: [{
        successCriterionId: 'req-1',
        conclusionIds: ['c-1'],
        recommendationIds: ['r-1'],
      }],
    },
    risksAndOpenIssues: [],
    capabilityProvenance: [],
    ...overrides,
  };
}

function strategyReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return report({
    deliverableType: 'research_strategy_report',
    payload: {
      directAnswers: [{
        questionId: 'q-1', answer: 'Lead with verified fit evidence.', answerStatus: 'supported',
        evidenceIds: ['e-1'], businessImplication: 'Reduce uncertainty', recommendedAction: 'Ship the fit card', validationNeeded: '',
      }],
      prioritizedActions: [{ id: 'action-1', action: 'Ship the fit card', ownerType: 'product', validationMethod: 'Task test' }],
      requestedArtifactBindings: [{ artifactType: 'strategy_map', status: 'complete', blockIds: ['cell-1'] }],
      riskDisclosures: [], limitations: [], openQuestions: [],
    },
    ...overrides,
  });
}

function input(overrides: Partial<ReportReviewInput> = {}): ReportReviewInput {
  return {
    task: { id: lease.taskId },
    plan: { id: lease.planVersionId },
    attempt: { id: lease.attemptId },
    deliverableArtifactId: 'deliverable-1',
    deliverable: report(),
    successCriterionIds: ['req-1'],
    questionIds: ['q-1'],
    evidenceIds: ['e-1'],
    expectedModel: 'model-v1',
    activeLease: lease,
    ...overrides,
  };
}

class RecordingLlm {
  calls: StructuredLLMCallOptions[] = [];
  constructor(private readonly outputs: Array<ReportReviewArtifact | Error>) {}
  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    this.calls.push(options);
    const output = this.outputs.shift();
    if (output instanceof Error) throw output;
    if (!output) throw new Error('missing fixture');
    return {
      data: output as T,
      modelName: 'model-v1',
      modelVersion: 'v1',
      promptHash: 'sha256:review',
      traceId: 'trace-review',
      receiptId: 'receipt-review',
    };
  }
}

class RecordingArtifacts {
  readonly writes: ArtifactWriteInput[] = [];
  async writeJson(input: ArtifactWriteInput): Promise<{ id: string; state: 'SEALED' }> {
    this.writes.push(input);
    return { id: 'review-artifact-1', state: 'SEALED' };
  }
}

class RevisionComposer {
  calls = 0;
  constructor(private readonly revised: Record<string, unknown>) {}
  async revise(): Promise<{ deliverable: Record<string, unknown>; deliverableArtifactId: string }> {
    this.calls += 1;
    return { deliverable: this.revised, deliverableArtifactId: 'deliverable-revised' };
  }
}

function semantic(
  verdict: ReportReviewArtifact['verdict'],
  revisionRound: 0 | 1 = 0,
  overrides: Partial<ReportReviewArtifact> = {},
): ReportReviewArtifact {
  const dimensions = passingReviewDimensions();
  if (verdict !== 'pass') dimensions[0] = { ...dimensions[0]!, passed: false, issues: ['needs work'] };
  return {
    version: 'report-review-v1',
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    deliverableArtifactId: 'deliverable-1',
    verdict,
    dimensions,
    revisionRound,
    ...overrides,
  };
}

function service(llm: RecordingLlm, artifacts: RecordingArtifacts, composer?: RevisionComposer): ReportReviewService {
  return new ReportReviewService({ llm, artifacts, composer });
}

test('report-review schema accepts pass only with every required dimension exactly once', () => {
  const candidate = semantic('pass');
  assert.doesNotThrow(() => new SchemaValidator().validateOrThrow('report-review', candidate));
  assert.deepEqual(candidate.dimensions.map(({ id }) => id), [...REQUIRED_REVIEW_DIMENSIONS]);
  assert.equal(new Set(candidate.dimensions.map(({ id }) => id)).size, REQUIRED_REVIEW_DIMENSIONS.length);
});

for (const invalid of INVALID_PASS_DIMENSION_CASES) {
  test(`report-review schema rejects pass with ${invalid.name}`, () => {
    assert.throws(
      () => new SchemaValidator().validateOrThrow(
        'report-review',
        semantic('pass', 0, { dimensions: invalid.dimensions() }),
      ),
      SchemaValidationError,
    );
  });
}

test('report-review-v2 requires all six answer-quality dimensions in addition to legacy dimensions', async () => {
  const answerReview: ReportReviewArtifact = {
    ...semantic('pass'),
    version: 'report-review-v2',
    dimensions: passingAnswerReviewDimensions(),
  };
  assert.doesNotThrow(() => new SchemaValidator().validateOrThrow('report-review', answerReview));
  assert.deepEqual(
    answerReview.dimensions.slice(REQUIRED_REVIEW_DIMENSIONS.length).map(({ id }) => id),
    [...ANSWER_QUALITY_REVIEW_DIMENSION_IDS],
  );

  const llm = new RecordingLlm([answerReview]);
  const artifacts = new RecordingArtifacts();
  const result = await service(llm, artifacts).review(input({
    deliverable: strategyReport(),
    requirement: {
      version: 'research-task-v2', task_type: 'research_synthesis', outcome_mode: 'answer', requested_artifacts: ['strategy_map'],
      business_domain: 'test', research_goal: 'answer q-1', target_audience: ['team'], scope: ['test'], constraints: [],
      success_criteria: [{ id: 'req-1', statement: 'usable' }], expected_deliverables: ['research_strategy_report'],
      assumptions: [], ambiguities: [], clarification_questions: [], blocking_issues: [], sensitivity: 'internal', pii_detected: false,
    },
  }));
  assert.equal(result.version, 'report-review-v2');
  assert.deepEqual(result.dimensions.map(({ id }) => id), [...REPORT_REVIEW_V2_DIMENSION_IDS]);
  assert.equal(artifacts.writes[0]?.schemaVersion, 'report-review-v2');
});

test('answer-quality dimensions deterministically block missing direct answers before semantic review', async () => {
  const llm = new RecordingLlm([]);
  const artifacts = new RecordingArtifacts();
  const missingAnswerReport = strategyReport();
  (missingAnswerReport.payload as Record<string, unknown>).directAnswers = [];
  const result = await service(llm, artifacts).review(input({
    deliverable: missingAnswerReport,
    requirement: {
      version: 'research-task-v2', task_type: 'research_synthesis', outcome_mode: 'answer', requested_artifacts: [],
      business_domain: 'test', research_goal: 'answer q-1', target_audience: ['team'], scope: ['test'], constraints: [],
      success_criteria: [{ id: 'req-1', statement: 'usable' }], expected_deliverables: ['research_strategy_report'],
      assumptions: [], ambiguities: [], clarification_questions: [], blocking_issues: [], sensitivity: 'internal', pii_detected: false,
    },
  }));
  assert.equal(result.version, 'report-review-v2');
  assert.equal(result.verdict, 'block');
  assert.equal(result.dimensions.find(({ id }) => id === 'direct_answer_coverage')?.passed, false);
  assert.equal(llm.calls.length, 0);
});

test('answer risk-consistency dimension blocks an undisclosed envelope risk', async () => {
  const llm = new RecordingLlm([]);
  const artifacts = new RecordingArtifacts();
  const riskyReport = strategyReport({ risksAndOpenIssues: ['Skill degraded: missing behavioral data'] });
  const result = await service(llm, artifacts).review(input({
    deliverable: riskyReport,
    requirement: {
      version: 'research-task-v2', task_type: 'research_synthesis', outcome_mode: 'answer', requested_artifacts: [],
      business_domain: 'test', research_goal: 'answer q-1', target_audience: ['team'], scope: ['test'], constraints: [],
      success_criteria: [{ id: 'req-1', statement: 'usable' }], expected_deliverables: ['research_strategy_report'],
      assumptions: [], ambiguities: [], clarification_questions: [], blocking_issues: [], sensitivity: 'internal', pii_detected: false,
    },
  }));
  assert.equal(result.verdict, 'block');
  assert.equal(result.dimensions.find(({ id }) => id === 'risk_consistency')?.passed, false);
  assert.equal(llm.calls.length, 0);
});

test('passes a deliverable after deterministic gates and semantic review', async () => {
  const llm = new RecordingLlm([semantic('pass')]);
  const artifacts = new RecordingArtifacts();
  const result = await service(llm, artifacts).review(input());
  assert.equal(result.verdict, 'pass');
  assert.equal(result.status, 'completed');
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0]?.schemaName, 'report-review');
  assert.deepEqual(
    llm.calls[0]?.schema,
    {},
    'an empty override lets the gateway use the canonical report-review schema registry entry',
  );
  assert.equal(llm.calls[0]?.receipt.stage, 'deliverable_review');
  assert.equal(artifacts.writes[0]?.activeLease, lease);
  assert.deepEqual(result.dimensions.map(({ id }) => id), [...REQUIRED_REVIEW_DIMENSIONS]);
  assert.equal(new Set(result.dimensions.map(({ id }) => id)).size, REQUIRED_REVIEW_DIMENSIONS.length);
  assert.equal(artifacts.writes[0]?.relativePath, 'reports/review-r0.json');
});

test('drops undeclared semantic review dimension fields before strict validation', async () => {
  const dimensions = passingReviewDimensions().map(({ id }) => ({
    id,
    score: 5,
    rationale: 'extra model explanation',
  }));
  const llm = new RecordingLlm([
    semantic('pass', 0, { dimensions: dimensions as unknown as ReportReviewArtifact['dimensions'] }),
  ]);
  const artifacts = new RecordingArtifacts();

  const result = await service(llm, artifacts).review(input());

  assert.ok(result.dimensions.every((dimension) => dimension.passed && dimension.issues.length === 0 && !('score' in dimension) && !('rationale' in dimension)));
  assert.equal(result.verdict, 'pass');
  assert.equal(result.status, 'completed');
});

for (const verdict of ['revise', 'block'] as const) {
  test(`does not upgrade a provider ${verdict} verdict when every dimension passes`, async () => {
    const llm = new RecordingLlm([
      semantic(verdict, 0, { dimensions: passingReviewDimensions() }),
    ]);
    const artifacts = new RecordingArtifacts();

    const result = await service(llm, artifacts).review(input());

    assert.equal(result.verdict, verdict);
    assert.equal(result.status, 'paused');
  });
}

test('derives failed dimensions when semantic review supplies issues without passed flags', async () => {
  const dimensions = passingReviewDimensions().map(({ id }) => ({
    id,
    issues: id === 'evidence_coverage' ? [{ message: 'evidence needs clarification' }] : [],
  }));
  const llm = new RecordingLlm([
    semantic('revise', 0, { dimensions: dimensions as unknown as ReportReviewArtifact['dimensions'] }),
  ]);
  const artifacts = new RecordingArtifacts();

  const result = await service(llm, artifacts).review(input());

  assert.equal(result.verdict, 'revise');
  assert.equal(result.status, 'paused');
  assert.equal(result.dimensions.find(({ id }) => id === 'evidence_coverage')?.passed, false);
  assert.deepEqual(
    result.dimensions.find(({ id }) => id === 'evidence_coverage')?.issues,
    ['evidence needs clarification'],
  );
});

for (const invalid of INVALID_PASS_DIMENSION_CASES.slice(0, 3)) {
  test(`review service rejects pass with ${invalid.name}`, async () => {
    const llm = new RecordingLlm([
      semantic('pass', 0, { dimensions: invalid.dimensions() }),
    ]);
    const artifacts = new RecordingArtifacts();
    await assert.rejects(
      service(llm, artifacts).review(input()),
      SchemaValidationError,
    );
    assert.equal(artifacts.writes.length, 0);
  });
}

for (const invalid of INVALID_PASS_DIMENSION_CASES.slice(3)) {
  test(`review service conservatively revises a provider pass with ${invalid.name}`, async () => {
    const llm = new RecordingLlm([
      semantic('pass', 0, { dimensions: invalid.dimensions() }),
    ]);
    const artifacts = new RecordingArtifacts();

    const result = await service(llm, artifacts).review(input());

    assert.equal(result.verdict, 'revise');
    assert.equal(result.status, 'paused');
    assert.equal(result.dimensions[0]?.passed, false);
    assert.equal(artifacts.writes.length, 1);
  });
}

test('revises exactly once and passes after re-running every gate', async () => {
  const revised = report();
  const llm = new RecordingLlm([semantic('revise'), semantic('pass', 1)]);
  const artifacts = new RecordingArtifacts();
  const composer = new RevisionComposer(revised);
  const result = await service(llm, artifacts, composer).review(input());
  assert.equal(result.verdict, 'pass');
  assert.equal(result.revisionRound, 1);
  assert.equal(result.status, 'completed');
  assert.equal(composer.calls, 1);
  assert.equal(llm.calls.length, 2);
  assert.equal(result.deliverableArtifactId, 'deliverable-revised');
  assert.equal(artifacts.writes.length, 1);
  assert.equal(artifacts.writes[0]?.relativePath, 'reports/review-r1.json');
  assert.equal(
    (artifacts.writes[0]?.value as ReportReviewArtifact).deliverableArtifactId,
    'deliverable-revised',
  );
});

test('pauses when the single revision still requests revision', async () => {
  const llm = new RecordingLlm([semantic('revise'), semantic('revise', 1)]);
  const artifacts = new RecordingArtifacts();
  const composer = new RevisionComposer(report());
  const result = await service(llm, artifacts, composer).review(input());
  assert.equal(result.verdict, 'revise');
  assert.equal(result.status, 'paused');
  assert.equal(composer.calls, 1);
});

test('pauses on a semantic block verdict', async () => {
  const llm = new RecordingLlm([semantic('block')]);
  const artifacts = new RecordingArtifacts();
  const result = await service(llm, artifacts).review(input());
  assert.equal(result.verdict, 'block');
  assert.equal(result.status, 'paused');
});

const INVALID_EXPLICIT_COVERAGE_CASES: Array<{
  name: string;
  deliverable: () => Record<string, unknown>;
}> = [{
  name: 'coverage is missing even when risk text contains every expected ID',
  deliverable: () => report({
    coverage: undefined,
    risksAndOpenIssues: ['req-1', 'q-1'],
  }),
}, {
  name: 'a question binding is duplicated',
  deliverable: () => report({
    coverage: {
      questionBindings: [
        { questionId: 'q-1', summaryIds: ['s-1'] },
        { questionId: 'q-1', summaryIds: ['s-1'] },
      ],
      successCriterionBindings: [{ successCriterionId: 'req-1', conclusionIds: ['c-1'], recommendationIds: ['r-1'] }],
    },
  }),
}, {
  name: 'a question binding points to a missing summary',
  deliverable: () => report({
    coverage: {
      questionBindings: [{ questionId: 'q-1', summaryIds: ['missing-summary'] }],
      successCriterionBindings: [{ successCriterionId: 'req-1', conclusionIds: ['c-1'], recommendationIds: ['r-1'] }],
    },
  }),
}, {
  name: 'a success criterion binding is duplicated',
  deliverable: () => report({
    coverage: {
      questionBindings: [{ questionId: 'q-1', summaryIds: ['s-1'] }],
      successCriterionBindings: [
        { successCriterionId: 'req-1', conclusionIds: ['c-1'], recommendationIds: ['r-1'] },
        { successCriterionId: 'req-1', conclusionIds: ['c-1'], recommendationIds: ['r-1'] },
      ],
    },
  }),
}, {
  name: 'a success criterion binding points to missing report nodes',
  deliverable: () => report({
    coverage: {
      questionBindings: [{ questionId: 'q-1', summaryIds: ['s-1'] }],
      successCriterionBindings: [{
        successCriterionId: 'req-1',
        conclusionIds: ['missing-conclusion'],
        recommendationIds: ['missing-recommendation'],
      }],
    },
  }),
}];

for (const invalid of INVALID_EXPLICIT_COVERAGE_CASES) {
  test(`blocks before reviewer LLM when ${invalid.name}`, async () => {
    const llm = new RecordingLlm([semantic('pass')]);
    const artifacts = new RecordingArtifacts();
    const result = await service(llm, artifacts).review(input({ deliverable: invalid.deliverable() }));
    assert.equal(result.verdict, 'block');
    assert.equal(result.status, 'paused');
    assert.equal(llm.calls.length, 0);
  });
}

test('passes deterministic coverage only from valid explicit report-node bindings', async () => {
  const llm = new RecordingLlm([semantic('pass')]);
  const result = await service(llm, new RecordingArtifacts()).review(input());
  assert.equal(result.status, 'completed');
  assert.equal(llm.calls.length, 1);
});

test('does not accept model drift from the reviewer', async () => {
  const llm = new RecordingLlm([new ModelDriftError('model-v1', 'model-v2')]);
  const artifacts = new RecordingArtifacts();
  await assert.rejects(service(llm, artifacts).review(input()), ModelDriftError);
  assert.equal(artifacts.writes.length, 0);
});

test('does not seal a review when the model receipt fails', async () => {
  const llm = new RecordingLlm([new MissingModelReceiptError(new Error('db down'))]);
  const artifacts = new RecordingArtifacts();
  await assert.rejects(service(llm, artifacts).review(input()), MissingModelReceiptError);
  assert.equal(artifacts.writes.length, 0);
});

test('rejects an artifact writer that does not return a sealed review artifact', async () => {
  const llm = new RecordingLlm([semantic('pass')]);
  const artifacts = { async writeJson(): Promise<{ id: string; state: 'STAGING' }> { return { id: 'review-1', state: 'STAGING' }; } };
  await assert.rejects(
    new ReportReviewService({ llm, artifacts }).review(input()),
    /review artifact was not sealed/,
  );
});
