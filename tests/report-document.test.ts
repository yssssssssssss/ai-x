import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { ControlArtifact } from '../database/control-plane.ts';
import {
  REPORT_REVIEW_DIMENSION_IDS,
  type ReportReviewArtifact,
} from '../packages/api-contract/control-workflow.ts';
import type {
  ChartSpec,
  ResearchDeliverableEnvelope,
  ResearchPlanPayload,
  VisualAssetManifest,
} from '../packages/api-contract/research-deliverable.ts';
import {
  EvidenceService,
  type EvidenceArtifactResolver,
  type EvidenceManifest,
  type ResolvedEvidenceArtifact,
} from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import { ReportEvidenceValidator } from '../apps/orchestrator-runtime/src/evidence/report-evidence-validator.ts';
import {
  assertValidReportDocument,
  composeReportDocument,
  type ReportChartReference,
  type ReportDocument,
  type ReportDocumentReferenceContext,
} from '../apps/orchestrator-runtime/src/report/report-document-composer.ts';
import type { VerifiedVisualAsset } from '../apps/orchestrator-runtime/src/report/visual-asset-service.ts';
import type { ChartTableAlternative } from '../apps/orchestrator-runtime/src/report/chart-renderer.ts';
import { assertValidReportReviewArtifact } from '../apps/orchestrator-runtime/src/report/report-review-service.ts';
import {
  SchemaValidationError,
  SchemaValidator,
} from '../apps/orchestrator-runtime/src/schema/validator.ts';

const binding = {
  taskId: 'task-report-document-1',
  planVersionId: 'plan-report-document-1',
  attemptId: 'attempt-report-document-1',
};
const deliverableArtifactId = 'deliverable-report-document-1';
const evidenceManifestArtifactId = 'evidence-manifest-report-document-1';
const evidenceArtifactId = 'evidence-source-report-document-1';
const reviewArtifactId = 'review-report-document-1';
const imageAssetId = 'asset-image-report-document-1';
const imageManifestArtifactId = 'manifest-image-report-document-1';
const chartAssetId = 'asset-chart-report-document-1';
const chartManifestArtifactId = 'manifest-chart-report-document-1';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const CHART_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450"></svg>',
);
const resolvedEvidenceArtifact: ResolvedEvidenceArtifact = {
  artifact: { id: evidenceArtifactId, contentSha256: sha('e') },
  value: { metrics: { competitorScore: 87 } },
};
const evidenceArtifactResolver: EvidenceArtifactResolver = {
  resolveArtifact: (artifactId) => artifactId === evidenceArtifactId ? resolvedEvidenceArtifact : null,
};
const REQUIRED_SECTION_IDS = [
  'cover',
  'executive-summary',
  'background',
  'scope-method',
  'key-metrics',
  'findings',
  'question-analysis',
  'visual-evidence',
  'comparison',
  'conclusion',
  'recommendations',
  'risks',
  'appendix',
] as const;

