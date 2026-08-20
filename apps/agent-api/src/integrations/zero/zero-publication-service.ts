import { createHash, randomUUID } from 'node:crypto';
import type {
  ControlPlaneRepository,
  ControlZeroPublication,
} from '../../../../../database/control-plane.ts';
import type {
  CurrentReportPackageResponse,
} from '../../../../../packages/api-contract/control-workflow.ts';
import type {
  VisualAssetReference,
} from '../../../../../packages/api-contract/research-deliverable.ts';
import type { CurrentReportPackageReader } from '../../../../orchestrator-runtime/src/report/current-report-package-reader.ts';
import type { ReportBlock } from '../../../../orchestrator-runtime/src/report/report-document-composer.ts';
import type { VerifiedVisualAsset } from '../../../../orchestrator-runtime/src/report/visual-asset-service.ts';
import type {
  ZeroIntegrationStatusResponse,
  ZeroPublicationFailure,
  ZeroPublicationStage,
} from '../../../../../packages/api-contract/zero-publication.ts';
import {
  ZeroMcpClientError,
  type LocalZeroMcpClient,
  type ZeroNodeInspection,
  type ZeroScreenshot,
} from './zero-mcp-client.ts';
import {
  renderZeroReport,
  ZERO_REPORT_TEMPLATE_VERSION,
  type ZeroVisualRole,
} from './zero-report-renderer.ts';
import {
  transcodeZeroImages,
  type ZeroVisualInput,
} from './zero-image-transcoder.ts';

const LEASE_MS = 60_000;

export class ZeroPublicationServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ZeroPublicationServiceError';
  }
}

export type ZeroPublicationStore = Pick<
  ControlPlaneRepository,
  | 'getTaskDetail'
  | 'findSealedArtifact'
  | 'createZeroPublication'
  | 'getZeroPublicationByIdForOwner'
  | 'getZeroPublicationForOwner'
  | 'claimZeroPublication'
  | 'heartbeatZeroPublication'
  | 'updateZeroPublication'
  | 'completeZeroPublication'
  | 'failZeroPublication'
  | 'listExpiredZeroPublications'
>;

export interface ZeroPublicationArtifacts {
  writeJson(input: {
    taskId: string;
    planVersionId: string;
    attemptId: string;
    kind: string;
    relativePath: string;
    value: unknown;
    schemaVersion: string;
    sensitivity: string;
    redactionPolicyVersion: string;
  }): Promise<{ id: string; state: string; contentSha256: string | null }>;
  writeBinary(input: {
    taskId: string;
    planVersionId: string;
    attemptId: string;
    kind: string;
    relativePath: string;
    bytes: Uint8Array;
    schemaVersion: string;
    sensitivity: string;
    redactionPolicyVersion: string;
  }): Promise<{ id: string; state: string; contentSha256: string | null }>;
}

export interface ZeroPublicationMcp extends Pick<
  LocalZeroMcpClient,
  | 'getStatus'
  | 'getCurrentTarget'
  | 'createHtmlDraft'
  | 'writeImage'
  | 'inspectNode'
  | 'getDesignMetadata'
  | 'captureScreenshot'
  | 'finalizeDraft'
  | 'cleanupDraft'
> {}

interface ReportPackagePort {
  read(input: {
    taskId: string;
    planVersionId: string;
    attemptId: string;
  }): Promise<CurrentReportPackageResponse | null>;
}

interface VisualAssetPort {
  (input: { assetId: string; manifestArtifactId: string }): Promise<Pick<
    VerifiedVisualAsset,
    'artifact' | 'manifestArtifact' | 'manifest' | 'bytes' | 'metadata'
  >>;
}

interface ServiceDependencies {
  store: ZeroPublicationStore;
  artifacts: ZeroPublicationArtifacts;
  zero: ZeroPublicationMcp;
  reportPackages: ReportPackagePort;
  readVisualAsset: VisualAssetPort;
  leaseOwner?: string;
  now?: () => Date;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
}

function hash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')}`;
}

function failure(error: unknown): ZeroPublicationFailure {
  if (error instanceof ZeroPublicationServiceError || error instanceof ZeroMcpClientError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: 'zero_publication_failed',
    message: error instanceof Error ? error.message : 'Zero publication failed',
    retryable: false,
  };
}

function xmlEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function metadataNodes(xml: string): Map<string, { id: string; width?: number; height?: number }> {
  const nodes = new Map<string, { id: string; width?: number; height?: number }>();
  for (const match of xml.matchAll(/<[^>]+\sid="([^"]+)"[^>]*>/gu)) {
    const tag = match[0];
    const name = tag.match(/\sname="([^"]*)"/u)?.[1];
    if (!name) continue;
    const width = Number(tag.match(/\swidth="([0-9.]+)"/u)?.[1]);
    const height = Number(tag.match(/\sheight="([0-9.]+)"/u)?.[1]);
    nodes.set(xmlEntities(name), {
      id: match[1]!,
      ...(Number.isFinite(width) ? { width } : {}),
      ...(Number.isFinite(height) ? { height } : {}),
    });
  }
  return nodes;
}

function blockVisuals(
  block: ReportBlock,
): Array<{ ref: VisualAssetReference; role: ZeroVisualRole; pairKey?: string; key: string }> {
  if (block.type === 'image') {
    return [{ ref: block.assetRef, role: 'image', key: `${block.id}:image` }];
  }
  if (block.type === 'image-comparison') {
    return [{
      ref: block.beforeAssetRef,
      role: 'image_original',
      pairKey: block.id,
      key: `${block.id}:original`,
    }, {
      ref: block.afterAssetRef,
      role: 'image_annotation',
      pairKey: block.id,
      key: `${block.id}:annotation`,
    }];
  }
  if (block.type === 'chart') {
    return [{ ref: block.chartRef, role: 'chart', key: `${block.id}:chart` }];
  }
  return [];
}

function visualLabel(block: ReportBlock, role: ZeroVisualRole): string {
  if (block.type === 'chart' || block.type === 'image') return block.caption;
  if (block.type === 'image-comparison') {
    return role === 'image_original'
      ? `${block.caption} · 原图`
      : `${block.caption} · 标注图`;
  }
  return block.id;
}

function assertMultimodal(
  report: CurrentReportPackageResponse | null,
): asserts report is Extract<CurrentReportPackageResponse, { presentationMode: 'multimodal' }> {
  if (!report || report.presentationMode !== 'multimodal') {
    throw new ZeroPublicationServiceError(
      'report_package_invalid',
      'Zero publication requires a multimodal Report Package',
    );
  }
}

export class ZeroPublicationService {
  private readonly leaseOwner: string;
  private readonly now: () => Date;

  constructor(private readonly dependencies: ServiceDependencies) {
    this.leaseOwner = dependencies.leaseOwner ?? `zero-publication-${process.pid}`;
    this.now = dependencies.now ?? (() => new Date());
  }

  async status(): Promise<ZeroIntegrationStatusResponse> {
    try {
      const status = await this.dependencies.zero.getStatus();
      if (!status.authenticated) {
        return {
          available: true,
          authenticated: false,
          ...(status.version ? { version: status.version } : {}),
          reason: 'unauthenticated',
        };
      }
      try {
        const target = await this.dependencies.zero.getCurrentTarget();
        return {
          available: true,
          authenticated: true,
          ...(status.version ? { version: status.version } : {}),
          currentFileKey: target.fileKey,
          currentPageId: target.pageId,
          currentPageName: target.pageName,
        };
      } catch (error) {
        if (error instanceof ZeroMcpClientError && error.code === 'zero_no_design_tab') {
          return {
            available: true,
            authenticated: true,
            ...(status.version ? { version: status.version } : {}),
            reason: 'no_design_tab',
          };
        }
        throw error;
      }
    } catch {
      return { available: false, authenticated: false, reason: 'offline' };
    }
  }

