import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ControlArtifact, ControlTaskDetail } from '../database/control-plane.ts';
import { EvidenceService, type EvidenceManifest } from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import {
  EditorialReportSourceReader,
  EditorialSourceError,
} from '../apps/orchestrator-runtime/src/report/editorial-report-source-reader.ts';
import type { ReportPackageArtifactValue } from '../apps/orchestrator-runtime/src/report/report-package-artifact.ts';

const ids = {
  task: '11111111-1111-4111-8111-111111111111',
  plan: '22222222-2222-4222-8222-222222222222',
  attempt: '33333333-3333-4333-8333-333333333333',
  package: '44444444-4444-4444-8444-444444444444',
  deliverable: '55555555-5555-4555-8555-555555555555',
  manifest: '66666666-6666-4666-8666-666666666666',
  review: '77777777-7777-4777-8777-777777777777',
  evidence: '88888888-8888-4888-8888-888888888888',
} as const;

const hash = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;

function researchPlanPayload(): Record<string, unknown> {
  return {
    title: 'Verified research plan',
    researchGoal: 'Understand the problem',
    scope: { market: 'CN', subjects: ['users'], timeWindow: '2026 Q3' },
    competitorSampling: {
      strategy: 'purposive', targetCount: 1,
      inclusionCriteria: ['relevant'], exclusionCriteria: ['irrelevant'],
    },
    researchQuestions: ['What should change?'],
    comparisonDimensions: [{ id: 'dimension-1', name: 'Quality', purpose: 'Compare', collectionFields: ['score'] }],
    sourcePlan: [{ evidenceClass: 'dataset', sourceTypes: ['verified dataset'], purpose: 'Support findings' }],
    executionPlan: [{ phase: 'collect', activities: ['collect'], duration: '1 day', outputs: ['dataset'] }],
    collectionTemplate: [{ field: 'score', description: 'Observed score', evidenceRequired: true }],
    analysisMethods: ['descriptive analysis'],
    deliverables: ['research_plan'],
    qualityChecks: ['source traceability'],
  };
}

function fixtureArtifact(
  id: string,
  kind: string,
  schemaVersion: string,
  overrides: Partial<ControlArtifact> = {},
): ControlArtifact {
  return {
    id,
    taskId: ids.task,
    planVersionId: ids.plan,
    attemptId: ids.attempt,
    kind,
    state: 'SEALED',
    storageUri: `/trusted/tasks/${ids.task}/attempts/${ids.attempt}/${id}.json`,
    contentSha256: hash(id[0] ?? 'a'),
    byteSize: 128,
    schemaVersion,
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
    failureReason: null,
    ...overrides,
  };
}

function passingReviewDimensions() {
  return [
    'requirement_coverage', 'question_coverage', 'evidence_coverage', 'reasoning_quality',
    'recommendation_quality', 'visual_quality', 'risk_disclosure',
  ].map((id) => ({ id, passed: true, issues: [] }));
}

class FixtureArtifacts {
  readonly values = new Map<string, { artifact: ControlArtifact; value: unknown }>();
  readonly jsonReads = new Map<string, number>();
  readonly boundReads = new Map<string, number>();
  readonly binaryReads = new Map<string, number>();

  add(artifact: ControlArtifact, value: unknown): void {
    this.values.set(artifact.id, { artifact, value });
  }

  private require(artifactId: string) {
    const stored = this.values.get(artifactId);
    if (!stored) throw new Error(`missing fixture Artifact ${artifactId}`);
    return stored;
  }

  async readVerifiedJson<T>(artifactId: string): Promise<{ artifact: ControlArtifact; value: T }> {
    this.jsonReads.set(artifactId, (this.jsonReads.get(artifactId) ?? 0) + 1);
    return this.require(artifactId) as { artifact: ControlArtifact; value: T };
  }

