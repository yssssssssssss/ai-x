import { createHash } from 'node:crypto';
import type { ReportPackageArtifactValue } from '../report/report-package-artifact.ts';

export type GoldMachineState = 'COLLECTING' | 'READY_FOR_REVIEW' | 'PASSED' | 'QUALITY_FAILED' | 'INVALIDATED' | 'BLOCKED_INFRA';
export type GoldDecision = 'PASSED' | 'QUALITY_FAILED' | 'INVALIDATED' | 'BLOCKED_INFRA' | 'READY_FOR_REVIEW';

export interface GoldPins {
  scenarioId: string;
  scenarioInputHash: string;
  policyHash: string;
  provider: string;
  endpoint: string;
  requestedModel: string;
  expectedActualModel: string;
  coreTool: string;
  buildHash: string;
  registryHash: string;
  schemaHash: string;
  reviewPolicyHash: string;
}

export interface GoldBatchStore {
  createBatch(input: { batchId: string; pinsHash: string; pins: GoldPins }): Promise<void>;
  getBatch(batchId: string): Promise<{ pinsHash: string; state: string; decision: string | null } | null>;
  getSlots(batchId: string): Promise<Array<{
    slotNo: number;
    attemptId: string | null;
    reportPackageId: string | null;
    state: string;
    infraRetries: number;
  }>>;
  updateSlot(batchId: string, slotNo: number, patch: Partial<{
    attemptId: string | null;
    reportPackageId: string | null;
    state: string;
    infraRetries: number;
  }>): Promise<void>;
  updateBatch(batchId: string, patch: Partial<{ state: string; decision: string | null }>): Promise<void>;
  appendReview(batchId: string, review: {
    attemptId: string;
    reviewerId: string;
    authenticated: boolean;
    independence: { capabilityOwner: boolean; operator: boolean; artifactEditor: boolean };
    verdict: string;
  }): Promise<void>;
  getReviews(batchId: string): Promise<Array<{ attemptId: string; reviewerId: string; verdict: string }>>;
}

export interface GoldReviewerAuthority {
  verifyReviewer(input: { reviewerId: string; attemptId: string }): Promise<{
    authenticated: boolean;
    independence: { capabilityOwner: boolean; operator: boolean; artifactEditor: boolean };
  }>;
}

export interface GoldBatchDependencies {
  reportPackages: {
    verify(input: { artifactId: string; attemptId: string }): Promise<{
      value: ReportPackageArtifactValue;
    }>;
  };
  reviewers: GoldReviewerAuthority;
}

export class GoldBatchPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoldBatchPolicyError';
  }
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