  async create(input: {
    taskId: string;
    ownerUserId: string;
    expectedTaskState: 'completed' | 'completed_with_gaps';
    idempotencyKey: string;
    updatePublicationId?: string;
  }): Promise<ControlZeroPublication> {
    const task = await this.dependencies.store.getTaskDetail(input.taskId);
    if (
      !task
      || task.ownerUserId !== input.ownerUserId
      || task.conversationOwnerUserId !== input.ownerUserId
    ) {
      throw new ZeroPublicationServiceError('task_not_found', 'Task does not exist');
    }
    if (
      task.state !== input.expectedTaskState
      || !task.activePlanVersionId
      || !task.currentAttemptId
    ) {
      throw new ZeroPublicationServiceError('report_not_completed', 'Task is not in the expected completed state');
    }
    const status = await this.dependencies.zero.getStatus();
    if (!status.available) throw new ZeroPublicationServiceError('zero_offline', 'Zero is offline', true);
    if (!status.authenticated) {
      throw new ZeroPublicationServiceError('zero_unauthenticated', 'Zero is not authenticated');
    }
    const target = await this.dependencies.zero.getCurrentTarget();
    const reportPackage = await this.dependencies.store.findSealedArtifact({
      taskId: task.id,
      attemptId: task.currentAttemptId,
      kind: 'report_package',
    });
    if (
      !reportPackage
      || reportPackage.planVersionId !== task.activePlanVersionId
      || !reportPackage.contentSha256
      || reportPackage.schemaVersion !== 'report-package-v1'
    ) {
      throw new ZeroPublicationServiceError('report_package_missing', 'Verified Report Package is unavailable');
    }
    const requestHash = hash({
      taskId: task.id,
      ownerUserId: input.ownerUserId,
      reportPackageArtifactId: reportPackage.id,
      reportPackageHash: reportPackage.contentSha256,
      zeroFileKey: target.fileKey,
      zeroPageId: target.pageId,
      updatePublicationId: input.updatePublicationId ?? null,
      templateVersion: ZERO_REPORT_TEMPLATE_VERSION,
    });
    return this.dependencies.store.createZeroPublication({
      taskId: task.id,
      ownerUserId: input.ownerUserId,
      planVersionId: task.activePlanVersionId,
      attemptId: task.currentAttemptId,
      reportPackageArtifactId: reportPackage.id,
      reportPackageHash: reportPackage.contentSha256,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      templateVersion: ZERO_REPORT_TEMPLATE_VERSION,
      zeroFileKey: target.fileKey,
      zeroPageId: target.pageId,
      zeroPageName: target.pageName,
      ...(input.updatePublicationId ? { updatePublicationId: input.updatePublicationId } : {}),
    });
  }

  async get(
    publicationId: string,
    taskId: string,
    ownerUserId: string,
  ): Promise<ControlZeroPublication | null> {
    return this.dependencies.store.getZeroPublicationForOwner({ publicationId, taskId, ownerUserId });
  }

  private async heartbeat(publication: ControlZeroPublication): Promise<ControlZeroPublication> {
    return this.dependencies.store.heartbeatZeroPublication({
      publicationId: publication.id,
      leaseOwner: this.leaseOwner,
      extendUntil: new Date(this.now().getTime() + LEASE_MS),
    });
  }

  private async update(
    publication: ControlZeroPublication,
    stage: ZeroPublicationStage,
    progress: number,
    values: Partial<Pick<
      ControlZeroPublication,
      'draftRootNodeId' | 'zeroNodeMap' | 'imageManifest' | 'screenshotManifest' | 'receiptArtifactId'
    >> = {},
  ): Promise<ControlZeroPublication> {
    return this.dependencies.store.updateZeroPublication({
      publicationId: publication.id,
      leaseOwner: this.leaseOwner,
      stage,
      progress,
      ...(values.draftRootNodeId ? { draftRootNodeId: values.draftRootNodeId } : {}),
      ...(values.zeroNodeMap ? { zeroNodeMap: values.zeroNodeMap } : {}),
      ...(values.imageManifest ? { imageManifest: values.imageManifest } : {}),
      ...(values.screenshotManifest ? { screenshotManifest: values.screenshotManifest } : {}),
      ...(values.receiptArtifactId ? { receiptArtifactId: values.receiptArtifactId } : {}),
    });
  }

