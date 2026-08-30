import type { ControlArtifact, ControlExecutionLease } from '../../../../database/control-plane.ts';
import type { EditorialPresentationSpecV1 } from '../../../../packages/api-contract/report-editorial-showcase.ts';
import type { EvidenceManifest } from '../../../../packages/api-contract/research-deliverable.ts';
import {
  parseReportPackageV3,
  REPORT_PACKAGE_V3_VERSION,
  type ReportPackageShowcaseV3,
  type ReportPackageV3,
} from '../../../../packages/api-contract/report-package.ts';
import type { ControlArtifactStore } from '../control/artifact-store.ts';
import { SchemaValidator } from '../schema/validator.ts';
import type { ReportPackageV2ArtifactVerifier } from './report-package-v2-artifact.ts';

export type ReportPackageV3ArtifactReader = Pick<
  ControlArtifactStore,
  'readVerifiedBoundJson' | 'readVerifiedBoundText'
>;

type ReportPackageV3ArtifactStore = ReportPackageV3ArtifactReader & Pick<ControlArtifactStore, 'writeJson'>;

type PackageBinding = Pick<ReportPackageV3, 'taskId' | 'planVersionId' | 'attemptId'>;

export interface ReportPackageV3SealInput {
  activeLease: ControlExecutionLease;
  canonicalPackageArtifactId: string;
  canonicalPackageContentSha256: string;
  reportPublicationId: string;
  preferredHtml: 'showcase' | 'canonical';
  showcase: ReportPackageShowcaseV3;
  onArtifactSealed?: (artifact: ControlArtifact) => void;
}

export interface ReportPackageV3VerifyInput extends PackageBinding {
  artifactId: string;
  reportPublicationId?: string;
}

function assertBoundArtifact(input: {
  artifact: ControlArtifact;
  artifactId: string;
  kind: string;
  binding: PackageBinding;
  schemaVersions: readonly string[];
  mediaType?: string;
}): asserts input is typeof input & { artifact: ControlArtifact & { contentSha256: string } } {
  const artifact = input.artifact;
  if (
    artifact.id !== input.artifactId
    || artifact.state !== 'SEALED'
    || !artifact.contentSha256
    || artifact.kind !== input.kind
    || artifact.taskId !== input.binding.taskId
    || artifact.planVersionId !== input.binding.planVersionId
    || artifact.attemptId !== input.binding.attemptId
    || !input.schemaVersions.includes(artifact.schemaVersion)
    || (input.mediaType !== undefined && artifact.mediaType !== input.mediaType)
  ) {
    throw new Error(`Report Package v3 ${input.kind} Artifact binding is invalid`);
  }
}

export class ReportPackageV3ArtifactVerifier {
  private readonly validator: Pick<SchemaValidator, 'validateFileOrThrow'>;

  constructor(protected readonly dependencies: {
    artifacts: ReportPackageV3ArtifactReader;
    canonicalPackages: Pick<ReportPackageV2ArtifactVerifier, 'verify'>;
    validator?: Pick<SchemaValidator, 'validateFileOrThrow'>;
  }) {
    this.validator = dependencies.validator ?? new SchemaValidator();
  }

