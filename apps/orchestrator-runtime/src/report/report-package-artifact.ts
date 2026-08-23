import type {
  ControlArtifact,
  ControlExecutionLease,
} from '../../../../database/control-plane.ts';
import type { ControlArtifactStore } from '../control/artifact-store.ts';
import { SchemaValidator } from '../schema/validator.ts';

export const REPORT_PACKAGE_SCHEMA_VERSION = 'report-package-v1';
const PACKAGE_COMPONENT_VALIDATOR = new SchemaValidator();

export interface ReportPackageArtifactValue {
  version: typeof REPORT_PACKAGE_SCHEMA_VERSION;
  taskId: string;
  planVersionId: string;
  attemptId: string;
  presentationMode: 'legacy_text' | 'current_text' | 'multimodal';
  deliverableArtifactId: string;
  evidenceManifestArtifactId: string;
  reportReviewArtifactId?: string;
  reportDocumentArtifactId?: string;
  reportLayoutBlueprintArtifactId?: string;
  reportLayoutDiagnosticArtifactId?: string;
}

type ReportPackageArtifactStore = Pick<
  ControlArtifactStore,
  'writeJson' | 'readVerifiedBoundJson'
>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonBlank(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Report Package ${field} is invalid`);
  }
  return value;
}

export function parseReportPackageArtifactValue(value: unknown): ReportPackageArtifactValue {
  const candidate = record(value);
  if (!candidate || candidate.version !== REPORT_PACKAGE_SCHEMA_VERSION) {
    throw new Error('Report Package value is invalid');
  }
  const presentationMode = candidate.presentationMode;
  if (
    presentationMode !== 'legacy_text'
    && presentationMode !== 'current_text'
    && presentationMode !== 'multimodal'
  ) {
    throw new Error('Report Package presentationMode is invalid');
  }
  const parsed: ReportPackageArtifactValue = {
    version: REPORT_PACKAGE_SCHEMA_VERSION,
    taskId: nonBlank(candidate.taskId, 'taskId'),
    planVersionId: nonBlank(candidate.planVersionId, 'planVersionId'),
    attemptId: nonBlank(candidate.attemptId, 'attemptId'),
    presentationMode,
    deliverableArtifactId: nonBlank(candidate.deliverableArtifactId, 'deliverableArtifactId'),
    evidenceManifestArtifactId: nonBlank(
      candidate.evidenceManifestArtifactId,
      'evidenceManifestArtifactId',
    ),
    ...(candidate.reportReviewArtifactId === undefined
      ? {}
      : { reportReviewArtifactId: nonBlank(candidate.reportReviewArtifactId, 'reportReviewArtifactId') }),
    ...(candidate.reportDocumentArtifactId === undefined
      ? {}
      : { reportDocumentArtifactId: nonBlank(candidate.reportDocumentArtifactId, 'reportDocumentArtifactId') }),
    ...(candidate.reportLayoutBlueprintArtifactId === undefined
      ? {}
      : { reportLayoutBlueprintArtifactId: nonBlank(candidate.reportLayoutBlueprintArtifactId, 'reportLayoutBlueprintArtifactId') }),
    ...(candidate.reportLayoutDiagnosticArtifactId === undefined
      ? {}
      : { reportLayoutDiagnosticArtifactId: nonBlank(candidate.reportLayoutDiagnosticArtifactId, 'reportLayoutDiagnosticArtifactId') }),
  };
  if (presentationMode === 'legacy_text' && (
    parsed.reportReviewArtifactId !== undefined
    || parsed.reportDocumentArtifactId !== undefined
    || parsed.reportLayoutBlueprintArtifactId !== undefined
    || parsed.reportLayoutDiagnosticArtifactId !== undefined
  )) {
    throw new Error('legacy Report Package must not reference review-gated components');
  }
  if (presentationMode === 'current_text' && (
    parsed.reportReviewArtifactId === undefined
    || parsed.reportDocumentArtifactId !== undefined
  )) {
    throw new Error('current text Report Package component set is invalid');
  }
  if (presentationMode === 'multimodal' && (
    parsed.reportReviewArtifactId === undefined
    || parsed.reportDocumentArtifactId === undefined
  )) {
    throw new Error('multimodal Report Package component set is invalid');
  }
  if (
    (parsed.reportLayoutBlueprintArtifactId !== undefined || parsed.reportLayoutDiagnosticArtifactId !== undefined)
    && parsed.reportDocumentArtifactId === undefined
  ) {
    throw new Error('Report Package cannot reference layout artifacts without a ReportDocument');
  }
  return parsed;
}

function assertBoundArtifact(input: {
  artifact: ControlArtifact;
  artifactId: string;
  kind: string;
  binding: Pick<ReportPackageArtifactValue, 'taskId' | 'planVersionId' | 'attemptId'>;
}): void {
  const { artifact, artifactId, kind, binding } = input;
  if (
    artifact.id !== artifactId
    || artifact.state !== 'SEALED'
    || artifact.contentSha256 === null
    || artifact.kind !== kind
    || artifact.taskId !== binding.taskId
    || artifact.planVersionId !== binding.planVersionId
    || artifact.attemptId !== binding.attemptId
  ) {
    throw new Error(`Report Package ${kind} Artifact binding is invalid`);
  }
}

export class ReportPackageArtifactService {
  constructor(private readonly artifacts: ReportPackageArtifactStore) {}

  async seal(input: {
    activeLease: ControlExecutionLease;
    presentationMode: ReportPackageArtifactValue['presentationMode'];
    deliverableArtifactId: string;
    evidenceManifestArtifactId: string;
    reportReviewArtifactId?: string;
    reportDocumentArtifactId?: string;
    reportLayoutBlueprintArtifactId?: string;
    reportLayoutDiagnosticArtifactId?: string;
  }): Promise<ControlArtifact> {
    const value = parseReportPackageArtifactValue({
      version: REPORT_PACKAGE_SCHEMA_VERSION,
      taskId: input.activeLease.taskId,
      planVersionId: input.activeLease.planVersionId,
      attemptId: input.activeLease.attemptId,
      presentationMode: input.presentationMode,
      deliverableArtifactId: input.deliverableArtifactId,
      evidenceManifestArtifactId: input.evidenceManifestArtifactId,
      ...(input.reportReviewArtifactId === undefined
        ? {}
        : { reportReviewArtifactId: input.reportReviewArtifactId }),
      ...(input.reportDocumentArtifactId === undefined
        ? {}
        : { reportDocumentArtifactId: input.reportDocumentArtifactId }),
      ...(input.reportLayoutBlueprintArtifactId === undefined
        ? {}
        : { reportLayoutBlueprintArtifactId: input.reportLayoutBlueprintArtifactId }),
      ...(input.reportLayoutDiagnosticArtifactId === undefined
        ? {}
        : { reportLayoutDiagnosticArtifactId: input.reportLayoutDiagnosticArtifactId }),
    });
    const artifact = await this.artifacts.writeJson({
      taskId: input.activeLease.taskId,
      planVersionId: input.activeLease.planVersionId,
      attemptId: input.activeLease.attemptId,
      kind: 'report_package',
      relativePath: 'reports/report-package.json',
      schemaVersion: REPORT_PACKAGE_SCHEMA_VERSION,
      activeLease: input.activeLease,
      value,
    });
    await this.verify({ artifactId: artifact.id, attemptId: input.activeLease.attemptId });
    return artifact;
  }

  async verify(input: {
    artifactId: string;
    attemptId: string;
  }): Promise<{ artifact: ControlArtifact; value: ReportPackageArtifactValue }> {
    const verified = await this.artifacts.readVerifiedBoundJson<unknown>(input.artifactId);
    const value = parseReportPackageArtifactValue(verified.value);
    assertBoundArtifact({
      artifact: verified.artifact,
      artifactId: input.artifactId,
      kind: 'report_package',
      binding: value,
    });
    if (
      verified.artifact.schemaVersion !== REPORT_PACKAGE_SCHEMA_VERSION
      || value.attemptId !== input.attemptId
    ) {
      throw new Error('Report Package Artifact identity is invalid');
    }

    const components = [
      { artifactId: value.deliverableArtifactId, kind: 'deliverable' },
      { artifactId: value.evidenceManifestArtifactId, kind: 'evidence_manifest' },
      ...(value.reportReviewArtifactId === undefined
        ? []
        : [{ artifactId: value.reportReviewArtifactId, kind: 'report_review' }]),
      ...(value.reportDocumentArtifactId === undefined
        ? []
        : [{ artifactId: value.reportDocumentArtifactId, kind: 'report_document' }]),
      ...(value.reportLayoutBlueprintArtifactId === undefined
        ? []
        : [{ artifactId: value.reportLayoutBlueprintArtifactId, kind: 'report_layout_blueprint' }]),
      ...(value.reportLayoutDiagnosticArtifactId === undefined
        ? []
        : [{ artifactId: value.reportLayoutDiagnosticArtifactId, kind: 'deliverable_validation_diagnostic' }]),
    ];
    const verifiedComponents = await Promise.all(
      components.map(({ artifactId }) => this.artifacts.readVerifiedBoundJson<unknown>(artifactId)),
    );
    verifiedComponents.forEach((component, index) => {
      const expected = components[index]!;
      assertBoundArtifact({
        artifact: component.artifact,
        artifactId: expected.artifactId,
        kind: expected.kind,
        binding: value,
      });
      if (expected.kind === 'report_layout_blueprint') {
        if (component.artifact.schemaVersion !== 'report-layout-blueprint-v1') {
          throw new Error('Report Package layout Blueprint schema version is invalid');
        }
        PACKAGE_COMPONENT_VALIDATOR.validateFileOrThrow(
          'schemas/report-layout-blueprint.schema.json',
          component.value,
        );
      }
      if (expected.kind === 'deliverable_validation_diagnostic') {
        if (component.artifact.schemaVersion !== 'deliverable-validation-diagnostic-v1') {
          throw new Error('Report Package layout diagnostic schema version is invalid');
        }
        PACKAGE_COMPONENT_VALIDATOR.validateFileOrThrow(
          'schemas/deliverable-validation-diagnostic.schema.json',
          component.value,
        );
      }
    });
    return { artifact: verified.artifact, value };
  }
}
