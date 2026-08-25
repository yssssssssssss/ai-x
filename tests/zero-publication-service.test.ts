import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import sharp from 'sharp';
import type {
  ControlArtifact,
  ControlTaskDetail,
  ControlZeroPublication,
} from '../database/control-plane.ts';
import type { CurrentReportPackageResponse } from '../packages/api-contract/control-workflow.ts';
import type { VisualAssetManifest } from '../packages/api-contract/research-deliverable.ts';
import {
  ZeroPublicationService,
  ZeroPublicationServiceError,
  type ZeroPublicationArtifacts,
  type ZeroPublicationMcp,
  type ZeroPublicationStore,
} from '../apps/agent-api/src/integrations/zero/zero-publication-service.ts';

const ownerUserId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const planVersionId = '33333333-3333-4333-8333-333333333333';
const attemptId = '44444444-4444-4444-8444-444444444444';
const reportPackageArtifactId = '55555555-5555-4555-8555-555555555555';

function publication(overrides: Partial<ControlZeroPublication> = {}): ControlZeroPublication {
  const now = new Date();
  return {
    id: randomUUID(), taskId, ownerUserId, planVersionId, attemptId,
    reportPackageArtifactId, reportPackageHash: `sha256:${'a'.repeat(64)}`,
    idempotencyKey: randomUUID(), requestHash: `sha256:${'b'.repeat(64)}`,
    templateVersion: 'zero-report-v1', status: 'queued', stage: 'checking_zero', progress: 0,
    zeroFileKey: 'file-1', zeroPageId: '30:1', zeroPageName: '[p]demo',
    draftRootNodeId: null, finalRootNodeId: null, updatePublicationId: null, updateRootNodeId: null,
    zeroNodeMap: null, imageManifest: null, screenshotManifest: null,
    receiptArtifactId: null, failure: null, leaseOwner: null, leaseExpiresAt: null,
    createdAt: now, updatedAt: now, completedAt: null,
    ...overrides,
  };
}

class MemoryPublicationStore implements ZeroPublicationStore {
  task: ControlTaskDetail = {
    id: taskId, conversationId: randomUUID(), originalInput: 'AI shopping report', ownerUserId,
    conversationOwnerUserId: ownerUserId, structuredTask: {}, state: 'completed', stateVersion: 9,
    activePlanVersionId: planVersionId, currentAttemptId: attemptId, activeRequirementVersionId: null,
  };
  reportArtifact: ControlArtifact = {
    id: reportPackageArtifactId, taskId, planVersionId, attemptId, kind: 'report_package',
    state: 'SEALED', storageUri: '/safe/report-package.json', contentSha256: `sha256:${'a'.repeat(64)}`,
    byteSize: 2, schemaVersion: 'report-package-v1', sensitivity: 'internal',
    redactionPolicyVersion: 'v1', failureReason: null,
  };
  rows = new Map<string, ControlZeroPublication>();
  claimOwners: string[] = [];
  created = 0;
  cleaned: string[] = [];

