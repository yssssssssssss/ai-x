import { isDeepStrictEqual } from 'node:util';
import type {
  ControlArtifact,
  ControlExecutionLease,
  ControlPlaneRepository,
} from '../../../../database/control-plane.ts';
import type { PassedReportReviewArtifact } from '../../../../packages/api-contract/control-workflow.ts';
import type {
  ReportDocumentV3,
  ReportDocumentV4,
  ReportNoticeV1,
} from '../../../../packages/api-contract/report-document.ts';
import type { ReportAuditAppendixMaterialV1 } from '../../../../packages/api-contract/report-editorial.ts';
import type { ReportPackageLayoutV2 } from '../../../../packages/api-contract/report-package.ts';
import type {
  ChartSpec,
  ContributionLedgerV1,
  EvidenceManifest,
  ResearchDeliverableEnvelope,
  ResearchPlanPayload,
  ResearchStrategyReportPayloadV2,
  VisualAssetManifest,
  VisualAssetReference,
} from '../../../../packages/api-contract/research-deliverable.ts';
import {
  ArtifactIntegrityError,
  type ControlArtifactStore,
} from '../control/artifact-store.ts';
import { EvidenceService, type EvidenceArtifactResolver } from '../evidence/evidence-service.ts';
import { chartTableAlternative, type ChartTableAlternative } from './chart-renderer.ts';
import {
  ChartSpecValidationError,
  chartSpecHash,
  validateChartSpec,
  type ChartEvidenceResolver,
} from './chart-spec-validator.ts';
import {
  assertReportCompositionInput,
  composeReportDocument,
  type ChartDataArtifactReference,
  type ReportDocument,
  type VerifiedChart,
} from './report-document-composer.ts';
import { resolveDeliverableContractById } from './deliverable-registry.ts';
import { isResearchStrategyPayloadV2 } from './research-strategy-deliverable-assembler.ts';
import { createDeliverableValidationDiagnostic } from './deliverable-validation-diagnostic.ts';
import {
  deterministicReportLayout,
  type ReportLayoutPlanner,
} from './report-layout-planner.ts';
import type {
  VerifiedVisualAsset,
  VisualAssetService,
} from './visual-asset-service.ts';
import type { ImageAnnotationOverlay } from './image-annotation-service.ts';
import {
  assertCompetitiveWeightChartBinding,
  COMPETITIVE_WEIGHT_CHART_DATA_VERSION,
  parseCompetitiveWeightChartData,
  type CompetitiveWeightChartData,
} from './competitive-weight-chart.ts';
import { SchemaValidator } from '../schema/validator.ts';
import { createDeterministicReportEditorialBlueprintV1 } from './report-editorial-blueprint.ts';
import { createDeterministicReportEditorialIntentCompilation } from './report-editorial-intent-compiler.ts';
import type {
  ReportEditorialPlanner,
  ReportEditorialPlannerDataClassification,
} from './report-editorial-planner.ts';
import {
  buildReportAuditAppendixMaterialV1,
  buildResearchPlanEditorialMaterialV1,
  buildResearchStrategyEditorialMaterialV1,
} from './report-editorial-material-builder.ts';
import {
  bindEditorialShowcaseContributions,
  createDeterministicEditorialShowcaseSpec,
} from './report-editorial-showcase-compiler.ts';
import type {
  EditorialShowcasePublicationResult,
  EditorialShowcasePublicationService,
} from './report-editorial-showcase-publication.ts';
import {
  projectReportEditorialDocumentV3,
  projectReportEditorialDocumentV4,
} from './report-editorial-projector.ts';

interface VerifiedArtifactValue<T> {
  artifact: ControlArtifact;
  value: T;
}

interface ReportBinding {
  taskId: string;
  planVersionId: string;
  attemptId: string;
}

interface PersistedVerifiedChart extends ReportBinding {
  version: 'verified-chart-v1';
  spec: ChartSpec;
  specHash: string;
  table: ChartTableAlternative;
  assetRef: VisualAssetReference;
  dataArtifactRef?: ChartDataArtifactReference;
}

export interface ChartSpecArtifactReference {
  artifactId: string;
  contentSha256: string;
}

export interface CompositionVerifiedChart extends VerifiedChart {
  chartSpecArtifactRef: ChartSpecArtifactReference;
}

export interface ReportMaterialDiscoveryInput extends ReportBinding {
  evidenceResolver?: ChartEvidenceResolver;
  evidenceManifest?: EvidenceManifest;
}

export interface ReportAttemptMaterials {
  visualAssets: VerifiedVisualAsset[];
  charts: CompositionVerifiedChart[];
  visualAnnotationBindings?: VerifiedVisualAnnotationBinding[];
}

export interface VerifiedVisualAnnotationBinding {
  assetId: string;
  originalAssetId: string;
  overlayArtifactId: string;
  findingIds: string[];
}

