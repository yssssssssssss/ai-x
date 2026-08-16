import { createHash } from 'node:crypto';
import type { ControlArtifact } from '../../../../database/control-plane.ts';
import {
  REPORT_REVIEW_DIMENSION_IDS,
  type ReportReviewArtifact,
} from '../../../../packages/api-contract/control-workflow.ts';
import type {
  ChartSpec,
  ResearchDeliverableEnvelope,
  ResearchPlanPayload,
  VisualAssetReference,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type { EvidenceManifest } from '../evidence/evidence-service.ts';
import {
  loadReportTemplate,
  type ReportTemplateSectionId,
} from '../runtime/config-loader.ts';
import { SchemaValidator } from '../schema/validator.ts';
import {
  chartTableAlternative,
  type ChartTableAlternative,
} from './chart-renderer.ts';
import {
  chartSpecHash,
  validateChartSpec,
  type ChartEvidenceResolver,
} from './chart-spec-validator.ts';
import {
  assertVisualAssetManifestSchema,
  type VerifiedVisualAsset,
} from './visual-asset-service.ts';

export type ReportAssetReference = VisualAssetReference;

export interface ReportChartReference extends ReportAssetReference {
  chartId: string;
}

export interface ReportParagraphBlock {
  id: string;
  type: 'paragraph';
  text: string;
}

export interface ReportFactBlock {
  id: string;
  type: 'fact';
  text: string;
  evidenceIds: string[];
}

export interface ReportMetricBlock {
  id: string;
  type: 'metric';
  label: string;
  value: number;
  evidenceIds: string[];
}

export interface ReportListBlock {
  id: string;
  type: 'list';
  items: string[];
}

export interface ReportImageBlock {
  id: string;
  type: 'image';
  assetRef: ReportAssetReference;
  caption: string;
  altText: string;
}

export interface ReportImageComparisonBlock {
  id: string;
  type: 'image-comparison';
  beforeAssetRef: ReportAssetReference;
  afterAssetRef: ReportAssetReference;
  caption: string;
  altText: string;
}

export interface ReportChartBlock {
  id: string;
  type: 'chart';
  chartRef: ReportChartReference;
  specHash: string;
  spec: ChartSpec;
  table: ChartTableAlternative;
  caption: string;
  altText: string;
}

export type ReportBlock =
  | ReportParagraphBlock
  | ReportFactBlock
  | ReportMetricBlock
  | ReportListBlock
  | ReportImageBlock
  | ReportImageComparisonBlock
  | ReportChartBlock;

export interface ReportSection {
  id: string;
  title: string;
  questionIds: string[];
  blocks: ReportBlock[];
}

export interface ReportDocument {
  version: 'report-document-v1';
  title: string;
  subtitle: string;
  executiveSummary: string;
  sections: ReportSection[];
}

interface ArtifactValue<T> {
  artifact: ControlArtifact;
  value: T;
}

export interface VerifiedChart {
  spec: ChartSpec;
  specHash: string;
  table: ChartTableAlternative;
  asset: VerifiedVisualAsset;
}

export interface ComposeReportDocumentInput {
  templateId: 'research-plan';
  requiredQuestionIds: string[];
  deliverable: ArtifactValue<ResearchDeliverableEnvelope<ResearchPlanPayload>>;
  evidenceManifest: ArtifactValue<EvidenceManifest>;
  evidenceResolver: ChartEvidenceResolver;
  review: ArtifactValue<ReportReviewArtifact>;
  visualAssets: VerifiedVisualAsset[];
  charts: VerifiedChart[];
}

export interface ReportDocumentReferenceContext {
  requiredQuestionIds: string[];
  evidenceIds: string[];
  visualAssets: ReportAssetReference[];
  charts: ReportChartReference[];
}

interface ArtifactBinding {
  taskId: string;
  planVersionId: string;
  attemptId: string;
}

export class ReportDocumentValidationError extends Error {
  constructor(message: string) {
    super(`ReportDocument validation failed: ${message}`);
    this.name = 'ReportDocumentValidationError';
  }
}

const DOCUMENT_SCHEMA = new SchemaValidator();

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

function contentHash(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function prettyJsonBytes(value: unknown, label: string): Buffer {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) fail(`${label} sealed JSON value is not serializable`);
  return Buffer.from(serialized);
}

function assertSealedJsonValue(artifact: ControlArtifact, value: unknown, label: string): void {
  const bytes = prettyJsonBytes(value, label);
  if (artifact.contentSha256 !== contentHash(bytes) || artifact.byteSize !== bytes.byteLength) {
    fail(`${label} sealed JSON content hash or byte size integrity does not match the supplied value`);
  }
}

function fail(message: string): never {
  throw new ReportDocumentValidationError(message);
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail(`${label} "${value}" must be unique`);
    seen.add(value);
  }
}

