import { isDeepStrictEqual } from 'node:util';
import type {
  ControlArtifact,
  ControlExecutionLease,
} from '../../../../database/control-plane.ts';
import type {
  ReportBlockV3,
  ReportBlockV4,
  ReportDocumentV3,
  ReportDocumentV4,
} from '../../../../packages/api-contract/report-document.ts';
import type { ReportEditorialBlueprintV1 } from '../../../../packages/api-contract/report-editorial.ts';
import {
  parseReportPackageV2,
  REPORT_PACKAGE_V2_VERSION,
  type ReportPackageAssetV2,
  type ReportPackageChartV2,
  type ReportPackageV2,
} from '../../../../packages/api-contract/report-package.ts';
import type { VisualAssetManifest } from '../../../../packages/api-contract/research-deliverable.ts';
import {
  assertReportDocumentV3Integrity,
  assertReportDocumentV4Integrity,
} from '../../../../packages/report-rendering/report-document-visitor.ts';
import type { ControlArtifactStore } from '../control/artifact-store.ts';
import { SchemaValidator } from '../schema/validator.ts';
import { assertValidReportReviewArtifact } from './report-review-service.ts';

const COMPONENT_VALIDATOR = new SchemaValidator();

export type ReportPackageV2ArtifactReader = Pick<
  ControlArtifactStore,
  | 'readVerifiedBoundJson'
  | 'readVerifiedBoundText'
  | 'readVerifiedBinary'
>;

type ReportPackageV2ArtifactStore = ReportPackageV2ArtifactReader & Pick<
  ControlArtifactStore,
  'writeJson'
>;

type PackageBinding = Pick<ReportPackageV2, 'taskId' | 'planVersionId' | 'attemptId'>;

export type ReportPackageV2SealInput = Omit<
  ReportPackageV2,
  'version' | 'taskId' | 'planVersionId' | 'attemptId' | 'presentationMode'
> & {
  activeLease: ControlExecutionLease;
  onArtifactSealed?: (artifact: ControlArtifact) => void;
};