  async readVerifiedBoundJson<T>(artifactId: string): Promise<{ artifact: ControlArtifact; value: T }> {
    this.boundReads.set(artifactId, (this.boundReads.get(artifactId) ?? 0) + 1);
    return this.require(artifactId) as { artifact: ControlArtifact; value: T };
  }

  async readVerifiedBinary(artifactId: string): Promise<never> {
    this.binaryReads.set(artifactId, (this.binaryReads.get(artifactId) ?? 0) + 1);
    throw new Error(`unexpected binary read ${artifactId}`);
  }
}

class FixtureTasks {
  readonly artifacts = new Map<string, ControlArtifact>();
  readonly metadataReads = new Map<string, number>();
  taskReads = 0;
  packageReads = 0;
  nextTask?: ControlTaskDetail;
  taskResponses: ControlTaskDetail[] = [];

  constructor(
    readonly task: ControlTaskDetail,
    readonly reportPackage: ControlArtifact,
  ) {}

  async getTaskDetail(taskId: string): Promise<ControlTaskDetail | null> {
    this.taskReads += 1;
    if (taskId !== this.task.id) return null;
    const queued = this.taskResponses.shift();
    if (queued) return queued;
    return this.taskReads > 1 && this.nextTask ? this.nextTask : this.task;
  }

  async getArtifact(artifactId: string): Promise<ControlArtifact | null> {
    this.metadataReads.set(artifactId, (this.metadataReads.get(artifactId) ?? 0) + 1);
    return this.artifacts.get(artifactId) ?? null;
  }

  async findSealedArtifact(input: { taskId: string; attemptId: string; kind: string }): Promise<ControlArtifact | null> {
    this.packageReads += 1;
    if (
      input.taskId !== this.task.id
      || input.attemptId !== this.reportPackage.attemptId
      || input.kind !== 'report_package'
    ) return null;
    return this.reportPackage;
  }
}

