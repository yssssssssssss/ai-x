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
  type EvidenceManifest,
  type ResolvedEvidenceArtifact,
} from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import {
  assertValidReportDocument,
  composeReportDocument,
  type ReportDocument,
} from '../apps/orchestrator-runtime/src/report/report-document-composer.ts';
import type { VerifiedVisualAsset } from '../apps/orchestrator-runtime/src/report/visual-asset-service.ts';
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
  const resolved: ResolvedEvidenceArtifact = {
    artifact: { id: evidenceArtifactId, contentSha256: sha('e') },
    value: { metrics: { competitorScore: 87 } },
  };
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
  }, {
    resolveArtifact: (artifactId) => artifactId === evidenceArtifactId ? resolved : null,
  });
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
    manifestArtifact: artifact(
      imageManifestArtifactId,
      'visual_asset_manifest',
      'visual-asset-manifest-v1',
      { contentSha256: manifest.manifestHash },
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

function verifiedChart(): { spec: ChartSpec; asset: VerifiedVisualAsset } {
  const spec = chartSpec();
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
    derivation: { kind: 'chart_svg', chartId: spec.chartId },
  });
  return {
    spec,
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
      manifestArtifact: artifact(
        chartManifestArtifactId,
        'visual_asset_manifest',
        'visual-asset-manifest-v1',
        { contentSha256: manifest.manifestHash },
      ),
    },
  };
}

function composeInput() {
  return {
    templateId: 'research-plan' as const,
    requiredQuestionIds: ['question-1'],
    deliverable: {
      artifact: artifact(
        deliverableArtifactId,
        'deliverable',
        'research-deliverable-v1-review-gated',
      ),
      value: deliverable(),
    },
    evidenceManifest: {
      artifact: artifact(
        evidenceManifestArtifactId,
        'evidence_manifest',
        'evidence-v1',
      ),
      value: evidenceManifest(),
    },
    review: {
      artifact: artifact(reviewArtifactId, 'report_review', 'report-review-v1'),
      value: review(),
    },
    visualAssets: [verifiedImage()],
    charts: [verifiedChart()],
  };
}

function referenceContext() {
  return {
    requiredQuestionIds: ['question-1'],
    evidenceIds: ['evidence-1'],
    visualAssets: [{ assetId: imageAssetId, manifestArtifactId: imageManifestArtifactId }],
    charts: [{
      chartId: 'chart-1',
      assetId: chartAssetId,
      manifestArtifactId: chartManifestArtifactId,
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
    caption: 'Verified competitor score comparison',
    altText: 'Competitor A has a verified score of 87.',
  }];
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
  assert.throws(() => composeReportDocument(notPassed), /review|pass|verdict/i);

  const wrongBinding = composeInput();
  wrongBinding.review.value = review({ deliverableArtifactId: 'another-deliverable' });
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
  input.charts[0]!.asset.manifest = {
    ...input.charts[0]!.asset.manifest,
    derivation: { kind: 'chart_svg', chartId: 'another-chart' },
  };

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
