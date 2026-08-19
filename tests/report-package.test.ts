import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ControlArtifact } from '../database/control-plane.ts';
import type {
  CurrentReportPackageResponse,
  ReportReviewArtifact,
} from '../packages/api-contract/control-workflow.ts';
import type {
  ChartSpec,
  ResearchDeliverableEnvelope,
  VisualAssetManifest,
  VisualAssetManifestV2,
} from '../packages/api-contract/research-deliverable.ts';
import type { ReportDocument } from '../apps/orchestrator-runtime/src/report/report-document-composer.ts';
import { ArtifactIntegrityError } from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import {
  EvidenceService,
  type EvidenceManifest,
  type ResolvedEvidenceArtifact,
} from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import {
  CurrentReportPackageReader,
  REVIEW_GATED_DELIVERABLE_SCHEMA_VERSION,
} from '../apps/orchestrator-runtime/src/report/current-report-package-reader.ts';
import { parseControlDeliverableResponse } from '../apps/web/src/report-package-response.ts';
import { chartTableAlternative } from '../apps/orchestrator-runtime/src/report/chart-renderer.ts';
import { chartSpecHash } from '../apps/orchestrator-runtime/src/report/chart-spec-validator.ts';

const binding = {
  taskId: 'task-1',
  planVersionId: 'plan-1',
  attemptId: 'attempt-1',
};
const evidenceArtifactId = 'evidence-1';
const manifestArtifactId = 'manifest-1';
const deliverableArtifactId = 'deliverable-1';
const reviewArtifactId = 'review-1';
const reportDocumentArtifactId = 'report-document-1';
const imageAssetId = 'asset-image-1';
const imageManifestArtifactId = 'manifest-image-1';
const annotationAssetId = 'asset-annotation-1';
const annotationManifestArtifactId = 'manifest-annotation-1';
const chartAssetId = 'asset-chart-1';
const chartManifestArtifactId = 'manifest-chart-1';
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
  return { output: { results: [{ name: 'verified dataset row', score: 87 }] } };
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
      jsonPointer: '/output/results/0/score',
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

function packageChartSpec(): ChartSpec {
  return {
    version: 'chart-spec-v1',
    chartId: 'chart-1',
    type: 'comparison',
    title: 'Verified comparison',
    categories: ['Score'],
    series: [{
      key: 'competitor:a',
      label: 'Competitor A',
      values: [87],
      evidenceIds: [['evidence-entry-1']],
    }],
    yAxis: { min: 0 },
  };
}

function packageReportDocument(): ReportDocument {
  const spec = packageChartSpec();
  return {
    version: 'report-document-v1',
    title: 'Verified report',
    subtitle: 'Professional multimodal report',
    executiveSummary: 'Verified evidence supports the conclusion.',
    sections: [{
      id: 'visual-evidence',
      title: 'Visual evidence',
      questionIds: ['question-1'],
      blocks: [{
        id: 'image-1',
        type: 'image',
        assetRef: { assetId: imageAssetId, manifestArtifactId: imageManifestArtifactId },
        caption: 'Verified source image',
        altText: 'Verified source image.',
      }, {
        id: 'chart-1',
        type: 'chart',
        chartRef: {
          chartId: spec.chartId,
          assetId: chartAssetId,
          manifestArtifactId: chartManifestArtifactId,
        },
        specHash: chartSpecHash(spec),
        spec,
        table: chartTableAlternative(spec),
        caption: spec.title,
        altText: 'Competitor A has a verified score of 87.',
      }],
    }],
  };
}

function packageImageComparisonDocument(): ReportDocument {
  const document = packageReportDocument();
  const section = document.sections[0]!;
  const chart = section.blocks.find(({ type }) => type === 'chart');
  assert.ok(chart?.type === 'chart');
  section.blocks = [{
    id: 'image-comparison-1',
    type: 'image-comparison',
    beforeAssetRef: { assetId: imageAssetId, manifestArtifactId: imageManifestArtifactId },
    afterAssetRef: { assetId: annotationAssetId, manifestArtifactId: annotationManifestArtifactId },
    caption: 'Verified original and annotation',
    altText: 'Verified original compared with its exact annotation.',
  }, chart];
  return document;
}