export interface ReportCompositionInput extends ReportBinding {
  requiredQuestionIds: string[];
  deliverable: VerifiedArtifactValue<ResearchDeliverableEnvelope<unknown>>;
  evidenceManifest: VerifiedArtifactValue<EvidenceManifest>;
  evidenceArtifactResolver: EvidenceArtifactResolver;
  review: VerifiedArtifactValue<PassedReportReviewArtifact>;
  visualAssets: VerifiedVisualAsset[];
  charts: CompositionVerifiedChart[];
  activeLease: ControlExecutionLease;
  contributionLedgerArtifactId?: string;
  onArtifactSealed?: (artifact: ControlArtifact) => void;
  expectedModel?: string;
  layoutStepNo?: number;
  editorialPlannerDataClassification?: ReportEditorialPlannerDataClassification;
  cancellationSignal?: AbortSignal;
}

export interface ReportCompositionResult {
  artifact: ControlArtifact;
  document: ReportDocument | ReportDocumentV3 | ReportDocumentV4;
  editorialBlueprintArtifactId?: string;
  editorialLayout?: ReportPackageLayoutV2;
  layoutBlueprintArtifactId?: string;
  layoutDiagnosticArtifactId?: string;
  editorialShowcase?: EditorialShowcasePublicationResult;
}

export interface ReportCompositionPort {
  discoverAttemptMaterials?(input: ReportMaterialDiscoveryInput): Promise<ReportAttemptMaterials>;
  composeAndStore(input: ReportCompositionInput): Promise<ReportCompositionResult>;
}


function sameBinding(value: ReportBinding, binding: ReportBinding): boolean {
  return value.taskId === binding.taskId
    && value.planVersionId === binding.planVersionId
    && value.attemptId === binding.attemptId;
}

function referenceKey(reference: VisualAssetReference): string {
  return `${reference.assetId}\u0000${reference.manifestArtifactId}`;
}

function chartIntegrityError(artifactId: string, context: string, error: unknown): Error {
  if (error instanceof ArtifactIntegrityError || error instanceof ChartSpecValidationError) {
    return error;
  }
  const detail = error instanceof Error ? `: ${error.message}` : '';
  return new ArtifactIntegrityError(artifactId, `${context}${detail}`);
}

function assertMaterialArtifact(artifact: ControlArtifact, binding: ReportBinding): void {
  if (artifact.state !== 'SEALED') {
    throw new Error(`report material ${artifact.id} must be SEALED, received ${artifact.state}`);
  }
  if (!sameBinding({
    taskId: artifact.taskId,
    planVersionId: artifact.planVersionId ?? '',
    attemptId: artifact.attemptId ?? '',
  }, binding)) {
    throw new Error(`report material ${artifact.id} Task, Plan, or Attempt binding does not match`);
  }
  if (!artifact.contentSha256 || artifact.byteSize === null) {
    throw new Error(`report material ${artifact.id} has no sealed hash or byte size`);
  }
}

function reportArtifactWasSealed(input: {
  artifact: ControlArtifact;
  binding: ReportBinding;
  kind: 'report_editorial_blueprint' | 'report_document';
  schemaVersion: 'report-editorial-blueprint-v1' | 'report-document-v3' | 'report-document-v4';
  onArtifactSealed?: (artifact: ControlArtifact) => void;
}): void {
  if (input.artifact.state === 'SEALED') input.onArtifactSealed?.(input.artifact);
  if (
    input.artifact.state !== 'SEALED'
    || !input.artifact.contentSha256
    || input.artifact.byteSize === null
    || input.artifact.taskId !== input.binding.taskId
    || input.artifact.planVersionId !== input.binding.planVersionId
    || input.artifact.attemptId !== input.binding.attemptId
    || input.artifact.kind !== input.kind
    || input.artifact.schemaVersion !== input.schemaVersion
  ) {
    throw new Error(`${input.kind} Artifact was not sealed with the active report binding`);
  }
}

async function readCompetitiveWeightChartDataArtifact(
  artifacts: Pick<ControlArtifactStore, 'readVerifiedJson'>,
  reference: ChartDataArtifactReference,
  binding: ReportBinding,
  chartId: string,
): Promise<CompetitiveWeightChartData> {
  const stored = await artifacts.readVerifiedJson<unknown>(reference.artifactId);
  const artifact = stored.artifact;
  if (
    artifact.id !== reference.artifactId
    || artifact.kind !== 'chart_data'
    || artifact.state !== 'SEALED'
    || artifact.contentSha256 !== reference.contentSha256
    || artifact.byteSize === null
    || artifact.schemaVersion !== COMPETITIVE_WEIGHT_CHART_DATA_VERSION
    || !sameBinding({
      taskId: artifact.taskId,
      planVersionId: artifact.planVersionId ?? '',
      attemptId: artifact.attemptId ?? '',
    }, binding)
  ) {
    throw new Error(`Chart ${chartId} data Artifact identity, hash, schema, or binding is invalid`);
  }
  return parseCompetitiveWeightChartData(stored.value, binding);
}

