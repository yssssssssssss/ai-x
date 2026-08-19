import { createHash } from 'node:crypto';
import type { ControlArtifact } from '../../../../database/control-plane.ts';
import type { ReportReviewArtifact } from '../../../../packages/api-contract/control-workflow.ts';
import type {
  ChartSpec,
  ResearchDeliverableEnvelope,
  VisualAssetManifest,
  VisualAssetReference,
} from '../../../../packages/api-contract/research-deliverable.ts';
import {
  EvidenceService,
  type EvidenceArtifactResolver,
  type EvidenceManifest,
} from '../evidence/evidence-service.ts';
import { ReportEvidenceValidator } from '../evidence/report-evidence-validator.ts';
import type { ReportTemplateSectionId } from '../runtime/config-loader.ts';
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
  assertCompetitiveWeightChartBinding,
  parseCompetitiveWeightChartData,
  type CompetitiveWeightChartData,
} from './competitive-weight-chart.ts';
import { assertValidReportReviewArtifact } from './report-review-service.ts';
import {
  resolveDeliverableContractById,
  type DeliverableContractResources,
} from './deliverable-registry.ts';
import {
  assertVisualAssetManifestSchema,
  type VerifiedVisualAsset,
} from './visual-asset-service.ts';

export type ReportAssetReference = VisualAssetReference;

export interface ReportChartReference extends ReportAssetReference {
  chartId: string;
}

export interface ReportVerifiedChartReference extends ReportChartReference {
  specHash: string;
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

export interface ChartDataArtifactReference {
  artifactId: string;
  contentSha256: string;
}

export interface VerifiedChart {
  spec: ChartSpec;
  specHash: string;
  table: ChartTableAlternative;
  asset: VerifiedVisualAsset;
  dataArtifactRef?: ChartDataArtifactReference;
  data?: CompetitiveWeightChartData;
}

export interface ComposeReportDocumentInput {
  templateId?: string;
  requiredQuestionIds: string[];
  deliverable: ArtifactValue<ResearchDeliverableEnvelope<unknown>>;
  evidenceManifest: ArtifactValue<EvidenceManifest>;
  evidenceArtifactResolver: EvidenceArtifactResolver;
  review: ArtifactValue<ReportReviewArtifact>;
  visualAssets: VerifiedVisualAsset[];
  charts: VerifiedChart[];
}

export interface ReportDocumentReferenceContext {
  requiredQuestionIds: string[];
  evidenceIds: string[];
  visualAssets: ReportAssetReference[];
  charts: ReportVerifiedChartReference[];
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

const EVIDENCE_SERVICE = new EvidenceService();
const REPORT_EVIDENCE_VALIDATOR: ReportEvidenceValidator = new ReportEvidenceValidator(EVIDENCE_SERVICE);
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
  manifestSchemaVersions: readonly VisualAssetManifest['version'][] = ['visual-asset-manifest-v1'],
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
    manifestSchemaVersions,
  );
  assertVisualAssetManifestSchema(asset.manifest);
  if (asset.manifestArtifact.schemaVersion !== asset.manifest.version) {
    fail(`${label} Manifest Artifact schemaVersion does not match its body version`);
  }
  if (
    asset.manifest.version === 'visual-asset-manifest-v2'
    && asset.artifact.schemaVersion !== 'visual-asset-v1'
  ) {
    fail(`${label} V2 Visual Asset Artifact schemaVersion must be visual-asset-v1`);
  }
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

function chartReferenceKey(reference: ReportVerifiedChartReference): string {
  return `${reference.chartId}\u0000${assetReferenceKey(reference)}\u0000${reference.specHash}`;
}

function assertChartTable(spec: ChartSpec, table: ChartTableAlternative, label: string): void {
  if (canonicalHash(table) !== canonicalHash(chartTableAlternative(spec))) {
    fail(`${label} table alternative does not match the validated Chart Spec`);
  }
}

function chartManifestSpecHash(asset: VerifiedVisualAsset): string {
  const derivation = asset.manifest.derivation;
  if (derivation?.kind !== 'chart_svg') fail(`Chart Asset ${asset.artifact.id} has no verified specHash lineage`);
  return derivation.specHash;
}

function assertCompositionInput(input: ComposeReportDocumentInput): {
  binding: ArtifactBinding;
  contract: DeliverableContractResources;
} {
  const deliverable = input.deliverable.value;
  const contract = resolveDeliverableContractById(deliverable.deliverableType);
  if (deliverable.deliverableType !== contract.entry.id) {
    fail('Deliverable deliverableType does not match its active Registry contract');
  }
  if (deliverable.version !== contract.entry.envelope_version) {
    fail('Deliverable version does not match its active Registry contract');
  }
  if (input.templateId !== undefined && input.templateId !== contract.entry.report_template) {
    fail(`requested Report Template ${input.templateId} does not match the active Registry contract`);
  }
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
    [`${contract.entry.envelope_version}-review-gated`],
  );
  assertSealedJsonValue(input.deliverable.artifact, deliverable, 'Deliverable');
  assertValueBinding(deliverable, binding, 'Deliverable');
  const payloadSchema = Object.fromEntries(
    Object.entries(contract.payloadSchema)
      .filter(([key]) => key !== '$schema' && key !== '$id'),
  );
  DOCUMENT_SCHEMA.validateSchemaOrThrow(
    payloadSchema,
    deliverable.payload,
    `${contract.entry.id} payload`,
  );
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
  EVIDENCE_SERVICE.validateManifest(input.evidenceManifest.value, input.evidenceArtifactResolver);
  if (deliverable.evidenceManifestArtifactId !== input.evidenceManifest.artifact.id) {
    fail(`Deliverable is bound to Evidence Manifest ${deliverable.evidenceManifestArtifactId}, not ${input.evidenceManifest.artifact.id}`);
  }
  REPORT_EVIDENCE_VALIDATOR.validate({
    manifest: input.evidenceManifest.value,
    report: deliverable,
    resolver: input.evidenceArtifactResolver,
    requireCoverage: true,
  });