  private async visualInputs(
    report: Extract<CurrentReportPackageResponse, { presentationMode: 'multimodal' }>,
  ): Promise<ZeroVisualInput[]> {
    const manifestByAsset = new Map(report.visualAssetManifests.map((manifest) => [manifest.assetId, manifest]));
    const inputs: ZeroVisualInput[] = [];
    for (const section of report.reportDocument.sections) {
      for (const block of section.blocks) {
        for (const visual of blockVisuals(block)) {
          const manifest = manifestByAsset.get(visual.ref.assetId);
          if (!manifest || manifest.exportPolicy === 'block') {
            throw new ZeroPublicationServiceError(
              'visual_asset_blocked',
              `Visual block ${block.id} has no exportable Asset`,
            );
          }
          const verified = await this.dependencies.readVisualAsset({
            assetId: visual.ref.assetId,
            manifestArtifactId: visual.ref.manifestArtifactId,
          });
          if (
            verified.artifact.id !== visual.ref.assetId
            || verified.manifestArtifact.id !== visual.ref.manifestArtifactId
            || verified.manifest.taskId !== report.deliverable.taskId
            || verified.manifest.planVersionId !== report.deliverable.planVersionId
            || verified.manifest.attemptId !== report.deliverable.attemptId
          ) {
            throw new ZeroPublicationServiceError(
              'visual_asset_invalid',
              `Visual block ${block.id} Asset binding is invalid`,
            );
          }
          inputs.push({
            key: visual.key,
            blockId: block.id,
            role: visual.role,
            ...(visual.pairKey ? { pairKey: visual.pairKey } : {}),
            mediaType: verified.manifest.mediaType,
            bytes: new Uint8Array(verified.bytes),
            width: verified.metadata.width,
            height: verified.metadata.height,
            exportPolicy: verified.manifest.exportPolicy,
            preserveTransparency: false,
            label: visualLabel(block, visual.role),
          });
        }
      }
    }
    return inputs;
  }