  async getTaskDetail(id: string) { return id === taskId ? this.task : null; }
  async findSealedArtifact() { return this.reportArtifact; }
  async createZeroPublication(input: Parameters<ZeroPublicationStore['createZeroPublication']>[0]) {
    const existing = [...this.rows.values()].find((row) => row.taskId === input.taskId && row.idempotencyKey === input.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== input.requestHash) throw new Error('idempotency conflict');
      if (existing.status !== 'failed') return existing;
      const retried = publication({
        ...existing,
        status: 'queued',
        stage: 'checking_zero',
        progress: 0,
        failure: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: null,
      });
      this.rows.set(retried.id, retried);
      return retried;
    }
    this.created += 1;
    const row = publication({
      idempotencyKey: input.idempotencyKey, requestHash: input.requestHash,
      zeroFileKey: input.zeroFileKey ?? null, zeroPageId: input.zeroPageId, zeroPageName: input.zeroPageName,
      updatePublicationId: input.updatePublicationId ?? null,
      updateRootNodeId: input.updatePublicationId ? '29:1' : null,
    });
    this.rows.set(row.id, row);
    return row;
  }
  async getZeroPublicationByIdForOwner(input: { publicationId: string }) { return this.rows.get(input.publicationId) ?? null; }
  async getZeroPublicationForOwner(input: { publicationId: string }) { return this.rows.get(input.publicationId) ?? null; }
  async claimZeroPublication(input: { publicationId: string; leaseOwner: string; leaseExpiresAt: Date }) {
    const row = this.rows.get(input.publicationId);
    const reclaimable = row?.status === 'running'
      && row.leaseExpiresAt !== null
      && row.leaseExpiresAt <= new Date();
    if (!row || (row.status !== 'queued' && !reclaimable)) return null;
    this.claimOwners.push(input.leaseOwner);
    const next = publication({
      ...row,
      status: 'running',
      failure: null,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: input.leaseExpiresAt,
      completedAt: null,
    });
    this.rows.set(next.id, next); return next;
  }
  async heartbeatZeroPublication(input: { publicationId: string; leaseOwner: string; extendUntil: Date }) {
    const row = this.rows.get(input.publicationId)!;
    const next = publication({ ...row, leaseOwner: input.leaseOwner, leaseExpiresAt: input.extendUntil });
    this.rows.set(next.id, next); return next;
  }
  async updateZeroPublication(input: Parameters<ZeroPublicationStore['updateZeroPublication']>[0]) {
    const row = this.rows.get(input.publicationId)!;
    const next = publication({
      ...row, stage: input.stage, progress: input.progress,
      draftRootNodeId: input.draftRootNodeId ?? row.draftRootNodeId,
      zeroNodeMap: input.zeroNodeMap ?? row.zeroNodeMap,
      imageManifest: input.imageManifest ?? row.imageManifest,
      screenshotManifest: input.screenshotManifest ?? row.screenshotManifest,
      receiptArtifactId: input.receiptArtifactId ?? row.receiptArtifactId,
    });
    this.rows.set(next.id, next); return next;
  }
  async completeZeroPublication(input: Parameters<ZeroPublicationStore['completeZeroPublication']>[0]) {
    const row = this.rows.get(input.publicationId)!;
    const next = publication({
      ...row, status: 'completed', stage: 'finalizing_receipt', progress: 100,
      finalRootNodeId: input.finalRootNodeId, receiptArtifactId: input.receiptArtifactId,
      screenshotManifest: input.screenshotManifest, leaseOwner: null, leaseExpiresAt: null,
      completedAt: new Date(),
    });
    this.rows.set(next.id, next); return next;
  }
  async failZeroPublication(input: Parameters<ZeroPublicationStore['failZeroPublication']>[0]) {
    const row = this.rows.get(input.publicationId)!;
    const next = publication({ ...row, status: 'failed', failure: input.failure, leaseOwner: null, leaseExpiresAt: null, completedAt: new Date() });
    this.rows.set(next.id, next); return next;
  }
  async listExpiredZeroPublications() { return [...this.rows.values()].filter((row) => row.status === 'running'); }
}

class MemoryArtifacts implements ZeroPublicationArtifacts {
  json: Array<{ id: string; value: unknown; attemptId?: string }> = [];
  binary: Array<{ id: string; bytes: Uint8Array; attemptId?: string }> = [];
  async writeJson(input: { value: unknown; attemptId?: string }) {
    const value = { id: randomUUID(), value: input.value, ...(input.attemptId ? { attemptId: input.attemptId } : {}) }; this.json.push(value);
    return { id: value.id, state: 'SEALED', contentSha256: `sha256:${'c'.repeat(64)}` };
  }
  async writeBinary(input: { bytes: Uint8Array; attemptId?: string }) {
    const value = { id: randomUUID(), bytes: input.bytes, ...(input.attemptId ? { attemptId: input.attemptId } : {}) }; this.binary.push(value);
    return { id: value.id, state: 'SEALED', contentSha256: `sha256:${'d'.repeat(64)}` };
  }
}