function sha(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function prettyJsonBytes(value: unknown): Buffer {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new TypeError('fixture value is not JSON serializable');
  return Buffer.from(serialized);
}

function sealedJsonArtifact(
  id: string,
  kind: string,
  schemaVersion: string,
  value: unknown,
  overrides: Partial<ControlArtifact> = {},
): ControlArtifact {
  const bytes = prettyJsonBytes(value);
  return artifact(id, kind, schemaVersion, {
    contentSha256: digest(bytes),
    byteSize: bytes.byteLength,
    ...overrides,
  });
}

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
    storageUri: `/private/${id}`,
    contentSha256: sha('a'),
    byteSize: 128,
    schemaVersion,
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
    failureReason: null,
    mediaType: null,
    metadata: null,
    ...overrides,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

function canonicalHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function researchPlanPayload(): ResearchPlanPayload {
  return {
    title: 'Verified pet nutrition competitive research plan',
    researchGoal: 'Compare verified positioning, pricing, and channel evidence.',
    scope: {
      market: 'Mainland China',
      subjects: ['Dog supplements', 'Cat supplements'],
      timeWindow: 'Previous twelve months',
    },
    competitorSampling: {
      strategy: 'Stratified by market visibility and product coverage',
      targetCount: 6,
      inclusionCriteria: ['Public product and brand evidence is available'],
      exclusionCriteria: ['Discontinued products without verifiable sources'],
    },
    researchQuestions: ['How do leading competitors position their products?'],
    comparisonDimensions: [{
      id: 'positioning',
      name: 'Product positioning',
      purpose: 'Compare target users, use cases, and claims.',
      collectionFields: ['Target pet', 'Use case', 'Core claim'],
    }],
    sourcePlan: [{
      evidenceClass: 'public_source',
      sourceTypes: ['Brand website', 'Commerce product page'],
      purpose: 'Verify positioning and product facts.',
    }],
    executionPlan: [{
      phase: 'Evidence collection',
      activities: ['Collect public evidence for sampled competitors'],
      duration: '2 business days',
      outputs: ['Verified competitor evidence table'],
    }],
    collectionTemplate: [{
      field: 'Core claim',
      description: 'The public product value proposition.',
      evidenceRequired: true,
    }],
    analysisMethods: ['Cross-competitor comparison'],
    deliverables: ['Competitive research report'],
    qualityChecks: ['Every fact is bound to Evidence'],
  };
}

function deliverable(): ResearchDeliverableEnvelope<ResearchPlanPayload> {
  return {
    version: 'research-deliverable-v1',
    ...binding,
    deliverableType: 'research_plan',
    evidenceManifestArtifactId,
    methodSummary: 'Verified public-source comparison with explicit Evidence bindings.',
    findingGraph: {
      findings: [{
        id: 'finding-1',
        kind: 'fact',
        statement: 'Competitor A leads the verified comparison metric.',
        evidenceIds: ['evidence-1'],
      }],
      analyses: [{
        id: 'analysis-1',
        statement: 'The verified metric supports a differentiated positioning opportunity.',
        findingIds: ['finding-1'],
      }],
      subQuestionSummaries: [{
        id: 'summary-1',
        summary: 'Leading competitors use distinct positioning claims.',
        findingIds: ['finding-1'],
        analysisIds: ['analysis-1'],
      }],
      overallConclusions: [{
        id: 'conclusion-1',
        statement: 'A focused positioning strategy is supported by the verified comparison.',
        summaryIds: ['summary-1'],
      }],
    },
    payload: researchPlanPayload(),
    recommendations: [{
      id: 'recommendation-1',
      statement: 'Prioritize the differentiated positioning opportunity.',
      summaryIds: ['summary-1'],
    }],
    coverage: {
      questionBindings: [{ questionId: 'question-1', summaryIds: ['summary-1'] }],
      successCriterionBindings: [{
        successCriterionId: 'criterion-1',
        conclusionIds: ['conclusion-1'],
        recommendationIds: ['recommendation-1'],
      }],
    },
    risksAndOpenIssues: ['Public pricing can change after collection.'],
    capabilityProvenance: [],
  };
}

function evidenceManifest(): EvidenceManifest {
  return new EvidenceService().createManifest({
    ...binding,
    collectedAt: '2026-08-16T00:00:00.000Z',
    entries: [{
      id: 'evidence-1',
      kind: 'tool_output',
      evidenceClass: 'dataset',
      artifactId: evidenceArtifactId,
      artifactContentSha256: sha('e'),
      jsonPointer: '/metrics/competitorScore',
      sensitivity: 'internal',
      redaction: 'none',
    }],
  }, evidenceArtifactResolver);
}

function review(overrides: Partial<ReportReviewArtifact> = {}): ReportReviewArtifact {
  return {
    version: 'report-review-v1',
    ...binding,
    deliverableArtifactId,
    verdict: 'pass',
    dimensions: REPORT_REVIEW_DIMENSION_IDS.map((id) => ({ id, passed: true, issues: [] })),
    revisionRound: 0,
    ...overrides,
  };
}

function visualManifest(input: {
  assetId: string;
  mediaType: VisualAssetManifest['mediaType'];
  bytes: Uint8Array;
  width: number;
  height: number;
  derivedFrom: VisualAssetManifest['derivedFrom'];
  derivation: VisualAssetManifest['derivation'];
}): VisualAssetManifest {
  const draft: Omit<VisualAssetManifest, 'manifestHash'> = {
    version: 'visual-asset-manifest-v1',
    ...binding,
    assetId: input.assetId,
    contentSha256: digest(input.bytes),
    mediaType: input.mediaType,
    byteSize: input.bytes.byteLength,
    width: input.width,
    height: input.height,
    exportPolicy: 'allow',
    source: input.derivedFrom ? { kind: 'derived' } : { kind: 'user_upload', fileName: 'verified.png' },
    derivedFrom: input.derivedFrom,
    derivation: input.derivation,
  };
  return { ...draft, manifestHash: canonicalHash(draft) };
}

function verifiedImage(): VerifiedVisualAsset {
  const manifest = visualManifest({
    assetId: imageAssetId,
    mediaType: 'image/png',
    bytes: PNG,
    width: 1,
    height: 1,
    derivedFrom: null,
    derivation: null,
  });
  return {
    artifact: artifact(imageAssetId, 'visual_asset', 'binary-v1', {
      contentSha256: manifest.contentSha256,
      byteSize: manifest.byteSize,
      mediaType: manifest.mediaType,
      metadata: { width: manifest.width, height: manifest.height },
    }),
    bytes: Buffer.from(PNG),
    metadata: {
      contentType: manifest.mediaType,
      byteSize: manifest.byteSize,
      width: manifest.width,
      height: manifest.height,
    },
    manifest,
    manifestArtifact: sealedJsonArtifact(
      imageManifestArtifactId,
      'visual_asset_manifest',
      'visual-asset-manifest-v1',
      manifest,
    ),
  };
}

function chartSpec(): ChartSpec {
  return {
    version: 'chart-spec-v1',
    chartId: 'chart-1',
    type: 'comparison',
    title: 'Verified competitor score',
    categories: ['Competitor score'],
    series: [{
      key: 'competitor:a',
      label: 'Competitor A',
      values: [87],
      evidenceIds: [['evidence-1']],
    }],
    yAxis: { min: 0 },
  };
}

function chartTable(spec: ChartSpec): ChartTableAlternative {
  return {
    caption: spec.title,
    columns: ['Series', ...spec.categories],
    rows: spec.series.map((series) => ({
      key: series.key,
      label: series.label,
      cells: [...series.values],
      evidenceIds: series.evidenceIds.map((ids) => [...ids]),
    })),
  };
}

interface VerifiedChartFixture {
  spec: ChartSpec;
  specHash: string;
  table: ChartTableAlternative;
  asset: VerifiedVisualAsset;
}

function verifiedChart(): VerifiedChartFixture {
  const spec = chartSpec();
  const specHash = canonicalHash(spec);
  const original = verifiedImage();
  const manifest = visualManifest({
    assetId: chartAssetId,
    mediaType: 'image/svg+xml',
    bytes: CHART_SVG,
    width: 800,
    height: 450,
    derivedFrom: {
      assetId: original.manifest.assetId,
      manifestArtifactId: original.manifestArtifact.id,
      contentSha256: original.manifest.contentSha256,
      manifestHash: original.manifest.manifestHash,
    },
    derivation: {
      kind: 'chart_svg',
      chartId: spec.chartId,
      specHash,
    } as unknown as VisualAssetManifest['derivation'],
  });
  return {
    spec,
    specHash,
    table: chartTable(spec),
    asset: {
      artifact: artifact(chartAssetId, 'visual_asset', 'binary-v1', {
        contentSha256: manifest.contentSha256,
        byteSize: manifest.byteSize,
        mediaType: manifest.mediaType,
        metadata: { width: manifest.width, height: manifest.height },
      }),
      bytes: Buffer.from(CHART_SVG),
      metadata: {
        contentType: manifest.mediaType,
        byteSize: manifest.byteSize,
        width: manifest.width,
        height: manifest.height,
      },
      manifest,
      manifestArtifact: sealedJsonArtifact(
        chartManifestArtifactId,
        'visual_asset_manifest',
        'visual-asset-manifest-v1',
        manifest,
      ),
    },
  };
}

function composeInput() {
  const deliverableValue = deliverable();
  const evidenceManifestValue = evidenceManifest();
  const reviewValue = review();
  return {
    templateId: 'research-plan' as const,
    requiredQuestionIds: ['question-1'],
    deliverable: {
      artifact: sealedJsonArtifact(
        deliverableArtifactId,
        'deliverable',
        'research-deliverable-v1-review-gated',
        deliverableValue,
      ),
      value: deliverableValue,
    },
    evidenceManifest: {
      artifact: sealedJsonArtifact(
        evidenceManifestArtifactId,
        'evidence_manifest',
        'evidence-v1',
        evidenceManifestValue,
      ),
      value: evidenceManifestValue,
    },
    evidenceResolver: (evidenceId: string): unknown | undefined => evidenceId === 'evidence-1' ? 87 : undefined,
    evidenceArtifactResolver,
    review: {
      artifact: sealedJsonArtifact(
        reviewArtifactId,
        'report_review',
        'report-review-v1',
        reviewValue,
      ),
      value: reviewValue,
    },
    visualAssets: [verifiedImage()],
    charts: [verifiedChart()],
  };
}

function resealChartForCurrentSpec(chart: VerifiedChartFixture): void {
  chart.specHash = canonicalHash(chart.spec);
  const { manifestHash: _manifestHash, ...manifestDraft } = chart.asset.manifest;
  const reboundDraft = {
    ...manifestDraft,
    derivation: {
      kind: 'chart_svg' as const,
      chartId: chart.spec.chartId,
      specHash: chart.specHash,
    },
  };
  chart.asset.manifest = {
    ...reboundDraft,
    manifestHash: canonicalHash(reboundDraft),
  } as unknown as VisualAssetManifest;
  chart.asset.manifestArtifact = sealedJsonArtifact(
    chart.asset.manifestArtifact.id,
    'visual_asset_manifest',
    'visual-asset-manifest-v1',
    chart.asset.manifest,
  );
}

function referenceContext(): Omit<ReportDocumentReferenceContext, 'charts'> & {
  charts: Array<ReportChartReference & { specHash: string }>;
} {
  const sealedChart = verifiedChart();
  const derivation = sealedChart.asset.manifest.derivation as unknown as {
    kind: 'chart_svg';
    chartId: string;
    specHash: string;
  };
  return {
    requiredQuestionIds: ['question-1'],
    evidenceIds: ['evidence-1'],
    visualAssets: [{ assetId: imageAssetId, manifestArtifactId: imageManifestArtifactId }],
    charts: [{
      chartId: derivation.chartId,
      assetId: chartAssetId,
      manifestArtifactId: chartManifestArtifactId,
      specHash: derivation.specHash,
    }],
  };
}

function reportDocument(): ReportDocument {
  const sections: ReportDocument['sections'] = REQUIRED_SECTION_IDS.map((id) => ({
    id,
    title: id,
    questionIds: id === 'question-analysis' ? ['question-1'] : [],
    blocks: [{ id: `${id}-paragraph`, type: 'paragraph' as const, text: `Content for ${id}.` }],
  }));
  const findings = sections.find(({ id }) => id === 'findings')!;
  findings.blocks = [{
    id: 'fact-1',
    type: 'fact',
    text: 'Competitor A leads the verified comparison metric.',
    evidenceIds: ['evidence-1'],
  }];
  const visuals = sections.find(({ id }) => id === 'visual-evidence')!;
  visuals.blocks = [{
    id: 'image-1',
    type: 'image',
    assetRef: { assetId: imageAssetId, manifestArtifactId: imageManifestArtifactId },
    caption: 'Verified source image',
    altText: 'A verified source image supporting finding one.',
  }];
  const comparisons = sections.find(({ id }) => id === 'comparison')!;
  comparisons.blocks = [{
    id: 'chart-1-block',
    type: 'chart',
    chartRef: {
      chartId: 'chart-1',
      assetId: chartAssetId,
      manifestArtifactId: chartManifestArtifactId,
    },
    specHash: canonicalHash(chartSpec()),
    spec: chartSpec(),
    table: chartTable(chartSpec()),
    caption: 'Verified competitor score comparison',
    altText: 'Competitor A has a verified score of 87.',
  } as unknown as ReportDocument['sections'][number]['blocks'][number]];
  return {
    version: 'report-document-v1',
    title: 'Verified pet nutrition competitive research plan',
    subtitle: 'Professional research plan',
    executiveSummary: 'Verified evidence supports a differentiated positioning opportunity.',
    sections,
  };
}

const schemaValidator = new SchemaValidator();

test('report-document schema rejects a document without an executive summary', () => {
  const candidate = reportDocument() as unknown as Record<string, unknown>;
  delete candidate.executiveSummary;

  assert.throws(
    () => schemaValidator.validateOrThrow('report-document', candidate),
    SchemaValidationError,
  );
});

test('report-document schema rejects a Fact block without Evidence', () => {
  const candidate = reportDocument();
  const findings = candidate.sections.find(({ id }) => id === 'findings')!;
  findings.blocks = [{
    id: 'unsupported-fact',
    type: 'fact',
    text: 'A factual claim cannot stand without Evidence.',
    evidenceIds: [],
  }];

  assert.throws(
    () => schemaValidator.validateOrThrow('report-document', candidate),
    SchemaValidationError,
  );
});

test('ReportDocument validation rejects dangling visual Asset and Chart references', () => {
  const danglingAsset = reportDocument();
  const image = danglingAsset.sections
    .flatMap(({ blocks }) => blocks)
    .find(({ type }) => type === 'image');
  assert.ok(image && image.type === 'image');
  image.assetRef.assetId = 'missing-asset';
  assert.throws(
    () => assertValidReportDocument(danglingAsset, referenceContext()),
    /asset|dangling|missing/i,
  );

  const danglingChart = reportDocument();
  const chart = danglingChart.sections
    .flatMap(({ blocks }) => blocks)
    .find(({ type }) => type === 'chart');
  assert.ok(chart && chart.type === 'chart');
  chart.chartRef.chartId = 'missing-chart';
  assert.throws(
    () => assertValidReportDocument(danglingChart, referenceContext()),
    /chart|dangling|missing/i,
  );
});

test('ReportDocument validation rejects duplicate section and block ids', () => {
  const duplicateSection = reportDocument();
  duplicateSection.sections[1]!.id = duplicateSection.sections[0]!.id;
  assert.throws(
    () => assertValidReportDocument(duplicateSection, referenceContext()),
    /section|duplicate|unique/i,
  );

  const duplicateBlock = reportDocument();
  duplicateBlock.sections[1]!.blocks[0]!.id = duplicateBlock.sections[0]!.blocks[0]!.id;
  assert.throws(
    () => assertValidReportDocument(duplicateBlock, referenceContext()),
    /block|duplicate|unique/i,
  );
});

test('ReportDocument validation rejects a required question not assigned to any section', () => {
  const candidate = reportDocument();
  for (const section of candidate.sections) section.questionIds = [];

  assert.throws(
    () => assertValidReportDocument(candidate, referenceContext()),
    /question-1|required question|section/i,
  );
});

test('composer rejects a Review that did not pass or is bound to another Deliverable', () => {
  const notPassed = composeInput();
  notPassed.review.value = review({
    verdict: 'revise',
    dimensions: REPORT_REVIEW_DIMENSION_IDS.map((id, index) => ({
      id,
      passed: index !== 0,
      issues: index === 0 ? ['Question coverage needs revision.'] : [],
    })),
  });
  notPassed.review.artifact = sealedJsonArtifact(
    reviewArtifactId,
    'report_review',
    'report-review-v1',
    notPassed.review.value,
  );
  assert.throws(() => composeReportDocument(notPassed), /review|pass|verdict/i);

  const wrongBinding = composeInput();
  wrongBinding.review.value = review({ deliverableArtifactId: 'another-deliverable' });
  wrongBinding.review.artifact = sealedJsonArtifact(
    reviewArtifactId,
    'report_review',
    'report-review-v1',
    wrongBinding.review.value,
  );
  assert.throws(
    () => composeReportDocument(wrongBinding),
    /review|deliverable|binding|another-deliverable/i,
  );
});

test('composer rejects inputs that are not SEALED verified artifacts', () => {
  const cases: Array<{ name: string; mutate: (input: ReturnType<typeof composeInput>) => void }> = [
    {
      name: 'Deliverable',
      mutate: (input) => { input.deliverable.artifact.state = 'STAGING'; },
    },
    {
      name: 'Evidence Manifest',
      mutate: (input) => { input.evidenceManifest.artifact.state = 'STAGING'; },
    },
    {
      name: 'Visual Asset',
      mutate: (input) => { input.visualAssets[0]!.artifact.state = 'STAGING'; },
    },
    {
      name: 'Chart Manifest',
      mutate: (input) => { input.charts[0]!.asset.manifestArtifact.state = 'STAGING'; },
    },
    {
      name: 'Review',
      mutate: (input) => { input.review.artifact.state = 'STAGING'; },
    },
  ];

  for (const candidate of cases) {
    const input = composeInput();
    candidate.mutate(input);
    assert.throws(
      () => composeReportDocument(input),
      new RegExp(`${candidate.name}|sealed|verified`, 'i'),
      candidate.name,
    );
  }
});

test('composer rejects a Chart whose sealed visual derivation is bound to another chart id', () => {
  const input = composeInput();
  const chart = input.charts[0]!;
  const { manifestHash: _manifestHash, ...manifestDraft } = chart.asset.manifest;
  const changedDraft = {
    ...manifestDraft,
    derivation: {
      kind: 'chart_svg' as const,
      chartId: 'another-chart',
      specHash: chart.specHash,
    },
  };
  chart.asset.manifest = {
    ...changedDraft,
    manifestHash: canonicalHash(changedDraft),
  } as unknown as VisualAssetManifest;
  chart.asset.manifestArtifact = sealedJsonArtifact(
    chart.asset.manifestArtifact.id,
    'visual_asset_manifest',
    'visual-asset-manifest-v1',
    chart.asset.manifest,
  );

  assert.throws(
    () => composeReportDocument(input),
    /chart|derivation|binding|another-chart/i,
  );
});

test('composer omits visual blocks rather than generating placeholders when no visual data exists', () => {
  const input = composeInput();
  input.visualAssets = [];
  input.charts = [];

  const document = composeReportDocument(input);
  const blocks = document.sections.flatMap(({ blocks }) => blocks);

  assert.equal(blocks.some(({ type }) => ['image', 'image-comparison', 'chart'].includes(type)), false);
  assert.equal(JSON.stringify(document).toLowerCase().includes('placeholder'), false);
  assert.deepEqual(document.sections.map(({ id }) => id), [...REQUIRED_SECTION_IDS]);
});

test('composer creates a schema-valid professional research-plan document with ordered sections and sealed references', () => {
  const input = composeInput();
  const document = composeReportDocument(input);

  assert.doesNotThrow(() => schemaValidator.validateOrThrow('report-document', document));
  assert.doesNotThrow(() => assertValidReportDocument(document, referenceContext()));
  assert.equal(document.title, input.deliverable.value.payload.title);
  assert.ok(document.executiveSummary.trim().length > 0);
  assert.deepEqual(document.sections.map(({ id }) => id), [...REQUIRED_SECTION_IDS]);
  assert.ok(document.sections.some(({ questionIds }) => questionIds.includes('question-1')));

  const blocks = document.sections.flatMap(({ blocks }) => blocks);
  const facts = blocks.filter(({ type }) => type === 'fact');
  assert.ok(facts.length > 0);
  for (const fact of facts) {
    assert.ok(fact.type === 'fact' && fact.evidenceIds.length > 0);
  }

  const image = blocks.find(({ type }) => type === 'image');
  assert.ok(image && image.type === 'image');
  assert.deepEqual(image.assetRef, {
    assetId: imageAssetId,
    manifestArtifactId: imageManifestArtifactId,
  });

  const chart = blocks.find(({ type }) => type === 'chart');
  assert.ok(chart && chart.type === 'chart');
  assert.deepEqual(chart.chartRef, {
    chartId: 'chart-1',
    assetId: chartAssetId,
    manifestArtifactId: chartManifestArtifactId,
  });
});

test('composer accepts production-realistic Manifest Artifact serialization distinct from canonical manifestHash', () => {
  const valid = composeInput();
  for (const asset of [valid.visualAssets[0]!, valid.charts[0]!.asset]) {
    const serializedManifest = prettyJsonBytes(asset.manifest);
    assert.notEqual(asset.manifest.manifestHash, digest(serializedManifest));
    assert.equal(asset.manifestArtifact.contentSha256, digest(serializedManifest));
    assert.equal(asset.manifestArtifact.byteSize, serializedManifest.byteLength);
  }
  assert.doesNotThrow(() => composeReportDocument(valid));
});

test('composer rejects a tampered serialized Manifest Artifact hash or byte size', () => {
  const tamperedHash = composeInput();
  tamperedHash.visualAssets[0]!.manifestArtifact.contentSha256 = sha('f');
  assert.throws(
    () => composeReportDocument(tamperedHash),
    /Manifest.*(hash|content|integrity)|serialized/i,
  );

  const tamperedSize = composeInput();
  tamperedSize.visualAssets[0]!.manifestArtifact.byteSize! += 1;
  assert.throws(
    () => composeReportDocument(tamperedSize),
    /Manifest.*(size|bytes|integrity)|serialized/i,
  );
});
test('composer binds Deliverable, Evidence Manifest, and Review values to exact sealed pretty-JSON bytes', () => {
  const tamperedDeliverable = composeInput();
  tamperedDeliverable.visualAssets = [];
  tamperedDeliverable.charts = [];
  tamperedDeliverable.deliverable.value.payload.title = 'Unreviewed replacement title';
  assert.throws(
    () => composeReportDocument(tamperedDeliverable),
    /Deliverable.*(hash|size|bytes|content|integrity)|sealed JSON/i,
  );

  const tamperedEvidenceManifest = composeInput();
  tamperedEvidenceManifest.visualAssets = [];
  tamperedEvidenceManifest.charts = [];
  const { manifestHash: _manifestHash, ...evidenceDraft } = tamperedEvidenceManifest.evidenceManifest.value;
  const changedEvidenceDraft = {
    ...evidenceDraft,
    collectedAt: '2026-08-16T01:00:00.000Z',
  };
  tamperedEvidenceManifest.evidenceManifest.value = {
    ...changedEvidenceDraft,
    manifestHash: canonicalHash(changedEvidenceDraft),
  };
  assert.throws(
    () => composeReportDocument(tamperedEvidenceManifest),
    /Evidence Manifest.*(hash|size|bytes|content|integrity)|sealed JSON/i,
  );

  const tamperedReview = composeInput();
  tamperedReview.visualAssets = [];
  tamperedReview.charts = [];
  tamperedReview.review.value.revisionRound = 1;
  assert.throws(
    () => composeReportDocument(tamperedReview),
    /Review.*(hash|size|bytes|content|integrity)|sealed JSON/i,
  );
});

test('composer validates ChartSpec values through the real Evidence resolver and binds the exact spec digest', () => {
  const mismatchedValue = composeInput();
  mismatchedValue.charts[0]!.spec.series[0]!.values[0] = 12;
  mismatchedValue.charts[0]!.table = chartTable(mismatchedValue.charts[0]!.spec);
  resealChartForCurrentSpec(mismatchedValue.charts[0]!);
  assert.throws(
    () => composeReportDocument(mismatchedValue),
    /Chart Spec|value.*Evidence|Evidence.*value|match/i,
  );

  const anotherSpecWithSameId = composeInput();
  anotherSpecWithSameId.charts[0]!.spec.title = 'Another spec reusing chart-1';
  anotherSpecWithSameId.charts[0]!.table = chartTable(anotherSpecWithSameId.charts[0]!.spec);
  assert.equal(anotherSpecWithSameId.charts[0]!.spec.chartId, 'chart-1');
  assert.throws(
    () => composeReportDocument(anotherSpecWithSameId),
    /Chart.*(spec|digest|hash|identity|pair)|SVG.*spec/i,
  );
});

test('ReportDocument chart block carries the validated ChartSpec digest and tabular text alternative for Task19', () => {
  const input = composeInput();
  const document = composeReportDocument(input);
  const block = document.sections
    .flatMap(({ blocks }) => blocks)
    .find(({ type }) => type === 'chart') as unknown as {
      type: 'chart';
      specHash: string;
      spec: ChartSpec;
      table: ChartTableAlternative;
    } | undefined;

  assert.ok(block);
  assert.equal(block.specHash, canonicalHash(input.charts[0]!.spec));
  assert.deepEqual(block.spec, input.charts[0]!.spec);
  assert.deepEqual(block.table, input.charts[0]!.table);
  assert.deepEqual(block.table.rows[0]?.cells, [87]);
  assert.deepEqual(block.table.rows[0]?.evidenceIds, [['evidence-1']]);
  assert.doesNotThrow(() => schemaValidator.validateOrThrow('report-document', document));
});

test('ReportDocument validation binds inline Chart data to the verified chart_svg Manifest specHash', () => {
  const document = reportDocument();
  const chart = document.sections
    .flatMap(({ blocks }) => blocks)
    .find(({ type }) => type === 'chart');
  assert.ok(chart && chart.type === 'chart');

  const changedSpec = structuredClone(chart.spec);
  changedSpec.title = 'Changed inline ChartSpec with the same chart id';
  chart.spec = changedSpec;
  chart.specHash = canonicalHash(changedSpec);
  chart.table = chartTable(changedSpec);

  const references = referenceContext();
  assert.notEqual(chart.specHash, references.charts[0]!.specHash);
  assert.throws(
    () => assertValidReportDocument(document, references),
    /chart.*(reference|manifest|lineage|spec).*digest|specHash/i,
  );
});

test('composer reuses EvidenceService.validateManifest for invalid JSON pointers and Artifact hashes', () => {
  const evidence = new EvidenceService();
  const invalidPointer = composeInput();
  invalidPointer.visualAssets = [];
  invalidPointer.charts = [];
  invalidPointer.evidenceManifest.value.entries[0]!.jsonPointer = 'metrics/competitorScore';
  const { manifestHash: _pointerHash, ...pointerDraft } = invalidPointer.evidenceManifest.value;
  invalidPointer.evidenceManifest.value.manifestHash = canonicalHash(pointerDraft);
  invalidPointer.evidenceManifest.artifact = sealedJsonArtifact(
    evidenceManifestArtifactId,
    'evidence_manifest',
    'evidence-v1',
    invalidPointer.evidenceManifest.value,
  );
  assert.throws(
    () => evidence.validateManifest(invalidPointer.evidenceManifest.value, evidenceArtifactResolver),
    /JSON pointer|pointer/i,
  );
  assert.throws(
    () => composeReportDocument(invalidPointer),
    /JSON pointer|pointer|Evidence Manifest/i,
  );

  const wrongArtifactHash = composeInput();
  wrongArtifactHash.visualAssets = [];
  wrongArtifactHash.charts = [];
  wrongArtifactHash.evidenceManifest.value.entries[0]!.artifactContentSha256 = sha('f');
  const { manifestHash: _artifactHash, ...artifactDraft } = wrongArtifactHash.evidenceManifest.value;
  wrongArtifactHash.evidenceManifest.value.manifestHash = canonicalHash(artifactDraft);
  wrongArtifactHash.evidenceManifest.artifact = sealedJsonArtifact(
    evidenceManifestArtifactId,
    'evidence_manifest',
    'evidence-v1',
    wrongArtifactHash.evidenceManifest.value,
  );
  assert.throws(
    () => evidence.validateManifest(wrongArtifactHash.evidenceManifest.value, evidenceArtifactResolver),
    /Artifact content hash.*match/i,
  );
  assert.throws(
    () => composeReportDocument(wrongArtifactHash),
    /Artifact content hash.*match|Evidence Manifest/i,
  );
});

test('composer reuses assertValidReportReviewArtifact for schema-invalid pass dimensions', () => {
  const input = composeInput();
  input.visualAssets = [];
  input.charts = [];
  (input.review.value.dimensions[0] as unknown as Record<string, unknown>).passed = 'yes';
  input.review.artifact = sealedJsonArtifact(
    reviewArtifactId,
    'report_review',
    'report-review-v1',
    input.review.value,
  );

  assert.throws(() => assertValidReportReviewArtifact(input.review.value), SchemaValidationError);
  assert.throws(
    () => composeReportDocument(input),
    /Review.*(schema|dimension|passed|boolean)|schema.*Review/i,
  );
});

test('composer reuses Deliverable envelope, payload, and report validators after sealed JSON verification', () => {
  const reportValidator = new ReportEvidenceValidator(new EvidenceService());

  const invalidEnvelope = composeInput();
  invalidEnvelope.visualAssets = [];
  invalidEnvelope.charts = [];
  invalidEnvelope.deliverable.value.capabilityProvenance = [{ id: 'missing-type' }] as never;
  invalidEnvelope.deliverable.artifact = sealedJsonArtifact(
    deliverableArtifactId,
    'deliverable',
    'research-deliverable-v1-review-gated',
    invalidEnvelope.deliverable.value,
  );
  assert.throws(
    () => reportValidator.validate({
      manifest: invalidEnvelope.evidenceManifest.value,
      report: invalidEnvelope.deliverable.value,
      resolver: evidenceArtifactResolver,
      requireCoverage: true,
    }),
    /report shape|provenance/i,
  );
  assert.throws(
    () => composeReportDocument(invalidEnvelope),
    /Deliverable.*(shape|schema|provenance)|report shape/i,
  );

  const invalidPayload = composeInput();
  invalidPayload.visualAssets = [];
  invalidPayload.charts = [];
  invalidPayload.deliverable.value.payload.competitorSampling.targetCount = 0;
  invalidPayload.deliverable.artifact = sealedJsonArtifact(
    deliverableArtifactId,
    'deliverable',
    'research-deliverable-v1-review-gated',
    invalidPayload.deliverable.value,
  );
  assert.throws(
    () => schemaValidator.validateFileOrThrow(
      `${process.cwd()}/schemas/deliverables/research-plan.schema.json`,
      invalidPayload.deliverable.value.payload,
    ),
    SchemaValidationError,
  );
  assert.throws(
    () => composeReportDocument(invalidPayload),
    /Deliverable.*payload|research-plan|targetCount|schema/i,
  );

  const invalidReport = composeInput();
  invalidReport.visualAssets = [];
  invalidReport.charts = [];
  invalidReport.deliverable.value.recommendations[0]!.summaryIds = ['missing-summary'];
  invalidReport.deliverable.artifact = sealedJsonArtifact(
    deliverableArtifactId,
    'deliverable',
    'research-deliverable-v1-review-gated',
    invalidReport.deliverable.value,
  );
  assert.throws(
    () => reportValidator.validate({
      manifest: invalidReport.evidenceManifest.value,
      report: invalidReport.deliverable.value,
      resolver: evidenceArtifactResolver,
      requireCoverage: true,
    }),
    /recommendation.*unknown summary/i,
  );
  assert.throws(
    () => composeReportDocument(invalidReport),
    /recommendation.*unknown summary|Deliverable.*report/i,
  );
});