  async execute(publicationId: string, ownerUserId: string): Promise<ControlZeroPublication> {
    let publication = await this.dependencies.store.getZeroPublicationByIdForOwner({
      publicationId,
      ownerUserId,
    });
    if (!publication) throw new ZeroPublicationServiceError('task_not_found', 'Publication does not exist');
    if (publication.status === 'completed') return publication;
    const claimed = await this.dependencies.store.claimZeroPublication({
      publicationId,
      leaseOwner: this.leaseOwner,
      leaseExpiresAt: new Date(this.now().getTime() + LEASE_MS),
    });
    if (!claimed) throw new ZeroPublicationServiceError('publication_lease_lost', 'Publication is already running', true);
    publication = claimed;
    let draftRootNodeId = publication.draftRootNodeId;
    let finalized = false;
    try {
      if (publication.receiptArtifactId && draftRootNodeId) {
        const finalName = typeof publication.zeroNodeMap?.__finalName === 'string'
          ? publication.zeroNodeMap.__finalName
          : `Zero report ${publication.taskId}`;
        const resumed = await this.dependencies.zero.finalizeDraft({
          pageName: publication.zeroPageName,
          draftRootNodeId,
          finalName,
          ...(publication.updateRootNodeId ? { updateRootNodeId: publication.updateRootNodeId } : {}),
        });
        finalized = true;
        return this.dependencies.store.completeZeroPublication({
          publicationId: publication.id,
          leaseOwner: this.leaseOwner,
          finalRootNodeId: resumed.finalRootNodeId,
          receiptArtifactId: publication.receiptArtifactId,
          screenshotManifest: publication.screenshotManifest ?? [],
        });
      }
      if (draftRootNodeId) {
        await this.dependencies.zero.cleanupDraft({
          pageName: publication.zeroPageName,
          rootNodeId: draftRootNodeId,
        });
        draftRootNodeId = null;
      }
      publication = await this.update(publication, 'reading_report', 10);
      const report = await this.dependencies.reportPackages.read({
        taskId: publication.taskId,
        planVersionId: publication.planVersionId,
        attemptId: publication.attemptId,
      });
      assertMultimodal(report);
      if (
        report.deliverable.taskId !== publication.taskId
        || report.deliverable.planVersionId !== publication.planVersionId
        || report.deliverable.attemptId !== publication.attemptId
      ) {
        throw new ZeroPublicationServiceError('report_package_invalid', 'Report Package binding is invalid');
      }

      publication = await this.update(publication, 'transcoding_images', 20);
      const transcoded = await transcodeZeroImages(await this.visualInputs(report));
      publication = await this.heartbeat(publication);
      publication = await this.update(publication, 'rendering_html', 30);
      const rendered = renderZeroReport({
        document: report.reportDocument,
        publicationId: publication.id,
        visuals: transcoded.placements,
      });
      publication = await this.update(publication, 'creating_draft', 40);
      const draft = await this.dependencies.zero.createHtmlDraft({
        html: rendered.html,
        name: `[ai-x-draft:${publication.id}] ${rendered.name}`,
      });
      draftRootNodeId = draft.rootNodeId;
      publication = await this.update(publication, 'creating_draft', 45, {
        draftRootNodeId,
      });

      const metadata = await this.dependencies.zero.getDesignMetadata(draftRootNodeId);
      const nodes = metadataNodes(metadata);
      const nodeMap: Record<string, unknown> = { __finalName: rendered.name };
      for (const placeholder of rendered.placeholders) {
        const node = nodes.get(placeholder.nodeName);
        if (!node) {
          throw new ZeroPublicationServiceError(
            'placeholder_missing',
            `Zero placeholder ${placeholder.key} is missing`,
          );
        }
        nodeMap[placeholder.key] = node.id;
      }
      publication = await this.update(publication, 'writing_images', 50, { zeroNodeMap: nodeMap });

      const imageManifest: unknown[] = [];
      for (let index = 0; index < transcoded.slices.length; index += 1) {
        publication = await this.heartbeat(publication);
        const slice = transcoded.slices[index]!;
        const nodeId = String(nodeMap[slice.key]);
        const written = await this.dependencies.zero.writeImage({
          pageName: publication.zeroPageName,
          nodeId,
          bytes: slice.bytes,
          description: `Write ${slice.label} for Zero report publication`,
        });
        imageManifest.push({
          key: slice.key,
          nodeId,
          imageHash: written.imageHash,
          contentSha256: slice.contentSha256,
        });
        publication = await this.update(
          publication,
          'writing_images',
          50 + Math.floor(((index + 1) / transcoded.slices.length) * 20),
          { imageManifest },
        );
      }

      publication = await this.update(publication, 'verifying_fills', 75);
      for (const item of imageManifest) {
        const expected = item as { nodeId: string; imageHash: string };
        const inspection = await this.dependencies.zero.inspectNode(expected.nodeId);
        const node = inspection.nodes.find(({ id }) => id === expected.nodeId);
        if (
          !node
          || node.fills.length !== 1
          || node.fills[0]?.type !== 'IMAGE'
          || node.fills[0].imageHash !== expected.imageHash
          || node.fills[0].scaleMode !== 'FIT'
        ) {
          throw new ZeroPublicationServiceError(
            'image_fill_missing',
            `Zero image node ${expected.nodeId} does not have the expected IMAGE fill`,
          );
        }
      }

      publication = await this.update(publication, 'verifying_metadata', 82);
      const finalMetadata = await this.dependencies.zero.getDesignMetadata(draftRootNodeId);
      const root = metadataNodes(finalMetadata).get(`[ai-x-draft:${publication.id}] ${rendered.name}`);
      if (
        !root
        || root.width === undefined
        || root.height === undefined
        || Math.abs(root.width - rendered.expectedWidth) > 1
        || root.height < rendered.expectedMinimumHeight
      ) {
        throw new ZeroPublicationServiceError('metadata_mismatch', 'Zero report root bounds are invalid');
      }

      publication = await this.update(publication, 'capturing_screenshots', 88);
      const screenshotTargets = [
        draftRootNodeId,
        ...new Set(Object.entries(nodeMap)
          .filter(([key]) => key !== '__finalName')
          .map(([, value]) => String(value))),
      ];
      const screenshotManifest: unknown[] = [];
      for (const targetNodeId of screenshotTargets) {
        publication = await this.heartbeat(publication);
        const screenshot = await this.dependencies.zero.captureScreenshot(targetNodeId, 4096);
        const artifact = await this.dependencies.artifacts.writeBinary({
          taskId: publication.taskId,
          planVersionId: publication.planVersionId,
          attemptId: publication.attemptId,
          kind: 'zero_publication_screenshot',
          relativePath: `publications/zero/${publication.id}/${targetNodeId.replace(':', '-')}.png`,
          bytes: screenshot.bytes,
          schemaVersion: 'zero-publication-screenshot-v1',
          sensitivity: 'internal',
          redactionPolicyVersion: 'v1',
        });
        if (artifact.state !== 'SEALED' || !artifact.contentSha256) {
          throw new ZeroPublicationServiceError('screenshot_failed', 'Zero screenshot Artifact was not sealed');
        }
        screenshotManifest.push({
          artifactId: artifact.id,
          nodeId: targetNodeId,
          width: screenshot.width,
          height: screenshot.height,
        });
      }

      publication = await this.update(publication, 'finalizing_receipt', 96, { screenshotManifest });
      const publishedAt = this.now().toISOString();
      const receipt = await this.dependencies.artifacts.writeJson({
        taskId: publication.taskId,
        planVersionId: publication.planVersionId,
        attemptId: publication.attemptId,
        kind: 'zero_publication_receipt',
        relativePath: `publications/zero/${publication.id}.json`,
        schemaVersion: 'zero-publication-receipt-v1',
        sensitivity: 'internal',
        redactionPolicyVersion: 'v1',
        value: {
          version: 'zero-publication-receipt-v1',
          publicationId: publication.id,
          taskId: publication.taskId,
          planVersionId: publication.planVersionId,
          attemptId: publication.attemptId,
          reportPackageArtifactId: publication.reportPackageArtifactId,
          reportPackageHash: publication.reportPackageHash,
          templateVersion: publication.templateVersion,
          zero: {
            fileKey: publication.zeroFileKey,
            pageId: publication.zeroPageId,
            pageName: publication.zeroPageName,
            rootNodeId: draftRootNodeId,
          },
          nodeMap,
          imageManifest,
          screenshotArtifactIds: screenshotManifest.map((item) => (item as { artifactId: string }).artifactId),
          publishedAt,
        },
      });
      if (receipt.state !== 'SEALED' || !receipt.contentSha256) {
        throw new ZeroPublicationServiceError('publication_receipt_failed', 'Zero publication receipt was not sealed');
      }
      publication = await this.update(publication, 'finalizing_receipt', 98, {
        receiptArtifactId: receipt.id,
      });
      const finalizedDraft = await this.dependencies.zero.finalizeDraft({
        pageName: publication.zeroPageName,
        draftRootNodeId,
        finalName: rendered.name,
        ...(publication.updateRootNodeId ? { updateRootNodeId: publication.updateRootNodeId } : {}),
      });
      finalized = true;
      return this.dependencies.store.completeZeroPublication({
        publicationId: publication.id,
        leaseOwner: this.leaseOwner,
        finalRootNodeId: finalizedDraft.finalRootNodeId,
        receiptArtifactId: receipt.id,
        screenshotManifest,
      });
    } catch (error) {
      if (draftRootNodeId && !finalized) {
        try {
          await this.dependencies.zero.cleanupDraft({
            pageName: publication.zeroPageName,
            rootNodeId: draftRootNodeId,
          });
        } catch {
          // Keep the original failure. The draft ID remains in the publication row for manual cleanup.
        }
      }
      const publicFailure = failure(error);
      if (finalized) {
        throw new ZeroPublicationServiceError(
          'publication_lease_lost',
          'Zero publication finalized externally and awaits receipt reconciliation',
          true,
        );
      }
      try {
        await this.dependencies.store.failZeroPublication({
          publicationId: publication.id,
          leaseOwner: this.leaseOwner,
          failure: publicFailure,
        });
      } catch {
        // Preserve the external operation error when the lease has already moved.
      }
      throw new ZeroPublicationServiceError(
        publicFailure.code,
        publicFailure.message,
        publicFailure.retryable,
      );
    }
  }

  async recoverExpired(): Promise<number> {
    const expired = await this.dependencies.store.listExpiredZeroPublications({ limit: 100 });
    let recovered = 0;
    for (const publication of expired) {
      try {
        await this.execute(publication.id, publication.ownerUserId);
        recovered += 1;
      } catch {
        // Each publication records its own terminal failure.
      }
    }
    return recovered;
  }
}

export type { CurrentReportPackageReader };