function assertVerifiedAssetBinding(asset: VerifiedVisualAsset, binding: ReportBinding): void {
  if (!sameBinding(asset.manifest, binding)) {
    throw new Error(`visual Asset ${asset.artifact.id} Manifest binding does not match Task, Plan, and Attempt`);
  }
  assertMaterialArtifact(asset.artifact, binding);
  assertMaterialArtifact(asset.manifestArtifact, binding);
}

function parseChartInput(value: unknown, binding: ReportBinding): PersistedVerifiedChart {
  const candidate = value as Partial<PersistedVerifiedChart> | null;
  if (
    !candidate
    || typeof candidate !== 'object'
    || Array.isArray(candidate)
    || candidate.version !== 'verified-chart-v1'
    || typeof candidate.taskId !== 'string'
    || typeof candidate.planVersionId !== 'string'
    || typeof candidate.attemptId !== 'string'
    || typeof candidate.specHash !== 'string'
    || !candidate.assetRef
    || typeof candidate.assetRef !== 'object'
    || typeof candidate.assetRef.assetId !== 'string'
    || typeof candidate.assetRef.manifestArtifactId !== 'string'
    || !sameBinding(candidate as ReportBinding, binding)
  ) {
    throw new Error('sealed Chart input has an invalid version, reference, or Task/Plan/Attempt binding');
  }
  return candidate as PersistedVerifiedChart;
}

async function readPersistedChart(
  artifacts: Pick<ControlArtifactStore, 'readVerifiedJson'>,
  reference: ChartSpecArtifactReference,
  binding: ReportBinding,
): Promise<PersistedVerifiedChart> {
  const stored = await artifacts.readVerifiedJson<unknown>(reference.artifactId);
  assertMaterialArtifact(stored.artifact, binding);
  if (
    stored.artifact.id !== reference.artifactId
    || stored.artifact.kind !== 'chart_spec'
    || stored.artifact.schemaVersion !== 'verified-chart-v1'
    || stored.artifact.contentSha256 !== reference.contentSha256
  ) {
    throw new Error(`Chart input ${reference.artifactId} identity, hash, schema, or binding is invalid`);
  }
  return parseChartInput(stored.value, binding);
}

export class ReportCompositionService implements ReportCompositionPort {
  constructor(private readonly dependencies: {
    artifacts: Pick<ControlArtifactStore, 'readVerifiedJson' | 'writeJson'>;
    visualAssets: Pick<VisualAssetService, 'readVerified'>;
    repository: Pick<ControlPlaneRepository, 'listArtifactsForAttempt'>;
    layoutPlanner?: Pick<ReportLayoutPlanner, 'plan'>;
    editorialPlanner?: Pick<ReportEditorialPlanner, 'plan'>;
    showcasePublisher?: Pick<EditorialShowcasePublicationService, 'publish'>;
    validator?: Pick<SchemaValidator, 'validateFileOrThrow' | 'validateOrThrow'>;
    reportV3Writer?: {
      enabled: boolean;
      editorialExperienceV1Enabled?: boolean;
      verifiedPresentations?: {
        recordTable?: boolean;
        graph?: boolean;
        priorityBoard?: boolean;
      };
    };
  }) {}