  async verify(input: ReportPackageV3VerifyInput): Promise<{
    artifact: ControlArtifact;
    value: ReportPackageV3;
  }> {
    const root = await this.dependencies.artifacts.readVerifiedBoundJson<unknown>(input.artifactId);
    const value = parseReportPackageV3(root.value);
    const binding: PackageBinding = value;
    if (
      value.taskId !== input.taskId
      || value.planVersionId !== input.planVersionId
      || value.attemptId !== input.attemptId
      || (input.reportPublicationId !== undefined && value.reportPublicationId !== input.reportPublicationId)
    ) {
      throw new Error('Report Package v3 expected identity does not match its value');
    }
    assertBoundArtifact({
      artifact: root.artifact,
      artifactId: input.artifactId,
      kind: 'report_package',
      binding,
      schemaVersions: [REPORT_PACKAGE_V3_VERSION],
    });
    if (!/(?:^|\/)reports\/report-package-v3\.json$/u.test(root.artifact.storageUri)) {
      throw new Error('Report Package v3 root does not use the fixed Package path');
    }

    const canonical = await this.dependencies.canonicalPackages.verify({
      artifactId: value.canonicalPackageArtifactId,
      taskId: value.taskId,
      planVersionId: value.planVersionId,
      attemptId: value.attemptId,
      reportPublicationId: value.reportPublicationId,
    });
    if (
      canonical.artifact.contentSha256 !== value.canonicalPackageContentSha256
      || canonical.value.reportPublicationId !== value.reportPublicationId
    ) {
      throw new Error('Report Package v3 canonical package identity is invalid');
    }

    if (value.showcase.status === 'ready') {
      const deliverable = await this.dependencies.artifacts.readVerifiedBoundJson<unknown>(
        canonical.value.deliverableArtifactId,
      );
      assertBoundArtifact({
        artifact: deliverable.artifact,
        artifactId: canonical.value.deliverableArtifactId,
        kind: 'deliverable',
        binding,
        schemaVersions: ['research-deliverable-v1-review-gated'],
      });
      const evidenceManifest = await this.dependencies.artifacts.readVerifiedBoundJson<EvidenceManifest>(
        canonical.value.evidenceManifestArtifactId,
      );
      assertBoundArtifact({
        artifact: evidenceManifest.artifact,
        artifactId: canonical.value.evidenceManifestArtifactId,
        kind: 'evidence_manifest',
        binding,
        schemaVersions: ['evidence-v1'],
      });
      if (
        !evidenceManifest.artifact.contentSha256
        || typeof evidenceManifest.value.manifestHash !== 'string'
        || evidenceManifest.value.taskId !== binding.taskId
        || evidenceManifest.value.planVersionId !== binding.planVersionId
        || evidenceManifest.value.attemptId !== binding.attemptId
      ) {
        throw new Error('Report Package v3 Evidence Manifest identity is incomplete');
      }
      const spec = await this.dependencies.artifacts.readVerifiedBoundJson<unknown>(
        value.showcase.specArtifactId,
      );
      assertBoundArtifact({
        artifact: spec.artifact,
        artifactId: value.showcase.specArtifactId,
        kind: 'report_editorial_showcase_spec',
        binding,
        schemaVersions: ['editorial-presentation-spec-v1'],
      });
      this.validator.validateFileOrThrow(
        'schemas/editorial-presentation-spec-v1.schema.json',
        spec.value,
      );
      const specValue = spec.value as EditorialPresentationSpecV1;
      if (
        specValue.binding.taskId !== binding.taskId
        || specValue.binding.planVersionId !== binding.planVersionId
        || specValue.binding.attemptId !== binding.attemptId
        || specValue.binding.deliverableArtifactId !== canonical.value.deliverableArtifactId
        || specValue.binding.deliverableContentSha256 !== deliverable.artifact.contentSha256
        || specValue.binding.reportReviewArtifactId !== canonical.value.reportReviewArtifactId
        || specValue.binding.evidenceManifestArtifactId !== canonical.value.evidenceManifestArtifactId
        || specValue.binding.evidenceManifestContentSha256 !== evidenceManifest.artifact.contentSha256
        || specValue.binding.evidenceManifestHash !== evidenceManifest.value.manifestHash
        || specValue.profileId !== value.showcase.profileId
        || specValue.generationMode !== value.showcase.generationMode
        || specValue.showcaseOutlineSignature !== value.showcase.showcaseOutlineSignature
      ) {
        throw new Error('Report Package v3 Showcase Spec identity is invalid');
      }

      const html = await this.dependencies.artifacts.readVerifiedBoundText(value.showcase.htmlArtifactId);
      assertBoundArtifact({
        artifact: html.artifact,
        artifactId: value.showcase.htmlArtifactId,
        kind: 'editorial_showcase_html',
        binding,
        schemaVersions: ['editorial-showcase-html-v1'],
        mediaType: 'text/html; charset=utf-8',
      });
      const requiredBindings = [
        `<meta name="showcase-profile" content="${value.showcase.profileId}">`,
        `<meta name="showcase-outline-signature" content="${value.showcase.showcaseOutlineSignature}">`,
        `<meta name="showcase-renderer-version" content="${value.showcase.rendererVersion}">`,
        `<meta name="showcase-spec-sha256" content="${spec.artifact.contentSha256}">`,
        `<meta name="source-deliverable-sha256" content="${deliverable.artifact.contentSha256}">`,
        `<meta name="source-evidence-manifest-id" content="${canonical.value.evidenceManifestArtifactId}">`,
        `<meta name="source-evidence-manifest-sha256" content="${evidenceManifest.artifact.contentSha256}">`,
        `<meta name="source-evidence-manifest-hash" content="${evidenceManifest.value.manifestHash}">`,
      ];
      if (html.content.length === 0 || requiredBindings.some((marker) => !html.content.includes(marker))) {
        throw new Error('Report Package v3 Showcase HTML identity is invalid');
      }
    }

    return { artifact: root.artifact, value };
  }
}

export class ReportPackageV3ArtifactService extends ReportPackageV3ArtifactVerifier {
  constructor(private readonly writable: {
    artifacts: ReportPackageV3ArtifactStore;
    canonicalPackages: Pick<ReportPackageV2ArtifactVerifier, 'verify'>;
    validator?: Pick<SchemaValidator, 'validateFileOrThrow'>;
  }) {
    super(writable);
  }

  async seal(input: ReportPackageV3SealInput): Promise<ControlArtifact> {
    const value = parseReportPackageV3({
      version: REPORT_PACKAGE_V3_VERSION,
      taskId: input.activeLease.taskId,
      planVersionId: input.activeLease.planVersionId,
      attemptId: input.activeLease.attemptId,
      reportPublicationId: input.reportPublicationId,
      canonicalPackageArtifactId: input.canonicalPackageArtifactId,
      canonicalPackageContentSha256: input.canonicalPackageContentSha256,
      preferredHtml: input.preferredHtml,
      showcase: input.showcase,
    });
    const artifact = await this.writable.artifacts.writeJson({
      taskId: value.taskId,
      planVersionId: value.planVersionId,
      attemptId: value.attemptId,
      kind: 'report_package',
      relativePath: 'reports/report-package-v3.json',
      schemaVersion: REPORT_PACKAGE_V3_VERSION,
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