function sameBinding(value: ArtifactBinding, expected: ArtifactBinding): boolean {
  return value.taskId === expected.taskId
    && value.planVersionId === expected.planVersionId
    && value.attemptId === expected.attemptId;
}

function artifactBinding(artifact: ControlArtifact, label: string): ArtifactBinding {
  if (!artifact.planVersionId || !artifact.attemptId) {
    fail(`${label} is missing its Plan or Attempt binding`);
  }
  return {
    taskId: artifact.taskId,
    planVersionId: artifact.planVersionId,
    attemptId: artifact.attemptId,
  };
}

function assertSealedArtifact(
  artifact: ControlArtifact,
  expected: ArtifactBinding,
  label: string,
  kind: string,
  schemaVersions: readonly string[],
): void {
  if (artifact.state !== 'SEALED') fail(`${label} Artifact ${artifact.id} must be SEALED and verified`);
  if (!sameBinding(artifactBinding(artifact, label), expected)) {
    fail(`${label} Artifact ${artifact.id} binding does not match the Deliverable`);
  }
  if (artifact.kind !== kind) fail(`${label} Artifact ${artifact.id} kind must be ${kind}`);
  if (!schemaVersions.includes(artifact.schemaVersion)) {
    fail(`${label} Artifact ${artifact.id} schemaVersion must be one of ${schemaVersions.join(', ')}`);
  }
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(artifact.contentSha256 ?? '')
    || artifact.byteSize === null
    || !Number.isSafeInteger(artifact.byteSize)
    || artifact.byteSize < 0
  ) {
    fail(`${label} Artifact ${artifact.id} has no valid sealed content hash or byte size`);
  }
}

function assertValueBinding(value: ArtifactBinding, binding: ArtifactBinding, label: string): void {
  if (!sameBinding(value, binding)) fail(`${label} value binding does not match the Deliverable`);
}

function assertVerifiedVisualAsset(
  asset: VerifiedVisualAsset,
  binding: ArtifactBinding,
  label: string,
): void {
  assertSealedArtifact(
    asset.artifact,
    binding,
    `${label} Visual Asset`,
    'visual_asset',
    ['visual-asset-v1', 'binary-v1'],
  );
  assertSealedArtifact(
    asset.manifestArtifact,
    binding,
    `${label} Manifest`,
    'visual_asset_manifest',
    ['visual-asset-manifest-v1'],
  );
  assertVisualAssetManifestSchema(asset.manifest);
  assertValueBinding(asset.manifest, binding, `${label} Manifest`);
  assertSealedJsonValue(asset.manifestArtifact, asset.manifest, `${label} Manifest`);
  const { manifestHash, ...manifestDraft } = asset.manifest;
  if (manifestHash !== canonicalHash(manifestDraft)) fail(`${label} Manifest hash integrity check failed`);
  if (
    asset.manifest.assetId !== asset.artifact.id
    || asset.manifest.contentSha256 !== asset.artifact.contentSha256
    || asset.manifest.mediaType !== asset.metadata.contentType
    || asset.manifest.byteSize !== asset.metadata.byteSize
    || asset.manifest.width !== asset.metadata.width
    || asset.manifest.height !== asset.metadata.height
    || asset.artifact.mediaType !== asset.metadata.contentType
    || asset.artifact.byteSize !== asset.metadata.byteSize
    || asset.artifact.metadata?.width !== asset.metadata.width
    || asset.artifact.metadata?.height !== asset.metadata.height
    || contentHash(asset.bytes) !== asset.manifest.contentSha256
  ) {
    fail(`${label} Visual Asset, bytes, and Manifest identity do not match`);
  }
  if (asset.manifest.exportPolicy === 'block') fail(`${label} Visual Asset is blocked from report export`);
}

