import type { ControlArtifact, ControlExecutionLease } from '../../../../database/control-plane.ts';
import type { EditorialPresentationSpecV1 } from '../../../../packages/api-contract/report-editorial-showcase.ts';
import type { ReportEditorialMaterialV1 } from '../../../../packages/api-contract/report-editorial.ts';
import type { ReportPackageShowcaseV3 } from '../../../../packages/api-contract/report-package.ts';
import type { EvidenceManifest } from '../../../../packages/api-contract/research-deliverable.ts';
import type { ControlArtifactStore } from '../control/artifact-store.ts';
import { ArtifactPublicationGroup } from '../control/artifact-publication-group.ts';
import { SchemaValidator } from '../schema/validator.ts';
import { bindEditorialShowcaseEvidenceManifest } from './report-editorial-showcase-compiler.ts';
import {
  EDITORIAL_SHOWCASE_RENDERER_VERSION,
  renderEditorialShowcase,
} from './report-editorial-showcase-renderer.ts';

const SPEC_SCHEMA_PATH = 'schemas/editorial-presentation-spec-v1.schema.json';
const MAX_SHOWCASE_HTML_BYTES = 2 * 1024 * 1024;

export type EditorialShowcasePublicationResult =
  | {
      specArtifact: ControlArtifact;
      htmlArtifact: ControlArtifact;
      showcase: Extract<ReportPackageShowcaseV3, { status: 'ready' }>;
    }
  | {
      showcase: Extract<ReportPackageShowcaseV3, { status: 'unavailable' }>;
    };

function sameBinding(
  value: { taskId: string; planVersionId: string; attemptId: string },
  lease: ControlExecutionLease,
): boolean {
  return value.taskId === lease.taskId
    && value.planVersionId === lease.planVersionId
    && value.attemptId === lease.attemptId;
}

function assertInputBinding(input: {
  activeLease: ControlExecutionLease;
  material: ReportEditorialMaterialV1;
  evidenceManifest: EvidenceManifest;
  evidenceManifestArtifact: ControlArtifact;
  spec: EditorialPresentationSpecV1;
}): void {
  if (!sameBinding(input.material.binding, input.activeLease)) {
    throw new Error('Showcase Material binding does not match Active Lease');
  }
  if (!sameBinding(input.evidenceManifest, input.activeLease)) {
    throw new Error('Showcase Evidence Manifest binding does not match Active Lease');
  }
  if (
    input.evidenceManifestArtifact.taskId !== input.activeLease.taskId
    || input.evidenceManifestArtifact.planVersionId !== input.activeLease.planVersionId
    || input.evidenceManifestArtifact.attemptId !== input.activeLease.attemptId
    || input.evidenceManifestArtifact.state !== 'SEALED'
    || input.evidenceManifestArtifact.kind !== 'evidence_manifest'
    || input.evidenceManifestArtifact.schemaVersion !== 'evidence-v1'
    || !input.evidenceManifestArtifact.contentSha256
  ) {
    throw new Error('Showcase Evidence Manifest Artifact binding is invalid');
  }
  if (!sameBinding(input.spec.binding, input.activeLease)) {
    throw new Error('Showcase Spec binding does not match Active Lease');
  }
  for (const key of [
    'taskId',
    'planVersionId',
    'attemptId',
    'deliverableArtifactId',
    'deliverableContentSha256',
    'reportReviewArtifactId',
  ] as const) {
    if (input.spec.binding[key] !== input.material.binding[key]) {
      throw new Error(`Showcase Spec ${key} does not match Material`);
    }
  }
}

function assertSealedArtifact(input: {
  artifact: ControlArtifact;
  lease: ControlExecutionLease;
  kind: string;
  schemaVersion: string;
  mediaType?: string;
}): void {
  const artifact = input.artifact;
  if (
    artifact.state !== 'SEALED'
    || artifact.taskId !== input.lease.taskId
    || artifact.planVersionId !== input.lease.planVersionId
    || artifact.attemptId !== input.lease.attemptId
    || artifact.kind !== input.kind
    || artifact.schemaVersion !== input.schemaVersion
    || !artifact.contentSha256
    || artifact.byteSize === null
    || (input.mediaType !== undefined && artifact.mediaType !== input.mediaType)
  ) {
    throw new Error(`Showcase ${input.kind} Artifact was not sealed with the active binding`);
  }
}

