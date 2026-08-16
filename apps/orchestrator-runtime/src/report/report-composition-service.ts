import type {
  ControlArtifact,
  ControlExecutionLease,
} from '../../../../database/control-plane.ts';
import type { PassedReportReviewArtifact } from '../../../../packages/api-contract/control-workflow.ts';
import type {
  EvidenceManifest,
  ResearchDeliverableEnvelope,
  ResearchPlanPayload,
} from '../../../../packages/api-contract/research-deliverable.ts';
import type { ControlArtifactStore } from '../control/artifact-store.ts';
import type { EvidenceArtifactResolver } from '../evidence/evidence-service.ts';
import {
  composeReportDocument,
  type ReportDocument,
  type VerifiedChart,
} from './report-document-composer.ts';
import type {
  VerifiedVisualAsset,
  VisualAssetService,
} from './visual-asset-service.ts';

interface VerifiedArtifactValue<T> {
  artifact: ControlArtifact;
  value: T;
}

export interface ReportCompositionInput {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  requiredQuestionIds: string[];
  deliverable: VerifiedArtifactValue<ResearchDeliverableEnvelope<ResearchPlanPayload>>;
  evidenceManifest: VerifiedArtifactValue<EvidenceManifest>;
  evidenceArtifactResolver: EvidenceArtifactResolver;
  review: VerifiedArtifactValue<PassedReportReviewArtifact>;
  visualAssets: VerifiedVisualAsset[];
  charts: VerifiedChart[];
  activeLease: ControlExecutionLease;
}

export interface ReportCompositionResult {
  artifact: ControlArtifact;
  document: ReportDocument;
}

export interface ReportCompositionPort {
  composeAndStore(input: ReportCompositionInput): Promise<ReportCompositionResult>;
}

export class ReportCompositionService implements ReportCompositionPort {
  constructor(private readonly dependencies: {
    artifacts: Pick<ControlArtifactStore, 'writeJson'>;
    visualAssets: Pick<VisualAssetService, 'readVerified'>;
  }) {}

  async composeAndStore(input: ReportCompositionInput): Promise<ReportCompositionResult> {
    if (
      input.activeLease.taskId !== input.taskId
      || input.activeLease.planVersionId !== input.planVersionId
      || input.activeLease.attemptId !== input.attemptId
    ) {
      throw new Error('ReportDocument composition lease identity does not match the report binding');
    }
    const visualAssets = await Promise.all(input.visualAssets.map((asset) =>
      this.dependencies.visualAssets.readVerified({
        assetId: asset.artifact.id,
        manifestArtifactId: asset.manifestArtifact.id,
      })));
    const charts = await Promise.all(input.charts.map(async (chart) => ({
      ...chart,
      asset: await this.dependencies.visualAssets.readVerified({
        assetId: chart.asset.artifact.id,
        manifestArtifactId: chart.asset.manifestArtifact.id,
      }),
    })));
    const document = composeReportDocument({
      templateId: 'research-plan',
      requiredQuestionIds: input.requiredQuestionIds,
      deliverable: input.deliverable,
      evidenceManifest: input.evidenceManifest,
      evidenceArtifactResolver: input.evidenceArtifactResolver,
      review: input.review,
      visualAssets,
      charts,
    });
    const artifact = await this.dependencies.artifacts.writeJson({
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      attemptId: input.attemptId,
      kind: 'report_document',
      relativePath: 'reports/report-document.json',
      value: document,
      schemaVersion: 'report-document-v1',
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
      || artifact.schemaVersion !== 'report-document-v1'
    ) {
      throw new Error('ReportDocument Artifact was not sealed with the active report binding');
    }
    return { artifact, document };
  }
}