export function goldPinsHash(pins: GoldPins): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(stable(pins))).digest('hex')}`;
}

export class GoldBatchService {
  constructor(
    private readonly store: GoldBatchStore,
    private readonly dependencies: GoldBatchDependencies,
  ) {}

  async createBatch(input: { batchId: string; pins: GoldPins }): Promise<{ machineState: GoldMachineState; pinsHash: string }> {
    if (input.pins.provider !== 'gateway') {
      throw new GoldBatchPolicyError('Gold batch requires the gateway provider');
    }
    if (!input.pins.requestedModel.trim() || !input.pins.expectedActualModel.trim()) {
      throw new GoldBatchPolicyError('Gold batch model pins must be non-empty');
    }
    if (input.pins.coreTool !== 'tavily-web-search') {
      throw new GoldBatchPolicyError('Gold batch requires tavily-web-search as the core Tool');
    }
    if (await this.store.getBatch(input.batchId)) throw new GoldBatchPolicyError(`batch ${input.batchId} already exists`);
    const hash = goldPinsHash(input.pins);
    await this.store.createBatch({ batchId: input.batchId, pinsHash: hash, pins: input.pins });
    return { machineState: 'COLLECTING', pinsHash: hash };
  }

  async recordAttempt(input: {
    batchId: string;
    slotNo: 1 | 2 | 3;
    attemptId?: string;
    result:
      | { kind: 'infra'; code: 'rate_limit' | 'server' | 'timeout' | 'network' | 'quota' | 'worker_loss' }
      | { kind: 'success'; fullReal: boolean; reportPackageId?: string }
      | { kind: 'quality_failed' }
      | { kind: 'integrity_failed'; reason: 'model_drift' | 'proof_drift' | 'checksum_drift' | 'fake_tool' };
  }): Promise<void> {
    const batch = await this.requireCollecting(input.batchId);
    void batch;
    const slot = (await this.store.getSlots(input.batchId)).find((entry) => entry.slotNo === input.slotNo);
    if (!slot) throw new GoldBatchPolicyError(`slot ${input.slotNo} does not exist`);
    if (slot.attemptId) throw new GoldBatchPolicyError(`slot ${input.slotNo} is permanently occupied`);
    if (input.result.kind === 'infra') {
      if (slot.infraRetries >= 3) {
        await this.store.updateBatch(input.batchId, { state: 'BLOCKED_INFRA', decision: 'BLOCKED_INFRA' });
        throw new GoldBatchPolicyError(`slot ${input.slotNo} exhausted infra retries`);
      }
      await this.store.updateSlot(input.batchId, input.slotNo, { infraRetries: slot.infraRetries + 1, state: 'OPEN' });
      return;
    }
    const attemptId = input.attemptId?.trim();
    if (!attemptId) {
      throw new GoldBatchPolicyError('Gold capability results require a real attempt id');
    }
    if (input.result.kind === 'integrity_failed') {
      await this.store.updateSlot(input.batchId, input.slotNo, { attemptId, state: 'INVALIDATED' });
      await this.store.updateBatch(input.batchId, { state: 'INVALIDATED', decision: 'INVALIDATED' });
      return;
    }
    let verifiedReportPackageId: string | undefined;
    if (input.result.kind === 'success') {
      const reportPackageId = input.result.reportPackageId?.trim();
      if (!reportPackageId) {
        throw new GoldBatchPolicyError('Gold success requires a non-empty sealed Report Package');
      }
      let reportPackage: { value: ReportPackageArtifactValue };
      try {
        reportPackage = await this.dependencies.reportPackages.verify({
          artifactId: reportPackageId,
          attemptId,
        });
      } catch {
        throw new GoldBatchPolicyError('Gold success requires a verified sealed Report Package');
      }
      if (reportPackage.value.attemptId !== attemptId) {
        throw new GoldBatchPolicyError('Gold Report Package does not belong to the capability attempt');
      }
      verifiedReportPackageId = reportPackageId;
      if (!input.result.fullReal) {
        await this.store.updateSlot(input.batchId, input.slotNo, { attemptId, state: 'INVALIDATED' });
        await this.store.updateBatch(input.batchId, { state: 'INVALIDATED', decision: 'INVALIDATED' });
        return;
      }
    }
    await this.store.updateSlot(input.batchId, input.slotNo, {
      attemptId,
      ...(verifiedReportPackageId === undefined ? {} : { reportPackageId: verifiedReportPackageId }),
      state: input.result.kind === 'success' ? 'SEALED' : 'QUALITY_FAILED',
    });
    const slots = await this.store.getSlots(input.batchId);
    if (slots.every((entry) => entry.attemptId !== null)) {
      await this.store.updateBatch(input.batchId, { state: 'READY_FOR_REVIEW', decision: 'READY_FOR_REVIEW' });
    }
  }

  async submitReview(input: {
    batchId: string;
    attemptId: string;
    reviewerId: string;
    verdict: 'usable' | 'needs_revision' | 'unusable';
  }): Promise<void> {
    const batch = await this.store.getBatch(input.batchId);
    if (!batch || batch.state !== 'READY_FOR_REVIEW') throw new GoldBatchPolicyError('batch is not ready for review');
    const slots = await this.store.getSlots(input.batchId);
    if (!slots.some((slot) => slot.attemptId === input.attemptId)) throw new GoldBatchPolicyError('attempt is not in this batch');
    const reviews = await this.store.getReviews(input.batchId);
    if (reviews.some((review) => review.attemptId === input.attemptId)) throw new GoldBatchPolicyError('attempt already has a review');
    const reviewer = await this.dependencies.reviewers.verifyReviewer({
      reviewerId: input.reviewerId,
      attemptId: input.attemptId,
    });
    if (reviewer.authenticated !== true) throw new GoldBatchPolicyError('reviewer is not authenticated');
    if (Object.values(reviewer.independence).some(Boolean)) throw new GoldBatchPolicyError('reviewer is not independent');
    await this.store.appendReview(input.batchId, {
      attemptId: input.attemptId,
      reviewerId: input.reviewerId,
      authenticated: true,
      independence: reviewer.independence,
      verdict: input.verdict,
    });
  }

  async decide(input: { batchId: string }): Promise<GoldDecision> {
    const batch = await this.store.getBatch(input.batchId);
    if (!batch) throw new GoldBatchPolicyError('batch does not exist');
    if (batch.state === 'INVALIDATED') return 'INVALIDATED';
    if (batch.state === 'BLOCKED_INFRA') return 'BLOCKED_INFRA';
    const slots = await this.store.getSlots(input.batchId);
    if (slots.some((slot) => slot.attemptId === null)) throw new GoldBatchPolicyError('batch does not have three occupied slots');
    if (slots.some((slot) => slot.state !== 'SEALED')) {
      await this.store.updateBatch(input.batchId, { state: 'QUALITY_FAILED', decision: 'QUALITY_FAILED' });
      return 'QUALITY_FAILED';
    }
    for (const slot of slots) {
      if (!slot.attemptId || !slot.reportPackageId) {
        await this.store.updateBatch(input.batchId, { state: 'INVALIDATED', decision: 'INVALIDATED' });
        return 'INVALIDATED';
      }
      try {
        await this.dependencies.reportPackages.verify({
          artifactId: slot.reportPackageId,
          attemptId: slot.attemptId,
        });
      } catch {
        await this.store.updateSlot(input.batchId, slot.slotNo, { state: 'INVALIDATED' });
        await this.store.updateBatch(input.batchId, { state: 'INVALIDATED', decision: 'INVALIDATED' });
        return 'INVALIDATED';
      }
    }
    const reviews = await this.store.getReviews(input.batchId);
    const reviewCounts = new Map<string, number>();
    for (const review of reviews) {
      reviewCounts.set(review.attemptId, (reviewCounts.get(review.attemptId) ?? 0) + 1);
    }
    if (
      reviews.length !== 3
      || slots.some((slot) => !slot.attemptId || reviewCounts.get(slot.attemptId) !== 1)
    ) {
      throw new GoldBatchPolicyError('batch requires exactly one review for each slot');
    }
    const usable = reviews.filter((review) => review.verdict === 'usable').length;
    const decision: GoldDecision = usable >= 2 ? 'PASSED' : 'QUALITY_FAILED';
    await this.store.updateBatch(input.batchId, { state: decision, decision });
    return decision;
  }

  private async requireCollecting(batchId: string): Promise<{ pinsHash: string; state: string; decision: string | null }> {
    const batch = await this.store.getBatch(batchId);
    if (!batch) throw new GoldBatchPolicyError(`batch ${batchId} does not exist`);
    if (batch.state !== 'COLLECTING') throw new GoldBatchPolicyError(`batch ${batchId} is ${batch.state}`);
    return batch;
  }
}