export class EditorialShowcasePublicationService {
  private readonly validator: Pick<SchemaValidator, 'validateFileOrThrow'>;

  constructor(private readonly dependencies: {
    artifacts: Pick<ControlArtifactStore, 'writeJson' | 'writeText' | 'invalidateArtifactPublication'>;
    validator?: Pick<SchemaValidator, 'validateFileOrThrow'>;
  }) {
    this.validator = dependencies.validator ?? new SchemaValidator();
  }

  async publish(input: {
    activeLease: ControlExecutionLease;
    material: ReportEditorialMaterialV1;
    evidenceManifest: EvidenceManifest;
    evidenceManifestArtifact: ControlArtifact;
    spec: EditorialPresentationSpecV1;
    onArtifactSealed?: (artifact: ControlArtifact) => void;
  }): Promise<EditorialShowcasePublicationResult> {
    assertInputBinding(input);
    const evidenceManifestContentSha256 = input.evidenceManifestArtifact.contentSha256;
    if (!evidenceManifestContentSha256) {
      throw new Error('Showcase Evidence Manifest Artifact has no sealed content hash');
    }
    const spec = bindEditorialShowcaseEvidenceManifest(input.spec, {
      artifactId: input.evidenceManifestArtifact.id,
      contentSha256: evidenceManifestContentSha256,
      manifestHash: input.evidenceManifest.manifestHash,
    });
    const publication = new ArtifactPublicationGroup(this.dependencies.artifacts);
    try {
      this.validator.validateFileOrThrow(SPEC_SCHEMA_PATH, spec);

      const specArtifact = await this.dependencies.artifacts.writeJson({
        taskId: input.activeLease.taskId,
        planVersionId: input.activeLease.planVersionId,
        attemptId: input.activeLease.attemptId,
        kind: 'report_editorial_showcase_spec',
        relativePath: 'reports/editorial-showcase-spec.json',
        value: spec,
        schemaVersion: spec.version,
        sensitivity: 'internal',
        redactionPolicyVersion: 'v1',
        activeLease: input.activeLease,
      });
      publication.track(specArtifact.id);
      assertSealedArtifact({
        artifact: specArtifact,
        lease: input.activeLease,
        kind: 'report_editorial_showcase_spec',
        schemaVersion: 'editorial-presentation-spec-v1',
      });
      const rendered = renderEditorialShowcase({
        spec,
        material: input.material,
        evidenceManifest: input.evidenceManifest,
        evidenceManifestArtifact: {
          id: input.evidenceManifestArtifact.id,
          contentSha256: evidenceManifestContentSha256,
        },
        sourceSpecContentSha256: specArtifact.contentSha256!,
      });

      const htmlArtifact = await this.dependencies.artifacts.writeText({
        taskId: input.activeLease.taskId,
        planVersionId: input.activeLease.planVersionId,
        attemptId: input.activeLease.attemptId,
        kind: 'editorial_showcase_html',
        relativePath: 'reports/editorial-showcase.html',
        schemaVersion: 'editorial-showcase-html-v1',
        sensitivity: 'internal',
        redactionPolicyVersion: 'v1',
        activeLease: input.activeLease,
        content: rendered.html,
        mediaType: 'text/html; charset=utf-8',
        maxByteSize: MAX_SHOWCASE_HTML_BYTES,
      });
      publication.track(htmlArtifact.id);
      assertSealedArtifact({
        artifact: htmlArtifact,
        lease: input.activeLease,
        kind: 'editorial_showcase_html',
        schemaVersion: 'editorial-showcase-html-v1',
        mediaType: 'text/html; charset=utf-8',
      });
      publication.commit();
      input.onArtifactSealed?.(specArtifact);
      input.onArtifactSealed?.(htmlArtifact);

      return {
        specArtifact,
        htmlArtifact,
        showcase: {
          status: 'ready',
          specArtifactId: specArtifact.id,
          htmlArtifactId: htmlArtifact.id,
          rendererVersion: EDITORIAL_SHOWCASE_RENDERER_VERSION,
          profileId: spec.profileId,
          generationMode: spec.generationMode,
          showcaseOutlineSignature: spec.showcaseOutlineSignature,
        },
      };
    } catch {
      await publication.compensate('Editorial Showcase publication did not complete');
      return {
        showcase: {
          status: 'unavailable',
          reasonCode: 'showcase_renderer_failure',
        },
      };
    }
  }
}