function assetReference(asset: VerifiedVisualAsset): ReportAssetReference {
  return {
    assetId: asset.artifact.id,
    manifestArtifactId: asset.manifestArtifact.id,
  };
}

function assetReferenceKey(reference: ReportAssetReference): string {
  return `${reference.assetId}\u0000${reference.manifestArtifactId}`;
}

function chartReferenceKey(reference: ReportChartReference): string {
  return `${reference.chartId}\u0000${assetReferenceKey(reference)}`;
}

function assertChartTable(spec: ChartSpec, table: ChartTableAlternative, label: string): void {
  if (canonicalHash(table) !== canonicalHash(chartTableAlternative(spec))) {
    fail(`${label} table alternative does not match the validated Chart Spec`);
  }
}

function assertCompositionInput(input: ComposeReportDocumentInput): ArtifactBinding {
  const deliverable = input.deliverable.value;
  const binding: ArtifactBinding = {
    taskId: deliverable.taskId,
    planVersionId: deliverable.planVersionId,
    attemptId: deliverable.attemptId,
  };
  assertSealedArtifact(
    input.deliverable.artifact,
    binding,
    'Deliverable',
    'deliverable',
    ['research-deliverable-v1-review-gated'],
  );
  assertSealedJsonValue(input.deliverable.artifact, deliverable, 'Deliverable');
  assertValueBinding(deliverable, binding, 'Deliverable');
  if (deliverable.version !== 'research-deliverable-v1' || deliverable.deliverableType !== 'research_plan') {
    fail('Deliverable must be a current research_plan');
  }

  assertSealedArtifact(
    input.evidenceManifest.artifact,
    binding,
    'Evidence Manifest',
    'evidence_manifest',
    ['evidence-v1'],
  );
  assertSealedJsonValue(input.evidenceManifest.artifact, input.evidenceManifest.value, 'Evidence Manifest');
  assertValueBinding(input.evidenceManifest.value, binding, 'Evidence Manifest');
  if (input.evidenceManifest.value.version !== 'evidence-v1') {
    fail('Evidence Manifest value version must be evidence-v1');
  }
  const { manifestHash: evidenceManifestHash, ...evidenceManifestDraft } = input.evidenceManifest.value;
  if (evidenceManifestHash !== canonicalHash(evidenceManifestDraft)) {
    fail('Evidence Manifest hash integrity check failed');
  }
  if (deliverable.evidenceManifestArtifactId !== input.evidenceManifest.artifact.id) {
    fail(`Deliverable is bound to Evidence Manifest ${deliverable.evidenceManifestArtifactId}, not ${input.evidenceManifest.artifact.id}`);
  }

  assertSealedArtifact(input.review.artifact, binding, 'Review', 'report_review', ['report-review-v1']);
  assertSealedJsonValue(input.review.artifact, input.review.value, 'Review');
  assertValueBinding(input.review.value, binding, 'Review');
  if (input.review.value.version !== 'report-review-v1') fail('Review value version must be report-review-v1');
  if (input.review.value.verdict !== 'pass') {
    fail(`Review verdict must be pass, received ${input.review.value.verdict}`);
  }
  if (input.review.value.deliverableArtifactId !== input.deliverable.artifact.id) {
    fail(`Review Deliverable binding ${input.review.value.deliverableArtifactId} does not match ${input.deliverable.artifact.id}`);
  }
  const reviewDimensions = new Map(input.review.value.dimensions.map((dimension) => [dimension.id, dimension]));
  for (const id of REPORT_REVIEW_DIMENSION_IDS) {
    const dimension = reviewDimensions.get(id);
    if (!dimension?.passed || dimension.issues.length > 0) fail(`Review dimension ${id} did not pass cleanly`);
  }
  if (reviewDimensions.size !== REPORT_REVIEW_DIMENSION_IDS.length) fail('Review dimensions are incomplete or duplicated');

  assertUnique(input.requiredQuestionIds, 'required question id');
  const coveredQuestionIds = new Set(deliverable.coverage.questionBindings.map(({ questionId }) => questionId));
  for (const questionId of input.requiredQuestionIds) {
    if (!coveredQuestionIds.has(questionId)) fail(`required question ${questionId} is not covered by the Deliverable`);
  }

  const evidenceIds = input.evidenceManifest.value.entries.map(({ id }) => id);
  assertUnique(evidenceIds, 'Evidence id');
  const evidenceSet = new Set(evidenceIds);
  for (const finding of deliverable.findingGraph.findings) {
    if (finding.kind !== 'fact') continue;
    if (finding.evidenceIds.length === 0) fail(`Fact ${finding.id} has no Evidence`);
    for (const evidenceId of finding.evidenceIds) {
      if (!evidenceSet.has(evidenceId)) fail(`Fact ${finding.id} references dangling Evidence ${evidenceId}`);
    }
  }

  const visualReferences = new Map<string, VerifiedVisualAsset>();
  for (const [index, asset] of input.visualAssets.entries()) {
    assertVerifiedVisualAsset(asset, binding, `Visual Asset ${index + 1}`);
    if (asset.manifest.mediaType === 'image/svg+xml') {
      fail(`Visual Asset ${asset.artifact.id} SVG must be supplied through a verified Chart`);
    }
    const key = assetReferenceKey(assetReference(asset));
    if (visualReferences.has(key)) fail(`Visual Asset reference ${asset.artifact.id} must be unique`);
    visualReferences.set(key, asset);
  }

  const chartIds = new Set<string>();
  const chartAssetReferences = new Set<string>();
  for (const [index, chart] of input.charts.entries()) {
    const label = `Chart ${chart.spec.chartId || index + 1}`;
    assertVerifiedVisualAsset(chart.asset, binding, label);
    const validatedSpec = validateChartSpec(chart.spec, input.evidenceResolver);
    const validatedSpecHash = chartSpecHash(validatedSpec);
    if (chart.specHash !== validatedSpecHash) {
      fail(`${label} spec digest ${chart.specHash} does not match the exact Chart Spec ${validatedSpecHash}`);
    }
    assertChartTable(validatedSpec, chart.table, label);
    if (chartIds.has(chart.spec.chartId)) fail(`Chart id ${chart.spec.chartId} must be unique`);
    chartIds.add(chart.spec.chartId);
    const chartAssetKey = assetReferenceKey(assetReference(chart.asset));
    if (chartAssetReferences.has(chartAssetKey)) fail(`Chart Asset ${chart.asset.artifact.id} must be unique`);
    chartAssetReferences.add(chartAssetKey);
    if (
      chart.asset.manifest.mediaType !== 'image/svg+xml'
      || chart.asset.manifest.source.kind !== 'derived'
      || chart.asset.manifest.derivation?.kind !== 'chart_svg'
      || chart.asset.manifest.derivation.chartId !== validatedSpec.chartId
      || chart.asset.manifest.derivation.specHash !== validatedSpecHash
      || !chart.asset.manifest.derivedFrom
    ) {
      const actualChartId = chart.asset.manifest.derivation?.kind === 'chart_svg'
        ? chart.asset.manifest.derivation.chartId
        : 'missing';
      fail(`${label} SVG derivation binding ${actualChartId} does not match Chart ${validatedSpec.chartId} and spec digest ${validatedSpecHash}`);
    }
    const origin = visualReferences.get(assetReferenceKey(chart.asset.manifest.derivedFrom));
    if (
      !origin
      || origin.manifest.contentSha256 !== chart.asset.manifest.derivedFrom.contentSha256
      || origin.manifest.manifestHash !== chart.asset.manifest.derivedFrom.manifestHash
    ) {
      fail(`${label} SVG lineage does not reference a verified sealed Visual Asset`);
    }
  }
  return binding;
}