  async discoverAttemptMaterials(input: ReportMaterialDiscoveryInput): Promise<ReportAttemptMaterials> {
    const binding: ReportBinding = input;
    const artifacts = await this.dependencies.repository.listArtifactsForAttempt({
      ...binding,
      kinds: ['visual_asset_manifest', 'image_annotation', 'chart_spec'],
    });
    const liveArtifacts = artifacts.filter((artifact) => artifact.state !== 'FAILED');
    const manifestArtifacts = liveArtifacts.filter((artifact) => artifact.kind === 'visual_asset_manifest');
    const annotationArtifacts = liveArtifacts.filter((artifact) => artifact.kind === 'image_annotation');
    const chartInputArtifacts = liveArtifacts.filter((artifact) => artifact.kind === 'chart_spec');
    const verifiedAssets: VerifiedVisualAsset[] = [];
    const annotationsByArtifactId = new Map<string, ImageAnnotationOverlay>();

    for (const annotationArtifact of annotationArtifacts) {
      assertMaterialArtifact(annotationArtifact, binding);
      if (annotationArtifact.schemaVersion !== 'image-annotation-v1') {
        throw new Error(`image annotation ${annotationArtifact.id} schemaVersion is invalid`);
      }
      const stored = await this.dependencies.artifacts.readVerifiedJson<ImageAnnotationOverlay>(
        annotationArtifact.id,
      );
      if (
        stored.artifact.id !== annotationArtifact.id
        || stored.value.version !== 'image-annotation-v1'
        || !stored.value.original
        || !Array.isArray(stored.value.annotations)
        || stored.value.annotations.length === 0
      ) {
        throw new Error(`image annotation ${annotationArtifact.id} is malformed`);
      }
      annotationsByArtifactId.set(annotationArtifact.id, stored.value);
    }

    for (const manifestArtifact of manifestArtifacts) {
      assertMaterialArtifact(manifestArtifact, binding);
      if (
        manifestArtifact.schemaVersion !== 'visual-asset-manifest-v1'
        && manifestArtifact.schemaVersion !== 'visual-asset-manifest-v2'
      ) {
        throw new Error(`visual Asset Manifest ${manifestArtifact.id} schemaVersion is invalid`);
      }
      const manifestValue = await this.dependencies.artifacts.readVerifiedJson<unknown>(manifestArtifact.id);
      const manifest = manifestValue.value as Partial<VisualAssetManifest> | null;
      if (
        manifestValue.artifact.id !== manifestArtifact.id
        || !manifest
        || typeof manifest !== 'object'
        || Array.isArray(manifest)
        || typeof manifest.assetId !== 'string'
        || manifest.version !== manifestArtifact.schemaVersion
      ) {
        throw new Error(`visual Asset Manifest ${manifestArtifact.id} has no exact version or Asset reference`);
      }
      const verified = await this.dependencies.visualAssets.readVerified({
        assetId: manifest.assetId,
        manifestArtifactId: manifestArtifact.id,
      });
      assertVerifiedAssetBinding(verified, binding);
      verifiedAssets.push(verified);
    }

    const lineageVisualAssets = verifiedAssets.filter(({ manifest }) => manifest.derivation?.kind !== 'chart_svg');
    const visualAssets = lineageVisualAssets.filter(({ manifest }) =>
      manifest.exportPolicy === 'allow' || manifest.exportPolicy === 'mask');
    const visualAnnotationBindings: VerifiedVisualAnnotationBinding[] = [];
    const usedAnnotationArtifacts = new Set<string>();
    for (const asset of lineageVisualAssets) {
      const derivation = asset.manifest.derivation;
      if (derivation?.kind !== 'annotation') continue;
      const lineage = asset.manifest.derivedFrom;
      const overlay = annotationsByArtifactId.get(derivation.overlayArtifactId);
      if (
        !lineage
        || !overlay
        || overlay.original.assetId !== lineage.assetId
        || overlay.original.manifestArtifactId !== lineage.manifestArtifactId
        || usedAnnotationArtifacts.has(derivation.overlayArtifactId)
      ) {
        throw new Error(`visual annotation ${asset.artifact.id} has invalid or duplicate overlay lineage`);
      }
      const findingIds = [...new Set(overlay.annotations.map(({ findingId }) => findingId))];
      if (findingIds.length === 0 || findingIds.some((findingId) => !findingId.trim())) {
        throw new Error(`visual annotation ${asset.artifact.id} has no finding bindings`);
      }
      usedAnnotationArtifacts.add(derivation.overlayArtifactId);
      visualAnnotationBindings.push({
        assetId: asset.artifact.id,
        originalAssetId: lineage.assetId,
        overlayArtifactId: derivation.overlayArtifactId,
        findingIds,
      });
    }
    if (usedAnnotationArtifacts.size !== annotationsByArtifactId.size) {
      throw new Error('every sealed image annotation must have one exact derived visual Asset');
    }
    const chartAssets = new Map(
      verifiedAssets
        .filter(({ manifest }) => manifest.derivation?.kind === 'chart_svg')
        .map((asset) => [referenceKey({
          assetId: asset.artifact.id,
          manifestArtifactId: asset.manifestArtifact.id,
        }), asset]),
    );
    const chartAssetIds = new Set<string>();
    for (const asset of chartAssets.values()) {
      if (chartAssetIds.has(asset.artifact.id)) {
        throw new ArtifactIntegrityError(
          asset.artifact.id,
          `Chart Asset id ${asset.artifact.id} must be unique`,
        );
      }
      chartAssetIds.add(asset.artifact.id);
    }
    const visualByReference = new Map(lineageVisualAssets.map((asset) => [referenceKey({
      assetId: asset.artifact.id,
      manifestArtifactId: asset.manifestArtifact.id,
    }), asset]));
    const charts: CompositionVerifiedChart[] = [];
    const usedChartAssets = new Set<string>();
    const chartIds = new Set<string>();

    for (const chartInputArtifact of chartInputArtifacts) {
      try {
        assertMaterialArtifact(chartInputArtifact, binding);
        if (chartInputArtifact.schemaVersion !== 'verified-chart-v1') {
          throw new Error(`Chart input ${chartInputArtifact.id} schemaVersion is invalid`);
        }
        const chartSpecArtifactRef = {
          artifactId: chartInputArtifact.id,
          contentSha256: chartInputArtifact.contentSha256!,
        };
        const persisted = await readPersistedChart(
          this.dependencies.artifacts,
          chartSpecArtifactRef,
          binding,
        );
        const spec = validateChartSpec(persisted.spec, input.evidenceResolver ?? (() => undefined));
        const key = referenceKey(persisted.assetRef);
        const asset = chartAssets.get(key);
        if (!asset || usedChartAssets.has(key) || chartIds.has(spec.chartId)) {
          throw new Error(`Chart ${spec.chartId} does not have one exact unique chart_svg Asset`);
        }
        const lineage = asset.manifest.derivedFrom;
        let dataArtifactRef: ChartDataArtifactReference | undefined;
        let data: CompetitiveWeightChartData | undefined;
        if (
          asset.manifest.version === 'visual-asset-manifest-v2'
          && asset.manifest.source.kind === 'chart_render'
        ) {
          const persistedDataArtifactRef = persisted.dataArtifactRef;
          if (
            asset.manifest.derivedFrom !== null
            || !persistedDataArtifactRef
            || typeof persistedDataArtifactRef !== 'object'
            || Array.isArray(persistedDataArtifactRef)
            || persistedDataArtifactRef.artifactId !== asset.manifest.source.dataArtifactId
            || persistedDataArtifactRef.contentSha256
              !== asset.manifest.source.dataArtifactContentSha256
          ) {
            throw new Error(`Chart ${spec.chartId} data Artifact provenance does not match its chart_render Manifest`);
          }
          dataArtifactRef = persistedDataArtifactRef;
          data = await readCompetitiveWeightChartDataArtifact(
            this.dependencies.artifacts,
            dataArtifactRef,
            binding,
            spec.chartId,
          );
          if (!input.evidenceManifest) {
            throw new Error(`Chart ${spec.chartId} requires its sealed Evidence Manifest for lineage verification`);
          }
          assertCompetitiveWeightChartBinding({
            data,
            spec,
            dataArtifactRef,
            evidenceEntries: input.evidenceManifest.entries,
          });
        } else {
          const origin = lineage ? visualByReference.get(referenceKey(lineage)) : undefined;
          if (
            asset.manifest.version !== 'visual-asset-manifest-v1'
            || !lineage
            || !origin
            || lineage.contentSha256 !== origin.manifest.contentSha256
            || lineage.manifestHash !== origin.manifest.manifestHash
          ) {
            throw new Error(`Chart ${spec.chartId} chart_svg specHash or Visual Asset lineage is invalid`);
          }
        }
        const specHash = chartSpecHash(spec);
        if (persisted.specHash !== specHash) throw new Error(`Chart ${spec.chartId} specHash is invalid`);
        const expectedTable = chartTableAlternative(spec);
        if (!isDeepStrictEqual(persisted.table, expectedTable)) {
          throw new Error(`Chart ${spec.chartId} table does not match its sealed ChartSpec`);
        }
        const derivation = asset.manifest.derivation;
        if (
          derivation?.kind !== 'chart_svg'
          || derivation.chartId !== spec.chartId
          || derivation.specHash !== specHash
        ) {
          throw new Error(`Chart ${spec.chartId} chart_svg specHash or Visual Asset lineage is invalid`);
        }
        usedChartAssets.add(key);
        chartIds.add(spec.chartId);
        if (asset.manifest.exportPolicy === 'allow' || asset.manifest.exportPolicy === 'mask') {
          charts.push({
            spec,
            specHash,
            table: expectedTable,
            asset,
            ...(dataArtifactRef ? { dataArtifactRef } : {}),
            ...(data ? { data } : {}),
            chartSpecArtifactRef,
          });
        }
      } catch (error) {
        throw chartIntegrityError(
          chartInputArtifact.id,
          'failed Chart material integrity validation',
          error,
        );
      }
    }

    if (usedChartAssets.size !== chartAssets.size) {
      const unmatched = [...chartAssets.values()].find((asset) => !usedChartAssets.has(referenceKey({
        assetId: asset.artifact.id,
        manifestArtifactId: asset.manifestArtifact.id,
      })));
      throw new ArtifactIntegrityError(
        unmatched?.artifact.id ?? 'chart-publication',
        'every sealed chart_svg Asset must have one exact sealed Chart input',
      );
    }
    return { visualAssets, charts, visualAnnotationBindings };
  }

