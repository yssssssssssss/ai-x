import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  CurrentReportPackageResponse,
  PassedReportReviewArtifact,
} from '../../../../packages/api-contract/control-workflow.ts';
import type {
  LegacyResearchDeliverableEnvelope,
  ResearchDeliverableEnvelope,
  VisualAssetManifest,
  VisualAssetReference,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type {
  ControlArtifact,
  ControlPlaneRepository,
} from '../../../../database/control-plane.ts';
import type { ControlArtifactStore } from '../control/artifact-store.ts';
import {
  EvidenceService,
  type EvidenceArtifactResolver,
  type EvidenceKind,
  type EvidenceManifest,
  type ResolvedEvidenceArtifact,
} from '../evidence/evidence-service.ts';
import { ReportEvidenceValidator } from '../evidence/report-evidence-validator.ts';
import { SchemaValidator } from '../schema/validator.ts';
import { chartTableAlternative } from './chart-renderer.ts';
import { chartSpecHash, validateChartSpec } from './chart-spec-validator.ts';
import { assertValidReportReviewArtifact } from './report-review-service.ts';
import {
  assertValidReportDocument,
  type ReportDocument,
} from './report-document-composer.ts';
import type { VerifiedVisualAsset, VisualAssetService } from './visual-asset-service.ts';
import {
  type ReportPackageArtifactValue,
} from './report-package-artifact.ts';
import {
  assertCompetitiveWeightChartBinding,
  COMPETITIVE_WEIGHT_CHART_DATA_VERSION,
  parseCompetitiveWeightChartData,
} from './competitive-weight-chart.ts';

export const REVIEW_GATED_DELIVERABLE_SCHEMA_VERSION = 'research-deliverable-v1-review-gated';
const LEGACY_DELIVERABLE_SCHEMA_VERSION = 'research-deliverable-v1';

interface ReportPackageBinding {
  taskId: string;
  planVersionId: string;
  attemptId: string;
}

interface CurrentReportPackageReaderDependencies {
  artifacts: Pick<ControlArtifactStore, 'readVerifiedJson'>;
  repository: Pick<ControlPlaneRepository, 'findSealedArtifact'>;
  evidence?: Pick<EvidenceService, 'resolveEvidenceValue' | 'validateManifest' | 'validateFindingGraph'>;
  reportValidator?: Pick<ReportEvidenceValidator, 'validate'>;
  schemaValidator?: Pick<SchemaValidator, 'validateOrThrow'>;
  visualAssets?: Pick<VisualAssetService, 'readVerified'>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function assertArtifactBinding(
  artifact: ControlArtifact,
  expectedId: string,
  expectedKind: string,
  binding: ReportPackageBinding,
  label: string,
): asserts artifact is ControlArtifact & { state: 'SEALED'; contentSha256: string } {
  if (artifact.id !== expectedId) throw new Error(`${label} Artifact id is invalid`);
  if (artifact.state !== 'SEALED' || !artifact.contentSha256) {
    throw new Error(`${label} Artifact is not sealed`);
  }
  if (artifact.kind !== expectedKind) throw new Error(`${label} Artifact kind is invalid`);
  if (artifact.taskId !== binding.taskId) throw new Error(`${label} Artifact taskId is invalid`);
  if (artifact.planVersionId !== binding.planVersionId) {
    throw new Error(`${label} Artifact planVersionId is invalid`);
  }
  if (artifact.attemptId !== binding.attemptId) {
    throw new Error(`${label} Artifact attemptId is invalid`);
  }
}

function evidenceArtifactKind(kind: EvidenceKind): string {
  switch (kind) {
    case 'tool_output': return 'tool_output';
    case 'knowledge_excerpt': return 'knowledge_excerpt';
    case 'screenshot': return 'visual_asset_manifest';
    case 'user_constraint': return 'chart_data';
  }
}

function assertJsonIdentity(
  value: Record<string, unknown>,
  binding: ReportPackageBinding,
  label: string,
): void {
  if (value.taskId !== binding.taskId) throw new Error(`${label} taskId is invalid`);
  if (value.planVersionId !== binding.planVersionId) {
    throw new Error(`${label} planVersionId is invalid`);
  }
  if (value.attemptId !== binding.attemptId) throw new Error(`${label} attemptId is invalid`);
}

function reportAssetReferences(document: ReportDocument): VisualAssetReference[] {
  const references: VisualAssetReference[] = [];
  const seen = new Set<string>();
  const manifestByAsset = new Map<string, string>();
  const append = (reference: VisualAssetReference): void => {
    const priorManifest = manifestByAsset.get(reference.assetId);
    if (priorManifest && priorManifest !== reference.manifestArtifactId) {
      throw new Error(`ReportDocument visual Asset ${reference.assetId} has conflicting Manifest references`);
    }
    manifestByAsset.set(reference.assetId, reference.manifestArtifactId);
    const key = `${reference.assetId}\u0000${reference.manifestArtifactId}`;
    if (seen.has(key)) return;
    seen.add(key);
    references.push(reference);
  };
  for (const block of document.sections.flatMap(({ blocks }) => blocks)) {
    if (block.type === 'image') append(block.assetRef);
    if (block.type === 'image-comparison') {
      append(block.beforeAssetRef);
      append(block.afterAssetRef);
    }
    if (block.type === 'chart') append(block.chartRef);
  }
  return references;
}

function visualReferenceKey(reference: VisualAssetReference): string {
  return `${reference.assetId}\u0000${reference.manifestArtifactId}`;
}

function assertVerifiedVisualReference(
  asset: VerifiedVisualAsset,
  reference: VisualAssetReference,
  binding: ReportPackageBinding,
): VisualAssetManifest {
  assertArtifactBinding(asset.artifact, reference.assetId, 'visual_asset', binding, 'Visual Asset');
  assertArtifactBinding(
    asset.manifestArtifact,
    reference.manifestArtifactId,
    'visual_asset_manifest',
    binding,
    'Visual Asset Manifest',
  );
  if (asset.manifestArtifact.schemaVersion !== asset.manifest.version) {
    throw new Error('Visual Asset Manifest Artifact schema version is invalid');
  }
  if (asset.manifest.assetId !== reference.assetId) {
    throw new Error('Visual Asset Manifest does not match its ReportDocument reference');
  }
  assertJsonIdentity(asset.manifest as unknown as Record<string, unknown>, binding, 'Visual Asset Manifest');
  return asset.manifest;
}

export class CurrentReportPackageReader {
  private readonly evidence: Pick<EvidenceService, 'resolveEvidenceValue' | 'validateManifest' | 'validateFindingGraph'>;
  private readonly reportValidator: Pick<ReportEvidenceValidator, 'validate'>;
  private readonly schemaValidator: Pick<SchemaValidator, 'validateOrThrow'>;

  constructor(private readonly dependencies: CurrentReportPackageReaderDependencies) {
    const evidence = dependencies.evidence ?? new EvidenceService();
    this.evidence = evidence;
    this.reportValidator = dependencies.reportValidator ?? new ReportEvidenceValidator(evidence);
    this.schemaValidator = dependencies.schemaValidator ?? new SchemaValidator();
  }

  async read(
    binding: ReportPackageBinding,
    frozen?: ReportPackageArtifactValue,
  ): Promise<CurrentReportPackageResponse | null> {
    if (frozen && (
      frozen.taskId !== binding.taskId
      || frozen.planVersionId !== binding.planVersionId
      || frozen.attemptId !== binding.attemptId
    )) {
      throw new Error('frozen Report Package binding is invalid');
    }
    const repositoryReview = frozen
      ? null
      : await this.dependencies.repository.findSealedArtifact({
          taskId: binding.taskId,
          attemptId: binding.attemptId,
          kind: 'report_review',
        });
    const selectedReviewId = frozen?.reportReviewArtifactId ?? repositoryReview?.id ?? null;
    let review: PassedReportReviewArtifact | null = null;
    let deliverableArtifactId: string;
    if (selectedReviewId) {
      const verifiedReview = await this.dependencies.artifacts.readVerifiedJson<unknown>(
        selectedReviewId,
      );
      assertArtifactBinding(
        verifiedReview.artifact,
        selectedReviewId,
        'report_review',
        binding,
        'Review',
      );
      if (verifiedReview.artifact.schemaVersion !== 'report-review-v1') {
        throw new Error('Review Artifact schema version is invalid');
      }
      assertValidReportReviewArtifact(verifiedReview.value, this.schemaValidator);
      const reviewRecord = record(verifiedReview.value);
      if (!reviewRecord) throw new Error('Review JSON schema is invalid');
      assertJsonIdentity(reviewRecord, binding, 'Review');
      if (verifiedReview.value.verdict !== 'pass') {
        throw new Error('final Review verdict must be pass');
      }
      review = verifiedReview.value as PassedReportReviewArtifact;
      if (basename(verifiedReview.artifact.storageUri) !== `review-r${review.revisionRound}.json`) {
        throw new Error('Review revision round does not match the final Review Artifact');
      }
      deliverableArtifactId = review.deliverableArtifactId;
      if (frozen && deliverableArtifactId !== frozen.deliverableArtifactId) {
        throw new Error('frozen Report Package deliverable reference is invalid');
      }
    } else if (frozen) {
      deliverableArtifactId = frozen.deliverableArtifactId;
    } else {
      const selectedDeliverable = await this.dependencies.repository.findSealedArtifact({
        taskId: binding.taskId,
        attemptId: binding.attemptId,
        kind: 'deliverable',
      });
      if (!selectedDeliverable) return null;
      deliverableArtifactId = selectedDeliverable.id;
    }

    const verifiedDeliverable = await this.dependencies.artifacts.readVerifiedJson<unknown>(
      deliverableArtifactId,
    );
    assertArtifactBinding(
      verifiedDeliverable.artifact,
      deliverableArtifactId,
      'deliverable',
      binding,
      'deliverable',
    );
    const schemaVersion = verifiedDeliverable.artifact.schemaVersion;
    const deliverable = record(verifiedDeliverable.value);
    if (!deliverable || deliverable.version !== 'research-deliverable-v1') {
      throw new Error('deliverable JSON schema is invalid');
    }
    assertJsonIdentity(deliverable, binding, 'deliverable');
    if (typeof deliverable.evidenceManifestArtifactId !== 'string') {
      throw new Error('deliverable is missing its Evidence Manifest Artifact reference');
    }

    const manifestId = deliverable.evidenceManifestArtifactId;
    if (frozen && manifestId !== frozen.evidenceManifestArtifactId) {
      throw new Error('frozen Report Package Evidence Manifest reference is invalid');
    }
    const verifiedManifest = await this.dependencies.artifacts.readVerifiedJson<unknown>(manifestId);
    assertArtifactBinding(
      verifiedManifest.artifact,
      manifestId,
      'evidence_manifest',
      binding,
      'Evidence Manifest',
    );
    if (verifiedManifest.artifact.schemaVersion !== 'evidence-v1') {
      throw new Error('Evidence Manifest Artifact schema version is invalid');
    }
    const manifestRecord = record(verifiedManifest.value);
    if (!manifestRecord || manifestRecord.version !== 'evidence-v1' || !Array.isArray(manifestRecord.entries)) {
      throw new Error('Evidence Manifest JSON schema is invalid');
    }
    assertJsonIdentity(manifestRecord, binding, 'Evidence Manifest');

    const resolvedArtifacts = new Map<string, ResolvedEvidenceArtifact>();
    for (const candidate of manifestRecord.entries) {
      const entry = record(candidate);
      if (
        !entry
        || typeof entry.artifactId !== 'string'
        || (
          entry.kind !== 'tool_output'
          && entry.kind !== 'knowledge_excerpt'
          && entry.kind !== 'screenshot'
          && entry.kind !== 'user_constraint'
        )
      ) {
        throw new Error('Evidence Manifest entry is invalid');
      }
      const verifiedEvidence = await this.dependencies.artifacts.readVerifiedJson<unknown>(
        entry.artifactId,
      );
      assertArtifactBinding(
        verifiedEvidence.artifact,
        entry.artifactId,
        evidenceArtifactKind(entry.kind),
        binding,
        'referenced Evidence',
      );
      if (entry.kind === 'screenshot') {
        if (!this.dependencies.visualAssets) {
          throw new Error('screenshot Evidence requires a verified visual Asset reader');
        }
        const screenshotManifest = record(verifiedEvidence.value);
        if (!screenshotManifest || typeof screenshotManifest.assetId !== 'string') {
          throw new Error('screenshot Evidence Manifest has no exact Asset reference');
        }
        const visual = await this.dependencies.visualAssets.readVerified({
          assetId: screenshotManifest.assetId,
          manifestArtifactId: entry.artifactId,
        });
        const verifiedVisualManifest = assertVerifiedVisualReference(
          visual,
          { assetId: screenshotManifest.assetId, manifestArtifactId: entry.artifactId },
          binding,
        );
        resolvedArtifacts.set(entry.artifactId, {
          artifact: {
            id: verifiedEvidence.artifact.id,
            contentSha256: verifiedEvidence.artifact.contentSha256,
          },
          value: verifiedVisualManifest,
        });
      } else {
        resolvedArtifacts.set(entry.artifactId, {
          artifact: {
            id: verifiedEvidence.artifact.id,
            contentSha256: verifiedEvidence.artifact.contentSha256,
          },
          value: verifiedEvidence.value,
        });
      }
    }
    const resolver: EvidenceArtifactResolver = {
      resolveArtifact: (artifactId) => resolvedArtifacts.get(artifactId) ?? null,
    };
    const evidenceManifest = verifiedManifest.value as EvidenceManifest;
    this.evidence.validateManifest(evidenceManifest, resolver);
    this.reportValidator.validate({
      manifest: evidenceManifest,
      report: deliverable,
      resolver,
      requireCoverage: schemaVersion === REVIEW_GATED_DELIVERABLE_SCHEMA_VERSION,
      validatePayloadSchema: false,
    });

    if (review) {
      if (schemaVersion !== REVIEW_GATED_DELIVERABLE_SCHEMA_VERSION) {
        throw new Error(`Review-bound deliverable Artifact schema marker ${schemaVersion} is unsupported`);
      }
      const repositoryDocument = frozen
        ? null
        : await this.dependencies.repository.findSealedArtifact({
            taskId: binding.taskId,
            attemptId: binding.attemptId,
            kind: 'report_document',
          });
      const selectedDocumentId = frozen?.reportDocumentArtifactId ?? repositoryDocument?.id ?? null;
      if (!selectedDocumentId) {
        return {
          presentationMode: 'current_text',
          deliverable: deliverable as unknown as ResearchDeliverableEnvelope<unknown>,
          evidenceManifest,
          reportReview: review,
        };
      }
      const verifiedDocument = await this.dependencies.artifacts.readVerifiedJson<unknown>(
        selectedDocumentId,
      );
      assertArtifactBinding(
        verifiedDocument.artifact,
        selectedDocumentId,
        'report_document',
        binding,
        'ReportDocument',
      );
      if (
        verifiedDocument.artifact.schemaVersion !== 'report-document-v1'
        && verifiedDocument.artifact.schemaVersion !== 'report-document-v2'
      ) {
        throw new Error('ReportDocument Artifact schema version is invalid');
      }
      this.schemaValidator.validateOrThrow('report-document', verifiedDocument.value);
      const reportDocument = verifiedDocument.value as ReportDocument;
      const references = reportAssetReferences(reportDocument);
      if (references.length > 0 && !this.dependencies.visualAssets) {
        throw new Error('multimodal ReportDocument requires a verified visual Asset reader');
      }
      const visualAssetManifests: VisualAssetManifest[] = [];
      const verifiedAssets = new Map<string, VerifiedVisualAsset>();
      for (const reference of references) {
        const asset = await this.dependencies.visualAssets!.readVerified(reference);
        visualAssetManifests.push(assertVerifiedVisualReference(asset, reference, binding));
        verifiedAssets.set(visualReferenceKey(reference), asset);
      }
      const evidenceEntries = new Map(evidenceManifest.entries.map((entry) => [entry.id, entry]));
      const chartEvidenceResolver = (evidenceId: string): unknown | undefined => {
        const entry = evidenceEntries.get(evidenceId);
        return entry ? this.evidence.resolveEvidenceValue(entry, resolver) : undefined;
      };
      const visualReferences = new Map<string, VisualAssetReference>();
      const chartReferences: Array<VisualAssetReference & { chartId: string; specHash: string }> = [];
      for (const block of reportDocument.sections.flatMap(({ blocks }) => blocks)) {
        if (block.type === 'image') {
          visualReferences.set(visualReferenceKey(block.assetRef), block.assetRef);
          continue;
        }
        if (block.type === 'image-comparison') {
          const before = verifiedAssets.get(visualReferenceKey(block.beforeAssetRef));
          const after = verifiedAssets.get(visualReferenceKey(block.afterAssetRef));
          const lineage = after?.manifest.derivedFrom;
          if (
            !before
            || !after
            || after.manifest.derivation?.kind !== 'annotation'
            || !lineage
            || lineage.assetId !== before.artifact.id
            || lineage.manifestArtifactId !== before.manifestArtifact.id
            || lineage.contentSha256 !== before.manifest.contentSha256
            || lineage.manifestHash !== before.manifest.manifestHash
          ) {
            throw new Error(`image comparison ${block.id} after annotation lineage does not exactly match its before Asset`);
          }
          visualReferences.set(visualReferenceKey(block.beforeAssetRef), block.beforeAssetRef);
          visualReferences.set(visualReferenceKey(block.afterAssetRef), block.afterAssetRef);
          continue;
        }
        if (block.type !== 'chart') continue;
        const asset = verifiedAssets.get(visualReferenceKey(block.chartRef));
        if (!asset) throw new Error(`Chart ${block.chartRef.chartId} has no verified visual Asset`);
        const validatedSpec = validateChartSpec(block.spec, chartEvidenceResolver);
        const expectedSpecHash = chartSpecHash(validatedSpec);
        const derivation = asset.manifest.derivation;
        if (
          block.specHash !== expectedSpecHash
          || derivation?.kind !== 'chart_svg'
          || block.chartRef.chartId !== validatedSpec.chartId
          || derivation.chartId !== validatedSpec.chartId
          || derivation.specHash !== expectedSpecHash
        ) {
          throw new Error(`Chart ${block.chartRef.chartId} specHash or chartId does not match its verified Manifest derivation`);
        }
        if (!isDeepStrictEqual(block.table, chartTableAlternative(validatedSpec))) {
          throw new Error(`Chart ${block.chartRef.chartId} sealed table does not match its Chart Spec`);
        }
        if (asset.manifest.version === 'visual-asset-manifest-v2') {
          const source = asset.manifest.source;
          if (source.kind !== 'chart_render' || asset.manifest.derivedFrom !== null) {
            throw new Error(`Chart ${block.chartRef.chartId} has invalid V2 chart_render provenance`);
          }
          const verifiedData = await this.dependencies.artifacts.readVerifiedJson<unknown>(
            source.dataArtifactId,
          );
          assertArtifactBinding(
            verifiedData.artifact,
            source.dataArtifactId,
            'chart_data',
            binding,
            'competitive weight Chart Data',
          );
          if (
            verifiedData.artifact.schemaVersion !== COMPETITIVE_WEIGHT_CHART_DATA_VERSION
            || verifiedData.artifact.contentSha256 !== source.dataArtifactContentSha256
          ) {
            throw new Error(`Chart ${block.chartRef.chartId} data Artifact schema or hash is invalid`);
          }
          const data = parseCompetitiveWeightChartData(verifiedData.value, binding);
          assertCompetitiveWeightChartBinding({
            data,
            spec: validatedSpec,
            dataArtifactRef: {
              artifactId: source.dataArtifactId,
              contentSha256: source.dataArtifactContentSha256,
            },
            evidenceEntries: evidenceManifest.entries,
          });
        }
        chartReferences.push({ ...block.chartRef, specHash: derivation.specHash });
      }
      const currentDeliverable = deliverable as unknown as ResearchDeliverableEnvelope<unknown>;
      assertValidReportDocument(reportDocument, {
        requiredQuestionIds: currentDeliverable.coverage.questionBindings.map(({ questionId }) => questionId),
        evidenceIds: evidenceManifest.entries.map(({ id }) => id),
        visualAssets: [...visualReferences.values()],
        charts: chartReferences,
      });
      return {
        presentationMode: 'multimodal',
        deliverable: deliverable as unknown as ResearchDeliverableEnvelope<unknown>,
        evidenceManifest,
        reportReview: review,
        reportDocument,
        visualAssetManifests,
      };
    }
    if (schemaVersion === LEGACY_DELIVERABLE_SCHEMA_VERSION) {
      return {
        presentationMode: 'legacy_text',
        deliverable: deliverable as unknown as LegacyResearchDeliverableEnvelope<unknown>,
        evidenceManifest,
      };
    }
    if (schemaVersion === REVIEW_GATED_DELIVERABLE_SCHEMA_VERSION) {
      throw new Error('review-gated report Review Artifact is missing');
    }
    throw new Error(`deliverable Artifact schema marker ${schemaVersion} is unsupported`);
  }
}