function paragraph(id: string, text: string): ReportParagraphBlock {
  return { id, type: 'paragraph', text };
}

function composeExecutiveSummary(deliverable: ResearchDeliverableEnvelope<ResearchPlanPayload>): string {
  return deliverable.findingGraph.analyses[0]?.statement
    ?? deliverable.findingGraph.overallConclusions[0]?.statement
    ?? deliverable.methodSummary;
}

function scopeText(payload: ResearchPlanPayload): string {
  return `${payload.scope.market}; ${payload.scope.subjects.join(', ')}; ${payload.scope.timeWindow}.`;
}

function sourceCaption(asset: VerifiedVisualAsset, index: number): string {
  if (asset.manifest.source.kind === 'user_upload') return asset.manifest.source.fileName;
  if (asset.manifest.source.kind === 'tool_artifact') return `Verified source visual ${index + 1}`;
  return `Verified derived visual ${index + 1}`;
}

function chartAltText(spec: ChartSpec): string {
  const values = spec.series.flatMap((series) => series.values)
    .filter((value): value is number => value !== null)
    .join(', ');
  return values ? `${spec.title}. Values: ${values}.` : `${spec.title}. No numeric values reported.`;
}

function composeSectionBlocks(
  sectionId: ReportTemplateSectionId,
  input: ComposeReportDocumentInput,
  executiveSummary: string,
): ReportBlock[] {
  const deliverable = input.deliverable.value;
  const payload = deliverable.payload;
  switch (sectionId) {
    case 'cover':
      return [paragraph('cover-title', payload.title), paragraph('cover-subtitle', 'Evidence-bound professional research plan.')];
    case 'executive-summary':
      return [paragraph('executive-summary-text', executiveSummary)];
    case 'background':
      return [paragraph('background-goal', payload.researchGoal)];
    case 'scope-method':
      return [
        paragraph('scope', scopeText(payload)),
        paragraph('method-summary', deliverable.methodSummary),
        paragraph('sampling-strategy', payload.competitorSampling.strategy),
      ];
    case 'key-metrics': {
      const metrics: ReportMetricBlock[] = [];
      for (const chart of input.charts) {
        for (const series of chart.spec.series) {
          for (let index = 0; index < series.values.length; index += 1) {
            const value = series.values[index]!;
            if (value === null) continue;
            metrics.push({
              id: `metric-${metrics.length + 1}`,
              type: 'metric',
              label: `${series.label} — ${chart.spec.categories[index]}`,
              value,
              evidenceIds: [...series.evidenceIds[index]!],
            });
          }
        }
      }
      return metrics.length > 0
        ? metrics
        : [paragraph('sampling-target', `Target competitor sample: ${payload.competitorSampling.targetCount}.`)];
    }
    case 'findings':
      return deliverable.findingGraph.findings.map((finding, index) => finding.kind === 'fact'
        ? {
            id: `finding-fact-${index + 1}`,
            type: 'fact',
            text: finding.statement,
            evidenceIds: [...finding.evidenceIds],
          }
        : paragraph(`finding-inference-${index + 1}`, finding.statement));
    case 'question-analysis': {
      const summaryById = new Map(
        deliverable.findingGraph.subQuestionSummaries.map((summary) => [summary.id, summary.summary]),
      );
      return deliverable.coverage.questionBindings.flatMap((questionBinding, questionIndex) =>
        questionBinding.summaryIds.map((summaryId, summaryIndex) =>
          paragraph(
            `question-${questionIndex + 1}-summary-${summaryIndex + 1}`,
            summaryById.get(summaryId) ?? fail(`Question ${questionBinding.questionId} references missing Summary ${summaryId}`),
          )));
    }
    case 'visual-evidence':
      return input.visualAssets.map((asset, index): ReportImageBlock => ({
        id: `image-${index + 1}`,
        type: 'image',
        assetRef: assetReference(asset),
        caption: sourceCaption(asset, index),
        altText: `Verified visual evidence, ${asset.metadata.width} by ${asset.metadata.height} pixels.`,
      }));
    case 'comparison':
      return input.charts.map(({ spec, specHash, table, asset }, index): ReportChartBlock => ({
        id: `chart-${index + 1}`,
        type: 'chart',
        chartRef: { chartId: spec.chartId, ...assetReference(asset) },
        specHash,
        spec: structuredClone(spec),
        table: structuredClone(table),
        caption: spec.title,
        altText: chartAltText(spec),
      }));
    case 'conclusion':
      return deliverable.findingGraph.overallConclusions.map((conclusion, index) =>
        paragraph(`conclusion-${index + 1}`, conclusion.statement));
    case 'recommendations':
      return deliverable.recommendations.map((recommendation, index) =>
        paragraph(`recommendation-${index + 1}`, recommendation.statement));
    case 'risks':
      return deliverable.risksAndOpenIssues.map((risk, index) => paragraph(`risk-${index + 1}`, risk));
    case 'appendix': {
      const evidenceItems = input.evidenceManifest.value.entries.map((entry) =>
        `${entry.id}: ${entry.evidenceClass} Evidence from Artifact ${entry.artifactId}.`);
      return evidenceItems.length > 0 ? [{ id: 'evidence-index', type: 'list', items: evidenceItems }] : [];
    }
  }
}

