import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  CurrentReportPackageResponse,
  PassedReportReviewArtifact,
} from '../../../../packages/api-contract/control-workflow.ts';
import type {
  ReadableReportDocument,
  ReportBlockV1V2,
  ReportBlockV3,
  ReportBlockV4,
  ReportDocumentV3,
  ReportDocumentV4,
} from '../../../../packages/api-contract/report-document.ts';
import type { ReportPackageV2 } from '../../../../packages/api-contract/report-package.ts';
import type {
  ContributionLedgerV1,
  ContributionSummaryV1,
  CrossSkillReviewV1,
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
import {
  assertReportProjectionIntegrity,
  requiredPayloadPointers,
} from './report-projection.ts';
import {
  resolveDeliverableContractById,
  selectReadablePayloadSchema,
} from './deliverable-registry.ts';
import type { VerifiedVisualAsset, VisualAssetService } from './visual-asset-service.ts';
import {
  assertReportDocumentV3Integrity,
  assertReportDocumentV4Integrity,
} from '../../../../packages/report-rendering/report-document-visitor.ts';
import {
  type ReportPackageArtifactValue,
} from './report-package-artifact.ts';
import {
  ReportPackageV2ArtifactVerifier,
  type ReportPackageV2ArtifactReader,
} from './report-package-v2-artifact.ts';
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
  artifacts: Pick<ControlArtifactStore, 'readVerifiedJson'> & ReportPackageV2ArtifactReader;
  repository: Pick<ControlPlaneRepository, 'findSealedArtifact'>;
  evidence?: Pick<EvidenceService, 'resolveEvidenceValue' | 'validateManifest' | 'validateFindingGraph'>;
  reportValidator?: Pick<ReportEvidenceValidator, 'validate'>;
  schemaValidator?: Pick<SchemaValidator, 'validateOrThrow'>;
  visualAssets?: Pick<VisualAssetService, 'readVerified'>;
}

export interface FrozenReportPackageRoot {
  artifactId: string;
  contentSha256: string;
}