class FakeZero implements ZeroPublicationMcp {
  available = true;
  fillFailure = false;
  cleanup: string[] = [];
  finalized: Array<{ draftRootNodeId: string; updateRootNodeId?: string }> = [];
  placeholders = new Map<string, string>();
  draftName = '';
  draftHtml = '';
  fills = new Map<string, string>();

  async getStatus() { return { available: this.available, authenticated: this.available, version: '3.12.8' }; }
  async getCurrentTarget() { return { fileKey: 'file-1', pageId: '30:1', pageName: '[p]demo' }; }
  async createHtmlDraft(input: { html: string; name: string }) {
    this.draftName = input.name;
    this.draftHtml = input.html;
    const names = [...input.html.matchAll(/data-ai-alt="([^"]*zero:[^"]+)"/gu)].map((match) => match[1]!);
    names.forEach((name, index) => this.placeholders.set(name, `31:${100 + index}`));
    return { rootNodeId: '31:2', x: 0, y: 0, width: 1440, height: 5000 };
  }
  async getDesignMetadata() {
    return `<frame id="31:2" name="${this.draftName}" width="1440" height="5000">${[...this.placeholders].map(([name, id]) => `<frame id="${id}" name="${name}" />`).join('')}</frame>`;
  }
  async writeImage(input: { nodeId: string }) {
    const hash = `hash-${input.nodeId}`; this.fills.set(input.nodeId, hash); return { nodeId: input.nodeId, imageHash: hash };
  }
  async inspectNode(nodeId: string) {
    return { nodes: [{ id: nodeId, name: 'image', fills: this.fillFailure ? [{ type: 'SOLID' }] : [{ type: 'IMAGE', imageHash: this.fills.get(nodeId), scaleMode: 'FIT' }] }] };
  }
  async captureScreenshot() { return { bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), contentType: 'image/png' as const, width: 100, height: 200, originalWidth: 100, originalHeight: 200 }; }
  async finalizeDraft(input: { draftRootNodeId: string; updateRootNodeId?: string }) { this.finalized.push(input); return { finalRootNodeId: input.draftRootNodeId }; }
  async cleanupDraft(input: { rootNodeId: string }) { this.cleanup.push(input.rootNodeId); }
}

