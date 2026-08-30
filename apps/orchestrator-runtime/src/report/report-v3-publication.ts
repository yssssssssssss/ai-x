import { createHash } from 'node:crypto';
import {
  ControlPlaneConflictError,
  type ControlArtifact,
  type ControlExecutionLease,
} from '../../../../database/control-plane.ts';
import type {
  ReportDocumentV3,
  ReportDocumentV4,
} from '../../../../packages/api-contract/report-document.ts';
import type {
  HtmlUnavailableReasonCode,
  ReportPackageStandaloneHtmlV2,
} from '../../../../packages/api-contract/report-package.ts';
import {
  ArtifactIntegrityError,
  type ControlArtifactStore,
} from '../control/artifact-store.ts';
import { ArtifactInvalidationError } from '../control/artifact-publication-group.ts';
import {
  renderStandaloneReport,
  STANDALONE_HTML_RENDERER_VERSION,
  STANDALONE_HTML_V4_RENDERER_VERSION,
} from './standalone-html-report-renderer.ts';

export const REPORT_V3_PUBLICATION_BUILDER_VERSION = 'report-v3-publication-v1';
const MAX_STANDALONE_HTML_BYTES = 2 * 1024 * 1024;

type StandaloneHtmlWriter = Pick<ControlArtifactStore, 'writeText'>;

export interface ReportPublicationIdentityInput {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  deliverableContentSha256: string;
  reportReviewContentSha256: string;
  reportDocumentVersion: 'report-document-v3' | 'report-document-v4';
  builderVersion?: string;
}

export type StandaloneHtmlPublicationResult =
  | {
      standaloneHtml: Extract<ReportPackageStandaloneHtmlV2, { status: 'ready' }>;
      artifact: ControlArtifact;
    }
  | {
      standaloneHtml: Extract<ReportPackageStandaloneHtmlV2, { status: 'unavailable' }>;
    };

function requireSha256(value: string, label: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a sealed SHA-256 hash`);
  }
}

export function createReportPublicationId(input: ReportPublicationIdentityInput): string {
  requireSha256(input.deliverableContentSha256, 'Report Publication Deliverable hash');
  requireSha256(input.reportReviewContentSha256, 'Report Publication Review hash');
  const identity = [
    input.taskId,
    input.planVersionId,
    input.attemptId,
    input.deliverableContentSha256,
    input.reportReviewContentSha256,
    input.reportDocumentVersion,
    input.builderVersion ?? REPORT_V3_PUBLICATION_BUILDER_VERSION,
  ];
  if (identity.some((value) => !value.trim())) {
    throw new Error('Report Publication identity contains a blank value');
  }
  return `report-publication-v1:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

function assertDocumentArtifact(input: {
  activeLease: ControlExecutionLease;
  artifact: ControlArtifact;
  document: ReportDocumentV3 | ReportDocumentV4;
}): asserts input is typeof input & { artifact: ControlArtifact & { contentSha256: string } } {
  const { activeLease, artifact, document } = input;
  if (
    (document.version !== 'report-document-v3' && document.version !== 'report-document-v4')
    || artifact.state !== 'SEALED'
    || artifact.kind !== 'report_document'
    || artifact.schemaVersion !== document.version
    || artifact.taskId !== activeLease.taskId
    || artifact.planVersionId !== activeLease.planVersionId
    || artifact.attemptId !== activeLease.attemptId
    || artifact.contentSha256 === null
    || artifact.byteSize === null
  ) {
    throw new Error('Standalone HTML requires a sealed bound ReportDocument v3 or v4 Artifact');
  }
}

function unavailable(reasonCode: HtmlUnavailableReasonCode): StandaloneHtmlPublicationResult {
  return { standaloneHtml: { status: 'unavailable', reasonCode } };
}

function renderFailureReason(error: unknown): HtmlUnavailableReasonCode {
  const message = error instanceof Error ? error.message : String(error);
  if (/exceeds \d+ bytes|size limit|byte size/iu.test(message)) return 'size_limit_exceeded';
  if (/Render Manifest|semantically equivalent/iu.test(message)) return 'render_manifest_mismatch';
  if (/unsafe|bundle path|executable|external content/iu.test(message)) return 'unsafe_output';
  return 'unsupported_block';
}

function rethrowLeaseLoss(error: unknown): void {
  if (
    error instanceof ControlPlaneConflictError
    || error instanceof ArtifactIntegrityError
    || error instanceof ArtifactInvalidationError
  ) throw error;
}

export async function renderAndSealStandaloneHtml(input: {
  artifacts: StandaloneHtmlWriter;
  activeLease: ControlExecutionLease;
  reportDocumentArtifact: ControlArtifact;
  document: ReportDocumentV3 | ReportDocumentV4;
  assetPathById?: ReadonlyMap<string, string>;
  onArtifactSealed?: (artifact: ControlArtifact) => void;
}): Promise<StandaloneHtmlPublicationResult> {
  const source = {
    activeLease: input.activeLease,
    artifact: input.reportDocumentArtifact,
    document: input.document,
  };
  assertDocumentArtifact(source);

  let html: string;
  try {
    html = renderStandaloneReport({
      document: input.document,
      sourceReportDocumentContentSha256: source.artifact.contentSha256,
      ...(input.assetPathById ? { assetPathById: input.assetPathById } : {}),
    }).html;
  } catch (error) {
    rethrowLeaseLoss(error);
    return unavailable(renderFailureReason(error));
  }

  try {
    const artifact = await input.artifacts.writeText({
      taskId: input.activeLease.taskId,
      planVersionId: input.activeLease.planVersionId,
      attemptId: input.activeLease.attemptId,
      kind: 'standalone_html_report',
      relativePath: 'reports/report.html',
      schemaVersion: 'standalone-html-report-v1',
      sensitivity: 'internal',
      redactionPolicyVersion: 'v1',
      activeLease: input.activeLease,
      content: html,
      mediaType: 'text/html; charset=utf-8',
      maxByteSize: MAX_STANDALONE_HTML_BYTES,
    });
    if (
      artifact.state !== 'SEALED'
      || artifact.kind !== 'standalone_html_report'
      || artifact.schemaVersion !== 'standalone-html-report-v1'
      || artifact.taskId !== input.activeLease.taskId
      || artifact.planVersionId !== input.activeLease.planVersionId
      || artifact.attemptId !== input.activeLease.attemptId
      || artifact.contentSha256 === null
      || artifact.byteSize === null
      || artifact.mediaType !== 'text/html; charset=utf-8'
    ) {
      throw new ArtifactIntegrityError(
        artifact.id,
        'Standalone HTML Artifact was not sealed with the active report binding',
      );
    }
    input.onArtifactSealed?.(artifact);
    return {
      artifact,
      standaloneHtml: {
        status: 'ready',
        artifactId: artifact.id,
        rendererVersion: input.document.version === 'report-document-v4'
          ? STANDALONE_HTML_V4_RENDERER_VERSION
          : STANDALONE_HTML_RENDERER_VERSION,
      },
    };
  } catch (error) {
    rethrowLeaseLoss(error);
    return unavailable(/size|byte/iu.test(error instanceof Error ? error.message : String(error))
      ? 'size_limit_exceeded'
      : 'artifact_write_failed');
  }
}
