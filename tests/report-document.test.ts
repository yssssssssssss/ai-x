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
  VisualAssetManifestV1,
  VisualAssetManifestV2,
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
import { createReportDocumentViewModel } from '../apps/web/src/reporting/report-document-view-model.ts';
import {
  COMPETITIVE_WEIGHT_CHART_DATA_VERSION,
  COMPETITIVE_WEIGHT_CHART_ID,
  COMPETITIVE_WEIGHT_SERIES_KEY,
  COMPETITIVE_WEIGHT_SERIES_LABEL,
  COMPETITIVE_WEIGHT_TITLE,
  type CompetitiveWeightChartData,
} from '../apps/orchestrator-runtime/src/report/competitive-weight-chart.ts';

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
const annotationAssetId = 'asset-annotation-report-document-1';
const annotationManifestArtifactId = 'manifest-annotation-report-document-1';
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

const RESEARCH_PLAN_DETAIL_SECTION_IDS = [
  'plan-definition',
  'research-questions',
  'comparison-framework',
  'evidence-plan',
  'execution-roadmap',
  'collection-template',
  'analysis-methods',
  'deliverables',
  'quality-assurance',
] as const;

function expectedResearchPlanSections(hasVisuals: boolean): string[] {
  const base = REQUIRED_SECTION_IDS.filter((id) => hasVisuals || (id !== 'visual-evidence' && id !== 'comparison'));
  const conclusionIndex = base.indexOf('conclusion');
  return [
    ...base.slice(0, conclusionIndex),
    ...RESEARCH_PLAN_DETAIL_SECTION_IDS,
    ...base.slice(conclusionIndex),
  ];
}

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
  source?: VisualAssetManifestV1['source'];
  derivedFrom: VisualAssetManifest['derivedFrom'];
  derivation: VisualAssetManifest['derivation'];
}): VisualAssetManifest {
  const draft: Omit<VisualAssetManifestV1, 'manifestHash'> = {
    version: 'visual-asset-manifest-v1',
    ...binding,
    assetId: input.assetId,
    contentSha256: digest(input.bytes),
    mediaType: input.mediaType,
    byteSize: input.bytes.byteLength,
    width: input.width,
    height: input.height,
    exportPolicy: 'allow',
    source: input.source
      ?? (input.derivedFrom ? { kind: 'derived' } : { kind: 'user_upload', fileName: 'verified.png' }),
    derivedFrom: input.derivedFrom,
    derivation: input.derivation,
  };
  return { ...draft, manifestHash: canonicalHash(draft) };
}