async function reportFixture(): Promise<{
  report: CurrentReportPackageResponse;
  readVisualAsset: (input: { assetId: string; manifestArtifactId: string }) => Promise<any>;
}> {
  const originalBytes = new Uint8Array(await sharp({ create: { width: 320, height: 960, channels: 3, background: '#eee' } }).jpeg().toBuffer());
  const annotationBytes = new Uint8Array(await sharp({ create: { width: 320, height: 960, channels: 3, background: '#fee' } }).jpeg().toBuffer());
  const manifests: VisualAssetManifest[] = [{
    version: 'visual-asset-manifest-v1', taskId, planVersionId, attemptId,
    assetId: 'asset-original', contentSha256: `sha256:${'1'.repeat(64)}`, mediaType: 'image/jpeg',
    byteSize: originalBytes.byteLength, width: 320, height: 960, exportPolicy: 'allow',
    source: { kind: 'user_upload', fileName: 'ai-shopping.jpg' }, derivedFrom: null, derivation: null,
    manifestHash: `sha256:${'2'.repeat(64)}`,
  }, {
    version: 'visual-asset-manifest-v1', taskId, planVersionId, attemptId,
    assetId: 'asset-annotation', contentSha256: `sha256:${'3'.repeat(64)}`, mediaType: 'image/jpeg',
    byteSize: annotationBytes.byteLength, width: 320, height: 960, exportPolicy: 'allow',
    source: { kind: 'derived' },
    derivedFrom: { assetId: 'asset-original', manifestArtifactId: 'manifest-original', contentSha256: `sha256:${'1'.repeat(64)}`, manifestHash: `sha256:${'2'.repeat(64)}` },
    derivation: { kind: 'annotation', overlayArtifactId: 'overlay-1' },
    manifestHash: `sha256:${'4'.repeat(64)}`,
  }];
  const report = {
    presentationMode: 'multimodal',
    deliverable: { version: 'research-deliverable-v1', taskId, planVersionId, attemptId, deliverableType: 'competitive_analysis_report', evidenceManifestArtifactId: 'evidence', methodSummary: 'method', findingGraph: { findings: [], analyses: [], subQuestionSummaries: [], overallConclusions: [] }, payload: {}, recommendations: [], coverage: { questionBindings: [], successCriterionBindings: [] }, risksAndOpenIssues: [], capabilityProvenance: [] },
    evidenceManifest: { version: 'evidence-v1', taskId, planVersionId, attemptId, collectedAt: new Date().toISOString(), manifestHash: `sha256:${'5'.repeat(64)}`, entries: [] },
    reportReview: { version: 'report-review-v1', taskId, planVersionId, attemptId, deliverableArtifactId: 'deliverable', verdict: 'pass', dimensions: [], revisionRound: 0 },
    reportDocument: {
      version: 'report-document-v1', title: 'AI 导购竞品分析', subtitle: '对比报告', executiveSummary: 'summary',
      sections: [{ id: 'visual', title: '视觉证据', questionIds: [], blocks: [{ id: 'comparison', type: 'image-comparison', beforeAssetRef: { assetId: 'asset-original', manifestArtifactId: 'manifest-original' }, afterAssetRef: { assetId: 'asset-annotation', manifestArtifactId: 'manifest-annotation' }, caption: '对照', altText: '对照图' }] }],
    },
    visualAssetManifests: manifests,
    contributionSummary: {
      version: 'contribution-summary-v1', taskId, planVersionId, attemptId,
      contributors: [{
        invocationId: 'invocation:virtual',
        skillId: 'virtual-user-research',
        contributionTypes: ['virtual_user_hypothesis'],
        unitCount: 1,
        limitations: ['仅供真实研究验证。'],
        units: [{
          sourceArtifactId: 'contribution-1', sourceUnitKey: 'unit-1', kind: 'hypothesis',
          title: '信任假设', statement: '用户可能需要更多可信度说明。',
          questionIds: ['question-1'], evidenceIds: ['SIM1-1'], status: 'provisional', confidence: 0.4,
          disposition: 'included', canonicalNodeIds: ['summary-1'],
        }],
        dispositions: [{ sourceUnitKey: 'unit-1', disposition: 'included', canonicalNodeIds: ['summary-1'] }],
      }],
    },
  } as unknown as CurrentReportPackageResponse;
  return {
    report,
    async readVisualAsset(input) {
      const index = input.assetId === 'asset-original' ? 0 : 1;
      const manifest = manifests[index]!;
      return {
        artifact: { id: manifest.assetId }, manifestArtifact: { id: input.manifestArtifactId },
        manifest, bytes: index === 0 ? originalBytes : annotationBytes,
        metadata: { contentType: 'image/jpeg', byteSize: manifest.byteSize, width: 320, height: 960 },
      };
    },
  };
}

async function harness() {
  const store = new MemoryPublicationStore();
  const artifacts = new MemoryArtifacts();
  const zero = new FakeZero();
  const fixture = await reportFixture();
  const reportReads: Array<Record<string, unknown>> = [];
  const service = new ZeroPublicationService({
    store, artifacts, zero,
    reportPackages: { async read(input) { reportReads.push(input); return fixture.report; } },
    readVisualAsset: fixture.readVisualAsset,
    leaseOwner: 'test-zero-worker',
  });
  return { service, store, artifacts, zero, reportReads };
}