function packageVisualManifest(
  assetId: string,
  mediaType: VisualAssetManifest['mediaType'],
): VisualAssetManifest {
  return {
    version: 'visual-asset-manifest-v1',
    ...binding,
    assetId,
    contentSha256: `sha256:${'a'.repeat(64)}`,
    mediaType,
    byteSize: 64,
    width: mediaType === 'image/svg+xml' ? 800 : 1,
    height: mediaType === 'image/svg+xml' ? 450 : 1,
    exportPolicy: 'allow',
    source: mediaType === 'image/svg+xml' ? { kind: 'derived' } : { kind: 'user_upload', fileName: 'verified.png' },
    derivedFrom: mediaType === 'image/svg+xml' ? {
      assetId: imageAssetId,
      manifestArtifactId: imageManifestArtifactId,
      contentSha256: `sha256:${'a'.repeat(64)}`,
      manifestHash: `sha256:${'f'.repeat(64)}`,
    } : null,
    derivation: mediaType === 'image/svg+xml' ? {
      kind: 'chart_svg',
      chartId: 'chart-1',
      specHash: chartSpecHash(packageChartSpec()),
    } : null,
    manifestHash: `sha256:${'f'.repeat(64)}`,
  };
}

interface FixtureVerifiedVisualAsset {
  artifact: ControlArtifact;
  manifestArtifact: ControlArtifact;
  manifest: VisualAssetManifest;
  bytes: Buffer;
  metadata: { contentType: VisualAssetManifest['mediaType']; byteSize: number; width: number; height: number };
}

function packageVerifiedVisualAsset(
  assetId: string,
  manifestArtifactId: string,
  mediaType: VisualAssetManifest['mediaType'],
): FixtureVerifiedVisualAsset {
  const visualManifest = packageVisualManifest(assetId, mediaType);
  return {
    artifact: artifact(assetId, 'visual_asset', 'binary-v1', {
      mediaType,
      contentSha256: visualManifest.contentSha256,
      byteSize: visualManifest.byteSize,
      metadata: { width: visualManifest.width, height: visualManifest.height },
    }),
    manifestArtifact: artifact(manifestArtifactId, 'visual_asset_manifest', 'visual-asset-manifest-v1'),
    manifest: visualManifest,
    bytes: Buffer.from([1, 2, 3]),
    metadata: {
      contentType: mediaType,
      byteSize: visualManifest.byteSize,
      width: visualManifest.width,
      height: visualManifest.height,
    },
  };
}

function packageVerifiedBrowserAsset(
  assetId: string,
  manifestArtifactId: string,
): FixtureVerifiedVisualAsset {
  const visual = packageVerifiedVisualAsset(assetId, manifestArtifactId, 'image/png');
  const manifest: VisualAssetManifestV2 = {
    ...visual.manifest,
    version: 'visual-asset-manifest-v2',
    source: {
      kind: 'browser_capture',
      artifactId: 'tool-output-browser-1',
      artifactContentSha256: `sha256:${'2'.repeat(64)}`,
      jsonPointer: '/output/captures/0',
      attachmentId: 'capture-1',
      sourcePageUrl: 'https://shop.example.test/product',
      finalUrl: 'https://shop.example.test/product?view=assistant',
      pageTitle: 'AI shopping assistant',
      capturedAt: '2026-08-19T08:00:00.000Z',
      captureMode: 'full_page_screenshot',
      viewport: { width: 1440, height: 900 },
    },
    derivedFrom: null,
    derivation: null,
  };
  return {
    ...visual,
    manifestArtifact: {
      ...visual.manifestArtifact,
      schemaVersion: manifest.version,
    },
    manifest,
  };
}

function packageVerifiedChartRender(
  assetId: string,
  manifestArtifactId: string,
): FixtureVerifiedVisualAsset {
  const visual = packageVerifiedVisualAsset(assetId, manifestArtifactId, 'image/svg+xml');
  const manifest: VisualAssetManifestV2 = {
    ...visual.manifest,
    version: 'visual-asset-manifest-v2',
    source: {
      kind: 'chart_render',
      dataArtifactId: 'chart-data-1',
      dataArtifactContentSha256: `sha256:${'3'.repeat(64)}`,
    },
    derivedFrom: null,
    derivation: {
      kind: 'chart_svg',
      chartId: packageChartSpec().chartId,
      specHash: chartSpecHash(packageChartSpec()),
    },
  };
  return {
    ...visual,
    artifact: {
      ...visual.artifact,
      schemaVersion: 'visual-asset-v1',
    },
    manifestArtifact: {
      ...visual.manifestArtifact,
      schemaVersion: manifest.version,
    },
    manifest,
  };
}

