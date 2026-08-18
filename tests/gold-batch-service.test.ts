import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GoldBatchPolicyError,
  GoldBatchService,
  type GoldBatchDependencies,
  type GoldBatchStore,
} from '../apps/orchestrator-runtime/src/gold/gold-batch-service.ts';

class MemoryGoldStore implements GoldBatchStore {
  batches = new Map<string, { pinsHash: string; state: string; decision: string | null }>();
  slots = new Map<string, Array<{
    slotNo: number;
    attemptId: string | null;
    reportPackageId: string | null;
    state: string;
    infraRetries: number;
  }>>();
  reviews = new Map<string, Array<{ attemptId: string; reviewerId: string; verdict: string }>>();

  async createBatch(input: { batchId: string; pinsHash: string; pins: unknown }): Promise<void> {
    this.batches.set(input.batchId, { pinsHash: input.pinsHash, state: 'COLLECTING', decision: null });
    this.slots.set(input.batchId, [1, 2, 3].map((slotNo) => ({
      slotNo,
      attemptId: null,
      reportPackageId: null,
      state: 'OPEN',
      infraRetries: 0,
    })));
  }
  async getBatch(batchId: string) { return this.batches.get(batchId) ?? null; }
  async getSlots(batchId: string) { return this.slots.get(batchId) ?? []; }
  async updateSlot(batchId: string, slotNo: number, patch: Partial<{
    attemptId: string | null;
    reportPackageId: string | null;
    state: string;
    infraRetries: number;
  }>) {
    const slot = (this.slots.get(batchId) ?? []).find((entry) => entry.slotNo === slotNo);
    if (!slot) throw new Error('slot missing');
    Object.assign(slot, patch);
  }
  async updateBatch(batchId: string, patch: Partial<{ state: string; decision: string | null }>) {
    const batch = this.batches.get(batchId);
    if (!batch) throw new Error('batch missing');
    Object.assign(batch, patch);
  }
  async appendReview(batchId: string, review: { attemptId: string; reviewerId: string; verdict: string }) {
    const entries = this.reviews.get(batchId) ?? [];
    entries.push(review);
    this.reviews.set(batchId, entries);
  }
  async getReviews(batchId: string) { return this.reviews.get(batchId) ?? []; }
}

class GoldTestAuthority {
  readonly packageAttempts = new Map<string, string>();
  readonly reviewerResults = new Map<string, Awaited<ReturnType<GoldBatchDependencies['reviewers']['verifyReviewer']>>>();

  readonly dependencies: GoldBatchDependencies = {
    reportPackages: {
      verify: async ({ artifactId, attemptId }) => {
        if (this.packageAttempts.get(artifactId) !== attemptId) throw new Error('unverified package');
        return {
          value: {
            version: 'report-package-v1',
            taskId: `task-${attemptId}`,
            planVersionId: `plan-${attemptId}`,
            attemptId,
            presentationMode: 'legacy_text',
            deliverableArtifactId: `deliverable-${attemptId}`,
            evidenceManifestArtifactId: `evidence-${attemptId}`,
          },
        };
      },
    },
    reviewers: {
      verifyReviewer: async ({ reviewerId, attemptId }) => {
        const result = this.reviewerResults.get(`${reviewerId}:${attemptId}`);
        if (!result) throw new Error('unverified reviewer');
        return result;
      },
    },
  };

  registerPackage(artifactId: string, attemptId: string): void {
    this.packageAttempts.set(artifactId, attemptId);
  }

  registerReviewer(reviewerId: string, attemptId: string, authenticated = true): void {
    this.reviewerResults.set(`${reviewerId}:${attemptId}`, {
      authenticated,
      independence: { capabilityOwner: false, operator: false, artifactEditor: false },
    });
  }
}

function pins() {
  return {
    scenarioId: 'live-digital-human',
    scenarioInputHash: 'sha256:input',
    policyHash: 'sha256:policy',
    provider: 'gateway',
    endpoint: 'llm.test',
    requestedModel: 'pinned-model',
    expectedActualModel: 'pinned-model',
    coreTool: 'tavily-web-search',
    buildHash: 'sha256:build',
    registryHash: 'sha256:registry',
    schemaHash: 'sha256:schema',
    reviewPolicyHash: 'sha256:review',
  };
}

test('creates exactly three fixed Gold slots with immutable pins', async () => {
  const store = new MemoryGoldStore();
  const service = new GoldBatchService(store, new GoldTestAuthority().dependencies);
  const batch = await service.createBatch({ batchId: 'batch-1', pins: pins() });
  assert.equal(batch.machineState, 'COLLECTING');
  assert.equal((await store.getSlots('batch-1')).length, 3);
  await assert.rejects(() => service.createBatch({ batchId: 'batch-1', pins: pins() }), GoldBatchPolicyError);
});

test('retries structured infra failures but permanently occupies first capability result', async () => {
  const store = new MemoryGoldStore();
  const service = new GoldBatchService(store, new GoldTestAuthority().dependencies);
  await service.createBatch({ batchId: 'batch-1', pins: pins() });
  await service.recordAttempt({ batchId: 'batch-1', slotNo: 1, result: { kind: 'infra', code: 'timeout' } });
  assert.equal((await store.getSlots('batch-1'))[0].attemptId, null);
  assert.equal((await store.getSlots('batch-1'))[0].infraRetries, 1);
  await assert.rejects(
    () => service.recordAttempt({ batchId: 'batch-1', slotNo: 1, result: { kind: 'quality_failed' } }),
    /real attempt id/u,
  );
  await service.recordAttempt({ batchId: 'batch-1', slotNo: 1, attemptId: 'a2', result: { kind: 'quality_failed' } });
  assert.equal((await store.getSlots('batch-1'))[0].attemptId, 'a2');
  await assert.rejects(() => service.recordAttempt({ batchId: 'batch-1', slotNo: 1, attemptId: 'a3', result: { kind: 'success', fullReal: true, reportPackageId: 'package-a3' } }), GoldBatchPolicyError);
});