  assertSealedArtifact(input.review.artifact, binding, 'Review', 'report_review', ['report-review-v1']);
  assertSealedJsonValue(input.review.artifact, input.review.value, 'Review');
  assertValueBinding(input.review.value, binding, 'Review');
  assertValidReportReviewArtifact(input.review.value, DOCUMENT_SCHEMA);
  if (input.review.value.version !== 'report-review-v1') fail('Review value version must be report-review-v1');
  if (input.review.value.verdict !== 'pass') {
    fail(`Review verdict must be pass, received ${input.review.value.verdict}`);
  }
  if (input.review.value.deliverableArtifactId !== input.deliverable.artifact.id) {
    fail(`Review Deliverable binding ${input.review.value.deliverableArtifactId} does not match ${input.deliverable.artifact.id}`);
  }

  assertUnique(input.requiredQuestionIds, 'required question id');
  const coveredQuestionIds = new Set(deliverable.coverage.questionBindings.map(({ questionId }) => questionId));
  for (const questionId of input.requiredQuestionIds) {
    if (!coveredQuestionIds.has(questionId)) fail(`required question ${questionId} is not covered by the Deliverable`);
  }

  const evidenceIds = input.evidenceManifest.value.entries.map(({ id }) => id);
  assertUnique(evidenceIds, 'Evidence id');
  const evidenceSet = new Set(evidenceIds);
  const evidenceEntries = new Map(
    input.evidenceManifest.value.entries.map((entry) => [entry.id, entry]),
  );
  const verifiedChartEvidenceResolver: ChartEvidenceResolver = (evidenceId) => {
    const entry = evidenceEntries.get(evidenceId);
    return entry
      ? EVIDENCE_SERVICE.resolveEvidenceValue(entry, input.evidenceArtifactResolver)
      : undefined;
  };
  for (const finding of deliverable.findingGraph.findings) {
    if (finding.kind !== 'fact') continue;
    if (finding.evidenceIds.length === 0) fail(`Fact ${finding.id} has no Evidence`);
    for (const evidenceId of finding.evidenceIds) {
      if (!evidenceSet.has(evidenceId)) fail(`Fact ${finding.id} references dangling Evidence ${evidenceId}`);
    }
  }

  const visualReferences = new Map<string, VerifiedVisualAsset>();
  const visualAssetIds = new Set<string>();
  const visualRoles = new Map<string, 'original' | 'annotation'>();
  for (const [index, asset] of input.visualAssets.entries()) {
    assertVerifiedVisualAsset(asset, binding, `Visual Asset ${index + 1}`);
    if (asset.manifest.mediaType === 'image/svg+xml') {
      fail(`Visual Asset ${asset.artifact.id} SVG must be supplied through a verified Chart`);
    }
    if (visualAssetIds.has(asset.artifact.id)) {
      fail(`Visual Asset id ${asset.artifact.id} must be unique`);
    }
    visualAssetIds.add(asset.artifact.id);
    const key = assetReferenceKey(assetReference(asset));
    if (visualReferences.has(key)) fail(`Visual Asset reference ${asset.artifact.id} must be unique`);
    visualReferences.set(key, asset);
    if (
      asset.manifest.source.kind === 'user_upload'
      && asset.manifest.derivedFrom === null
      && asset.manifest.derivation === null
    ) {
      visualRoles.set(key, 'original');
    } else if (
      asset.manifest.source.kind === 'derived'
      && asset.manifest.derivedFrom !== null
      && asset.manifest.derivation?.kind === 'annotation'
    ) {
      visualRoles.set(key, 'annotation');
    } else {
      fail(`Visual Asset ${asset.artifact.id} has an unsupported source or role`);
    }
  }
  for (const asset of input.visualAssets) {
    const assetKey = assetReferenceKey(assetReference(asset));
    if (visualRoles.get(assetKey) !== 'annotation') continue;
    const lineage = asset.manifest.derivedFrom;
    const lineageKey = lineage ? assetReferenceKey(lineage) : null;
    const original = lineage
      ? visualReferences.get(assetReferenceKey(lineage))
      : undefined;
    if (
      !lineage
      || !original
      || !lineageKey
      || visualRoles.get(lineageKey) !== 'original'
      || lineage.contentSha256 !== original.manifest.contentSha256
      || lineage.manifestHash !== original.manifest.manifestHash
    ) {
      fail(`Annotation Asset ${asset.artifact.id} lineage does not reference its exact verified original`);
    }
  }