export function assertValidReportDocument(
  document: ReportDocument,
  references: ReportDocumentReferenceContext,
): void {
  DOCUMENT_SCHEMA.validateOrThrow('report-document', document);
  assertUnique(document.sections.map(({ id }) => id), 'section id');
  assertUnique(document.sections.flatMap(({ blocks }) => blocks.map(({ id }) => id)), 'block id');
  assertUnique(references.requiredQuestionIds, 'required question id');
  const coveredQuestions = new Set(document.sections.flatMap(({ questionIds }) => questionIds));
  for (const questionId of references.requiredQuestionIds) {
    if (!coveredQuestions.has(questionId)) fail(`required question ${questionId} is not assigned to any section`);
  }

  const evidenceIds = new Set(references.evidenceIds);
  const visualReferences = new Set(references.visualAssets.map(assetReferenceKey));
  const chartReferences = new Set(references.charts.map(chartReferenceKey));
  for (const section of document.sections) {
    assertUnique(section.questionIds, `question id in section ${section.id}`);
    for (const block of section.blocks) {
      if (block.type === 'fact' || block.type === 'metric') {
        for (const evidenceId of block.evidenceIds) {
          if (!evidenceIds.has(evidenceId)) fail(`${block.type} block ${block.id} references dangling Evidence ${evidenceId}`);
        }
      } else if (block.type === 'image') {
        if (!visualReferences.has(assetReferenceKey(block.assetRef))) {
          fail(`image block ${block.id} references a dangling or missing Asset`);
        }
      } else if (block.type === 'image-comparison') {
        if (
          !visualReferences.has(assetReferenceKey(block.beforeAssetRef))
          || !visualReferences.has(assetReferenceKey(block.afterAssetRef))
        ) {
          fail(`image comparison block ${block.id} references a dangling or missing Asset`);
        }
      } else if (block.type === 'chart') {
        if (!chartReferences.has(chartReferenceKey(block.chartRef))) {
          fail(`chart block ${block.id} references a dangling or missing Chart`);
        }
        if (block.specHash !== chartSpecHash(block.spec)) {
          fail(`chart block ${block.id} spec digest does not match its Chart Spec`);
        }
        assertChartTable(block.spec, block.table, `chart block ${block.id}`);
        for (const series of block.spec.series) {
          for (const pointEvidenceIds of series.evidenceIds) {
            for (const evidenceId of pointEvidenceIds) {
              if (!evidenceIds.has(evidenceId)) {
                fail(`chart block ${block.id} references dangling Evidence ${evidenceId}`);
              }
            }
          }
        }
      }
    }
  }
}

export function composeReportDocument(input: ComposeReportDocumentInput): ReportDocument {
  assertCompositionInput(input);
  const template = loadReportTemplate(input.templateId);
  const executiveSummary = composeExecutiveSummary(input.deliverable.value);
  const document: ReportDocument = {
    version: 'report-document-v1',
    title: input.deliverable.value.payload.title,
    subtitle: template.subtitle,
    executiveSummary,
    sections: template.sections.map((section): ReportSection => ({
      id: section.id,
      title: section.title,
      questionIds: section.id === 'question-analysis' ? [...input.requiredQuestionIds] : [],
      blocks: composeSectionBlocks(section.id, input, executiveSummary),
    })),
  };
  assertValidReportDocument(document, {
    requiredQuestionIds: input.requiredQuestionIds,
    evidenceIds: input.evidenceManifest.value.entries.map(({ id }) => id),
    visualAssets: input.visualAssets.map(assetReference),
    charts: input.charts.map(({ spec, asset }) => ({ chartId: spec.chartId, ...assetReference(asset) })),
  });
  return document;
}
