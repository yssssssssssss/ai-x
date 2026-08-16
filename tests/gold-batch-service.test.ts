import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GoldBatchPolicyError,
  GoldBatchService,
  type GoldBatchStore,
} from '../apps/orchestrator-runtime/src/gold/gold-batch-service.ts';

class MemoryGoldStore implements GoldBatchStore {
  batches = new Map<string, { pinsHash: string; state: string; decision: string | null }>();
  slots = new Map<string, Array<{ slotNo: number; attemptId: string | null; state: string; infraRetries: number }>>();
  reviews = new Map<string, Array<{ attemptId: string; reviewerId: string; verdict: string }>>();

  async createBatch(input: { batchId: string; pinsHash: string; pins: unknown }): Promise<void> {
    this.batches.set(input.batchId, { pinsHash: input.pinsHash, state: 'COLLECTING', decision: null });
    this.slots.set(input.batchId, [1, 2, 3].map((slotNo) => ({ slotNo, attemptId: null, state: 'OPEN', infraRetries: 0 })));
  }
  async getBatch(batchId: string) { return this.batches.get(batchId) ?? null; }
  async getSlots(batchId: string) { return this.slots.get(batchId) ?? []; }
  async updateSlot(batchId: string, slotNo: number, patch: Partial<{ attemptId: string | null; state: string; infraRetries: number }>) {
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
  const service = new GoldBatchService(store);
  const batch = await service.createBatch({ batchId: 'batch-1', pins: pins() });
  assert.equal(batch.machineState, 'COLLECTING');
  assert.equal((await store.getSlots('batch-1')).length, 3);
  await assert.rejects(() => service.createBatch({ batchId: 'batch-1', pins: pins() }), GoldBatchPolicyError);
});

test('retries structured infra failures but permanently occupies first capability result', async () => {
  const store = new MemoryGoldStore();
  const service = new GoldBatchService(store);
  await service.createBatch({ batchId: 'batch-1', pins: pins() });
  await service.recordAttempt({ batchId: 'batch-1', slotNo: 1, attemptId: 'a1', result: { kind: 'infra', code: 'timeout' } });
  assert.equal((await store.getSlots('batch-1'))[0].attemptId, null);
  assert.equal((await store.getSlots('batch-1'))[0].infraRetries, 1);
  await service.recordAttempt({ batchId: 'batch-1', slotNo: 1, attemptId: 'a2', result: { kind: 'quality_failed' } });
  assert.equal((await store.getSlots('batch-1'))[0].attemptId, 'a2');
  await assert.rejects(() => service.recordAttempt({ batchId: 'batch-1', slotNo: 1, attemptId: 'a3', result: { kind: 'success', sealed: true, fullReal: true, reportPackageId: 'package-a3' } }), GoldBatchPolicyError);
});

test('invalidates batch on model or proof drift and blocks further slots', async () => {
  const store = new MemoryGoldStore();
  const service = new GoldBatchService(store);
  await service.createBatch({ batchId: 'batch-1', pins: pins() });
  await service.recordAttempt({ batchId: 'batch-1', slotNo: 1, attemptId: 'a1', result: { kind: 'integrity_failed', reason: 'model_drift' } });
  assert.equal((await store.getBatch('batch-1'))?.state, 'INVALIDATED');
  await assert.rejects(() => service.recordAttempt({ batchId: 'batch-1', slotNo: 2, attemptId: 'a2', result: { kind: 'success', sealed: true, fullReal: true, reportPackageId: 'package-a2' } }), GoldBatchPolicyError);
});

test('requires three sealed slots and independent reviews before PASSED decision', async () => {
  const store = new MemoryGoldStore();
  const service = new GoldBatchService(store);
  await service.createBatch({ batchId: 'batch-1', pins: pins() });
  for (const slotNo of [1, 2, 3] as const) {
    await service.recordAttempt({ batchId: 'batch-1', slotNo, attemptId: `a${slotNo}`, result: { kind: 'success', sealed: true, fullReal: true, reportPackageId: `package-a${slotNo}` } });
  }
  await service.submitReview({ batchId: 'batch-1', attemptId: 'a1', reviewerId: 'r1', authenticated: true, independence: { capabilityOwner: false, operator: false, artifactEditor: false }, verdict: 'usable' });
  await service.submitReview({ batchId: 'batch-1', attemptId: 'a2', reviewerId: 'r1', authenticated: true, independence: { capabilityOwner: false, operator: false, artifactEditor: false }, verdict: 'usable' });
  await service.submitReview({ batchId: 'batch-1', attemptId: 'a3', reviewerId: 'r1', authenticated: true, independence: { capabilityOwner: false, operator: false, artifactEditor: false }, verdict: 'needs_revision' });
  const decision = await service.decide({ batchId: 'batch-1' });
  assert.equal(decision, 'PASSED');
});