interface FrozenReportPackageComponents {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  deliverableArtifactId: string;
  evidenceManifestArtifactId: string;
  reportReviewArtifactId?: string;
  reportDocumentArtifactId?: string;
  crossSkillReviewArtifactId?: string;
  contributionLedgerArtifactId?: string;
  contributionSummaryArtifactId?: string;
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

function evidenceArtifactKind(entry: Record<string, unknown>): string {
  switch (entry.kind) {
    case 'tool_output': return 'tool_output';
    case 'knowledge_excerpt': return entry.toolId === 'joyspace-read'
      ? 'knowledge_snapshot'
      : 'knowledge_output';
    case 'screenshot': return 'visual_asset_manifest';
    case 'user_constraint': return 'chart_data';
    case 'dataset': return 'dataset_input_profile';
    default: throw new Error('Evidence kind is unsupported');
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

function reportBlocks(document: ReadableReportDocument): Array<ReportBlockV1V2 | ReportBlockV3 | ReportBlockV4> {
  if (document.version === 'report-document-v3') {
    return document.sections.flatMap(({ blocks }) => blocks);
  }
  if (document.version === 'report-document-v4') {
    return document.sections.flatMap(({ blocks }) => blocks);
  }
  return document.sections.flatMap(({ blocks }) => blocks);
}

function reportAssetReferences(document: ReadableReportDocument): VisualAssetReference[] {
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
  for (const block of reportBlocks(document)) {
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
  if (asset.manifest.exportPolicy === 'block') {
    throw new Error(`Visual Asset ${reference.assetId} is blocked by its export policy`);
  }
  return asset.manifest;
}

function assertStructuredTraceReferences(input: {
  document: ReportDocumentV3 | ReportDocumentV4;
  requiredQuestionIds: readonly string[];
  evidenceIds: readonly string[];
  findingIds: readonly string[];
  summaryIds: readonly string[];
}): void {
  const requiredQuestionIds = new Set(input.requiredQuestionIds);
  const evidenceIds = new Set(input.evidenceIds);
  const findingIds = new Set(input.findingIds);
  const summaryIds = new Set(input.summaryIds);
  const coveredQuestions = new Set<string>();
  for (const [leafId, trace] of Object.entries(input.document.traceIndex)) {
    for (const questionId of trace.questionIds) {
      if (!requiredQuestionIds.has(questionId)) {
        throw new Error(`${input.document.version} leaf ${leafId} references unknown required question ${questionId}`);
      }
      coveredQuestions.add(questionId);
    }
    for (const evidenceId of trace.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        throw new Error(`${input.document.version} leaf ${leafId} references dangling Evidence ${evidenceId}`);
      }
    }
    for (const findingId of trace.findingIds) {
      if (!findingIds.has(findingId)) {
        throw new Error(`${input.document.version} leaf ${leafId} references dangling Finding ${findingId}`);
      }
    }
    for (const summaryId of trace.summaryIds) {
      if (!summaryIds.has(summaryId)) {
        throw new Error(`${input.document.version} leaf ${leafId} references dangling Summary ${summaryId}`);
      }
    }
  }
  for (const questionId of input.requiredQuestionIds) {
    if (!coveredQuestions.has(questionId)) {
      throw new Error(`${input.document.version} does not cover required question ${questionId}`);
    }
  }
}

export class CurrentReportPackageReader {
  private readonly evidence: Pick<EvidenceService, 'resolveEvidenceValue' | 'validateManifest' | 'validateFindingGraph'>;
  private readonly reportValidator: Pick<ReportEvidenceValidator, 'validate'>;
  private readonly schemaValidator: Pick<SchemaValidator, 'validateOrThrow'>;
  private readonly reportPackageV2: ReportPackageV2ArtifactVerifier;

  constructor(private readonly dependencies: CurrentReportPackageReaderDependencies) {
    const evidence = dependencies.evidence ?? new EvidenceService();
    this.evidence = evidence;
    this.reportValidator = dependencies.reportValidator ?? new ReportEvidenceValidator(evidence);
    this.schemaValidator = dependencies.schemaValidator ?? new SchemaValidator();
    this.reportPackageV2 = new ReportPackageV2ArtifactVerifier(dependencies.artifacts);
  }

  async read(
    binding: ReportPackageBinding,
    frozen?: ReportPackageArtifactValue | FrozenReportPackageRoot,
  ): Promise<CurrentReportPackageResponse | null> {
    let reportPackageV2: ReportPackageV2 | undefined;
    let frozenComponents: FrozenReportPackageComponents | undefined;
    if (frozen && 'artifactId' in frozen) {
      const verified = await this.reportPackageV2.verify({
        artifactId: frozen.artifactId,
        ...binding,
      });
      if (verified.artifact.contentSha256 !== frozen.contentSha256) {
        throw new Error('frozen Report Package root hash is invalid');
      }
      reportPackageV2 = verified.value;
      frozenComponents = {
        taskId: reportPackageV2.taskId,
        planVersionId: reportPackageV2.planVersionId,
        attemptId: reportPackageV2.attemptId,
        deliverableArtifactId: reportPackageV2.deliverableArtifactId,
        evidenceManifestArtifactId: reportPackageV2.evidenceManifestArtifactId,
        reportReviewArtifactId: reportPackageV2.reportReviewArtifactId,
        reportDocumentArtifactId: reportPackageV2.sourceReportDocumentArtifactId,
        ...(reportPackageV2.crossSkillReviewArtifactId === undefined
          ? {}
          : { crossSkillReviewArtifactId: reportPackageV2.crossSkillReviewArtifactId }),
        ...(reportPackageV2.contributionLedgerArtifactId === undefined
          ? {}
          : { contributionLedgerArtifactId: reportPackageV2.contributionLedgerArtifactId }),
        ...(reportPackageV2.contributionSummaryArtifactId === undefined
          ? {}
          : { contributionSummaryArtifactId: reportPackageV2.contributionSummaryArtifactId }),
      };
    } else {
      frozenComponents = frozen;
    }
    if (frozenComponents && (
      frozenComponents.taskId !== binding.taskId
      || frozenComponents.planVersionId !== binding.planVersionId
      || frozenComponents.attemptId !== binding.attemptId
    )) {
      throw new Error('frozen Report Package binding is invalid');
    }
    const contributionSidecars: {
      crossSkillReview?: CrossSkillReviewV1;
      contributionLedger?: ContributionLedgerV1;
      contributionSummary?: ContributionSummaryV1;
    } = {};
    if (frozenComponents?.crossSkillReviewArtifactId) {
      const verified = await this.dependencies.artifacts.readVerifiedJson<unknown>(
        frozenComponents.crossSkillReviewArtifactId,
      );
      assertArtifactBinding(verified.artifact, frozenComponents.crossSkillReviewArtifactId, 'cross_skill_review', binding, 'Cross-Skill Review');
      this.schemaValidator.validateOrThrow('cross-skill-review-v1', verified.value);
      const reviewRecord = record(verified.value);
      if (!reviewRecord) throw new Error('Cross-Skill Review JSON is invalid');
      assertJsonIdentity(reviewRecord, binding, 'Cross-Skill Review');
      contributionSidecars.crossSkillReview = verified.value as CrossSkillReviewV1;
    }
    if (frozenComponents?.contributionLedgerArtifactId) {
      const verified = await this.dependencies.artifacts.readVerifiedJson<unknown>(
        frozenComponents.contributionLedgerArtifactId,
      );
      assertArtifactBinding(verified.artifact, frozenComponents.contributionLedgerArtifactId, 'contribution_ledger', binding, 'Contribution Ledger');
      this.schemaValidator.validateOrThrow('contribution-ledger-v1', verified.value);
      const ledgerRecord = record(verified.value);
      if (!ledgerRecord) throw new Error('Contribution Ledger JSON is invalid');
      assertJsonIdentity(ledgerRecord, binding, 'Contribution Ledger');
      contributionSidecars.contributionLedger = verified.value as ContributionLedgerV1;
    }
    if (frozenComponents?.contributionSummaryArtifactId) {
      const verified = await this.dependencies.artifacts.readVerifiedJson<unknown>(
        frozenComponents.contributionSummaryArtifactId,
      );
      assertArtifactBinding(verified.artifact, frozenComponents.contributionSummaryArtifactId, 'contribution_summary', binding, 'Contribution Summary');
      this.schemaValidator.validateOrThrow('contribution-summary-v1', verified.value);
      const summaryRecord = record(verified.value);
      if (!summaryRecord) throw new Error('Contribution Summary JSON is invalid');
      assertJsonIdentity(summaryRecord, binding, 'Contribution Summary');
      contributionSidecars.contributionSummary = verified.value as ContributionSummaryV1;
    }
    const repositoryReview = frozenComponents
      ? null
      : await this.dependencies.repository.findSealedArtifact({
          taskId: binding.taskId,
          attemptId: binding.attemptId,
          kind: 'report_review',
        });
    const selectedReviewId = frozenComponents?.reportReviewArtifactId ?? repositoryReview?.id ?? null;
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
      if (
        verifiedReview.artifact.schemaVersion !== 'report-review-v1'
        && verifiedReview.artifact.schemaVersion !== 'report-review-v2'
        && verifiedReview.artifact.schemaVersion !== 'report-review-v3'
      ) {
        throw new Error('Review Artifact schema version is invalid');
      }
      assertValidReportReviewArtifact(verifiedReview.value, this.schemaValidator);
      if (verifiedReview.artifact.schemaVersion !== verifiedReview.value.version) {
        throw new Error('Review Artifact schema version does not match its value');
      }
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
      if (frozenComponents && deliverableArtifactId !== frozenComponents.deliverableArtifactId) {
        throw new Error('frozen Report Package deliverable reference is invalid');
      }
    } else if (frozenComponents) {
      deliverableArtifactId = frozenComponents.deliverableArtifactId;
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
    if (review) {
      const expectedReviewVersion = deliverable.deliverableType === 'research_strategy_report'
        ? 'report-review-v2'
        : deliverable.deliverableType === 'industry_market_analysis_report'
          ? 'report-review-v3'
          : 'report-review-v1';
      if (review.version !== expectedReviewVersion) {
        throw new Error(`deliverable ${String(deliverable.deliverableType)} requires ${expectedReviewVersion}`);
      }
    }
    if (typeof deliverable.evidenceManifestArtifactId !== 'string') {
      throw new Error('deliverable is missing its Evidence Manifest Artifact reference');
    }

    const manifestId = deliverable.evidenceManifestArtifactId;
    if (frozenComponents && manifestId !== frozenComponents.evidenceManifestArtifactId) {
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
          && entry.kind !== 'dataset'
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
        evidenceArtifactKind(entry),
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
      const repositoryDocument = frozenComponents
        ? null
        : await this.dependencies.repository.findSealedArtifact({
            taskId: binding.taskId,
            attemptId: binding.attemptId,
            kind: 'report_document',
          });
      const selectedDocumentId = frozenComponents?.reportDocumentArtifactId ?? repositoryDocument?.id ?? null;
      if (!selectedDocumentId) {
        return {
          presentationMode: 'current_text',
          deliverable: deliverable as unknown as ResearchDeliverableEnvelope<unknown>,
          evidenceManifest,
          reportReview: review,
          ...contributionSidecars,
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
        && verifiedDocument.artifact.schemaVersion !== 'report-document-v3'
        && verifiedDocument.artifact.schemaVersion !== 'report-document-v4'
      ) {
        throw new Error('ReportDocument Artifact schema version is invalid');
      }
      this.schemaValidator.validateOrThrow('report-document', verifiedDocument.value);
      const reportDocument = verifiedDocument.value as ReadableReportDocument;
      if (verifiedDocument.artifact.schemaVersion !== reportDocument.version) {
        throw new Error('ReportDocument Artifact schema version does not match its value');
      }
      if (reportDocument.version === 'report-document-v3' || reportDocument.version === 'report-document-v4') {
        if (reportDocument.version === 'report-document-v4') assertReportDocumentV4Integrity(reportDocument);
        else assertReportDocumentV3Integrity(reportDocument);
        if (
          reportDocument.sourceDeliverableArtifactId !== deliverableArtifactId
          || reportDocument.sourceDeliverableContentSha256 !== verifiedDeliverable.artifact.contentSha256
        ) {
          throw new Error(`${reportDocument.version} source Deliverable identity is invalid`);
        }
      } else {
        assertReportProjectionIntegrity({
          document: reportDocument,
          deliverableArtifactId,
          payload: deliverable.payload,
          requiredPointers: requiredPayloadPointers(
            selectReadablePayloadSchema(
              resolveDeliverableContractById(String(deliverable.deliverableType)),
              deliverable.payload,
            ).schema,
          ),
        });
      }
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
      for (const block of reportBlocks(reportDocument)) {
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
      if (reportDocument.version === 'report-document-v3' || reportDocument.version === 'report-document-v4') {
        assertStructuredTraceReferences({
          document: reportDocument,
          requiredQuestionIds: currentDeliverable.coverage.questionBindings.map(({ questionId }) => questionId),
          evidenceIds: evidenceManifest.entries.map(({ id }) => id),
          findingIds: currentDeliverable.findingGraph.findings.map(({ id }) => id),
          summaryIds: currentDeliverable.findingGraph.subQuestionSummaries.map(({ id }) => id),
        });
      } else {
        assertValidReportDocument(reportDocument, {
          requiredQuestionIds: currentDeliverable.coverage.questionBindings.map(({ questionId }) => questionId),
          evidenceIds: evidenceManifest.entries.map(({ id }) => id),
          findingIds: currentDeliverable.findingGraph.findings.map(({ id }) => id),
          summaryIds: currentDeliverable.findingGraph.subQuestionSummaries.map(({ id }) => id),
          visualAssets: [...visualReferences.values()],
          charts: chartReferences,
        });
      }
      return {
        presentationMode: 'multimodal',
        deliverable: deliverable as unknown as ResearchDeliverableEnvelope<unknown>,
        evidenceManifest,
        reportReview: review,
        reportDocument,
        reportDocumentContentSha256: verifiedDocument.artifact.contentSha256,
        visualAssetManifests,
        ...(reportPackageV2 === undefined ? {} : {
          reportPackage: {
            version: reportPackageV2.version,
            reportPublicationId: reportPackageV2.reportPublicationId,
            layout: reportPackageV2.layout,
            assetSnapshot: reportPackageV2.assetSnapshot,
            standaloneHtml: reportPackageV2.standaloneHtml,
            notices: reportPackageV2.notices,
          },
        }),
        ...contributionSidecars,
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