  async composeAndStore(input: ReportCompositionInput): Promise<ReportCompositionResult> {
    if (
      input.activeLease.taskId !== input.taskId
      || input.activeLease.planVersionId !== input.planVersionId
      || input.activeLease.attemptId !== input.attemptId
    ) {
      throw new Error('ReportDocument composition lease identity does not match the report binding');
    }
    const evidenceById = new Map(input.evidenceManifest.value.entries.map((entry) => [entry.id, entry]));
    const evidenceService = new EvidenceService();
    const chartEvidenceResolver: ChartEvidenceResolver = (evidenceId) => {
      const entry = evidenceById.get(evidenceId);
      return entry
        ? evidenceService.resolveEvidenceValue(entry, input.evidenceArtifactResolver)
        : undefined;
    };
    const refreshedCharts = await Promise.all(input.charts.map(async (chart): Promise<CompositionVerifiedChart> => {
      try {
        const asset = await this.dependencies.visualAssets.readVerified({
          assetId: chart.asset.artifact.id,
          manifestArtifactId: chart.asset.manifestArtifact.id,
        });
        assertVerifiedAssetBinding(asset, input);
        const persisted = await readPersistedChart(
          this.dependencies.artifacts,
          chart.chartSpecArtifactRef,
          input,
        );
        const expectedAssetRef = {
          assetId: asset.artifact.id,
          manifestArtifactId: asset.manifestArtifact.id,
        };
        if (!isDeepStrictEqual(persisted.assetRef, expectedAssetRef)) {
          throw new Error(`Chart input ${chart.chartSpecArtifactRef.artifactId} Asset reference changed before composition`);
        }
        const spec = validateChartSpec(persisted.spec, chartEvidenceResolver);
        const specHash = chartSpecHash(spec);
        const table = chartTableAlternative(spec);
        if (persisted.specHash !== specHash || !isDeepStrictEqual(persisted.table, table)) {
          throw new Error(`Chart ${spec.chartId} specHash or table is invalid before composition`);
        }
        const manifest = asset.manifest;
        if (manifest.version !== 'visual-asset-manifest-v2') {
          return {
            spec,
            specHash,
            table,
            asset,
            chartSpecArtifactRef: chart.chartSpecArtifactRef,
          };
        }
        const source = manifest.source;
        const dataArtifactRef = persisted.dataArtifactRef;
        if (
          source.kind !== 'chart_render'
          || manifest.derivedFrom !== null
          || !dataArtifactRef
          || dataArtifactRef.artifactId !== source.dataArtifactId
          || dataArtifactRef.contentSha256 !== source.dataArtifactContentSha256
        ) {
          throw new Error(`Chart ${spec.chartId} data Artifact provenance does not match its chart_render Manifest`);
        }
        const data = await readCompetitiveWeightChartDataArtifact(
          this.dependencies.artifacts,
          dataArtifactRef,
          input,
          spec.chartId,
        );
        assertCompetitiveWeightChartBinding({
          data,
          spec,
          dataArtifactRef,
          evidenceEntries: input.evidenceManifest.value.entries,
        });
        return {
          spec,
          specHash,
          table,
          asset,
          dataArtifactRef,
          data,
          chartSpecArtifactRef: chart.chartSpecArtifactRef,
        };
      } catch (error) {
        throw chartIntegrityError(
          chart.chartSpecArtifactRef.artifactId,
          'failed Chart composition integrity validation',
          error,
        );
      }
    }));
    const contract = resolveDeliverableContractById(input.deliverable.value.deliverableType);
    if (input.deliverable.value.deliverableType !== contract.entry.id) {
      throw new Error('ReportDocument Deliverable type does not match its active Registry contract');
    }
    if (input.deliverable.value.version !== contract.entry.envelope_version) {
      throw new Error('ReportDocument Deliverable version does not match its active Registry contract');
    }
    const visualAssets = await Promise.all(input.visualAssets.map((asset) =>
      this.dependencies.visualAssets.readVerified({
        assetId: asset.artifact.id,
        manifestArtifactId: asset.manifestArtifact.id,
      })));
    const charts = refreshedCharts;
    const payload = input.deliverable.value.payload;
    const editorialExperienceV1Enabled = this.dependencies.reportV3Writer
      ?.editorialExperienceV1Enabled === true;
    const editorialStrategyPayload = input.deliverable.value.deliverableType === 'research_strategy_report'
      && isResearchStrategyPayloadV2(payload)
      ? payload
      : undefined;
    const researchPlanPayload = input.deliverable.value.deliverableType === 'research_plan'
      ? payload as ResearchPlanPayload
      : undefined;
    const useEditorialPipeline = this.dependencies.reportV3Writer?.enabled === true
      && (editorialStrategyPayload !== undefined
        || (editorialExperienceV1Enabled && researchPlanPayload !== undefined));
    if (useEditorialPipeline) {
      assertReportCompositionInput({
        templateId: contract.entry.report_template,
        requiredQuestionIds: input.requiredQuestionIds,
        deliverable: input.deliverable,
        evidenceManifest: input.evidenceManifest,
        evidenceArtifactResolver: input.evidenceArtifactResolver,
        review: input.review,
        visualAssets,
        charts,
      });
      const validator = this.dependencies.validator ?? new SchemaValidator();
      const materialInput = {
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        attemptId: input.attemptId,
        requiredQuestionIds: input.requiredQuestionIds,
        review: input.review,
      };
      const material = editorialStrategyPayload
        ? buildResearchStrategyEditorialMaterialV1({
            ...materialInput,
            deliverable: {
              artifact: input.deliverable.artifact,
              value: { ...input.deliverable.value, payload: editorialStrategyPayload },
            },
          })
        : buildResearchPlanEditorialMaterialV1({
            ...materialInput,
            deliverable: {
              artifact: input.deliverable.artifact,
              value: { ...input.deliverable.value, payload: researchPlanPayload! },
            },
          });
      validator.validateFileOrThrow(
        'schemas/report-editorial-material-v1.schema.json',
        material,
      );
      let auditAppendix: ReportAuditAppendixMaterialV1 | undefined;
      if (input.contributionLedgerArtifactId) {
        const contributionLedger = await this.dependencies.artifacts
          .readVerifiedJson<ContributionLedgerV1>(input.contributionLedgerArtifactId);
        validator.validateOrThrow('contribution-ledger-v1', contributionLedger.value);
        auditAppendix = buildReportAuditAppendixMaterialV1({ material, contributionLedger });
      }
      const presentations = this.dependencies.reportV3Writer?.verifiedPresentations;
      const presentationOptions = {
        recordTable: presentations?.recordTable === true,
        graph: presentations?.graph === true,
        priorityBoard: presentations?.priorityBoard === true,
        cardGrid: editorialExperienceV1Enabled,
        stageFlow: editorialExperienceV1Enabled,
      };
      const showcaseRequested = this.dependencies.showcasePublisher !== undefined
        && editorialStrategyPayload !== undefined;
      const editorialPlan = this.dependencies.editorialPlanner && input.expectedModel
        ? await this.dependencies.editorialPlanner.plan({
            material,
            attemptId: input.attemptId,
            stepNo: input.layoutStepNo ?? 0,
            expectedModel: input.expectedModel,
            presentationOptions,
            enableEditorialCopy: editorialExperienceV1Enabled,
            enableEditorialShowcase: showcaseRequested,
            ...(input.editorialPlannerDataClassification
              ? { dataClassification: input.editorialPlannerDataClassification }
              : {}),
            ...(input.cancellationSignal ? { cancellationSignal: input.cancellationSignal } : {}),
          })
        : editorialExperienceV1Enabled
          ? (() => {
              const fallback = createDeterministicReportEditorialIntentCompilation(
                material,
                presentationOptions,
              );
              return {
                blueprint: fallback.blueprint,
                mode: 'fallback' as const,
                reasonCode: 'planner_disabled' as const,
                warnings: [],
                editorialCopy: fallback.editorialCopy,
                ...(showcaseRequested
                  ? { showcaseSpec: createDeterministicEditorialShowcaseSpec(material) }
                  : {}),
              };
            })()
          : {
              blueprint: createDeterministicReportEditorialBlueprintV1(material, presentationOptions),
              mode: 'fallback' as const,
              reasonCode: 'planner_disabled' as const,
              warnings: [],
              editorialCopy: undefined,
              ...(showcaseRequested
                ? { showcaseSpec: createDeterministicEditorialShowcaseSpec(material) }
                : {}),
            };
      const blueprint = editorialPlan.blueprint;
      validator.validateFileOrThrow(
        'schemas/report-editorial-blueprint-v1.schema.json',
        blueprint,
      );
      const editorialBlueprintArtifact = await this.dependencies.artifacts.writeJson({
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        attemptId: input.attemptId,
        kind: 'report_editorial_blueprint',
        relativePath: 'reports/report-editorial-blueprint.json',
        value: blueprint,
        schemaVersion: blueprint.version,
        sensitivity: 'internal',
        redactionPolicyVersion: 'v1',
        activeLease: input.activeLease,
      });
      reportArtifactWasSealed({
        artifact: editorialBlueprintArtifact,
        binding: input,
        kind: 'report_editorial_blueprint',
        schemaVersion: 'report-editorial-blueprint-v1',
        ...(input.onArtifactSealed ? { onArtifactSealed: input.onArtifactSealed } : {}),
      });
      const notices: ReportNoticeV1[] = editorialPlan.mode === 'fallback'
        && editorialPlan.reasonCode !== 'planner_disabled'
        ? [{
            id: editorialPlan.reasonCode === 'data_policy_denied'
              ? 'notice-data-policy-fallback'
              : 'notice-layout-fallback',
            code: editorialPlan.reasonCode === 'data_policy_denied'
              ? 'data_policy_fallback'
              : 'layout_fallback',
            severity: 'info',
            scope: 'report',
            relatedUnitIds: [],
          }]
        : [];
      const document = editorialExperienceV1Enabled
        ? projectReportEditorialDocumentV4({
            material,
            blueprint,
            editorialCopy: editorialPlan.editorialCopy,
            layoutMode: editorialPlan.mode,
            ...(auditAppendix ? { auditAppendix } : {}),
            ...(notices.length > 0 ? { notices } : {}),
          })
        : projectReportEditorialDocumentV3({
            material,
            blueprint,
            layoutMode: editorialPlan.mode,
            ...(auditAppendix ? { auditAppendix } : {}),
            ...(notices.length > 0 ? { notices } : {}),
          });
      validator.validateOrThrow('report-document', document);
      const artifact = await this.dependencies.artifacts.writeJson({
        taskId: input.taskId,
        planVersionId: input.planVersionId,
        attemptId: input.attemptId,
        kind: 'report_document',
        relativePath: 'reports/report-document.json',
        value: document,
        schemaVersion: document.version,
        sensitivity: 'internal',
        redactionPolicyVersion: 'v1',
        activeLease: input.activeLease,
      });
      reportArtifactWasSealed({
        artifact,
        binding: input,
        kind: 'report_document',
        schemaVersion: document.version,
        ...(input.onArtifactSealed ? { onArtifactSealed: input.onArtifactSealed } : {}),
      });
      const editorialLayout: ReportPackageLayoutV2 = editorialPlan.mode === 'model'
        ? { mode: 'model', blueprintArtifactId: editorialBlueprintArtifact.id }
        : {
            mode: 'fallback',
            blueprintArtifactId: editorialBlueprintArtifact.id,
            reasonCode: editorialPlan.reasonCode,
          };
      const editorialShowcase = this.dependencies.showcasePublisher && editorialStrategyPayload
        ? await this.dependencies.showcasePublisher.publish({
            activeLease: input.activeLease,
            material,
            evidenceManifest: input.evidenceManifest.value,
            evidenceManifestArtifact: input.evidenceManifest.artifact,
            spec: bindEditorialShowcaseContributions(
              editorialPlan.showcaseSpec ?? createDeterministicEditorialShowcaseSpec(material),
              material,
              auditAppendix,
            ),
            ...(input.onArtifactSealed ? { onArtifactSealed: input.onArtifactSealed } : {}),
          })
        : undefined;
      return {
        artifact,
        document,
        editorialBlueprintArtifactId: editorialBlueprintArtifact.id,
        editorialLayout,
        ...(editorialShowcase === undefined ? {} : { editorialShowcase }),
      };
    }
    const strategyPayload = isResearchStrategyPayloadV2(input.deliverable.value.payload)
      ? input.deliverable.value.payload as ResearchStrategyReportPayloadV2
      : null;
    const layout = strategyPayload
      ? this.dependencies.layoutPlanner && input.expectedModel
        ? await this.dependencies.layoutPlanner.plan({
            payload: strategyPayload,
            attemptId: input.attemptId,
            stepNo: input.layoutStepNo ?? 0,
            expectedModel: input.expectedModel,
            ...(input.cancellationSignal ? { cancellationSignal: input.cancellationSignal } : {}),
          })
        : deterministicReportLayout(strategyPayload)
      : undefined;
    const layoutBlueprintArtifact = layout
      ? await this.dependencies.artifacts.writeJson({
          taskId: input.taskId,
          planVersionId: input.planVersionId,
          attemptId: input.attemptId,
          kind: 'report_layout_blueprint',
          relativePath: 'reports/report-layout-blueprint.json',
          value: layout.blueprint,
          schemaVersion: layout.blueprint.version,
          sensitivity: 'internal',
          redactionPolicyVersion: 'v1',
          activeLease: input.activeLease,
        })
      : undefined;
    if (layoutBlueprintArtifact && (
      layoutBlueprintArtifact.state !== 'SEALED'
      || layoutBlueprintArtifact.taskId !== input.taskId
      || layoutBlueprintArtifact.planVersionId !== input.planVersionId
      || layoutBlueprintArtifact.attemptId !== input.attemptId
      || layoutBlueprintArtifact.kind !== 'report_layout_blueprint'
      || layoutBlueprintArtifact.schemaVersion !== 'report-layout-blueprint-v1'
    )) {
      throw new Error('Report Layout Blueprint Artifact was not sealed with the active report binding');
    }
    const layoutDiagnosticArtifact = layout?.mode === 'fallback' && layout.warnings.length > 0
      ? await this.dependencies.artifacts.writeJson({
          taskId: input.taskId,
          planVersionId: input.planVersionId,
          attemptId: input.attemptId,
          kind: 'deliverable_validation_diagnostic',
          relativePath: 'diagnostics/report-layout.json',
          value: createDeliverableValidationDiagnostic({
            taskId: input.taskId,
            planVersionId: input.planVersionId,
            attemptId: input.attemptId,
            stage: 'layout_blueprint',
            round: 0,
            error: new Error(layout.warnings.join('; ')),
            fallbackApplied: true,
          }),
          schemaVersion: 'deliverable-validation-diagnostic-v1',
          sensitivity: 'internal',
          redactionPolicyVersion: 'v1',
          activeLease: input.activeLease,
        })
      : undefined;
    const document = composeReportDocument({
      templateId: contract.entry.report_template,
      requiredQuestionIds: input.requiredQuestionIds,
      deliverable: input.deliverable,
      evidenceManifest: input.evidenceManifest,
      evidenceArtifactResolver: input.evidenceArtifactResolver,
      review: input.review,
      visualAssets,
      charts,
      ...(layout ? { layout } : {}),
    });
    const artifact = await this.dependencies.artifacts.writeJson({
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      attemptId: input.attemptId,
      kind: 'report_document',
      relativePath: 'reports/report-document.json',
      value: document,
      schemaVersion: document.version,
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
      activeLease: input.activeLease,
    });
    if (
      artifact.state !== 'SEALED'
      || !artifact.contentSha256
      || artifact.taskId !== input.taskId
      || artifact.planVersionId !== input.planVersionId
      || artifact.attemptId !== input.attemptId
      || artifact.kind !== 'report_document'
      || artifact.schemaVersion !== document.version
    ) {
      throw new Error('ReportDocument Artifact was not sealed with the active report binding');
    }
    return {
      artifact,
      document,
      ...(layoutBlueprintArtifact ? { layoutBlueprintArtifactId: layoutBlueprintArtifact.id } : {}),
      ...(layoutDiagnosticArtifact ? { layoutDiagnosticArtifactId: layoutDiagnosticArtifact.id } : {}),
    };
  }
}