function packageVerifiedAnnotation(
  original: FixtureVerifiedVisualAsset,
  lineageOverrides: Partial<NonNullable<VisualAssetManifest['derivedFrom']>> = {},
): FixtureVerifiedVisualAsset {
  const annotation = packageVerifiedVisualAsset(
    annotationAssetId,
    annotationManifestArtifactId,
    'image/png',
  );
  annotation.manifest.source = { kind: 'derived' };
  annotation.manifest.derivedFrom = {
    assetId: original.artifact.id,
    manifestArtifactId: original.manifestArtifact.id,
    contentSha256: original.manifest.contentSha256,
    manifestHash: original.manifest.manifestHash,
    ...lineageOverrides,
  };
  annotation.manifest.derivation = {
    kind: 'annotation',
    overlayArtifactId: 'overlay-annotation-1',
  };
  return annotation;
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

class FixtureVisualAssets {
  readonly reads: Array<{ assetId: string; manifestArtifactId: string; chartId?: string }> = [];
  readonly assets = new Map<string, FixtureVerifiedVisualAsset>();

  add(asset: FixtureVerifiedVisualAsset): void {
    this.assets.set(`${asset.artifact.id}:${asset.manifestArtifact.id}`, asset);
  }

  async readVerified(input: {
    assetId: string;
    manifestArtifactId: string;
    chartId?: string;
  }): Promise<FixtureVerifiedVisualAsset> {
    this.reads.push(input);
    const asset = this.assets.get(`${input.assetId}:${input.manifestArtifactId}`);
    if (!asset) throw new Error('missing verified visual Asset');
    return asset;
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
  reportDocument?: ReportDocument | null;
  visualAssets?: FixtureVerifiedVisualAsset[];
} = {}): {
  reader: CurrentReportPackageReader;
  artifacts: FixtureArtifacts;
  repository: FixtureRepository;
  visualAssets: FixtureVisualAssets;
} {
  const artifacts = new FixtureArtifacts();
  const repository = new FixtureRepository();
  const visualAssets = new FixtureVisualAssets();
  for (const asset of options.visualAssets ?? []) visualAssets.add(asset);
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
  if (options.reportDocument) {
    const reportDocumentArtifact = artifact(
      reportDocumentArtifactId,
      'report_document',
      'report-document-v1',
    );
    artifacts.add(reportDocumentArtifact, options.reportDocument);
    repository.byKind.set('report_document', reportDocumentArtifact);
  }
  const dependencies = { artifacts, repository, visualAssets };
  return {
    reader: new CurrentReportPackageReader(dependencies),
    artifacts,
    repository,
    visualAssets,
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
  assert.equal('visualAssetManifests' in (result ?? {}), false);
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

test('reads screenshot and user-constraint Evidence from their concrete Artifact kinds', async () => {
  const fixture = setup();
  const screenshotArtifactId = 'screenshot-evidence-1';
  const constraintArtifactId = 'constraint-evidence-1';
  const screenshotHash = `sha256:${'2'.repeat(64)}`;
  const constraintHash = `sha256:${'3'.repeat(64)}`;
  const screenshotVisual = packageVerifiedBrowserAsset(
    'asset-source-1',
    screenshotArtifactId,
  );
  screenshotVisual.manifestArtifact.contentSha256 = screenshotHash;
  const screenshotValue = screenshotVisual.manifest;
  const constraintValue = { weights: [{ percentage: 20 }] };
  fixture.visualAssets.add(screenshotVisual);
  fixture.artifacts.add(screenshotVisual.manifestArtifact, screenshotValue);
  fixture.artifacts.add(
    artifact(constraintArtifactId, 'chart_data', 'competitive-weight-chart-data-v1', {
      contentSha256: constraintHash,
    }),
    constraintValue,
  );
  const storedManifest = fixture.artifacts.artifacts.get(manifestArtifactId);
  assert.ok(storedManifest);
  storedManifest.value = new EvidenceService().createManifest({
    ...binding,
    collectedAt: '2026-08-14T10:00:00.000Z',
    entries: [
      ...manifest().entries,
      {
        id: 'screenshot-entry-1',
        kind: 'screenshot',
        evidenceClass: 'screenshot',
        artifactId: screenshotArtifactId,
        artifactContentSha256: screenshotHash,
        jsonPointer: '/assetId',
        sensitivity: 'internal',
        redaction: 'none',
      },
      {
        id: 'constraint-entry-1',
        kind: 'user_constraint',
        evidenceClass: 'user_input',
        artifactId: constraintArtifactId,
        artifactContentSha256: constraintHash,
        jsonPointer: '/weights/0/percentage',
        sensitivity: 'internal',
        redaction: 'none',
      },
    ],
  }, {
    resolveArtifact: (artifactId) => {
      if (artifactId === evidenceArtifactId) {
        return {
          artifact: { id: evidenceArtifactId, contentSha256: evidenceContentSha256 },
          value: evidenceValue(),
        };
      }
      if (artifactId === screenshotArtifactId) {
        return {
          artifact: { id: screenshotArtifactId, contentSha256: screenshotHash },
          value: screenshotValue,
        };
      }
      if (artifactId === constraintArtifactId) {
        return {
          artifact: { id: constraintArtifactId, contentSha256: constraintHash },
          value: constraintValue,
        };
      }
      return null;
    },
  });

  const result = await fixture.reader.read(binding);

  assert.equal(result?.presentationMode, 'current_text');
  assert.ok(fixture.artifacts.reads.includes(screenshotArtifactId));
  assert.ok(fixture.artifacts.reads.includes(constraintArtifactId));
});

test('rejects screenshot Evidence backed only by an unverified Asset shell', async () => {
  const fixture = setup();
  const screenshotArtifactId = 'screenshot-shell-1';
  const screenshotAssetId = 'asset-shell-1';
  const screenshotHash = `sha256:${'4'.repeat(64)}`;
  const screenshotValue = { assetId: screenshotAssetId };
  fixture.artifacts.add(
    artifact(screenshotArtifactId, 'visual_asset_manifest', 'visual-asset-manifest-v1', {
      contentSha256: screenshotHash,
    }),
    screenshotValue,
  );
  const storedManifest = fixture.artifacts.artifacts.get(manifestArtifactId);
  assert.ok(storedManifest);
  storedManifest.value = new EvidenceService().createManifest({
    ...binding,
    collectedAt: '2026-08-14T10:00:00.000Z',
    entries: [
      ...manifest().entries,
      {
        id: 'screenshot-shell-entry-1',
        kind: 'screenshot',
        evidenceClass: 'screenshot',
        artifactId: screenshotArtifactId,
        artifactContentSha256: screenshotHash,
        jsonPointer: '/assetId',
        sensitivity: 'internal',
        redaction: 'none',
      },
    ],
  }, {
    resolveArtifact: (artifactId) => {
      if (artifactId === evidenceArtifactId) {
        return {
          artifact: { id: evidenceArtifactId, contentSha256: evidenceContentSha256 },
          value: evidenceValue(),
        };
      }
      if (artifactId === screenshotArtifactId) {
        return {
          artifact: { id: screenshotArtifactId, contentSha256: screenshotHash },
          value: screenshotValue,
        };
      }
      return null;
    },
  });

  await assert.rejects(
    fixture.reader.read(binding),
    /verified visual asset|missing verified visual asset/i,
  );
  assert.deepEqual(fixture.visualAssets.reads, [{
    assetId: screenshotAssetId,
    manifestArtifactId: screenshotArtifactId,
  }]);
});

test('returns multimodal only from a sealed ReportDocument and its exact verified visual manifest set', async () => {
  const image = packageVerifiedVisualAsset(imageAssetId, imageManifestArtifactId, 'image/png');
  const chart = packageVerifiedVisualAsset(chartAssetId, chartManifestArtifactId, 'image/svg+xml');
  const extra = packageVerifiedVisualAsset('asset-unreferenced', 'manifest-unreferenced', 'image/png');
  const fixture = setup({
    reportDocument: packageReportDocument(),
    visualAssets: [extra, chart, image],
  });

  const result = await fixture.reader.read(binding);

  assert.equal(result?.presentationMode, 'multimodal');
  if (result?.presentationMode !== 'multimodal') assert.fail('expected a multimodal package');
  assert.deepEqual(result.reportDocument, packageReportDocument());
  assert.deepEqual(result.visualAssetManifests, [image.manifest, chart.manifest]);
  assert.equal('visualAssetManifest' in result, false, 'the obsolete singular alias must not survive cutover');
  assert.deepEqual(fixture.visualAssets.reads, [{
    assetId: imageAssetId,
    manifestArtifactId: imageManifestArtifactId,
  }, {
    assetId: chartAssetId,
    manifestArtifactId: chartManifestArtifactId,
    chartId: 'chart-1',
  }]);
  assert.equal(fixture.visualAssets.reads.some(({ assetId }) => assetId === extra.artifact.id), false);
});

test('reads a mixed V2 browser image and V1 Chart package without rewriting either Manifest', async () => {
  const image = packageVerifiedBrowserAsset(imageAssetId, imageManifestArtifactId);
  const chart = packageVerifiedVisualAsset(chartAssetId, chartManifestArtifactId, 'image/svg+xml');
  const fixture = setup({
    reportDocument: packageReportDocument(),
    visualAssets: [image, chart],
  });

  const result = await fixture.reader.read(binding);

  assert.equal(result?.presentationMode, 'multimodal');
  if (result?.presentationMode !== 'multimodal') assert.fail('expected a multimodal package');
  assert.deepEqual(result.visualAssetManifests, [image.manifest, chart.manifest]);
  assert.equal(result.visualAssetManifests[0]?.version, 'visual-asset-manifest-v2');
  assert.equal(result.visualAssetManifests[1]?.version, 'visual-asset-manifest-v1');
  assert.equal(parseControlDeliverableResponse(result).presentationMode, 'multimodal');
});

test('reads and Web-parses a V2 chart_render package before its Writer is enabled', async () => {
  const image = packageVerifiedVisualAsset(imageAssetId, imageManifestArtifactId, 'image/png');
  const chart = packageVerifiedChartRender(chartAssetId, chartManifestArtifactId);
  const fixture = setup({
    reportDocument: packageReportDocument(),
    visualAssets: [image, chart],
  });

  const result = await fixture.reader.read(binding);

  assert.equal(result?.presentationMode, 'multimodal');
  if (result?.presentationMode !== 'multimodal') assert.fail('expected a multimodal package');
  assert.deepEqual(result.visualAssetManifests, [image.manifest, chart.manifest]);
  assert.equal(result.visualAssetManifests[1]?.version, 'visual-asset-manifest-v2');
  assert.equal(result.visualAssetManifests[1]?.source.kind, 'chart_render');
  assert.equal(parseControlDeliverableResponse(result).presentationMode, 'multimodal');
});

test('rejects both V1/V2 Manifest marker crossings before returning a report package', async () => {
  const chart = packageVerifiedVisualAsset(chartAssetId, chartManifestArtifactId, 'image/svg+xml');
  const mismatches = [
    {
      image: packageVerifiedBrowserAsset(imageAssetId, imageManifestArtifactId),
      marker: 'visual-asset-manifest-v1',
    },
    {
      image: packageVerifiedVisualAsset(imageAssetId, imageManifestArtifactId, 'image/png'),
      marker: 'visual-asset-manifest-v2',
    },
  ];

  for (const { image, marker } of mismatches) {
    image.manifestArtifact.schemaVersion = marker;
    const fixture = setup({
      reportDocument: packageReportDocument(),
      visualAssets: [image, chart],
    });
    await assert.rejects(
      fixture.reader.read(binding),
      /manifest.*schema version|schema version.*manifest/i,
    );
  }
});

test('revalidates ReportDocument Chart values, chart_svg specHash, and sealed table before multimodal return', async () => {
  const evidenceMismatch = packageReportDocument();
  const evidenceMismatchBlock = evidenceMismatch.sections
    .flatMap(({ blocks }) => blocks)
    .find(({ type }) => type === 'chart');
  assert.ok(evidenceMismatchBlock?.type === 'chart');
  evidenceMismatchBlock.spec.series[0]!.values[0] = 12;
  evidenceMismatchBlock.specHash = chartSpecHash(evidenceMismatchBlock.spec);
  evidenceMismatchBlock.table = chartTableAlternative(evidenceMismatchBlock.spec);
  const evidenceMismatchChart = packageVerifiedVisualAsset(chartAssetId, chartManifestArtifactId, 'image/svg+xml');
  assert.ok(evidenceMismatchChart.manifest.derivation?.kind === 'chart_svg');
  evidenceMismatchChart.manifest.derivation.specHash = evidenceMismatchBlock.specHash;
  const evidenceMismatchFixture = setup({
    reportDocument: evidenceMismatch,
    visualAssets: [
      packageVerifiedVisualAsset(imageAssetId, imageManifestArtifactId, 'image/png'),
      evidenceMismatchChart,
    ],
  });
  await assert.rejects(
    evidenceMismatchFixture.reader.read(binding),
    /chart|spec|evidence|value|match/i,
  );

  const manifestMismatch = packageVerifiedVisualAsset(chartAssetId, chartManifestArtifactId, 'image/svg+xml');
  assert.ok(manifestMismatch.manifest.derivation?.kind === 'chart_svg');
  manifestMismatch.manifest.derivation.specHash = `sha256:${'d'.repeat(64)}`;
  const manifestMismatchFixture = setup({
    reportDocument: packageReportDocument(),
    visualAssets: [
      packageVerifiedVisualAsset(imageAssetId, imageManifestArtifactId, 'image/png'),
      manifestMismatch,
    ],
  });
  await assert.rejects(
    manifestMismatchFixture.reader.read(binding),
    /chart|specHash|manifest|digest|match/i,
  );

  const tableMismatch = packageReportDocument();
  const tableMismatchBlock = tableMismatch.sections
    .flatMap(({ blocks }) => blocks)
    .find(({ type }) => type === 'chart');
  assert.ok(tableMismatchBlock?.type === 'chart');
  tableMismatchBlock.table.rows[0]!.cells[0] = 12;
  const tableMismatchFixture = setup({
    reportDocument: tableMismatch,
    visualAssets: [
      packageVerifiedVisualAsset(imageAssetId, imageManifestArtifactId, 'image/png'),
      packageVerifiedVisualAsset(chartAssetId, chartManifestArtifactId, 'image/svg+xml'),
    ],
  });
  await assert.rejects(
    tableMismatchFixture.reader.read(binding),
    /chart|table|spec|sealed|match/i,
  );
});

test('rejects image comparisons unless the after Manifest is an exact annotation of the before Asset', async () => {
  const before = packageVerifiedVisualAsset(imageAssetId, imageManifestArtifactId, 'image/png');
  const chart = packageVerifiedVisualAsset(chartAssetId, chartManifestArtifactId, 'image/svg+xml');
  const validAfter = packageVerifiedAnnotation(before);
  const valid = setup({
    reportDocument: packageImageComparisonDocument(),
    visualAssets: [before, validAfter, chart],
  });
  const validResult = await valid.reader.read(binding);
  assert.equal(validResult?.presentationMode, 'multimodal');
  if (validResult?.presentationMode !== 'multimodal') assert.fail('expected a multimodal package');
  assert.deepEqual(validResult.visualAssetManifests, [before.manifest, validAfter.manifest, chart.manifest]);

  const unrelatedAfter = packageVerifiedVisualAsset(
    annotationAssetId,
    annotationManifestArtifactId,
    'image/png',
  );
  const unrelated = setup({
    reportDocument: packageImageComparisonDocument(),
    visualAssets: [before, unrelatedAfter, chart],
  });
  await assert.rejects(
    unrelated.reader.read(binding),
    /image comparison|annotation|derivedFrom|lineage|before|after/i,
  );

  const tamperedLineageCases: Array<{
    name: string;
    overrides: Partial<NonNullable<VisualAssetManifest['derivedFrom']>>;
  }> = [{
    name: 'assetId',
    overrides: { assetId: 'asset-unrelated-original' },
  }, {
    name: 'manifestArtifactId',
    overrides: { manifestArtifactId: 'manifest-unrelated-original' },
  }, {
    name: 'contentSha256',
    overrides: { contentSha256: `sha256:${'d'.repeat(64)}` },
  }, {
    name: 'manifestHash',
    overrides: { manifestHash: `sha256:${'e'.repeat(64)}` },
  }];
  for (const candidate of tamperedLineageCases) {
    const tamperedAfter = packageVerifiedAnnotation(before, candidate.overrides);
    const fixture = setup({
      reportDocument: packageImageComparisonDocument(),
      visualAssets: [before, tamperedAfter, chart],
    });
    await assert.rejects(
      fixture.reader.read(binding),
      /image comparison|annotation|derivedFrom|lineage|before|after/i,
      candidate.name,
    );
  }
});

test('never downgrades a tampered ReportDocument to current_text', async () => {
  const fixture = setup({
    reportDocument: packageReportDocument(),
    visualAssets: [
      packageVerifiedVisualAsset(imageAssetId, imageManifestArtifactId, 'image/png'),
      packageVerifiedVisualAsset(chartAssetId, chartManifestArtifactId, 'image/svg+xml'),
    ],
  });
  fixture.artifacts.tampered.add(reportDocumentArtifactId);

  await assert.rejects(fixture.reader.read(binding), ArtifactIntegrityError);
});

test('rejects multimodal when an image or Chart reference lacks its exact verified Manifest', async () => {
  const missingChart = setup({
    reportDocument: packageReportDocument(),
    visualAssets: [packageVerifiedVisualAsset(imageAssetId, imageManifestArtifactId, 'image/png')],
  });
  await assert.rejects(
    missingChart.reader.read(binding),
    /chart|visual|asset|manifest|verified|missing/i,
  );

  const wrongImageManifest = setup({
    reportDocument: packageReportDocument(),
    visualAssets: [
      packageVerifiedVisualAsset(imageAssetId, 'manifest-wrong-image', 'image/png'),
      packageVerifiedVisualAsset(chartAssetId, chartManifestArtifactId, 'image/svg+xml'),
    ],
  });
  await assert.rejects(
    wrongImageManifest.reader.read(binding),
    /image|visual|asset|manifest|verified|missing/i,
  );
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

test('rejects review-gated deliverables without explicit coverage', async () => {
  const fixture = setup();
  const stored = fixture.artifacts.artifacts.get(deliverableArtifactId);
  assert.ok(stored);
  const value = { ...(stored.value as Record<string, unknown>) };
  delete value.coverage;
  stored.value = value;
  await assert.rejects(fixture.reader.read(binding), /coverage/i);
});

test('returns historical research-deliverable-v1 Artifacts as legacy_text without coverage or a Review', async () => {
  const fixture = setup({ deliverableSchemaVersion: 'research-deliverable-v1', review: null });
  const stored = fixture.artifacts.artifacts.get(deliverableArtifactId);
  assert.ok(stored);
  const value = { ...(stored.value as Record<string, unknown>) };
  delete value.coverage;
  stored.value = value;
  const result = await fixture.reader.read(binding);

  assert.equal(result?.presentationMode, 'legacy_text');
  assert.equal(result?.reportReview, undefined);
  assert.equal('reportDocument' in (result ?? {}), false);
  assert.equal('visualAssetManifest' in (result ?? {}), false);
  assert.equal('visualAssetManifests' in (result ?? {}), false);
});

test('models legacy coverage as optional while current coverage remains required', () => {
  const fullDeliverable = deliverable() as unknown as ResearchDeliverableEnvelope<unknown>;
  const { coverage: _coverage, ...deliverableWithoutCoverage } = fullDeliverable;
  const legacyPackage: CurrentReportPackageResponse = {
    presentationMode: 'legacy_text',
    deliverable: deliverableWithoutCoverage,
    evidenceManifest: manifest(),
  };

  assert.equal(legacyPackage.deliverable.coverage, undefined);

  const currentWithoutCoverage = {
    presentationMode: 'current_text' as const,
    deliverable: deliverableWithoutCoverage,
    evidenceManifest: manifest(),
    reportReview: review(),
  };
  // @ts-expect-error current_text packages require explicit coverage
  const _invalidCurrentPackage: CurrentReportPackageResponse = currentWithoutCoverage;
});

test('types multimodal packages with required ReportDocument and exact plural Visual Asset Manifests', () => {
  const fullDeliverable = deliverable() as unknown as ResearchDeliverableEnvelope<unknown>;
  const visualAssetManifests = [
    packageVisualManifest(imageAssetId, 'image/png'),
    packageVisualManifest(chartAssetId, 'image/svg+xml'),
  ];
  const multimodalPackage: CurrentReportPackageResponse = {
    presentationMode: 'multimodal',
    deliverable: fullDeliverable,
    evidenceManifest: manifest(),
    reportReview: review() as ReportReviewArtifact & { verdict: 'pass' },
    reportDocument: packageReportDocument(),
    visualAssetManifests,
  };
  assert.deepEqual(multimodalPackage.visualAssetManifests, visualAssetManifests);

  // @ts-expect-error multimodal packages require a ReportDocument
  const _missingDocument: CurrentReportPackageResponse = {
    presentationMode: 'multimodal',
    deliverable: fullDeliverable,
    evidenceManifest: manifest(),
    reportReview: review() as ReportReviewArtifact & { verdict: 'pass' },
    visualAssetManifests,
  };
  // @ts-expect-error multimodal packages require at least the exact referenced Visual Asset Manifests
  const _missingManifests: CurrentReportPackageResponse = {
    presentationMode: 'multimodal',
    deliverable: fullDeliverable,
    evidenceManifest: manifest(),
    reportReview: review() as ReportReviewArtifact & { verdict: 'pass' },
    reportDocument: packageReportDocument(),
  };
  // @ts-expect-error current_text must remain free of Phase 5 ReportDocument fields
  const _invalidCurrentMultimodalFields: CurrentReportPackageResponse = {
    presentationMode: 'current_text',
    deliverable: fullDeliverable,
    evidenceManifest: manifest(),
    reportReview: review() as ReportReviewArtifact & { verdict: 'pass' },
    reportDocument: packageReportDocument(),
    visualAssetManifests,
  };
});

test('narrows final package Reviews to pass verdicts', () => {
  const fullDeliverable = deliverable() as unknown as ResearchDeliverableEnvelope<unknown>;
  const currentWithRevision = {
    presentationMode: 'current_text' as const,
    deliverable: fullDeliverable,
    evidenceManifest: manifest(),
    reportReview: review({ verdict: 'revise' }),
  };
  // @ts-expect-error final current_text packages require a pass Review
  const _invalidCurrentReview: CurrentReportPackageResponse = currentWithRevision;

  const multimodalWithBlock = {
    presentationMode: 'multimodal' as const,
    deliverable: fullDeliverable,
    evidenceManifest: manifest(),
    reportReview: review({ verdict: 'block' }),
  };
  // @ts-expect-error final multimodal packages require a pass Review
  const _invalidMultimodalReview: CurrentReportPackageResponse = multimodalWithBlock;
});

test('never silently downgrades an unknown deliverable schema marker', async () => {
  const { reader } = setup({ deliverableSchemaVersion: 'unexpected-deliverable-v2', review: null });
  await assert.rejects(reader.read(binding), /schema|marker/i);
});


test('runtime package client validates text modes and fail-closes multimodal package shape', () => {
  const legacy = {
    presentationMode: 'legacy_text',
    deliverable: deliverable(),
    evidenceManifest: manifest(),
  };
  assert.equal(parseControlDeliverableResponse(legacy).presentationMode, 'legacy_text');

  const current = {
    presentationMode: 'current_text',
    deliverable: deliverable(),
    evidenceManifest: manifest(),
    reportReview: review(),
  };
  assert.equal(parseControlDeliverableResponse(current).presentationMode, 'current_text');
  assert.throws(
    () => parseControlDeliverableResponse({ ...current, presentationMode: 'future_mode' }),
    /presentationMode|mode/i,
  );
  assert.throws(
    () => parseControlDeliverableResponse({ ...current, reportReview: review({ verdict: 'revise' }) }),
    /pass|verdict|review/i,
  );

  const image = packageVisualManifest(imageAssetId, 'image/png');
  const chart = packageVisualManifest(chartAssetId, 'image/svg+xml');
  const multimodal = {
    ...current,
    presentationMode: 'multimodal',
    reportDocument: packageReportDocument(),
    visualAssetManifests: [image, chart],
  };
  assert.equal(parseControlDeliverableResponse(multimodal).presentationMode, 'multimodal');
  const browser = packageVerifiedBrowserAsset(imageAssetId, imageManifestArtifactId).manifest;
  assert.equal(parseControlDeliverableResponse({
    ...multimodal,
    visualAssetManifests: [browser, chart],
  }).presentationMode, 'multimodal');
  assert.throws(
    () => parseControlDeliverableResponse({
      ...multimodal,
      visualAssetManifests: [{ ...browser, version: 'visual-asset-manifest-v1' }, chart],
    }),
    /visual asset|manifest|source|schema/i,
  );
  assert.throws(
    () => parseControlDeliverableResponse({
      ...multimodal,
      visualAssetManifests: [{ ...browser, version: 'visual-asset-manifest-v3' }, chart],
    }),
    /visual asset|manifest|version|schema/i,
  );
  const { exportPolicy: _exportPolicy, ...imageWithoutExportPolicy } = image;
  const { mediaType: _mediaType, ...imageWithoutMediaType } = image;
  const wrongBindingManifests = (['taskId', 'planVersionId', 'attemptId'] as const).map((field) => ({
    ...multimodal,
    visualAssetManifests: [{ ...image, [field]: `foreign-${field}` }, chart],
  }));

  for (const invalid of [
    { ...multimodal, reportDocument: undefined },
    { ...multimodal, visualAssetManifests: undefined },
    { ...multimodal, visualAssetManifests: [] },
    { ...multimodal, visualAssetManifests: [image] },
    {
      ...multimodal,
      visualAssetManifests: [
        image,
        chart,
        packageVisualManifest('asset-unreferenced', 'image/png'),
      ],
    },
    {
      ...multimodal,
      visualAssetManifests: undefined,
      visualAssetManifest: image,
    },
    { ...multimodal, visualAssetManifests: [imageWithoutExportPolicy, chart] },
    { ...multimodal, visualAssetManifests: [imageWithoutMediaType, chart] },
    ...wrongBindingManifests,
  ]) {
    assert.throws(
      () => parseControlDeliverableResponse(invalid),
      /report document|visual asset|manifest|multimodal|reference/i,
    );
  }

  assert.throws(
    () => parseControlDeliverableResponse({
      ...current,
      reportDocument: packageReportDocument(),
      visualAssetManifests: [image, chart],
    }),
    /current_text|multimodal|report document|visual asset/i,
  );
  assert.throws(
    () => parseControlDeliverableResponse({ ...legacy, visualAssetManifests: [image] }),
    /legacy_text|multimodal|visual asset/i,
  );
});

test('runtime package client accepts only null-lineage V2 chart_render Manifests', () => {
  const image = packageVisualManifest(imageAssetId, 'image/png');
  const chart = packageVerifiedChartRender(chartAssetId, chartManifestArtifactId).manifest;
  const multimodal = {
    presentationMode: 'multimodal',
    deliverable: deliverable(),
    evidenceManifest: manifest(),
    reportReview: review(),
    reportDocument: packageReportDocument(),
    visualAssetManifests: [image, chart],
  };

  assert.equal(parseControlDeliverableResponse(multimodal).presentationMode, 'multimodal');

  const wrongLineage = {
    ...chart,
    derivedFrom: {
      assetId: image.assetId,
      manifestArtifactId: imageManifestArtifactId,
      contentSha256: image.contentSha256,
      manifestHash: image.manifestHash,
    },
  };
  const wrongDerivation = { ...chart, derivation: null };
  for (const invalid of [wrongLineage, wrongDerivation]) {
    assert.throws(
      () => parseControlDeliverableResponse({
        ...multimodal,
        visualAssetManifests: [image, invalid],
      }),
      /visual asset|manifest|chart_render|lineage|derivation/i,
    );
  }
});