test('Zero publication service creates and completes a multimodal publication with real image fills', async () => {
  const { service, store, artifacts, zero, reportReads } = await harness();
  const created = await service.create({ taskId, ownerUserId, expectedTaskState: 'completed', idempotencyKey: 'idem-1' });
  const completed = await service.execute(created.id, ownerUserId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.finalRootNodeId, '31:2');
  assert.ok((completed.imageManifest?.length ?? 0) >= 2);
  assert.ok(artifacts.binary.length >= 1, 'screenshot is sealed as an Artifact');
  assert.equal(artifacts.json.length, 1, 'one publication receipt is sealed');
  assert.ok(artifacts.binary.every((artifact) => artifact.attemptId === undefined));
  assert.ok(artifacts.json.every((artifact) => artifact.attemptId === undefined));
  assert.equal(zero.cleanup.length, 0);
  assert.match(zero.draftHtml, /Multi-Skill 贡献摘要/u);
  assert.match(zero.draftHtml, /合成模拟证据/u);
  assert.doesNotMatch(zero.draftHtml, /sourceUnitKey|artifactContentSha256/u);
  assert.equal(store.created, 1);
  assert.equal(store.claimOwners.length, 1);
  assert.match(store.claimOwners[0]!, /^test-zero-worker:[0-9a-f-]{36}$/u);
  assert.deepEqual(reportReads, [{
    taskId,
    planVersionId,
    attemptId,
    reportPackageArtifactId,
    reportPackageHash: `sha256:${'a'.repeat(64)}`,
  }]);
});

test('Zero publication service fails before persistence when Zero is offline', async () => {
  const { service, store, zero } = await harness();
  zero.available = false;
  await assert.rejects(
    () => service.create({ taskId, ownerUserId, expectedTaskState: 'completed', idempotencyKey: 'idem-offline' }),
    (error: unknown) => error instanceof ZeroPublicationServiceError && error.code === 'zero_offline',
  );
  assert.equal(store.created, 0);
});

test('Zero publication service cleans a failed draft and retries the same publication identity', async () => {
  const { service, store, zero } = await harness();
  zero.fillFailure = true;
  const request = { taskId, ownerUserId, expectedTaskState: 'completed' as const, idempotencyKey: 'idem-fill' };
  const created = await service.create(request);
  await assert.rejects(() => service.execute(created.id, ownerUserId), /IMAGE fill/);
  assert.equal(store.rows.get(created.id)?.status, 'failed');
  assert.deepEqual(zero.cleanup, ['31:2']);

  zero.fillFailure = false;
  const retried = await service.create(request);
  assert.equal(retried.id, created.id);
  assert.equal(retried.idempotencyKey, created.idempotencyKey);
  assert.equal(retried.status, 'queued');
  const completed = await service.execute(retried.id, ownerUserId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.id, created.id);
  assert.equal(store.created, 1, 'retry must not create a second publication');
});

test('Zero publication service rejects update mode before persistence', async () => {
  const { service, store } = await harness();
  await assert.rejects(
    () => service.create({
      taskId,
      ownerUserId,
      expectedTaskState: 'completed',
      idempotencyKey: 'idem-update',
      updatePublicationId: randomUUID(),
    }),
    (error: unknown) => error instanceof ZeroPublicationServiceError && error.code === 'update_not_supported',
  );
  assert.equal(store.created, 0);
});

test('Zero publication service reclaims an expired publication with a fresh claim token', async () => {
  const { service, store, zero } = await harness();
  const created = await service.create({
    taskId, ownerUserId, expectedTaskState: 'completed', idempotencyKey: 'idem-recovery',
  });
  store.rows.set(created.id, publication({
    ...created, status: 'running', leaseOwner: 'lost-worker', leaseExpiresAt: new Date(Date.now() - 1),
  }));
  const recovered = await service.recoverExpired();
  assert.equal(recovered, 1);
  assert.equal(store.rows.get(created.id)?.status, 'completed');
  assert.equal(zero.finalized[0]?.updateRootNodeId, undefined);
  assert.equal(store.claimOwners.length, 1);
  assert.notEqual(store.claimOwners[0], 'lost-worker');
});
