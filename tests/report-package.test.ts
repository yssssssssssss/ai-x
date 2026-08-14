import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ControlArtifact } from '../database/control-plane.ts';
import { ArtifactIntegrityError } from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import {
  EvidenceService,
  type EvidenceManifest,
  type ResolvedEvidenceArtifact,
} from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import type { ReportReviewArtifact } from '../apps/orchestrator-runtime/src/report/report-review-service.ts';
import {
  CurrentReportPackageReader,
  REVIEW_GATED_DELIVERABLE_SCHEMA_VERSION,
} from '../apps/orchestrator-runtime/src/report/current-report-package-reader.ts';

const binding = {
  taskId: 'task-1',
  planVersionId: 'plan-1',
  attemptId: 'attempt-1',
};
const evidenceArtifactId = 'evidence-1';
const manifestArtifactId = 'manifest-1';
const deliverableArtifactId = 'deliverable-1';
const reviewArtifactId = 'review-1';
const evidenceContentSha256 = `sha256:${'1'.repeat(64)}`;
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

function artifact(
  id: string,
  kind: string,
  schemaVersion: string,
  overrides: Partial<ControlArtifact> = {},
): ControlArtifact {
  return {
    id,
    ...binding,
    kind,
    state: 'SEALED',
    storageUri: `/artifacts/${id}.json`,
    contentSha256: `sha256:${id.padEnd(64, '0').slice(0, 64)}`,
    byteSize: 1,
    schemaVersion,
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
    failureReason: null,
    ...overrides,
  };
}

function evidenceValue(): Record<string, unknown> {
  return { output: { results: [{ name: 'verified dataset row' }] } };
}

function manifest(): EvidenceManifest {
  const resolved: ResolvedEvidenceArtifact = {
    artifact: { id: evidenceArtifactId, contentSha256: evidenceContentSha256 },
    value: evidenceValue(),
  };
  return new EvidenceService().createManifest({
    ...binding,
    collectedAt: '2026-08-14T10:00:00.000Z',
    entries: [{
      id: 'evidence-entry-1',
      kind: 'tool_output',
      evidenceClass: 'dataset',
      artifactId: evidenceArtifactId,
      artifactContentSha256: evidenceContentSha256,
      jsonPointer: '/output/results/0',
      sensitivity: 'internal',
      redaction: 'none',
    }],
  }, {
    resolveArtifact: (artifactId) => artifactId === evidenceArtifactId ? resolved : null,
  });
}

function deliverable(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 'research-deliverable-v1',
    ...binding,
    deliverableType: 'research_plan',
    evidenceManifestArtifactId: manifestArtifactId,
    methodSummary: 'Verified current synthesis',
    findingGraph: {
      findings: [{ id: 'finding-1', kind: 'fact', statement: 'Verified fact', evidenceIds: ['evidence-entry-1'] }],
      analyses: [{ id: 'analysis-1', statement: 'Verified analysis', findingIds: ['finding-1'] }],
      subQuestionSummaries: [{ id: 'summary-1', summary: 'Verified summary', findingIds: ['finding-1'], analysisIds: ['analysis-1'] }],
      overallConclusions: [{ id: 'conclusion-1', statement: 'Verified conclusion', summaryIds: ['summary-1'] }],
    },
    payload: { title: 'Verified report' },
    recommendations: [{ id: 'recommendation-1', statement: 'Act on the conclusion', summaryIds: ['summary-1'] }],
    risksAndOpenIssues: [],
    capabilityProvenance: [],
    ...overrides,
  };
}

function review(overrides: Partial<ReportReviewArtifact> = {}): ReportReviewArtifact {
  return {
    version: 'report-review-v1',
    ...binding,
    deliverableArtifactId,
    verdict: 'pass',
    dimensions: passingReviewDimensions(),
    revisionRound: 0,
    ...overrides,
  };
}

class FixtureArtifacts {
  readonly reads: string[] = [];
  readonly tampered = new Set<string>();
  readonly artifacts = new Map<string, { artifact: ControlArtifact; value: unknown }>();

  add(candidate: ControlArtifact, value: unknown): void {
    this.artifacts.set(candidate.id, { artifact: candidate, value });
  }

  async readVerifiedJson<T>(artifactId: string): Promise<{ artifact: ControlArtifact; value: T }> {
    this.reads.push(artifactId);
    if (this.tampered.has(artifactId)) throw new ArtifactIntegrityError(artifactId);
    const candidate = this.artifacts.get(artifactId);
    if (!candidate) throw new Error(`missing fixture Artifact ${artifactId}`);
    return candidate as { artifact: ControlArtifact; value: T };
  }
}

class FixtureRepository {
  readonly byKind = new Map<string, ControlArtifact>();

  async findSealedArtifact(input: { taskId: string; attemptId: string; kind: string }): Promise<ControlArtifact | null> {
    const candidate = this.byKind.get(input.kind) ?? null;
    if (!candidate || candidate.taskId !== input.taskId || candidate.attemptId !== input.attemptId) return null;
    return candidate;
  }
}