function harness(options: {
  task?: Partial<ControlTaskDetail>;
  packageByteSize?: number;
  evidenceByteSize?: number;
  invalidPayload?: boolean;
  duplicateEvidenceReference?: boolean;
} = {}) {
  const evidenceValue = { output: { results: [{ score: 87 }] } };
  const evidenceArtifact = fixtureArtifact(ids.evidence, 'tool_output', 'tool-output-v1', {
    contentSha256: hash('8'),
    byteSize: options.evidenceByteSize ?? 128,
  });
  const entries = [{
    id: 'evidence-1',
    kind: 'tool_output' as const,
    evidenceClass: 'dataset' as const,
    artifactId: ids.evidence,
    artifactContentSha256: evidenceArtifact.contentSha256!,
    jsonPointer: '/output/results/0/score',
    sensitivity: 'internal' as const,
    redaction: 'none' as const,
  }];
  if (options.duplicateEvidenceReference) {
    entries.push({ ...entries[0]!, id: 'evidence-2' });
  }
  const manifest = new EvidenceService().createManifest({
    taskId: ids.task,
    planVersionId: ids.plan,
    attemptId: ids.attempt,
    collectedAt: '2026-08-27T00:00:00.000Z',
    entries,
  }, {
    resolveArtifact: (artifactId) => artifactId === ids.evidence
      ? {
          artifact: { id: ids.evidence, contentSha256: evidenceArtifact.contentSha256! },
          value: evidenceValue,
        }
      : null,
  });
  const deliverable = {
    version: 'research-deliverable-v1',
    taskId: ids.task,
    planVersionId: ids.plan,
    attemptId: ids.attempt,
    deliverableType: 'research_plan',
    evidenceManifestArtifactId: ids.manifest,
    methodSummary: 'Verified synthesis',
    findingGraph: {
      findings: [{ id: 'finding-1', kind: 'fact', statement: 'The verified score is 87.', evidenceIds: ['evidence-1'] }],
      analyses: [{ id: 'analysis-1', statement: 'The score is material.', findingIds: ['finding-1'] }],
      subQuestionSummaries: [{ id: 'summary-1', summary: 'The score answers the question.', findingIds: ['finding-1'], analysisIds: ['analysis-1'] }],
      overallConclusions: [{ id: 'conclusion-1', statement: 'Proceed with validation.', summaryIds: ['summary-1'] }],
    },
    payload: {
      ...researchPlanPayload(),
      ...(options.invalidPayload ? { unexpected: true } : {}),
    },
    recommendations: [{ id: 'recommendation-1', statement: 'Validate the plan.', summaryIds: ['summary-1'] }],
    coverage: {
      questionBindings: [{ questionId: 'question-1', summaryIds: ['summary-1'] }],
      successCriterionBindings: [{
        successCriterionId: 'criterion-1',
        conclusionIds: ['conclusion-1'],
        recommendationIds: ['recommendation-1'],
      }],
    },
    risksAndOpenIssues: [],
    capabilityProvenance: [],
  };
  const review = {
    version: 'report-review-v1',
    taskId: ids.task,
    planVersionId: ids.plan,
    attemptId: ids.attempt,
    deliverableArtifactId: ids.deliverable,
    verdict: 'pass',
    dimensions: passingReviewDimensions(),
    revisionRound: 0,
  };
  const reportPackage: ReportPackageArtifactValue = {
    version: 'report-package-v1',
    taskId: ids.task,
    planVersionId: ids.plan,
    attemptId: ids.attempt,
    presentationMode: 'current_text',
    deliverableArtifactId: ids.deliverable,
    evidenceManifestArtifactId: ids.manifest,
    reportReviewArtifactId: ids.review,
  };
  const packageArtifact = fixtureArtifact(ids.package, 'report_package', 'report-package-v1', {
    contentSha256: hash('4'),
    byteSize: options.packageByteSize ?? 128,
  });
  const artifacts = new FixtureArtifacts();
  artifacts.add(packageArtifact, reportPackage);
  artifacts.add(fixtureArtifact(ids.deliverable, 'deliverable', 'research-deliverable-v1-review-gated', {
    storageUri: `/trusted/tasks/${ids.task}/attempts/${ids.attempt}/deliverables/final-r0.json`,
  }), deliverable);
  artifacts.add(fixtureArtifact(ids.manifest, 'evidence_manifest', 'evidence-v1'), manifest);
  artifacts.add(fixtureArtifact(ids.review, 'report_review', 'report-review-v1', {
    storageUri: `/trusted/tasks/${ids.task}/attempts/${ids.attempt}/reports/review-r0.json`,
  }), review);
  artifacts.add(evidenceArtifact, evidenceValue);

  const task: ControlTaskDetail = {
    id: ids.task,
    conversationId: '99999999-9999-4999-8999-999999999999',
    originalInput: 'Create a research plan',
    ownerUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    conversationOwnerUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    structuredTask: {},
    state: 'completed',
    stateVersion: 12,
    activePlanVersionId: ids.plan,
    currentAttemptId: ids.attempt,
    activeRequirementVersionId: null,
    ...options.task,
  };
  const tasks = new FixtureTasks(task, packageArtifact);
  for (const { artifact } of artifacts.values.values()) tasks.artifacts.set(artifact.id, artifact);
  return {
    tasks,
    artifacts,
    reader: new EditorialReportSourceReader({ tasks, artifacts }),
  };
}