export interface ReportPackageV2VerifyInput extends PackageBinding {
  artifactId: string;
  reportPublicationId?: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Report Package v2 ${label} value is invalid`);
  }
  return value as Record<string, unknown>;
}

function assertBoundArtifact(input: {
  artifact: ControlArtifact;
  artifactId: string;
  kind: string;
  binding: PackageBinding;
  schemaVersions?: readonly string[];
}): asserts input is typeof input & { artifact: ControlArtifact & { contentSha256: string } } {
  const { artifact } = input;
  if (
    artifact.id !== input.artifactId
    || artifact.state !== 'SEALED'
    || artifact.contentSha256 === null
    || artifact.kind !== input.kind
    || artifact.taskId !== input.binding.taskId
    || artifact.planVersionId !== input.binding.planVersionId
    || artifact.attemptId !== input.binding.attemptId
    || (input.schemaVersions !== undefined && !input.schemaVersions.includes(artifact.schemaVersion))
  ) {
    throw new Error(`Report Package v2 ${input.kind} Artifact binding is invalid`);
  }
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === left.length
    && rightSet.size === right.length
    && leftSet.size === rightSet.size
    && [...leftSet].every((value) => rightSet.has(value));
}

function assertValueBinding(value: Record<string, unknown>, binding: PackageBinding, label: string): void {
  if (
    value.taskId !== binding.taskId
    || value.planVersionId !== binding.planVersionId
    || value.attemptId !== binding.attemptId
  ) {
    throw new Error(`Report Package v2 ${label} value binding is invalid`);
  }
}

type PackageReportDocument = ReportDocumentV3 | ReportDocumentV4;

function reportBlocks(document: PackageReportDocument): Array<ReportBlockV3 | ReportBlockV4> {
  if (document.version === 'report-document-v4') {
    return document.sections.flatMap(({ blocks }) => blocks);
  }
  return document.sections.flatMap(({ blocks }) => blocks);
}

function assertDocumentNotices(document: PackageReportDocument, reportPackage: ReportPackageV2): void {
  const packageNotices = new Map(reportPackage.notices.map((notice) => [notice.id, notice]));
  for (const notice of document.notices) {
    if (!isDeepStrictEqual(packageNotices.get(notice.id), notice)) {
      throw new Error('Report Package v2 notices do not preserve ReportDocument notices');
    }
  }
}

function assertDocumentAssetSnapshotIdentity(
  document: PackageReportDocument,
  assets: readonly ReportPackageAssetV2[],
): void {
  const documentManifests = new Map<string, string>();
  const append = (assetId: string, manifestArtifactId: string): void => {
    const prior = documentManifests.get(assetId);
    if (prior !== undefined && prior !== manifestArtifactId) {
      throw new Error(`Report Package v2 ReportDocument Asset ${assetId} has conflicting Manifest references`);
    }
    documentManifests.set(assetId, manifestArtifactId);
  };
  for (const block of reportBlocks(document)) {
    if (block.type === 'image') append(block.assetRef.assetId, block.assetRef.manifestArtifactId);
    if (block.type === 'image-comparison') {
      append(block.beforeAssetRef.assetId, block.beforeAssetRef.manifestArtifactId);
      append(block.afterAssetRef.assetId, block.afterAssetRef.manifestArtifactId);
    }
    if (block.type === 'chart') append(block.chartRef.assetId, block.chartRef.manifestArtifactId);
  }
  for (const asset of assets) {
    if (documentManifests.get(asset.assetId) !== asset.manifestArtifactId) {
      throw new Error(
        `Report Package v2 Asset ${asset.assetId} Manifest identity does not match ReportDocument`,
      );
    }
  }
}

function assertManifestMatchesSnapshot(
  manifest: VisualAssetManifest,
  asset: ReportPackageAssetV2,
  binding: PackageBinding,
): void {
  if (
    manifest.taskId !== binding.taskId
    || manifest.planVersionId !== binding.planVersionId
    || manifest.attemptId !== binding.attemptId
    || manifest.assetId !== asset.assetId
    || manifest.contentSha256 !== asset.contentSha256
    || manifest.manifestHash !== asset.manifestHash
    || manifest.mediaType !== asset.mediaType
    || manifest.exportPolicy !== asset.exportPolicy
  ) {
    throw new Error(`Report Package v2 Asset ${asset.assetId} Manifest does not match its snapshot`);
  }
  if (asset.sourceKind === 'chart_svg') {
    if (
      manifest.version !== 'visual-asset-manifest-v2'
      || manifest.mediaType !== 'image/svg+xml'
      || manifest.source.kind !== 'chart_render'
      || manifest.derivation?.kind !== 'chart_svg'
    ) {
      throw new Error(`Report Package v2 Asset ${asset.assetId} is not a verified chart SVG`);
    }
  } else if (manifest.mediaType === 'image/svg+xml') {
    throw new Error(`Report Package v2 Asset ${asset.assetId} cannot publish ordinary SVG`);
  }
}

function assertChartSpecValue(
  value: unknown,
  chart: ReportPackageChartV2,
  asset: ReportPackageAssetV2,
): void {
  const candidate = record(value, `Chart ${chart.chartId}`);
  const assetRef = record(candidate.assetRef, `Chart ${chart.chartId} assetRef`);
  if (
    candidate.version !== 'verified-chart-v1'
    || candidate.chartId !== chart.chartId
    || candidate.specHash !== chart.specHash
    || assetRef.assetId !== chart.assetId
    || assetRef.manifestArtifactId !== asset.manifestArtifactId
  ) {
    throw new Error(`Report Package v2 Chart ${chart.chartId} does not match its snapshot`);
  }
  if (chart.dataArtifactRef !== undefined) {
    const dataRef = record(candidate.dataArtifactRef, `Chart ${chart.chartId} dataArtifactRef`);
    if (
      dataRef.artifactId !== chart.dataArtifactRef.artifactId
      || dataRef.contentSha256 !== chart.dataArtifactRef.contentSha256
    ) {
      throw new Error(`Report Package v2 Chart ${chart.chartId} data reference is invalid`);
    }
  } else if (candidate.dataArtifactRef !== undefined) {
    throw new Error(`Report Package v2 Chart ${chart.chartId} has an unsealed data reference`);
  }
}

export class ReportPackageV2ArtifactVerifier {
  constructor(private readonly artifacts: ReportPackageV2ArtifactReader) {}

  async verify(input: ReportPackageV2VerifyInput): Promise<{
    artifact: ControlArtifact;
    value: ReportPackageV2;
  }> {
    const verifiedPackage = await this.artifacts.readVerifiedBoundJson<unknown>(input.artifactId);
    const value = parseReportPackageV2(verifiedPackage.value);
    const binding: PackageBinding = value;
    if (
      value.taskId !== input.taskId
      || value.planVersionId !== input.planVersionId
      || value.attemptId !== input.attemptId
      || (
        input.reportPublicationId !== undefined
        && value.reportPublicationId !== input.reportPublicationId
      )
    ) {
      throw new Error('Report Package v2 expected identity does not match its value');
    }
    assertBoundArtifact({
      artifact: verifiedPackage.artifact,
      artifactId: input.artifactId,
      kind: 'report_package',
      binding,
      schemaVersions: [REPORT_PACKAGE_V2_VERSION],
    });
    if (!/(?:^|\/)reports\/report-package\.json$/u.test(verifiedPackage.artifact.storageUri)) {
      throw new Error('Report Package v2 root does not use the fixed Package path');
    }

    const deliverable = await this.artifacts.readVerifiedBoundJson<unknown>(value.deliverableArtifactId);
    assertBoundArtifact({
      artifact: deliverable.artifact,
      artifactId: value.deliverableArtifactId,
      kind: 'deliverable',
      binding,
    });
    const deliverableValue = record(deliverable.value, 'Deliverable');
    assertValueBinding(deliverableValue, binding, 'Deliverable');
    if (deliverableValue.evidenceManifestArtifactId !== value.evidenceManifestArtifactId) {
      throw new Error('Report Package v2 Deliverable Evidence Manifest reference is invalid');
    }

    const evidence = await this.artifacts.readVerifiedBoundJson<unknown>(value.evidenceManifestArtifactId);
    assertBoundArtifact({
      artifact: evidence.artifact,
      artifactId: value.evidenceManifestArtifactId,
      kind: 'evidence_manifest',
      binding,
    });
    assertValueBinding(record(evidence.value, 'Evidence Manifest'), binding, 'Evidence Manifest');

    const review = await this.artifacts.readVerifiedBoundJson<unknown>(value.reportReviewArtifactId);
    assertBoundArtifact({
      artifact: review.artifact,
      artifactId: value.reportReviewArtifactId,
      kind: 'report_review',
      binding,
      schemaVersions: ['report-review-v1', 'report-review-v2', 'report-review-v3'],
    });
    const reviewValue = record(review.value, 'Report Review');
    assertValidReportReviewArtifact(review.value, COMPONENT_VALIDATOR);
    assertValueBinding(reviewValue, binding, 'Report Review');
    if (
      reviewValue.version !== review.artifact.schemaVersion
      || reviewValue.deliverableArtifactId !== value.deliverableArtifactId
      || reviewValue.verdict !== 'pass'
    ) {
      throw new Error('Report Package v2 Report Review reference is invalid');
    }

    const document = await this.artifacts.readVerifiedBoundJson<unknown>(
      value.sourceReportDocumentArtifactId,
    );
    assertBoundArtifact({
      artifact: document.artifact,
      artifactId: value.sourceReportDocumentArtifactId,
      kind: 'report_document',
      binding,
      schemaVersions: ['report-document-v3', 'report-document-v4'],
    });
    if (document.artifact.contentSha256 !== value.sourceReportDocumentContentSha256) {
      throw new Error('Report Package v2 source ReportDocument hash is invalid');
    }
    const documentValue = record(document.value, 'source ReportDocument') as unknown as PackageReportDocument;
    if (documentValue.version !== 'report-document-v3' && documentValue.version !== 'report-document-v4') {
      throw new Error('Report Package v2 source ReportDocument version is invalid');
    }
    if (document.artifact.schemaVersion !== documentValue.version) {
      throw new Error('Report Package v2 source ReportDocument Artifact version is invalid');
    }
    COMPONENT_VALIDATOR.validateOrThrow('report-document', document.value);
    if (documentValue.version === 'report-document-v4') assertReportDocumentV4Integrity(documentValue);
    else assertReportDocumentV3Integrity(documentValue);
    if (
      documentValue.sourceDeliverableArtifactId !== value.deliverableArtifactId
      || documentValue.sourceDeliverableContentSha256 !== deliverable.artifact.contentSha256
      || documentValue.layoutMode !== value.layout.mode
    ) {
      throw new Error('Report Package v2 source ReportDocument lineage is invalid');
    }
    if (!sameSet(
      documentValue.semanticManifest.assetIds,
      value.assetSnapshot.assets.map(({ assetId }) => assetId),
    )) {
      throw new Error('Report Package v2 Asset snapshot does not match ReportDocument Assets');
    }
    assertDocumentAssetSnapshotIdentity(documentValue, value.assetSnapshot.assets);
    assertDocumentNotices(documentValue, value);

    const blueprint = await this.artifacts.readVerifiedBoundJson<unknown>(value.layout.blueprintArtifactId);
    assertBoundArtifact({
      artifact: blueprint.artifact,
      artifactId: value.layout.blueprintArtifactId,
      kind: 'report_editorial_blueprint',
      binding,
      schemaVersions: ['report-editorial-blueprint-v1'],
    });
    if (record(blueprint.value, 'editorial Blueprint').version !== 'report-editorial-blueprint-v1') {
      throw new Error('Report Package v2 editorial Blueprint value is invalid');
    }
    COMPONENT_VALIDATOR.validateFileOrThrow(
      'schemas/report-editorial-blueprint-v1.schema.json',
      blueprint.value,
    );
    const blueprintValue = blueprint.value as ReportEditorialBlueprintV1;
    const blueprintUnitIds = blueprintValue.sections.flatMap(({ blocks }) => (
      blocks.flatMap(({ unitRefs }) => unitRefs)
    ));
    if (
      new Set(blueprintUnitIds).size !== blueprintUnitIds.length
      || !sameSet(blueprintUnitIds, documentValue.semanticManifest.presentationUnitIds)
    ) {
      throw new Error('Report Package v2 editorial Blueprint units do not match ReportDocument');
    }

    const optionalComponents = [
      value.crossSkillReviewArtifactId === undefined ? null : {
        id: value.crossSkillReviewArtifactId,
        kind: 'cross_skill_review',
        schemaVersion: 'cross-skill-review-v1',
      },
      value.contributionLedgerArtifactId === undefined ? null : {
        id: value.contributionLedgerArtifactId,
        kind: 'contribution_ledger',
        schemaVersion: 'contribution-ledger-v1',
      },
      value.contributionSummaryArtifactId === undefined ? null : {
        id: value.contributionSummaryArtifactId,
        kind: 'contribution_summary',
        schemaVersion: 'contribution-summary-v1',
      },
    ].filter((component): component is { id: string; kind: string; schemaVersion: string } => component !== null);
    for (const component of optionalComponents) {
      const verified = await this.artifacts.readVerifiedBoundJson<unknown>(component.id);
      assertBoundArtifact({
        artifact: verified.artifact,
        artifactId: component.id,
        kind: component.kind,
        binding,
        schemaVersions: [component.schemaVersion],
      });
      COMPONENT_VALIDATOR.validateFileOrThrow(
        `schemas/${component.schemaVersion}.schema.json`,
        verified.value,
      );
    }

    const verifiedManifestByAssetId = new Map<string, VisualAssetManifest>();
    for (const asset of value.assetSnapshot.assets) {
      const binary = await this.artifacts.readVerifiedBinary(asset.assetId);
      assertBoundArtifact({
        artifact: binary.artifact,
        artifactId: asset.assetId,
        kind: 'visual_asset',
        binding,
        schemaVersions: ['visual-asset-v1'],
      });
      if (
        binary.artifact.contentSha256 !== asset.contentSha256
        || binary.metadata.contentType !== asset.mediaType
      ) {
        throw new Error(`Report Package v2 Asset ${asset.assetId} bytes do not match its snapshot`);
      }
      const manifest = await this.artifacts.readVerifiedBoundJson<unknown>(asset.manifestArtifactId);
      assertBoundArtifact({
        artifact: manifest.artifact,
        artifactId: asset.manifestArtifactId,
        kind: 'visual_asset_manifest',
        binding,
        schemaVersions: ['visual-asset-manifest-v1', 'visual-asset-manifest-v2'],
      });
      const manifestValue = record(
        manifest.value,
        `Asset ${asset.assetId} Manifest`,
      ) as unknown as VisualAssetManifest;
      if (manifestValue.version !== manifest.artifact.schemaVersion) {
        throw new Error(`Report Package v2 Asset ${asset.assetId} Manifest version is invalid`);
      }
      COMPONENT_VALIDATOR.validateFileOrThrow(
        manifestValue.version === 'visual-asset-manifest-v2'
          ? 'schemas/visual-asset-manifest-v2.schema.json'
          : 'schemas/visual-asset-manifest.schema.json',
        manifest.value,
      );
      assertManifestMatchesSnapshot(manifestValue, asset, binding);
      verifiedManifestByAssetId.set(asset.assetId, manifestValue);
      for (const leafId of asset.leafIds) {
        if (!documentValue.semanticManifest.leafUnitIds.includes(leafId)) {
          throw new Error(`Report Package v2 Asset ${asset.assetId} leaf is outside ReportDocument`);
        }
      }
    }

    for (const chart of value.assetSnapshot.charts) {
      const asset = value.assetSnapshot.assets.find(({ assetId }) => assetId === chart.assetId)!;
      const manifest = verifiedManifestByAssetId.get(chart.assetId)!;
      const spec = await this.artifacts.readVerifiedBoundJson<unknown>(chart.chartSpecArtifactId);
      assertBoundArtifact({
        artifact: spec.artifact,
        artifactId: chart.chartSpecArtifactId,
        kind: 'chart_spec',
        binding,
        schemaVersions: ['verified-chart-v1'],
      });
      if (spec.artifact.contentSha256 !== chart.chartSpecArtifactContentSha256) {
        throw new Error(`Report Package v2 Chart ${chart.chartId} Spec hash is invalid`);
      }
      assertChartSpecValue(spec.value, chart, asset);
      if (asset.sourceKind === 'chart_svg') {
        if (
          manifest.version !== 'visual-asset-manifest-v2'
          || manifest.source.kind !== 'chart_render'
          || manifest.derivation?.kind !== 'chart_svg'
          || manifest.derivation.chartId !== chart.chartId
          || manifest.derivation.specHash !== chart.specHash
          || chart.dataArtifactRef === undefined
          || manifest.source.dataArtifactId !== chart.dataArtifactRef.artifactId
          || manifest.source.dataArtifactContentSha256 !== chart.dataArtifactRef.contentSha256
        ) {
          throw new Error(`Report Package v2 Chart ${chart.chartId} SVG provenance is invalid`);
        }
      }
      for (const leafId of chart.leafIds) {
        if (!documentValue.semanticManifest.leafUnitIds.includes(leafId)) {
          throw new Error(`Report Package v2 Chart ${chart.chartId} leaf is outside ReportDocument`);
        }
      }
      if (chart.dataArtifactRef !== undefined) {
        const data = await this.artifacts.readVerifiedBoundJson<unknown>(chart.dataArtifactRef.artifactId);
        assertBoundArtifact({
          artifact: data.artifact,
          artifactId: chart.dataArtifactRef.artifactId,
          kind: 'chart_data',
          binding,
          schemaVersions: [chart.dataArtifactRef.schemaVersion],
        });
        if (data.artifact.contentSha256 !== chart.dataArtifactRef.contentSha256) {
          throw new Error(`Report Package v2 Chart ${chart.chartId} Data hash is invalid`);
        }
      }
    }

    if (value.standaloneHtml.status === 'ready') {
      const html = await this.artifacts.readVerifiedBoundText(value.standaloneHtml.artifactId);
      assertBoundArtifact({
        artifact: html.artifact,
        artifactId: value.standaloneHtml.artifactId,
        kind: 'standalone_html_report',
        binding,
        schemaVersions: ['standalone-html-report-v1'],
      });
      const documentBinding = `<meta name="report-document-sha256" content="${value.sourceReportDocumentContentSha256}">`;
      const rendererBinding = `<meta name="report-renderer-version" content="${value.standaloneHtml.rendererVersion}">`;
      if (
        html.artifact.mediaType !== 'text/html; charset=utf-8'
        || html.content.length === 0
        || !html.content.includes(documentBinding)
        || !html.content.includes(rendererBinding)
      ) {
        throw new Error('Report Package v2 standalone HTML identity is invalid');
      }
    }

    return { artifact: verifiedPackage.artifact, value };
  }
}

export class ReportPackageV2ArtifactService extends ReportPackageV2ArtifactVerifier {
  constructor(private readonly writableArtifacts: ReportPackageV2ArtifactStore) {
    super(writableArtifacts);
  }

  async seal(input: ReportPackageV2SealInput): Promise<ControlArtifact> {
    const value = parseReportPackageV2({
      version: REPORT_PACKAGE_V2_VERSION,
      taskId: input.activeLease.taskId,
      planVersionId: input.activeLease.planVersionId,
      attemptId: input.activeLease.attemptId,
      reportPublicationId: input.reportPublicationId,
      presentationMode: 'multimodal',
      deliverableArtifactId: input.deliverableArtifactId,
      evidenceManifestArtifactId: input.evidenceManifestArtifactId,
      reportReviewArtifactId: input.reportReviewArtifactId,
      sourceReportDocumentArtifactId: input.sourceReportDocumentArtifactId,
      sourceReportDocumentContentSha256: input.sourceReportDocumentContentSha256,
      ...(input.crossSkillReviewArtifactId === undefined
        ? {}
        : { crossSkillReviewArtifactId: input.crossSkillReviewArtifactId }),
      ...(input.contributionLedgerArtifactId === undefined
        ? {}
        : { contributionLedgerArtifactId: input.contributionLedgerArtifactId }),
      ...(input.contributionSummaryArtifactId === undefined
        ? {}
        : { contributionSummaryArtifactId: input.contributionSummaryArtifactId }),
      layout: input.layout,
      assetSnapshot: input.assetSnapshot,
      standaloneHtml: input.standaloneHtml,
      notices: input.notices,
    });
    const artifact = await this.writableArtifacts.writeJson({
      taskId: value.taskId,
      planVersionId: value.planVersionId,
      attemptId: value.attemptId,
      kind: 'report_package',
      relativePath: 'reports/report-package.json',
      schemaVersion: REPORT_PACKAGE_V2_VERSION,
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
      activeLease: input.activeLease,
      value,
    });
    input.onArtifactSealed?.(artifact);
    await this.verify({
      artifactId: artifact.id,
      taskId: value.taskId,
      planVersionId: value.planVersionId,
      attemptId: value.attemptId,
      reportPublicationId: value.reportPublicationId,
    });
    return artifact;
  }
}