  const chartIds = new Set<string>();
  const chartAssetReferences = new Set<string>();
  const chartAssetIds = new Set<string>();
  for (const [index, chart] of input.charts.entries()) {
    const label = `Chart ${chart.spec.chartId || index + 1}`;
    assertVerifiedVisualAsset(chart.asset, binding, label, [
      'visual-asset-manifest-v1',
      'visual-asset-manifest-v2',
    ]);
    const validatedSpec = validateChartSpec(chart.spec, verifiedChartEvidenceResolver);
    const validatedSpecHash = chartSpecHash(validatedSpec);
    if (chart.specHash !== validatedSpecHash) {
      fail(`${label} spec digest ${chart.specHash} does not match the exact Chart Spec ${validatedSpecHash}`);
    }
    assertChartTable(validatedSpec, chart.table, label);
    if (chartIds.has(chart.spec.chartId)) fail(`Chart id ${chart.spec.chartId} must be unique`);
    chartIds.add(chart.spec.chartId);
    if (chartAssetIds.has(chart.asset.artifact.id)) {
      fail(`Chart Asset id ${chart.asset.artifact.id} must be unique`);
    }
    chartAssetIds.add(chart.asset.artifact.id);
    const chartAssetKey = assetReferenceKey(assetReference(chart.asset));
    if (chartAssetReferences.has(chartAssetKey)) fail(`Chart Asset ${chart.asset.artifact.id} must be unique`);
    chartAssetReferences.add(chartAssetKey);
    if (
      chart.asset.manifest.mediaType !== 'image/svg+xml'
      || chart.asset.manifest.derivation?.kind !== 'chart_svg'
      || chart.asset.manifest.derivation.chartId !== validatedSpec.chartId
      || chart.asset.manifest.derivation.specHash !== validatedSpecHash
    ) {
      const actualChartId = chart.asset.manifest.derivation?.kind === 'chart_svg'
        ? chart.asset.manifest.derivation.chartId
        : 'missing';
      fail(`${label} SVG derivation binding ${actualChartId} does not match Chart ${validatedSpec.chartId} and spec digest ${validatedSpecHash}`);
    }
    if (chart.asset.manifest.version === 'visual-asset-manifest-v2') {
      const source = chart.asset.manifest.source;
      if (
        source.kind !== 'chart_render'
        || chart.asset.manifest.derivedFrom !== null
        || !chart.dataArtifactRef
        || chart.dataArtifactRef.artifactId !== source.dataArtifactId
        || chart.dataArtifactRef.contentSha256 !== source.dataArtifactContentSha256
      ) {
        fail(`${label} data Artifact provenance does not match its verified chart_render Manifest`);
      }
      if (!chart.data) fail(`${label} has no verified competitive weight Chart Data`);
      try {
        const data = parseCompetitiveWeightChartData(chart.data, binding);
        assertCompetitiveWeightChartBinding({
          data,
          spec: validatedSpec,
          dataArtifactRef: chart.dataArtifactRef,
          evidenceEntries: input.evidenceManifest.value.entries,
        });
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
      continue;
    }
    const lineage = chart.asset.manifest.derivedFrom;
    if (chart.asset.manifest.source.kind !== 'derived' || !lineage) {
      fail(`${label} SVG lineage does not reference a verified sealed Visual Asset`);
    }
    const origin = visualReferences.get(assetReferenceKey(lineage));
    if (
      !origin
      || origin.manifest.contentSha256 !== lineage.contentSha256
      || origin.manifest.manifestHash !== lineage.manifestHash
    ) {
      fail(`${label} SVG lineage does not reference a verified sealed Visual Asset`);
    }
  }
  return { binding, contract };
}

function paragraph(id: string, text: string): ReportParagraphBlock {
  return { id, type: 'paragraph', text };
}

interface ResearchPlanRenderPayload {
  title: string;
  researchGoal: string;
  scope: { market: string; subjects: string[]; timeWindow: string };
  competitorSampling: { strategy: string; targetCount: number };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function researchPlanRenderPayload(value: unknown): ResearchPlanRenderPayload | null {
  const payload = record(value);
  const scope = record(payload?.scope);
  const sampling = record(payload?.competitorSampling);
  if (
    !payload
    || typeof payload.title !== 'string'
    || typeof payload.researchGoal !== 'string'
    || !scope
    || typeof scope.market !== 'string'
    || !Array.isArray(scope.subjects)
    || !scope.subjects.every((subject) => typeof subject === 'string')
    || typeof scope.timeWindow !== 'string'
    || !sampling
    || typeof sampling.strategy !== 'string'
    || typeof sampling.targetCount !== 'number'
  ) return null;
  return {
    title: payload.title,
    researchGoal: payload.researchGoal,
    scope: {
      market: scope.market,
      subjects: scope.subjects,
      timeWindow: scope.timeWindow,
    },
    competitorSampling: {
      strategy: sampling.strategy,
      targetCount: sampling.targetCount,
    },
  };
}
function payloadRecords(payload: unknown, field: string): Record<string, unknown>[] {
  const value = record(payload)?.[field];
  return Array.isArray(value)
    ? value.flatMap((candidate) => {
        const item = record(candidate);
        return item ? [item] : [];
      })
    : [];
}

function payloadString(value: Record<string, unknown>, field: string): string {
  return typeof value[field] === 'string' ? value[field] : '';
}

function payloadStrings(value: Record<string, unknown>, field: string): string[] {
  return Array.isArray(value[field])
    ? value[field].filter((item): item is string => typeof item === 'string')
    : [];
}

function professionalSectionBlocks(
  sectionId: ReportTemplateSectionId,
  input: ComposeReportDocumentInput,
): ReportBlock[] {
  const deliverable = input.deliverable.value;
  const payload = deliverable.payload;
  if (deliverable.deliverableType === 'competitive_analysis_report') {
    const payloadRoot = record(payload) ?? {};
    if (sectionId === 'executive-summary') {
      const items = payloadStrings(payloadRoot, 'managementSummary');
      return items.length > 0 ? [{
        id: 'competitive-management-summary',
        type: 'list',
        items,
      }] : [];
    }
    if (sectionId === 'scope-method') {
      return [{
        id: 'competitive-samples',
        type: 'list',
        items: payloadRecords(payload, 'competitorSamples').map((sample) =>
          `${payloadString(sample, 'name')}: ${payloadString(sample, 'rationale')}`),
      }];
    }
    if (sectionId === 'key-metrics') {
      const samplesById = new Map(
        payloadRecords(payload, 'competitorSamples').map((sample) => [
          payloadString(sample, 'id'),
          payloadString(sample, 'name'),
        ]),
      );
      const metrics = payloadRecords(payload, 'dimensionMatrix').flatMap((row, rowIndex) => {
        const dimension = payloadString(row, 'dimension');
        const weight = typeof row.weight === 'number' ? row.weight : null;
        const weightLabel = weight === null ? '' : ` · 权重 ${Math.round(weight * 1000) / 10}%`;
        return payloadRecords(row, 'values').flatMap((value, valueIndex): ReportMetricBlock[] => {
          if (typeof value.score !== 'number') return [];
          const sampleId = payloadString(value, 'sampleId');
          return [{
            id: `competitive-score-${rowIndex + 1}-${valueIndex + 1}`,
            type: 'metric',
            label: `${dimension}${weightLabel} · ${samplesById.get(sampleId) || sampleId}（5分制）`,
            value: value.score,
            evidenceIds: payloadStrings(value, 'evidenceIds'),
          }];
        });
      });
      const scoringMethod = payloadStrings(payloadRoot, 'scoringMethod');
      return [
        ...metrics,
        ...(scoringMethod.length > 0 ? [{
          id: 'competitive-scoring-method',
          type: 'list' as const,
          items: scoringMethod,
        }] : []),
      ];
    }
    if (sectionId === 'findings') {
      const samplesById = new Map(
        payloadRecords(payload, 'competitorSamples').map((sample) => [
          payloadString(sample, 'id'),
          payloadString(sample, 'name'),
        ]),
      );
      const differences = payloadRecords(payload, 'differences');
      const matrixRows = payloadRecords(payload, 'dimensionMatrix');
      const matrixDimensions = new Set(matrixRows.map((row) => payloadString(row, 'dimension')));
      const matrix = matrixRows.map((row, rowIndex): ReportFactBlock => {
        const dimension = payloadString(row, 'dimension');
        const values = payloadRecords(row, 'values');
        const matchingDifferences = differences.filter(
          (difference) => payloadString(difference, 'dimension') === dimension,
        );
        const evidenceIds = [...new Set([
          ...values.flatMap((value) => payloadStrings(value, 'evidenceIds')),
          ...matchingDifferences.flatMap((difference) => payloadStrings(difference, 'evidenceIds')),
        ])];
        const sampleSummary = values.map((value) => {
          const sampleId = payloadString(value, 'sampleId');
          const sampleName = samplesById.get(sampleId) || sampleId;
          const score = typeof value.score === 'number' ? `评分 ${value.score}/5；` : '';
          return `${sampleName}：${score}${payloadString(value, 'value')}`;
        }).join('\n');
        const differenceSummary = matchingDifferences
          .map((difference) => payloadString(difference, 'statement'))
          .join('；');
        return {
          id: `competitive-matrix-${rowIndex + 1}`,
          type: 'fact',
          text: `【${dimension}${typeof row.weight === 'number' ? `｜权重 ${Math.round(row.weight * 1000) / 10}%` : ''}】\n${sampleSummary}${differenceSummary ? `\n综合判断：${differenceSummary}` : ''}`,
          evidenceIds,
        };
      });
      const crossDimensionDifferences = differences.filter(
        (difference) => !matrixDimensions.has(payloadString(difference, 'dimension')),
      );
      if (crossDimensionDifferences.length === 0) return matrix;
      return [...matrix, {
        id: 'competitive-cross-dimension-synthesis',
        type: 'fact',
        text: `【跨维度综合】\n${crossDimensionDifferences.map((difference) => (
          `${payloadString(difference, 'dimension')}：${payloadString(difference, 'statement')}`
        )).join('\n')}`,
        evidenceIds: [...new Set(crossDimensionDifferences.flatMap(
          (difference) => payloadStrings(difference, 'evidenceIds'),
        ))],
      }];
    }
    if (sectionId === 'visual-evidence') {
      const comparisons = payloadRecords(payload, 'screenshotComparisons');
      const assetsById = new Map(input.visualAssets.map((asset) => [asset.artifact.id, asset]));
      const roles = new Map<string, 'original' | 'annotation'>();
      for (const asset of input.visualAssets) {
        if (
          asset.manifest.source.kind === 'user_upload'
          && asset.manifest.derivedFrom === null
          && asset.manifest.derivation === null
        ) {
          roles.set(asset.artifact.id, 'original');
          continue;
        }
        if (
          asset.manifest.source.kind === 'derived'
          && asset.manifest.derivedFrom !== null
          && asset.manifest.derivation?.kind === 'annotation'
        ) {
          roles.set(asset.artifact.id, 'annotation');
          continue;
        }
        fail(`Competitive visual Asset ${asset.artifact.id} has an unsupported source or role`);
      }
      for (const asset of input.visualAssets) {
        if (roles.get(asset.artifact.id) !== 'annotation') continue;
        const lineage = asset.manifest.derivedFrom!;
        const original = assetsById.get(lineage.assetId);
        if (
          !original
          || roles.get(original.artifact.id) !== 'original'
          || lineage.manifestArtifactId !== original.manifestArtifact.id
          || lineage.contentSha256 !== original.manifest.contentSha256
          || lineage.manifestHash !== original.manifest.manifestHash
        ) {
          fail(`Competitive annotation Asset ${asset.artifact.id} has invalid exact original lineage`);
        }
      }
      if (comparisons.length === 0) {
        if (input.visualAssets.length > 0) {
          fail('Competitive screenshot comparisons are required for a non-empty verified visual inventory');
        }
        return [];
      }
      return comparisons.map((comparison, comparisonIndex) => {
        const assetIds = payloadStrings(comparison, 'assetIds');
        if (assetIds.length !== 2 || assetIds[0] === assetIds[1]) {
          fail('Competitive screenshot comparison requires exactly one unique original/annotation pair');
        }
        const original = assetsById.get(assetIds[0]!)
          ?? fail(`Screenshot comparison references missing verified original Asset ${assetIds[0]}`);
        const annotation = assetsById.get(assetIds[1]!)
          ?? fail(`Screenshot comparison references missing verified annotation Asset ${assetIds[1]}`);
        const lineage = annotation.manifest.derivedFrom;
        if (
          roles.get(original.artifact.id) !== 'original'
          || roles.get(annotation.artifact.id) !== 'annotation'
          || lineage === null
          || lineage.assetId !== original.artifact.id
          || lineage.manifestArtifactId !== original.manifestArtifact.id
          || lineage.contentSha256 !== original.manifest.contentSha256
          || lineage.manifestHash !== original.manifest.manifestHash
        ) {
          fail('Competitive screenshot comparison has invalid exact original/annotation lineage');
        }
        return {
          id: `competitive-screenshot-comparison-${comparisonIndex + 1}`,
          type: 'image-comparison',
          beforeAssetRef: assetReference(original),
          afterAssetRef: assetReference(annotation),
          caption: `${payloadString(comparison, 'caption')} 输入边界仅用于来源溯源，不定位或证明任何研究发现。`,
          altText: `Original ${payloadString(comparison, 'dimension')} screenshot with an input-provenance boundary that does not locate or substantiate a research finding.`,
        };
      });
    }
    if (sectionId === 'comparison') {
      return [{
        id: 'competitive-impacts',
        type: 'list',
        items: payloadRecords(payload, 'impacts').map((impact) =>
          `${payloadString(impact, 'audience')}: ${payloadString(impact, 'statement')}`),
      }];
    }
    if (sectionId === 'recommendations') {
      const blocks: ReportBlock[] = [{
        id: 'competitive-actions',
        type: 'list',
        items: payloadRecords(payload, 'actionRecommendations').map((action) =>
          `${payloadString(action, 'priority')}: ${payloadString(action, 'statement')}`),
      }];
      const roadmap = payloadRecords(payload, 'roadmap');
      if (roadmap.length > 0) {
        blocks.push({
          id: 'competitive-roadmap',
          type: 'list',
          items: roadmap.map((item) => (
            `${payloadString(item, 'priority')}: ${payloadString(item, 'statement')}；指标：${payloadString(item, 'metric')}；验证：${payloadString(item, 'validationMethod')}`
          )),
        });
      }
      return blocks;
    }
    if (sectionId === 'appendix') {
      const blocks: ReportBlock[] = [];
      const instrumentation = payloadStrings(payloadRoot, 'instrumentationPlan');
      const userTest = payloadStrings(payloadRoot, 'userTestScript');
      if (instrumentation.length > 0) {
        blocks.push({
          id: 'competitive-instrumentation-plan',
          type: 'list',
          items: instrumentation,
        });
      }
      if (userTest.length > 0) {
        blocks.push({
          id: 'competitive-user-test-script',
          type: 'list',
          items: userTest,
        });
      }
      return blocks;
    }
  }
  if (deliverable.deliverableType === 'voc_diagnosis_report') {
    if (sectionId === 'scope-method') {
      return [{
        id: 'voc-datasets',
        type: 'list',
        items: payloadRecords(payload, 'datasets').map((dataset) =>
          `${payloadString(dataset, 'name')} — ${payloadString(dataset, 'source')}: ${String(dataset.recordCount ?? '')} records`),
      }];
    }
    if (sectionId === 'key-metrics') {
      const evidenceByTheme = new Map(
        payloadRecords(payload, 'themes').map((theme) => [
          payloadString(theme, 'id'),
          payloadStrings(theme, 'evidenceIds'),
        ]),
      );
      const frequencies = payloadRecords(payload, 'frequencies').flatMap((frequency, index): ReportMetricBlock[] => {
        const themeId = payloadString(frequency, 'themeId');
        const evidenceIds = evidenceByTheme.get(themeId)
          ?? fail(`VOC frequency references missing theme ${themeId}`);
        return [{
          id: `voc-frequency-count-${index + 1}`,
          type: 'metric',
          label: `${themeId} count`,
          value: typeof frequency.count === 'number' ? frequency.count : 0,
          evidenceIds,
        }, {
          id: `voc-frequency-share-${index + 1}`,
          type: 'metric',
          label: `${themeId} share`,
          value: typeof frequency.share === 'number' ? frequency.share : 0,
          evidenceIds,
        }];
      });
      const sentiments = payloadRecords(payload, 'sentiments').map((sentiment, index): ReportMetricBlock => {
        const themeId = payloadString(sentiment, 'themeId');
        return {
          id: `voc-sentiment-${index + 1}`,
          type: 'metric',
          label: `${themeId} ${payloadString(sentiment, 'label')} sentiment`,
          value: typeof sentiment.score === 'number' ? sentiment.score : 0,
          evidenceIds: evidenceByTheme.get(themeId)
            ?? fail(`VOC sentiment references missing theme ${themeId}`),
        };
      });
      return [...frequencies, ...sentiments];
    }
    if (sectionId === 'findings') {
      const themes = payloadRecords(payload, 'themes').map((theme, index): ReportFactBlock => ({
        id: `voc-theme-${index + 1}`,
        type: 'fact',
        text: payloadString(theme, 'label'),
        evidenceIds: payloadStrings(theme, 'evidenceIds'),
      }));
      const quotes = payloadRecords(payload, 'representativeQuotes').map((quote, index): ReportFactBlock => ({
        id: `voc-quote-${index + 1}`,
        type: 'fact',
        text: `“${payloadString(quote, 'quote')}”`,
        evidenceIds: [payloadString(quote, 'evidenceId')],
      }));
      return [...themes, ...quotes];
    }
    if (sectionId === 'comparison') {
      return [{
        id: 'voc-severity-priority',
        type: 'list',
        items: [
          ...payloadRecords(payload, 'severities').map((severity) =>
            `${payloadString(severity, 'themeId')} — ${payloadString(severity, 'level')}: ${payloadString(severity, 'rationale')}`),
          ...payloadRecords(payload, 'priorities').map((priority) =>
            `${payloadString(priority, 'themeId')} — ${payloadString(priority, 'level')}: ${payloadString(priority, 'rationale')}`),
        ],
      }];
    }
  }
  if (deliverable.deliverableType === 'design_audit_report') {
    if (sectionId === 'scope-method') {
      return [{
        id: 'design-pages',
        type: 'list',
        items: payloadRecords(payload, 'pages').map((page) =>
          `${payloadString(page, 'name')} — ${payloadString(page, 'state')}`),
      }];
    }
    if (sectionId === 'findings') {
      return [{
        id: 'design-findings',
        type: 'list',
        items: [
          ...payloadRecords(payload, 'issues').map((issue) => payloadString(issue, 'statement')),
          ...payloadRecords(payload, 'principles').map((principle) =>
            `${payloadString(principle, 'principle')}: ${payloadString(principle, 'rationale')}`),
          ...payloadRecords(payload, 'severities').map((severity) =>
            `${payloadString(severity, 'level')}: ${payloadString(severity, 'rationale')}`),
        ],
      }];
    }
    if (sectionId === 'visual-evidence') {
      const assetsById = new Map(input.visualAssets.map((asset) => [asset.artifact.id, asset]));
      return payloadRecords(payload, 'annotatedScreenshots').map((screenshot, index): ReportImageComparisonBlock => {
        const assetId = payloadString(screenshot, 'assetId');
        const annotation = assetsById.get(assetId)
          ?? fail(`Annotated screenshot references missing verified visual Asset ${assetId}`);
        const originalReference = annotation.manifest.derivedFrom;
        if (annotation.manifest.derivation?.kind !== 'annotation' || !originalReference) {
          fail(`Annotated screenshot Asset ${assetId} does not have verified annotation lineage`);
        }
        const original = input.visualAssets.find((asset) =>
          assetReferenceKey(assetReference(asset)) === assetReferenceKey(originalReference));
        if (!original) fail(`Annotated screenshot Asset ${assetId} has missing original visual lineage`);
        return {
          id: `design-annotation-${index + 1}`,
          type: 'image-comparison',
          beforeAssetRef: assetReference(original),
          afterAssetRef: assetReference(annotation),
          caption: payloadString(screenshot, 'annotation'),
          altText: `Verified design issue annotation for ${payloadString(screenshot, 'issueId')}.`,
        };
      });
    }
    if (sectionId === 'recommendations') {
      return [{
        id: 'design-remediations',
        type: 'list',
        items: payloadRecords(payload, 'remediations').map((remediation) =>
          `${payloadString(remediation, 'action')} — ${payloadStrings(remediation, 'acceptanceCriteria').join('; ')}`),
      }];
    }
    if (sectionId === 'appendix') {
      return [{
        id: 'design-retests',
        type: 'list',
        items: payloadRecords(payload, 'retests').map((retest) =>
          `${payloadString(retest, 'method')}: ${payloadString(retest, 'expectedResult')}`),
      }];
    }
  }
  if (deliverable.deliverableType === 'accessibility_audit_report') {
    if (sectionId === 'scope-method') {
      return [{
        id: 'accessibility-platforms',
        type: 'list',
        items: payloadRecords(payload, 'platforms').map((platform) =>
          `${payloadString(platform, 'name')} — ${payloadString(platform, 'assistiveTechnology')} / ${payloadString(platform, 'browser')}`),
      }];
    }
    if (sectionId === 'key-metrics') {
      return [{
        id: 'accessibility-levels-priorities',
        type: 'list',
        items: [
          ...payloadRecords(payload, 'conformanceLevels').map((level) =>
            `${payloadString(level, 'issueId')} — ${payloadString(level, 'level')}: ${payloadString(level, 'criterion')}`),
          ...payloadRecords(payload, 'priorities').map((priority) =>
            `${payloadString(priority, 'issueId')} — ${payloadString(priority, 'level')}: ${payloadString(priority, 'rationale')}`),
        ],
      }];
    }
    if (sectionId === 'findings') {
      return [{
        id: 'accessibility-findings',
        type: 'list',
        items: [
          ...payloadRecords(payload, 'pourPrinciples').map((principle) =>
            `${payloadString(principle, 'principle')}: ${payloadString(principle, 'rationale')}`),
          ...payloadRecords(payload, 'components').map((component) =>
            `${payloadString(component, 'component')} (${payloadString(component, 'selector')})`),
        ],
      }];
    }
    if (sectionId === 'visual-evidence') {
      return [{
        id: 'accessibility-screen-reader-behavior',
        type: 'list',
        items: payloadRecords(payload, 'screenReaderBehavior').map((behavior) =>
          `${payloadString(behavior, 'observed')} — expected: ${payloadString(behavior, 'expected')}`),
      }];
    }
    if (sectionId === 'recommendations') {
      return [{
        id: 'accessibility-remediations',
        type: 'list',
        items: payloadRecords(payload, 'remediations').map((remediation) =>
          payloadString(remediation, 'action')),
      }];
    }
    if (sectionId === 'appendix') {
      return [{
        id: 'accessibility-verification',
        type: 'list',
        items: payloadRecords(payload, 'verification').map((verification) =>
          `${payloadString(verification, 'method')}: ${payloadString(verification, 'expectedResult')}`),
      }];
    }
  }
  return [];
}

function deliverableLabel(deliverableType: string): string {
  return deliverableType.replace(/[_-]+/gu, ' ').replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function reportTitle(deliverable: ResearchDeliverableEnvelope<unknown>): string {
  if (deliverable.deliverableType === 'competitive_analysis_report') {
    return '竞品分析报告 / Competitive Analysis Report';
  }
  const title = record(deliverable.payload)?.title;
  return typeof title === 'string' && title.trim() ? title : deliverableLabel(deliverable.deliverableType);
}

function composeExecutiveSummary(deliverable: ResearchDeliverableEnvelope<unknown>): string {
  return deliverable.findingGraph.analyses[0]?.statement
    ?? deliverable.findingGraph.overallConclusions[0]?.statement
    ?? deliverable.methodSummary;
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

function competitiveSectionIntroduction(
  sectionId: ReportTemplateSectionId,
  input: ComposeReportDocumentInput,
  comparisonSectionTitle: string,
): string {
  const visualEvidenceIntroduction = input.visualAssets.length > 0
    ? '本章集中展示已验证的产品截图与标注图，用于帮助读者对照视觉证据与文字结论。'
    : input.charts.length > 0
      ? `本章没有已验证的产品截图；已验证图表位于“${comparisonSectionTitle}”章节，用于对照数据与文字结论。`
      : '本章用于展示可验证的产品截图、标注图或图表。本任务没有已验证的截图或图表：Web Research 仅采集文本来源，且未提供用户截图，因此不展示未经验证的网络图片。';
  const introductions: Record<ReportTemplateSectionId, string> = {
    cover: '本页用于识别报告主题、研究对象与交付范围。',
    'executive-summary': '本章用于快速概括研究范围、核心判断与优先行动，帮助读者在阅读全文前建立决策框架。',
    background: '本章说明市场背景、业务问题和研究目标，定义本次分析要回答的核心问题。',
    'scope-method': '本章界定竞品样本、纳入与排除标准、证据时间范围和分析方法，用于说明结论在什么边界内成立。',
    'key-metrics': '本章汇总可直接对比的量化指标与口径；公开证据不足时保留缺口，不为了排名而强行打分。',
    findings: '本章用于按消费决策支持维度整合各平台表现，并在每个维度后给出跨平台核心差异，避免将同一问题拆成零散事实。',
    'question-analysis': '本章将原始研究问题与证据化回答逐项对齐，用于检查问题是否已被完整覆盖。',
    'visual-evidence': visualEvidenceIntroduction,
    comparison: '本章将竞品差异转换为对消费者、产品团队和业务结果的影响，用于判断哪些差异值得优先处理。',
    conclusion: '本章收敛全文最重要的判断，明确行业竞争焦点、京东的优势与当前短板。',
    recommendations: '本章将研究结论转化为可执行产品行动，并按 P0–P2 标注下一季度的优先级。',
    risks: '本章披露证据缺口、研究边界和尚需实测的问题，避免将未验证推断当作确定结论。',
    appendix: '本章列出证据编号、来源与追溯信息，用于复核报告中的关键事实与结论。',
  };
  return introductions[sectionId];
}

function composeSectionContentBlocks(
  sectionId: ReportTemplateSectionId,
  input: ComposeReportDocumentInput,
  executiveSummary: string,
): ReportBlock[] {
  const deliverable = input.deliverable.value;
  const researchPlanPayload = researchPlanRenderPayload(deliverable.payload);
  const professionalBlocks = professionalSectionBlocks(sectionId, input);
  switch (sectionId) {
    case 'cover':
      return [
        paragraph('cover-title', reportTitle(deliverable)),
        paragraph(
          'cover-subtitle',
          deliverable.deliverableType === 'research_plan'
            ? 'Evidence-bound professional research plan.'
            : `Evidence-bound ${deliverableLabel(deliverable.deliverableType)}.`,
        ),
      ];
    case 'executive-summary':
      return [paragraph('executive-summary-text', executiveSummary), ...professionalBlocks];
    case 'background':
      return [paragraph('background-goal', researchPlanPayload?.researchGoal ?? deliverable.methodSummary)];
    case 'scope-method':
      if (professionalBlocks.length > 0) {
        return [paragraph('method-summary', deliverable.methodSummary), ...professionalBlocks];
      }
      return researchPlanPayload
        ? [
            paragraph(
              'scope',
              `${researchPlanPayload.scope.market}; ${researchPlanPayload.scope.subjects.join(', ')}; ${researchPlanPayload.scope.timeWindow}.`,
            ),
            paragraph('method-summary', deliverable.methodSummary),
            paragraph('sampling-strategy', researchPlanPayload.competitorSampling.strategy),
          ]
        : [paragraph('method-summary', deliverable.methodSummary)];
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
      if (metrics.length > 0 || professionalBlocks.length > 0) {
        return [...metrics, ...professionalBlocks];
      }
      return researchPlanPayload
        ? [paragraph('sampling-target', `Target competitor sample: ${researchPlanPayload.competitorSampling.targetCount}.`)]
        : [];
    }
    case 'findings':
      if (deliverable.deliverableType === 'competitive_analysis_report') {
        return professionalBlocks;
      }
      return [
        ...deliverable.findingGraph.findings.map((finding, index) => finding.kind === 'fact'
          ? {
              id: `finding-fact-${index + 1}`,
              type: 'fact' as const,
              text: finding.statement,
              evidenceIds: [...finding.evidenceIds],
            }
          : paragraph(`finding-inference-${index + 1}`, finding.statement)),
        ...professionalBlocks,
      ];
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
    case 'visual-evidence': {
      if (professionalBlocks.length > 0) return professionalBlocks;
      const annotationsByOriginal = new Map<string, VerifiedVisualAsset[]>();
      for (const asset of input.visualAssets) {
        if (asset.manifest.derivation?.kind !== 'annotation' || !asset.manifest.derivedFrom) continue;
        const key = assetReferenceKey(asset.manifest.derivedFrom);
        const annotations = annotationsByOriginal.get(key) ?? [];
        annotations.push(asset);
        annotationsByOriginal.set(key, annotations);
      }
      const blocks: ReportBlock[] = [];
      let imageIndex = 0;
      let comparisonIndex = 0;
      for (const asset of input.visualAssets) {
        if (asset.manifest.derivation?.kind === 'annotation') continue;
        imageIndex += 1;
        blocks.push({
          id: `image-${imageIndex}`,
          type: 'image',
          assetRef: assetReference(asset),
          caption: sourceCaption(asset, imageIndex - 1),
          altText: `Verified visual evidence, ${asset.metadata.width} by ${asset.metadata.height} pixels.`,
        });
        for (const annotation of annotationsByOriginal.get(assetReferenceKey(assetReference(asset))) ?? []) {
          comparisonIndex += 1;
          blocks.push({
            id: `image-comparison-${comparisonIndex}`,
            type: 'image-comparison',
            beforeAssetRef: assetReference(asset),
            afterAssetRef: assetReference(annotation),
            caption: `${sourceCaption(asset, imageIndex - 1)} with verified annotation.`,
            altText: `Original visual evidence compared with its verified annotation.`,
          });
        }
      }
      return blocks;
    }
    case 'comparison':
      return [
        ...input.charts.map(({ spec, specHash, table, asset }, index): ReportChartBlock => ({
          id: `chart-${index + 1}`,
          type: 'chart',
          chartRef: { chartId: spec.chartId, ...assetReference(asset) },
          specHash,
          spec: structuredClone(spec),
          table: structuredClone(table),
          caption: spec.title,
          altText: chartAltText(spec),
        })),
        ...professionalBlocks,
      ];
    case 'conclusion':
      return deliverable.findingGraph.overallConclusions.map((conclusion, index) =>
        paragraph(`conclusion-${index + 1}`, conclusion.statement));
    case 'recommendations':
      return [
        ...deliverable.recommendations.map((recommendation, index) =>
          paragraph(`recommendation-${index + 1}`, recommendation.statement)),
        ...professionalBlocks,
      ];
    case 'risks':
      return deliverable.risksAndOpenIssues.map((risk, index) => paragraph(`risk-${index + 1}`, risk));
    case 'appendix': {
      const evidenceItems = input.evidenceManifest.value.entries.map((entry) =>
        `${entry.id}: ${entry.evidenceClass} Evidence from Artifact ${entry.artifactId}.`);
      return [
        ...professionalBlocks,
        ...(evidenceItems.length > 0 ? [{ id: 'evidence-index', type: 'list' as const, items: evidenceItems }] : []),
      ];
    }
  }
}

function composeSectionBlocks(
  sectionId: ReportTemplateSectionId,
  input: ComposeReportDocumentInput,
  executiveSummary: string,
  comparisonSectionTitle?: string,
): ReportBlock[] {
  const content = composeSectionContentBlocks(sectionId, input, executiveSummary);
  if (input.deliverable.value.deliverableType !== 'competitive_analysis_report') return content;
  const comparisonTitle = comparisonSectionTitle
    ?? fail('competitive report template is missing its comparison section');
  return [
    paragraph(
      `section-intro-${sectionId}`,
      competitiveSectionIntroduction(sectionId, input, comparisonTitle),
    ),
    ...content,
  ];
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
        if (!chartReferences.has(chartReferenceKey({ ...block.chartRef, specHash: block.specHash }))) {
          fail(`chart block ${block.id} reference or specHash does not match its verified Chart Manifest digest`);
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
  const { contract } = assertCompositionInput(input);
  const template = contract.reportTemplate;
  const executiveSummary = composeExecutiveSummary(input.deliverable.value);
  const comparisonSectionTitle = template.sections.find(({ id }) => id === 'comparison')?.title;
  const document: ReportDocument = {
    version: 'report-document-v1',
    title: reportTitle(input.deliverable.value),
    subtitle: template.subtitle,
    executiveSummary,
    sections: template.sections.map((section): ReportSection => ({
      id: section.id,
      title: section.title,
      questionIds: section.id === 'question-analysis' ? [...input.requiredQuestionIds] : [],
      blocks: composeSectionBlocks(
        section.id,
        input,
        executiveSummary,
        comparisonSectionTitle,
      ),
    })),
  };
  assertValidReportDocument(document, {
    requiredQuestionIds: input.requiredQuestionIds,
    evidenceIds: input.evidenceManifest.value.entries.map(({ id }) => id),
    visualAssets: input.visualAssets.map(assetReference),
    charts: input.charts.map(({ spec, asset }) => ({
      chartId: spec.chartId,
      ...assetReference(asset),
      specHash: chartManifestSpecHash(asset),
    })),
  });
  return document;
}