test('invalidates batch on model or proof drift and blocks further slots', async () => {
  const store = new MemoryGoldStore();
  const service = new GoldBatchService(store, new GoldTestAuthority().dependencies);
  await service.createBatch({ batchId: 'batch-1', pins: pins() });
  await service.recordAttempt({ batchId: 'batch-1', slotNo: 1, attemptId: 'a1', result: { kind: 'integrity_failed', reason: 'model_drift' } });
  assert.equal((await store.getBatch('batch-1'))?.state, 'INVALIDATED');
  await assert.rejects(() => service.recordAttempt({ batchId: 'batch-1', slotNo: 2, attemptId: 'a2', result: { kind: 'success', fullReal: true, reportPackageId: 'package-a2' } }), GoldBatchPolicyError);
});

test('requires three sealed slots and independent reviews before PASSED decision', async () => {
  const store = new MemoryGoldStore();
  const authority = new GoldTestAuthority();
  const service = new GoldBatchService(store, authority.dependencies);
  await service.createBatch({ batchId: 'batch-1', pins: pins() });
  for (const slotNo of [1, 2, 3] as const) {
    authority.registerPackage(`package-a${slotNo}`, `a${slotNo}`);
    authority.registerReviewer('r1', `a${slotNo}`);
    await service.recordAttempt({ batchId: 'batch-1', slotNo, attemptId: `a${slotNo}`, result: { kind: 'success', fullReal: true, reportPackageId: `package-a${slotNo}` } });
  }
  await service.submitReview({ batchId: 'batch-1', attemptId: 'a1', reviewerId: 'r1', verdict: 'usable' });
  await service.submitReview({ batchId: 'batch-1', attemptId: 'a2', reviewerId: 'r1', verdict: 'usable' });
  await service.submitReview({ batchId: 'batch-1', attemptId: 'a3', reviewerId: 'r1', verdict: 'needs_revision' });
  const decision = await service.decide({ batchId: 'batch-1' });
  assert.equal(decision, 'PASSED');
});

test('does not trust caller-declared Report Package identity or reviewer status', async () => {
  const store = new MemoryGoldStore();
  const authority = new GoldTestAuthority();
  const service = new GoldBatchService(store, authority.dependencies);
  await service.createBatch({ batchId: 'batch-1', pins: pins() });

  await assert.rejects(() => service.recordAttempt({
    batchId: 'batch-1',
    slotNo: 1,
    attemptId: 'a1',
    result: { kind: 'success', fullReal: true, reportPackageId: 'unverified-package' },
  }), GoldBatchPolicyError);

  for (const slotNo of [1, 2, 3] as const) {
    authority.registerPackage(`package-a${slotNo}`, `a${slotNo}`);
    await service.recordAttempt({
      batchId: 'batch-1',
      slotNo,
      attemptId: `a${slotNo}`,
      result: { kind: 'success', fullReal: true, reportPackageId: `package-a${slotNo}` },
    });
  }
  authority.registerReviewer('r1', 'a1', false);
  await assert.rejects(() => service.submitReview({
    batchId: 'batch-1',
    attemptId: 'a1',
    reviewerId: 'r1',
    verdict: 'usable',
  }), GoldBatchPolicyError);
});

test('revalidates persisted Report Packages before the final decision', async () => {
  const store = new MemoryGoldStore();
  const authority = new GoldTestAuthority();
  const service = new GoldBatchService(store, authority.dependencies);
  await service.createBatch({ batchId: 'batch-1', pins: pins() });
  for (const slotNo of [1, 2, 3] as const) {
    authority.registerPackage(`package-a${slotNo}`, `a${slotNo}`);
    await service.recordAttempt({
      batchId: 'batch-1',
      slotNo,
      attemptId: `a${slotNo}`,
      result: { kind: 'success', fullReal: true, reportPackageId: `package-a${slotNo}` },
    });
  }
  authority.packageAttempts.delete('package-a2');

  assert.equal(await service.decide({ batchId: 'batch-1' }), 'INVALIDATED');
  assert.equal((await store.getSlots('batch-1'))[1]?.state, 'INVALIDATED');
});

test('final decision rejects duplicate reviews even when the stored review count is three', async () => {
  const store = new MemoryGoldStore();
  const authority = new GoldTestAuthority();
  const service = new GoldBatchService(store, authority.dependencies);
  await service.createBatch({ batchId: 'batch-1', pins: pins() });
  for (const slotNo of [1, 2, 3] as const) {
    authority.registerPackage(`package-a${slotNo}`, `a${slotNo}`);
    await service.recordAttempt({
      batchId: 'batch-1',
      slotNo,
      attemptId: `a${slotNo}`,
      result: { kind: 'success', fullReal: true, reportPackageId: `package-a${slotNo}` },
    });
  }
  store.reviews.set('batch-1', [
    { attemptId: 'a1', reviewerId: 'r1', verdict: 'usable' },
    { attemptId: 'a1', reviewerId: 'r2', verdict: 'usable' },
    { attemptId: 'a2', reviewerId: 'r3', verdict: 'usable' },
  ]);

  await assert.rejects(() => service.decide({ batchId: 'batch-1' }), /exactly one review/u);
});