test('freezes the current completed task and reads its exact verified SEALED Report Package', async () => {
  const fixture = harness({ duplicateEvidenceReference: true });

  const source = await fixture.reader.readCurrent(ids.task);

  assert.deepEqual(source.binding, {
    taskId: ids.task,
    taskState: 'completed',
    taskStateVersion: 12,
    planVersionId: ids.plan,
    attemptId: ids.attempt,
    reportPackageArtifactId: ids.package,
    reportPackageContentSha256: hash('4'),
  });
  assert.equal(source.current.presentationMode, 'current_text');
  assert.equal(fixture.artifacts.boundReads.get(ids.package), 1);
  assert.equal(fixture.artifacts.jsonReads.get(ids.evidence), 1, 'duplicate Evidence references must share one read');
  assert.equal(fixture.tasks.taskReads, 4, 'each binding read must finish by re-reading the task row');
  assert.equal(fixture.tasks.packageReads, 2);
  const bindingIds = new Set<string>([ids.task, ids.plan, ids.attempt]);
  assert.deepEqual(
    source.sourceArtifacts.map(({ artifactId }) => artifactId).sort(),
    Object.values(ids).filter((id) => !bindingIds.has(id)).sort(),
  );
  assert.equal(source.sourcePolicyMetadata.length, source.sourceArtifacts.length);
  assert.deepEqual(source.verifiedVisualAssets, []);
});

test('freezes the reviewed requirement fields needed by the Editorial Summary', async () => {
  const fixture = harness({
    task: {
      originalInput: '研究新业务模式并给出验证计划',
      structuredTask: {
        version: 'research-task-v2',
        task_type: 'user_research_planning',
        business_domain: 'new_business',
        research_goal: '判断用户需求与风险',
        target_audience: ['产品负责人'],
        scope: ['中国市场'],
        constraints: [{ id: 'constraint-1', statement: '只使用已审校证据', source: 'user' }],
        success_criteria: [{ id: 'criterion-1', statement: '给出可执行验证计划' }],
        expected_deliverables: ['研究方案'],
        requested_artifacts: [{ id: 'artifact-1', kind: 'research_plan', title: '研究方案', required: true }],
        assumptions: [],
        ambiguities: [],
        clarification_questions: [],
        blocking_issues: [],
        sensitivity: 'internal',
        pii_detected: false,
      },
    },
  });

  const source = await fixture.reader.readCurrent(ids.task);

  assert.deepEqual(source.taskContext, {
    originalRequest: '研究新业务模式并给出验证计划',
    researchGoal: '判断用户需求与风险',
    targetAudience: ['产品负责人'],
    scope: ['中国市场'],
    constraints: ['只使用已审校证据'],
    successCriteria: ['给出可执行验证计划'],
    expectedDeliverables: ['研究方案'],
    requestedArtifacts: [{ id: 'artifact-1', kind: 'research_plan', title: '研究方案', required: true }],
    sensitivity: 'internal',
    piiDetected: false,
  });
});

test('rejects non-completed tasks before reading any Artifact', async () => {
  const fixture = harness({ task: { state: 'executing' } });

  await assert.rejects(
    () => fixture.reader.readCurrent(ids.task),
    (error: unknown) => error instanceof EditorialSourceError && error.code === 'SOURCE_NOT_COMPLETED',
  );
  assert.equal(fixture.artifacts.jsonReads.size, 0);
  assert.equal(fixture.artifacts.boundReads.size, 0);
});

test('rejects an oversized Report Package from fresh metadata before reading its bytes', async () => {
  const fixture = harness({ packageByteSize: 256 * 1024 + 1 });

  await assert.rejects(
    () => fixture.reader.readCurrent(ids.task),
    (error: unknown) => error instanceof EditorialSourceError && error.code === 'SOURCE_BUDGET_EXCEEDED',
  );
  assert.equal(fixture.tasks.metadataReads.get(ids.package), 1);
  assert.equal(fixture.artifacts.boundReads.get(ids.package), undefined);
});

test('rejects Report Package metadata drift between selection and the exact id lookup', async () => {
  const fixture = harness();
  fixture.tasks.artifacts.set(ids.package, {
    ...fixture.tasks.reportPackage,
    contentSha256: hash('a'),
  });

  await assert.rejects(
    () => fixture.reader.readCurrent(ids.task),
    (error: unknown) => error instanceof EditorialSourceError && error.code === 'SOURCE_BINDING_INCOMPLETE',
  );
  assert.equal(fixture.artifacts.boundReads.get(ids.package), undefined);
});