function setup(options: {
  deliverableSchemaVersion?: string;
  review?: ReportReviewArtifact | null;
  reviewArtifact?: ControlArtifact;
} = {}): {
  reader: CurrentReportPackageReader;
  artifacts: FixtureArtifacts;
  repository: FixtureRepository;
} {
  const artifacts = new FixtureArtifacts();
  const repository = new FixtureRepository();
  const evidenceArtifact = artifact(evidenceArtifactId, 'tool_output', 'tool-output-v1', {
    contentSha256: evidenceContentSha256,
  });
  const evidenceManifestArtifact = artifact(manifestArtifactId, 'evidence_manifest', 'evidence-v1');
  const deliverableArtifact = artifact(
    deliverableArtifactId,
    'deliverable',
    options.deliverableSchemaVersion ?? REVIEW_GATED_DELIVERABLE_SCHEMA_VERSION,
    { storageUri: '/artifacts/deliverables/final-r0.json' },
  );
  artifacts.add(evidenceArtifact, evidenceValue());
  artifacts.add(evidenceManifestArtifact, manifest());
  artifacts.add(deliverableArtifact, deliverable());
  repository.byKind.set('deliverable', deliverableArtifact);
  if (options.review !== null) {
    const reviewArtifact = options.reviewArtifact ?? artifact(reviewArtifactId, 'report_review', 'report-review-v1', {
      storageUri: '/artifacts/reports/review-r0.json',
    });
    artifacts.add(reviewArtifact, options.review ?? review());
    repository.byKind.set('report_review', reviewArtifact);
  }
  return {
    reader: new CurrentReportPackageReader({ artifacts, repository }),
    artifacts,
    repository,
  };
}

test('returns a verified review-gated current_text package and reads every JSON Artifact', async () => {
  const fixture = setup();
  const result = await fixture.reader.read(binding);

  assert.equal(result?.presentationMode, 'current_text');
  if (result?.presentationMode !== 'current_text') assert.fail('expected a current_text package');
  assert.deepEqual(result?.deliverable, deliverable());
  assert.deepEqual(result?.evidenceManifest, manifest());
  assert.deepEqual(result?.reportReview, review());
  assert.equal('reportDocument' in (result ?? {}), false);
  assert.equal('visualAssetManifest' in (result ?? {}), false);
  assert.deepEqual(result.reportReview.dimensions.map(({ id }) => id), [...REQUIRED_REVIEW_DIMENSIONS]);
  assert.equal(
    new Set(result.reportReview.dimensions.map(({ id }) => id)).size,
    REQUIRED_REVIEW_DIMENSIONS.length,
  );
  assert.deepEqual(fixture.artifacts.reads, [
    reviewArtifactId,
    deliverableArtifactId,
    manifestArtifactId,
    evidenceArtifactId,
  ]);
});
test('reads the final revised deliverable through the Review binding instead of an arbitrary draft', async () => {
  const revisedDeliverableArtifactId = 'deliverable-revised';
  const fixture = setup({
    review: review({
      deliverableArtifactId: revisedDeliverableArtifactId,
      revisionRound: 1,
    }),
    reviewArtifact: artifact(reviewArtifactId, 'report_review', 'report-review-v1', {
      storageUri: '/artifacts/reports/review-r1.json',
    }),
  });
  fixture.artifacts.add(
    artifact(
      revisedDeliverableArtifactId,
      'deliverable',
      REVIEW_GATED_DELIVERABLE_SCHEMA_VERSION,
      { storageUri: '/artifacts/deliverables/final-r1.json' },
    ),
    deliverable({ methodSummary: 'Final revised synthesis' }),
  );

  const result = await fixture.reader.read(binding);
  if (result?.presentationMode !== 'current_text') assert.fail('expected a current_text package');

  assert.equal(result?.deliverable.methodSummary, 'Final revised synthesis');
  assert.equal(result.reportReview.deliverableArtifactId, revisedDeliverableArtifactId);
  assert.deepEqual(fixture.artifacts.reads, [
    reviewArtifactId,
    revisedDeliverableArtifactId,
    manifestArtifactId,
    evidenceArtifactId,
  ]);
});

for (const invalid of INVALID_PASS_DIMENSION_CASES) {
  test(`rejects a pass Review with ${invalid.name}`, async () => {
    const { reader } = setup({
      review: review({ dimensions: invalid.dimensions() }),
    });
    await assert.rejects(reader.read(binding), /dimension|review|pass|schema/i);
  });
}


test('rejects a review-gated package when its Review Artifact is missing', async () => {
  const { reader } = setup({ review: null });
  await assert.rejects(reader.read(binding), /review.*missing|missing.*review/i);
});

test('propagates Review Artifact checksum failure instead of downgrading to legacy_text', async () => {
  const fixture = setup();
  fixture.artifacts.tampered.add(reviewArtifactId);
  await assert.rejects(fixture.reader.read(binding), ArtifactIntegrityError);
});