function verifiedImage(input: {
  assetId?: string;
  manifestArtifactId?: string;
  source?: VisualAssetManifestV1['source'];
} = {}): VerifiedVisualAsset {
  const assetId = input.assetId ?? imageAssetId;
  const manifestArtifactId = input.manifestArtifactId ?? imageManifestArtifactId;
  const manifest = visualManifest({
    assetId,
    mediaType: 'image/png',
    bytes: PNG,
    width: 1,
    height: 1,
    source: input.source,
    derivedFrom: null,
    derivation: null,
  });
  return {
    artifact: artifact(assetId, 'visual_asset', 'binary-v1', {
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
      manifestArtifactId,
      'visual_asset_manifest',
      'visual-asset-manifest-v1',
      manifest,
    ),
  };
}

function verifiedBrowserImage(
  assetId: string,
  manifestArtifactId: string,
  sourcePageUrl: string,
): VerifiedVisualAsset {
  const draft: Omit<VisualAssetManifestV2, 'manifestHash'> = {
    version: 'visual-asset-manifest-v2',
    ...binding,
    assetId,
    contentSha256: digest(PNG),
    mediaType: 'image/png',
    byteSize: PNG.byteLength,
    width: 1,
    height: 1,
    exportPolicy: 'allow',
    source: {
      kind: 'browser_capture',
      artifactId: 'artifact-browser-tool-report-document-1',
      artifactContentSha256: sha('b'),
      jsonPointer: '/output/captures/0',
      attachmentId: 'capture-1',
      sourcePageUrl,
      finalUrl: sourcePageUrl,
      pageTitle: 'Verified AI shopping assistant',
      capturedAt: '2026-08-20T02:00:00.000Z',
      captureMode: 'element_screenshot',
      selector: '#shopping-assistant',
      viewport: { width: 1440, height: 900 },
    },
    derivedFrom: null,
    derivation: null,
  };
  const manifest: VisualAssetManifestV2 = {
    ...draft,
    manifestHash: canonicalHash(draft),
  };
  return {
    artifact: artifact(assetId, 'visual_asset', 'visual-asset-v1', {
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
      manifestArtifactId,
      'visual_asset_manifest',
      'visual-asset-manifest-v2',
      manifest,
    ),
  };
}

function verifiedAnnotation(
  original: VerifiedVisualAsset,
  input: { assetId?: string; manifestArtifactId?: string } = {},
): VerifiedVisualAsset {
  const assetId = input.assetId ?? annotationAssetId;
  const manifestArtifactId = input.manifestArtifactId ?? annotationManifestArtifactId;
  const manifest = visualManifest({
    assetId,
    mediaType: 'image/png',
    bytes: PNG,
    width: 1,
    height: 1,
    derivedFrom: {
      assetId: original.artifact.id,
      manifestArtifactId: original.manifestArtifact.id,
      contentSha256: original.manifest.contentSha256,
      manifestHash: original.manifest.manifestHash,
    },
    derivation: { kind: 'annotation', overlayArtifactId: `overlay-${assetId}` },
  });
  return {
    artifact: artifact(assetId, 'visual_asset', 'binary-v1', {
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
      manifestArtifactId,
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
  dataArtifactRef?: { artifactId: string; contentSha256: string };
  data?: CompetitiveWeightChartData;
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

function verifiedChartRender(): VerifiedChartFixture {
  const chart = verifiedChart();
  chart.spec = {
    version: 'chart-spec-v1',
    chartId: COMPETITIVE_WEIGHT_CHART_ID,
    type: 'comparison',
    title: COMPETITIVE_WEIGHT_TITLE,
    categories: ['需求理解', '内容可信度'],
    series: [{
      key: COMPETITIVE_WEIGHT_SERIES_KEY,
      label: COMPETITIVE_WEIGHT_SERIES_LABEL,
      values: [60, 40],
      evidenceIds: [['W-1'], ['W-2']],
    }],
    yAxis: { min: 0 },
  };
  chart.specHash = canonicalHash(chart.spec);
  chart.table = chartTable(chart.spec);
  const { manifestHash: _manifestHash, ...manifestDraft } = chart.asset.manifest;
  const dataArtifactRef = {
    artifactId: 'chart-data-report-document-1',
    contentSha256: sha('d'),
  };
  const v2Draft: Omit<VisualAssetManifestV2, 'manifestHash'> = {
    ...manifestDraft,
    version: 'visual-asset-manifest-v2',
    source: {
      kind: 'chart_render',
      dataArtifactId: dataArtifactRef.artifactId,
      dataArtifactContentSha256: dataArtifactRef.contentSha256,
    },
    derivedFrom: null,
    derivation: {
      kind: 'chart_svg',
      chartId: chart.spec.chartId,
      specHash: chart.specHash,
    },
  };
  chart.asset.artifact.schemaVersion = 'visual-asset-v1';
  chart.asset.manifest = {
    ...v2Draft,
    manifestHash: canonicalHash(v2Draft),
  };
  chart.asset.manifestArtifact = sealedJsonArtifact(
    chart.asset.manifestArtifact.id,
    'visual_asset_manifest',
    'visual-asset-manifest-v2',
    chart.asset.manifest,
  );
  chart.dataArtifactRef = dataArtifactRef;
  chart.data = {
    version: COMPETITIVE_WEIGHT_CHART_DATA_VERSION,
    ...binding,
    unit: 'percent',
    weights: [
      { dimension: '需求理解', percentage: 60 },
      { dimension: '内容可信度', percentage: 40 },
    ],
  };
  return chart;
}

function attachVerifiedChartRender(
  input: ReturnType<typeof composeInput>,
  chart = verifiedChartRender(),
): VerifiedChartFixture {
  const dataArtifactRef = chart.dataArtifactRef!;
  const data = chart.data!;
  const resolvedData: ResolvedEvidenceArtifact = {
    artifact: {
      id: dataArtifactRef.artifactId,
      contentSha256: dataArtifactRef.contentSha256,
    },
    value: data,
  };
  const resolver: EvidenceArtifactResolver = {
    resolveArtifact: (artifactId) => artifactId === dataArtifactRef.artifactId
      ? resolvedData
      : evidenceArtifactResolver.resolveArtifact(artifactId),
  };
  const weightEntries = data.weights.map((_, index) => ({
    id: `W-${index + 1}`,
    kind: 'user_constraint' as const,
    evidenceClass: 'user_input' as const,
    artifactId: dataArtifactRef.artifactId,
    artifactContentSha256: dataArtifactRef.contentSha256,
    jsonPointer: `/weights/${index}/percentage`,
    sensitivity: 'internal' as const,
    redaction: 'none' as const,
  }));
  input.evidenceManifest.value = new EvidenceService().createManifest({
    ...binding,
    collectedAt: '2026-08-16T00:00:00.000Z',
    entries: [...evidenceManifest().entries, ...weightEntries],
  }, resolver);
  input.evidenceManifest.artifact = sealedJsonArtifact(
    evidenceManifestArtifactId,
    'evidence_manifest',
    'evidence-v1',
    input.evidenceManifest.value,
  );
  input.evidenceArtifactResolver = resolver;
  input.charts = [chart];
  return chart;
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

test('ReportDocument validation rejects dangling visual Asset, image Evidence, and Chart references', () => {
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

  const danglingImageEvidence = reportDocument();
  const evidencedImage = danglingImageEvidence.sections
    .flatMap(({ blocks }) => blocks)
    .find(({ type }) => type === 'image');
  assert.ok(evidencedImage && evidencedImage.type === 'image');
  evidencedImage.evidenceIds = ['missing-evidence'];
  assert.throws(
    () => assertValidReportDocument(danglingImageEvidence, referenceContext()),
    /image.*evidence|dangling.*evidence/i,
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

test('composer accepts a V2 chart_render Chart with null visual lineage', () => {
  const input = composeInput();
  const chart = attachVerifiedChartRender(input);

  const document = composeReportDocument(input);
  const block = document.sections
    .flatMap(({ blocks }) => blocks)
    .find((candidate) => candidate.type === 'chart');

  assert.ok(block?.type === 'chart');
  assert.equal(block.chartRef.assetId, chart.asset.artifact.id);
  assert.equal(block.specHash, chart.specHash);
  assert.deepEqual(block.table, chart.table);

  const mismatched = composeInput();
  const mismatchedChart = attachVerifiedChartRender(mismatched);
  mismatchedChart.dataArtifactRef = {
    ...mismatchedChart.dataArtifactRef!,
    contentSha256: sha('e'),
  };
  assert.throws(
    () => composeReportDocument(mismatched),
    /chart.*data artifact|data artifact.*chart/i,
  );
});

test('composer keeps V1 Chart visual lineage exact', () => {
  const input = composeInput();
  const chart = input.charts[0]!;
  const lineage = chart.asset.manifest.derivedFrom;
  assert.ok(lineage);
  const { manifestHash: _manifestHash, ...manifestDraft } = chart.asset.manifest;
  const changedDraft = {
    ...manifestDraft,
    derivedFrom: { ...lineage, assetId: 'another-visual-asset' },
  };
  chart.asset.manifest = {
    ...changedDraft,
    manifestHash: canonicalHash(changedDraft),
  } as VisualAssetManifest;
  chart.asset.manifestArtifact = sealedJsonArtifact(
    chart.asset.manifestArtifact.id,
    'visual_asset_manifest',
    'visual-asset-manifest-v1',
    chart.asset.manifest,
  );

  assert.throws(
    () => composeReportDocument(input),
    /chart|svg|lineage|visual asset/i,
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
  assert.deepEqual(document.sections.map(({ id }) => id), expectedResearchPlanSections(false));
});

test('composer pairs an annotation with its original into a production-view image comparison', () => {
  const input = composeInput();
  const original = input.visualAssets[0]!;
  const annotation = verifiedAnnotation(original);
  input.visualAssets = [original, annotation];
  input.charts = [];

  const document = composeReportDocument(input);
  const comparison = document.sections
    .flatMap(({ blocks }) => blocks)
    .find(({ type }) => type === 'image-comparison');
  assert.ok(comparison?.type === 'image-comparison');
  assert.deepEqual(comparison.beforeAssetRef, {
    assetId: original.artifact.id,
    manifestArtifactId: original.manifestArtifact.id,
  });
  assert.deepEqual(comparison.afterAssetRef, {
    assetId: annotation.artifact.id,
    manifestArtifactId: annotation.manifestArtifact.id,
  });

  const model = createReportDocumentViewModel({
    document,
    visualAssetManifests: [original.manifest, annotation.manifest],
    assetUrl: ({ assetId }) => `/api/control-tasks/${binding.taskId}/assets/${assetId}`,
  });
  const viewComparison = model.sections
    .flatMap(({ blocks }) => blocks)
    .find(({ kind }) => kind === 'comparison');
  assert.deepEqual(viewComparison, {
    id: comparison.id,
    kind: 'comparison',
    originalAssetId: original.artifact.id,
    annotationAssetId: annotation.artifact.id,
    originalSrc: `/api/control-tasks/${binding.taskId}/assets/${original.artifact.id}`,
    annotationSrc: `/api/control-tasks/${binding.taskId}/assets/${annotation.artifact.id}`,
    caption: comparison.caption,
    altText: comparison.altText,
  });
});

test('composer creates a schema-valid professional research-plan document with ordered sections and sealed references', () => {
  const input = composeInput();
  const document = composeReportDocument(input);

  assert.doesNotThrow(() => schemaValidator.validateOrThrow('report-document', document));
  assert.doesNotThrow(() => assertValidReportDocument(document, referenceContext()));
  assert.equal(document.title, input.deliverable.value.payload.title);
  assert.ok(document.executiveSummary.trim().length > 0);
  assert.equal(document.version, 'report-document-v2');
  assert.deepEqual(document.coveredPointers, [
    '/title', '/researchGoal', '/scope', '/competitorSampling', '/researchQuestions',
    '/comparisonDimensions', '/sourcePlan', '/executionPlan', '/collectionTemplate',
    '/analysisMethods', '/deliverables', '/qualityChecks',
  ]);
  assert.deepEqual(document.sections.map(({ id }) => id), expectedResearchPlanSections(true));
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

test('composer derives Chart Evidence from the verified Manifest resolver and rejects an independent resolver split', () => {
  const input = composeInput();
  input.evidenceResolver = (evidenceId: string): unknown | undefined => evidenceId === 'evidence-1' ? 12 : undefined;
  input.charts[0]!.spec.series[0]!.values[0] = 12;
  input.charts[0]!.table = chartTable(input.charts[0]!.spec);
  resealChartForCurrentSpec(input.charts[0]!);

  const evidenceEntry = input.evidenceManifest.value.entries[0]!;
  assert.equal(new EvidenceService().resolveEvidenceValue(evidenceEntry, evidenceArtifactResolver), 87);
  assert.equal(input.evidenceResolver('evidence-1'), 12);
  assert.throws(
    () => composeReportDocument(input),
    /Chart Spec|value.*Evidence|Evidence.*value|verified Manifest|match/i,
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

function professionalComposeInput(input: {
  templateId: string;
  deliverableId: string;
  payload: Record<string, unknown>;
  visuals: 'none' | 'source' | 'annotation';
}): Parameters<typeof composeReportDocument>[0] {
  const compose = composeInput() as unknown as Parameters<typeof composeReportDocument>[0];
  compose.templateId = input.templateId;
  compose.deliverable.value.deliverableType = input.deliverableId;
  compose.deliverable.value.payload = structuredClone(input.payload);
  compose.deliverable.artifact = sealedJsonArtifact(
    deliverableArtifactId,
    'deliverable',
    'research-deliverable-v1-review-gated',
    compose.deliverable.value,
  );
  compose.charts = [];
  if (input.visuals === 'none') {
    compose.visualAssets = [];
  } else {
    const source = verifiedImage();
    compose.visualAssets = input.visuals === 'annotation'
      ? [source, verifiedAnnotation(source)]
      : [source];
  }
  return compose;
}

function reportSectionText(document: ReportDocument, sectionId: string): string {
  const section = document.sections.find(({ id }) => id === sectionId);
  assert.ok(section, `missing ReportDocument section ${sectionId}`);
  return JSON.stringify(section.blocks);
}

function competitivePayload(screenshotComparisons: unknown[]): Record<string, unknown> {
  return {
    competitorSamples: [{ id: 'sample-a', name: 'Phase6 Product A', rationale: 'Primary comparator', evidenceIds: ['evidence-1'] }],
    dimensionMatrix: [{
      dimension: 'onboarding',
      weight: 0.2,
      values: [{ sampleId: 'sample-a', value: 'Phase6 guided matrix value', score: 4.5, evidenceIds: ['evidence-1'] }],
    }],
    differences: [{ id: 'difference-1', dimension: 'onboarding', statement: 'Phase6 competitor difference', evidenceIds: ['evidence-1'] }],
    impacts: [{ differenceId: 'difference-1', audience: 'New users', statement: 'Phase6 novice impact' }],
    actionRecommendations: [{ id: 'action-1', differenceIds: ['difference-1'], priority: 'P1', statement: 'Phase6 prioritized action' }],
    managementSummary: ['Phase6 management decision'],
    scoringMethod: ['Phase6 1–5 anchor definition'],
    roadmap: [{
      priority: 'P0',
      statement: 'Phase6 roadmap action',
      metric: 'Phase6 completion rate',
      validationMethod: 'Phase6 controlled experiment',
    }],
    instrumentationPlan: ['Phase6 instrumentation event and properties'],
    userTestScript: ['Phase6 user task, probe, success criterion, and trust measure'],
    visualEvidence: [],
    screenshotComparisons,
  };
}

test('competitive ReportDocument projects matrix, actions, impact, and screenshot comparison into selected sections', () => {
  const document = composeReportDocument(professionalComposeInput({
    templateId: 'competitive-analysis-report',
    deliverableId: 'competitive_analysis_report',
    visuals: 'annotation',
    payload: competitivePayload([
      {
        id: 'screenshot-1',
        dimension: 'onboarding',
        sampleIds: ['sample-a'],
        assetIds: [imageAssetId, annotationAssetId],
        caption: 'Phase6 screenshot comparison',
      },
    ]),
  }));

  assert.equal(document.title, '竞品分析报告 / Competitive Analysis Report');
  assert.equal(
    document.sections.find(({ id }) => id === 'findings')?.title,
    '维度矩阵与核心差异 / Dimension Matrix and Key Differences',
  );
  assert.equal(document.sections.every(({ title }) => title.includes(' / ')), true);
  assert.equal(
    document.sections.reduce(
      (count, section) => count + section.blocks.filter(({ id }) => id.startsWith('section-intro-')).length,
      0,
    ),
    document.sections.length,
  );
  assert.match(reportSectionText(document, 'findings'), /本章用于按消费决策支持维度/u);
  assert.doesNotMatch(reportSectionText(document, 'findings'), /六个消费决策支持维度/u);
  assert.match(reportSectionText(document, 'findings'), /Phase6 guided matrix value/);
  assert.match(reportSectionText(document, 'findings'), /Phase6 competitor difference/);
  assert.match(reportSectionText(document, 'findings'), /Phase6 Product A/);
  assert.equal(
    document.sections
      .find(({ id }) => id === 'findings')
      ?.blocks.filter(({ type }) => type === 'fact').length,
    2,
  );
  const matrixFact = document.sections
    .find(({ id }) => id === 'findings')
    ?.blocks.find(({ type }) => type === 'fact');
  assert.ok(matrixFact?.type === 'fact');
  assert.match(
    matrixFact.text,
    /【onboarding｜权重 20%】\nPhase6 Product A：评分 4.5\/5；Phase6 guided matrix value\n综合判断：/u,
  );
  assert.match(reportSectionText(document, 'findings'), /【跨维度综合】/u);
  assert.match(reportSectionText(document, 'executive-summary'), /Phase6 management decision/u);
  assert.match(reportSectionText(document, 'key-metrics'), /Phase6 1–5 anchor definition/u);
  assert.match(reportSectionText(document, 'key-metrics'), /"value":4.5/u);
  assert.match(reportSectionText(document, 'comparison'), /Phase6 novice impact/);
  assert.match(reportSectionText(document, 'recommendations'), /Phase6 prioritized action/);
  assert.match(reportSectionText(document, 'recommendations'), /Phase6 roadmap action/u);
  assert.match(reportSectionText(document, 'visual-evidence'), /Phase6 screenshot comparison/);
  assert.match(reportSectionText(document, 'appendix'), /Phase6 instrumentation event and properties/u);
  assert.match(reportSectionText(document, 'appendix'), /Phase6 user task, probe, success criterion, and trust measure/u);
  assert.match(reportSectionText(document, 'recommendations'), /P1/);
  const screenshot = document.sections
    .find(({ id }) => id === 'visual-evidence')
    ?.blocks.find((block) => (
      block.type === 'image-comparison'
      && block.beforeAssetRef.assetId === imageAssetId
      && block.afterAssetRef.assetId === annotationAssetId
      && block.caption.includes('Phase6 screenshot comparison')
    ));
  assert.ok(screenshot?.type === 'image-comparison');
  assert.match(screenshot.caption, /输入边界仅用于来源溯源，不定位或证明任何研究发现/u);
  assert.match(screenshot.altText, /input-provenance boundary.*does not locate or substantiate a research finding/iu);
});

test('competitive ReportDocument rejects duplicate dimensionMatrix dimensions', () => {
  const payload = competitivePayload([]);
  payload.dimensionMatrix = [
    ...(payload.dimensionMatrix as unknown[]),
    structuredClone((payload.dimensionMatrix as unknown[])[0]),
  ];
  const input = professionalComposeInput({
    templateId: 'competitive-analysis-report',
    deliverableId: 'competitive_analysis_report',
    visuals: 'none',
    payload,
  });

  assert.throws(
    () => composeReportDocument(input),
    /dimensionMatrix.*unique|duplicate.*dimension/i,
  );
});

test('competitive ReportDocument renders a browser single image with exact dual Evidence and source metadata', () => {
  const browserAssetId = 'asset-browser-report-document-1';
  const browserManifestArtifactId = 'manifest-browser-report-document-1';
  const publicArtifactId = 'artifact-public-source-report-document-1';
  const publicArtifactContentSha256 = sha('c');
  const sourcePageUrl = 'https://example.test/ai-shopping-assistant';
  const publicSourceUrl = 'https://EXAMPLE.TEST:443/ai-shopping-assistant#overview';
  const browser = verifiedBrowserImage(
    browserAssetId,
    browserManifestArtifactId,
    sourcePageUrl,
  );
  const payload = competitivePayload([]);
  payload.visualEvidence = [{
    id: 'visual-evidence-1',
    sampleIds: ['sample-a'],
    dimension: 'onboarding',
    assetId: browserAssetId,
    evidenceIds: ['E-screenshot', 'E-public'],
    caption: 'Verified AI shopping-assistant entry point',
  }];
  const input = professionalComposeInput({
    templateId: 'competitive-analysis-report',
    deliverableId: 'competitive_analysis_report',
    visuals: 'none',
    payload,
  });
  input.visualAssets = [browser];
  const publicOutput = {
    results: [{ title: 'Verified public source', url: publicSourceUrl }],
  };
  const redactedOutputHash = canonicalHash(publicOutput);
  const resolver: EvidenceArtifactResolver = {
    resolveArtifact: (artifactId) => {
      if (artifactId === publicArtifactId) {
        return {
          artifact: { id: publicArtifactId, contentSha256: publicArtifactContentSha256 },
          value: { output: publicOutput, redactedOutputHash },
        };
      }
      if (artifactId === browserManifestArtifactId) {
        return {
          artifact: {
            id: browserManifestArtifactId,
            contentSha256: browser.manifestArtifact.contentSha256!,
          },
          value: browser.manifest,
        };
      }
      return evidenceArtifactResolver.resolveArtifact(artifactId);
    },
  };
  input.evidenceManifest.value = new EvidenceService().createManifest({
    ...binding,
    collectedAt: '2026-08-20T02:01:00.000Z',
    entries: [...evidenceManifest().entries, {
      id: 'E-public',
      kind: 'tool_output',
      evidenceClass: 'public_source',
      toolId: 'tavily-web-search',
      toolTier: 'core',
      artifactId: publicArtifactId,
      artifactContentSha256: publicArtifactContentSha256,
      jsonPointer: '/output/results/0',
      sourceUrl: publicSourceUrl,
      toolProof: {
        implementationId: 'tavily',
        executionMode: 'real',
        redactedOutputHash,
      },
      sensitivity: 'public',
      redaction: 'masked',
    }, {
      id: 'E-screenshot',
      kind: 'screenshot',
      evidenceClass: 'screenshot',
      toolId: 'playwright-page-capture',
      toolTier: 'optional',
      artifactId: browserManifestArtifactId,
      artifactContentSha256: browser.manifestArtifact.contentSha256!,
      jsonPointer: '/assetId',
      sourceUrl: sourcePageUrl,
      sensitivity: 'public',
      redaction: 'none',
    }],
  }, resolver);
  input.evidenceManifest.artifact = sealedJsonArtifact(
    evidenceManifestArtifactId,
    'evidence_manifest',
    'evidence-v1',
    input.evidenceManifest.value,
  );
  input.evidenceArtifactResolver = resolver;

  const document = composeReportDocument(input);
  const visualBlocks = document.sections.find(({ id }) => id === 'visual-evidence')?.blocks ?? [];
  const image = visualBlocks.find((block) => block.type === 'image');
  assert.ok(image?.type === 'image');
  assert.deepEqual(image.assetRef, {
    assetId: browserAssetId,
    manifestArtifactId: browserManifestArtifactId,
  });
  assert.deepEqual(image.evidenceIds, ['E-screenshot', 'E-public']);
  assert.match(image.caption, /Verified AI shopping-assistant entry point.*example\.test.*2026-08-20T02:00:00\.000Z/u);
  assert.equal(visualBlocks.filter(({ type }) => type === 'image').length, 1);
});

test('competitive ReportDocument keeps unselected input-provenance visuals out of an empty visual section', () => {
  const textOnly = professionalComposeInput({
    templateId: 'competitive-analysis-report',
    deliverableId: 'competitive_analysis_report',
    visuals: 'none',
    payload: competitivePayload([]),
  });
  const document = composeReportDocument(textOnly);
  assert.match(
    reportSectionText(document, 'visual-evidence'),
    /没有满足来源与证据绑定要求的图片或图表/u,
  );
  assert.equal(
    document.sections
      .find(({ id }) => id === 'visual-evidence')
      ?.blocks.filter(({ type }) => type === 'image' || type === 'image-comparison').length,
    0,
  );

  const unusedVisuals = professionalComposeInput({
    templateId: 'competitive-analysis-report',
    deliverableId: 'competitive_analysis_report',
    visuals: 'annotation',
    payload: competitivePayload([]),
  });
  const unusedDocument = composeReportDocument(unusedVisuals);
  assert.equal(
    unusedDocument.sections
      .find(({ id }) => id === 'visual-evidence')
      ?.blocks.some(({ type }) => type === 'image' || type === 'image-comparison'),
    false,
  );
});

test('competitive chart-only report places the chart at the end of Visual Evidence', () => {
  const input = professionalComposeInput({
    templateId: 'competitive-analysis-report',
    deliverableId: 'competitive_analysis_report',
    visuals: 'none',
    payload: competitivePayload([]),
  });
  attachVerifiedChartRender(input as ReturnType<typeof composeInput>);

  const document = composeReportDocument(input);
  const visualSection = document.sections.find(({ id }) => id === 'visual-evidence');
  const comparisonSection = document.sections.find(({ id }) => id === 'comparison');
  assert.ok(visualSection);
  assert.ok(comparisonSection);
  const visualIntroduction = visualSection.blocks[0];
  assert.ok(visualIntroduction?.type === 'paragraph');
  assert.equal(
    visualIntroduction.text,
    '本章按单图证据、原图与标注图对比、图表及数据表的顺序集中展示已验证视觉材料，用于帮助读者对照视觉证据与文字结论。',
  );
  assert.equal(comparisonSection.title, '竞争影响分析 / Competitive Impact Analysis');
  assert.equal(
    visualSection.blocks.some(({ type }) => type === 'image' || type === 'image-comparison' || type === 'chart'),
    true,
  );
  assert.equal(visualSection.blocks.at(-1)?.type, 'chart');
  assert.equal(comparisonSection.blocks.some(({ type }) => type === 'chart'), false);
});

for (const invalid of [{
  name: 'a single image',
  visuals: 'source' as const,
  assetIds: [imageAssetId],
}, {
  name: 'a duplicate image',
  visuals: 'source' as const,
  assetIds: [imageAssetId, imageAssetId],
}, {
  name: 'a reversed annotation pair',
  visuals: 'annotation' as const,
  assetIds: [annotationAssetId, imageAssetId],
}, {
  name: 'three images',
  visuals: 'annotation' as const,
  assetIds: [imageAssetId, annotationAssetId, 'asset-extra'],
}]) {
  test(`competitive ReportDocument rejects ${invalid.name}`, () => {
    const input = professionalComposeInput({
      templateId: 'competitive-analysis-report',
      deliverableId: 'competitive_analysis_report',
      visuals: invalid.visuals,
      payload: competitivePayload([{
        id: 'screenshot-1',
        dimension: 'onboarding',
        sampleIds: ['sample-a'],
        assetIds: invalid.assetIds,
        caption: 'Invalid screenshot comparison',
      }]),
    });
    assert.throws(() => composeReportDocument(input), /screenshot|visual|original|annotation|pair|unique|items/i);
  });
}

test('competitive ReportDocument rejects two originals and mismatched annotation lineage', () => {
  const originalA = verifiedImage();
  const originalB = verifiedImage({
    assetId: 'asset-image-report-document-2',
    manifestArtifactId: 'manifest-image-report-document-2',
  });

  const twoOriginals = professionalComposeInput({
    templateId: 'competitive-analysis-report',
    deliverableId: 'competitive_analysis_report',
    visuals: 'source',
    payload: competitivePayload([{
      id: 'screenshot-1',
      dimension: 'onboarding',
      sampleIds: ['sample-a'],
      assetIds: [originalA.artifact.id, originalB.artifact.id],
      caption: 'Invalid two-original comparison',
    }]),
  });
  twoOriginals.visualAssets = [originalA, originalB];
  assert.throws(() => composeReportDocument(twoOriginals), /original|annotation|lineage|pair/i);

  const annotationB = verifiedAnnotation(originalB);
  const wrongLineage = professionalComposeInput({
    templateId: 'competitive-analysis-report',
    deliverableId: 'competitive_analysis_report',
    visuals: 'annotation',
    payload: competitivePayload([{
      id: 'screenshot-1',
      dimension: 'onboarding',
      sampleIds: ['sample-a'],
      assetIds: [originalA.artifact.id, annotationB.artifact.id],
      caption: 'Invalid cross-original comparison',
    }]),
  });
  wrongLineage.visualAssets = [originalA, originalB, annotationB];
  assert.throws(() => composeReportDocument(wrongLineage), /original|annotation|lineage|pair/i);
});

test('competitive ReportDocument rejects duplicate Asset ids and nested annotation lineage', () => {
  const original = verifiedImage();
  const annotation = verifiedAnnotation(original);
  const payload = competitivePayload([{
    id: 'screenshot-1',
    dimension: 'onboarding',
    sampleIds: ['sample-a'],
    assetIds: [original.artifact.id, annotation.artifact.id],
    caption: 'Exact screenshot comparison',
  }]);

  const duplicateId = professionalComposeInput({
    templateId: 'competitive-analysis-report',
    deliverableId: 'competitive_analysis_report',
    visuals: 'annotation',
    payload,
  });
  duplicateId.visualAssets = [
    original,
    verifiedImage({ manifestArtifactId: 'manifest-image-report-document-duplicate' }),
    annotation,
  ];
  assert.throws(() => composeReportDocument(duplicateId), /Asset id.*unique/i);

  const unselectedToolSource = professionalComposeInput({
    templateId: 'competitive-analysis-report',
    deliverableId: 'competitive_analysis_report',
    visuals: 'annotation',
    payload,
  });
  unselectedToolSource.visualAssets = [
    original,
    annotation,
    verifiedImage({
      assetId: 'asset-tool-report-document-1',
      manifestArtifactId: 'manifest-tool-report-document-1',
      source: {
        kind: 'tool_artifact',
        artifactId: 'tool-output-report-document-1',
        artifactContentSha256: sha('f'),
        jsonPointer: '/image',
        url: 'https://example.test/verified.png',
      },
    }),
  ];
  assert.doesNotThrow(() => composeReportDocument(unselectedToolSource));

  const annotationChain = professionalComposeInput({
    templateId: 'competitive-analysis-report',
    deliverableId: 'competitive_analysis_report',
    visuals: 'annotation',
    payload,
  });
  annotationChain.visualAssets = [
    original,
    annotation,
    verifiedAnnotation(annotation, {
      assetId: 'asset-nested-annotation-report-document-1',
      manifestArtifactId: 'manifest-nested-annotation-report-document-1',
    }),
  ];
  assert.throws(() => composeReportDocument(annotationChain), /exact verified original/i);
});

test('VOC ReportDocument projects themes, quotes, severity, and priority into diagnosis sections', () => {
  const document = composeReportDocument(professionalComposeInput({
    templateId: 'voc-diagnosis-report',
    deliverableId: 'voc_diagnosis_report',
    visuals: 'none',
    payload: {
      datasets: [{ id: 'dataset-1', name: 'Support feedback', source: 'ticket export', recordCount: 120 }],
      themes: [{ id: 'theme-1', label: 'Phase6 setup delay theme', datasetIds: ['dataset-1'], evidenceIds: ['evidence-1'] }],
      frequencies: [{ themeId: 'theme-1', count: 38, share: 0.3167 }],
      sentiments: [{ themeId: 'theme-1', label: 'negative', score: -0.7 }],
      representativeQuotes: [{ themeId: 'theme-1', quote: 'Phase6 representative quote', evidenceId: 'evidence-1' }],
      severities: [{ themeId: 'theme-1', level: 'high', rationale: 'Phase6 severe activation block' }],
      priorities: [{ themeId: 'theme-1', level: 'P1', rationale: 'Phase6 priority rationale' }],
    },
  }));

  assert.match(reportSectionText(document, 'findings'), /Phase6 setup delay theme/);
  assert.match(reportSectionText(document, 'findings'), /Phase6 representative quote/);
  assert.match(reportSectionText(document, 'comparison'), /Phase6 severe activation block/);
  assert.match(reportSectionText(document, 'comparison'), /Phase6 priority rationale/);
  assert.match(reportSectionText(document, 'comparison'), /high/);
  assert.match(reportSectionText(document, 'comparison'), /P1/);
});

test('design-audit ReportDocument projects issues, annotations, remediation, and retest into selected sections', () => {
  const document = composeReportDocument(professionalComposeInput({
    templateId: 'design-audit-report',
    deliverableId: 'design_audit_report',
    visuals: 'annotation',
    payload: {
      pages: [{ id: 'page-1', name: 'Checkout', state: 'default' }],
      issues: [{ id: 'issue-1', pageId: 'page-1', statement: 'Phase6 primary hierarchy issue' }],
      principles: [{ issueId: 'issue-1', principle: 'clear hierarchy', rationale: 'Phase6 principle rationale' }],
      severities: [{ issueId: 'issue-1', level: 'major', rationale: 'Phase6 design severity' }],
      annotatedScreenshots: [{ issueId: 'issue-1', assetId: annotationAssetId, annotation: 'Phase6 competing actions annotation' }],
      remediations: [{ issueId: 'issue-1', action: 'Phase6 establish one primary action', acceptanceCriteria: ['One dominant action'] }],
      retests: [{ issueId: 'issue-1', method: 'Expert review', expectedResult: 'Phase6 primary action found first' }],
    },
  }));

  assert.match(reportSectionText(document, 'findings'), /Phase6 primary hierarchy issue/);
  assert.match(reportSectionText(document, 'visual-evidence'), /Phase6 competing actions annotation/);
  assert.match(reportSectionText(document, 'recommendations'), /Phase6 establish one primary action/);
  assert.match(reportSectionText(document, 'appendix'), /Phase6 primary action found first/);
  const annotationComparison = document.sections
    .find(({ id }) => id === 'visual-evidence')
    ?.blocks.find((block) => (
      block.type === 'image-comparison'
      && block.afterAssetRef.assetId === annotationAssetId
      && block.caption.includes('Phase6 competing actions annotation')
    ));
  assert.ok(annotationComparison?.type === 'image-comparison');
});

test('accessibility ReportDocument projects POUR, screen-reader behavior, remediation, and verification into selected sections', () => {
  const document = composeReportDocument(professionalComposeInput({
    templateId: 'accessibility-audit-report',
    deliverableId: 'accessibility_audit_report',
    visuals: 'none',
    payload: {
      platforms: [{ name: 'Web', assistiveTechnology: 'VoiceOver', browser: 'Safari' }],
      pourPrinciples: [{ issueId: 'issue-1', principle: 'Operable', rationale: 'Phase6 keyboard rationale' }],
      components: [{ issueId: 'issue-1', component: 'Phase6 checkout button', selector: '#checkout' }],
      conformanceLevels: [
        { issueId: 'issue-1', level: 'A', criterion: '2.1.1 Keyboard' },
        { issueId: 'issue-2', level: 'B', criterion: 'Phase6 classification B' },
        { issueId: 'issue-3', level: 'C', criterion: 'Phase6 classification C' },
      ],
      priorities: [
        { issueId: 'issue-1', level: 'P0', rationale: 'Blocks keyboard users' },
        { issueId: 'issue-2', level: 'P1', rationale: 'Major barrier' },
        { issueId: 'issue-3', level: 'P2', rationale: 'Material degradation' },
        { issueId: 'issue-4', level: 'P3', rationale: 'Minor improvement' },
      ],
      screenReaderBehavior: [{ issueId: 'issue-1', observed: 'Phase6 purpose is not announced', expected: 'Name and role are announced' }],
      remediations: [{ issueId: 'issue-1', action: 'Phase6 use a named native button' }],
      verification: [{ issueId: 'issue-1', method: 'VoiceOver retest', expectedResult: 'Phase6 control is reachable and announced' }],
    },
  }));

  assert.match(reportSectionText(document, 'findings'), /Operable/);
  assert.match(reportSectionText(document, 'findings'), /Phase6 checkout button/);
  assert.match(reportSectionText(document, 'visual-evidence'), /Phase6 purpose is not announced/);
  assert.match(reportSectionText(document, 'recommendations'), /Phase6 use a named native button/);
  assert.match(reportSectionText(document, 'appendix'), /Phase6 control is reachable and announced/);
});