test('fails the start fence when the task binding changes during a frozen read', async () => {
  const fixture = harness();
  fixture.tasks.nextTask = { ...fixture.tasks.task, stateVersion: 13 };

  await assert.rejects(
    () => fixture.reader.readCurrent(ids.task),
    (error: unknown) => error instanceof EditorialSourceError && error.code === 'SOURCE_BINDING_CHANGED',
  );
});

test('rejects an oversized Evidence Artifact from metadata before reading its bytes', async () => {
  const fixture = harness({ evidenceByteSize: 8 * 1024 * 1024 + 1 });

  await assert.rejects(
    () => fixture.reader.readCurrent(ids.task),
    (error: unknown) => error instanceof EditorialSourceError && error.code === 'SOURCE_BUDGET_EXCEEDED',
  );
  assert.equal(fixture.artifacts.jsonReads.get(ids.evidence), undefined);
});

test('preflights the aggregate Evidence metadata budget before reading any Evidence bytes', async () => {
  const fixture = harness();
  const characters = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
  const entries = characters.map((character, index) => {
    const artifactId = `budget-evidence-${index}`;
    const artifact = fixtureArtifact(artifactId, 'tool_output', 'tool-output-v1', {
      contentSha256: hash(character),
      byteSize: 8 * 1024 * 1024,
    });
    fixture.artifacts.add(artifact, { output: { value: index } });
    fixture.tasks.artifacts.set(artifactId, artifact);
    return {
      id: `budget-entry-${index}`,
      kind: 'tool_output',
      evidenceClass: 'dataset',
      artifactId,
      artifactContentSha256: artifact.contentSha256,
      jsonPointer: '/output/value',
      sensitivity: 'internal',
      redaction: 'none',
    };
  });
  const storedManifest = fixture.artifacts.values.get(ids.manifest);
  assert.ok(storedManifest);
  storedManifest.value = {
    ...(storedManifest.value as EvidenceManifest),
    entries,
  };

  await assert.rejects(
    () => fixture.reader.readCurrent(ids.task),
    (error: unknown) => error instanceof EditorialSourceError && error.code === 'SOURCE_BUDGET_EXCEEDED',
  );
  for (const { artifactId } of entries) {
    assert.equal(fixture.artifacts.jsonReads.get(artifactId), undefined);
    assert.equal(fixture.tasks.metadataReads.get(artifactId), 1);
  }
});

test('strictly validates the active deliverable payload schema', async () => {
  const fixture = harness({ invalidPayload: true });

  await assert.rejects(
    () => fixture.reader.readCurrent(ids.task),
    (error: unknown) => error instanceof EditorialSourceError && error.code === 'SOURCE_PAYLOAD_INVALID',
  );
});

test('assertStillCurrent compares task state/version, plan, attempt, and package identity', async () => {
  const fixture = harness();
  const source = await fixture.reader.readCurrent(ids.task);
  await fixture.reader.assertStillCurrent(source.binding);
  fixture.tasks.nextTask = { ...fixture.tasks.task, currentAttemptId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };

  await assert.rejects(
    () => fixture.reader.assertStillCurrent(source.binding),
    (error: unknown) => error instanceof EditorialSourceError && error.code === 'SOURCE_BINDING_CHANGED',
  );
});

test('assertStillCurrent rejects a task switch during its Artifact lookup window', async () => {
  const fixture = harness();
  const source = await fixture.reader.readCurrent(ids.task);
  fixture.tasks.taskResponses.push(
    fixture.tasks.task,
    { ...fixture.tasks.task, stateVersion: fixture.tasks.task.stateVersion + 1 },
  );

  await assert.rejects(
    () => fixture.reader.assertStillCurrent(source.binding),
    (error: unknown) => error instanceof EditorialSourceError && error.code === 'SOURCE_BINDING_CHANGED',
  );
});