for (const field of ['taskId', 'planVersionId', 'attemptId'] as const) {
  test(`rejects a Deliverable payload with the wrong ${field}`, async () => {
    const fixture = setup();
    const stored = fixture.artifacts.artifacts.get(deliverableArtifactId);
    assert.ok(stored);
    stored.value = deliverable({ [field]: `wrong-${field}` });
    await assert.rejects(fixture.reader.read(binding), new RegExp(field, 'i'));
  });

  test(`rejects an Evidence Manifest Artifact with the wrong ${field} binding`, async () => {
    const fixture = setup();
    const stored = fixture.artifacts.artifacts.get(manifestArtifactId);
    assert.ok(stored);
    stored.artifact[field] = `wrong-${field}`;
    await assert.rejects(fixture.reader.read(binding), new RegExp(field, 'i'));
  });

  test(`rejects a referenced Evidence Artifact with the wrong ${field} binding`, async () => {
    const fixture = setup();
    const stored = fixture.artifacts.artifacts.get(evidenceArtifactId);
    assert.ok(stored);
    stored.artifact[field] = `wrong-${field}`;
    await assert.rejects(fixture.reader.read(binding), new RegExp(field, 'i'));
  });
}

test('rejects an unsealed Review Artifact', async () => {
  const reviewArtifact = artifact(reviewArtifactId, 'report_review', 'report-review-v1', {
    state: 'STAGING',
    storageUri: '/artifacts/reports/review-r0.json',
  });
  const { reader } = setup({ reviewArtifact });
  await assert.rejects(reader.read(binding), /sealed/i);
});

for (const field of ['taskId', 'planVersionId', 'attemptId'] as const) {
  test(`rejects a Review payload with the wrong ${field}`, async () => {
    const { reader } = setup({ review: review({ [field]: `wrong-${field}` }) });
    await assert.rejects(reader.read(binding), new RegExp(field, 'i'));
  });

  test(`rejects a Review Artifact with the wrong ${field} binding`, async () => {
    const reviewArtifact = artifact(reviewArtifactId, 'report_review', 'report-review-v1', {
      [field]: `wrong-${field}`,
      storageUri: '/artifacts/reports/review-r0.json',
    });
    const { reader } = setup({ reviewArtifact });
    await assert.rejects(reader.read(binding), new RegExp(`${field}|review`, 'i'));
  });
}

test('rejects a Review that is not bound to the final Deliverable Artifact', async () => {
  const { reader } = setup({ review: review({ deliverableArtifactId: 'older-deliverable' }) });
  await assert.rejects(reader.read(binding), /deliverable/i);
});

for (const verdict of ['revise', 'block'] as const) {
  test(`rejects a review-gated package whose final Review verdict is ${verdict}`, async () => {
    const { reader } = setup({ review: review({ verdict }) });
    await assert.rejects(reader.read(binding), /verdict|pass/i);
  });
}

test('rejects a Review whose revisionRound does not match its final-round Artifact path', async () => {
  const { reader } = setup({ review: review({ revisionRound: 1 }) });
  await assert.rejects(reader.read(binding), /revision.*round/i);
});

test('rejects a Review Artifact with the wrong schema version', async () => {
  const reviewArtifact = artifact(reviewArtifactId, 'report_review', 'wrong-review-version', {
    storageUri: '/artifacts/reports/review-r0.json',
  });
  const { reader } = setup({ reviewArtifact });
  await assert.rejects(reader.read(binding), /schema/i);
});

test('revalidates referenced Evidence Artifacts and the Finding Graph on every read', async () => {
  const fixture = setup();
  fixture.artifacts.tampered.add(evidenceArtifactId);
  await assert.rejects(fixture.reader.read(binding), ArtifactIntegrityError);

  const invalid = setup();
  const stored = invalid.artifacts.artifacts.get(deliverableArtifactId);
  assert.ok(stored);
  stored.value = deliverable({
    findingGraph: {
      findings: [{ id: 'finding-1', kind: 'fact', statement: 'Unrooted fact', evidenceIds: ['missing-evidence'] }],
      analyses: [{ id: 'analysis-1', statement: 'Analysis', findingIds: ['finding-1'] }],
      subQuestionSummaries: [{ id: 'summary-1', summary: 'Summary', findingIds: ['finding-1'], analysisIds: ['analysis-1'] }],
      overallConclusions: [{ id: 'conclusion-1', statement: 'Conclusion', summaryIds: ['summary-1'] }],
    },
  });
  await assert.rejects(invalid.reader.read(binding), /unknown evidence/i);
});

test('returns historical research-deliverable-v1 Artifacts as legacy_text without a Review', async () => {
  const { reader } = setup({ deliverableSchemaVersion: 'research-deliverable-v1', review: null });
  const result = await reader.read(binding);

  assert.equal(result?.presentationMode, 'legacy_text');
  assert.equal(result?.reportReview, undefined);
  assert.equal('reportDocument' in (result ?? {}), false);
  assert.equal('visualAssetManifest' in (result ?? {}), false);
});

test('never silently downgrades an unknown deliverable schema marker', async () => {
  const { reader } = setup({ deliverableSchemaVersion: 'unexpected-deliverable-v2', review: null });
  await assert.rejects(reader.read(binding), /schema|marker/i);
});
