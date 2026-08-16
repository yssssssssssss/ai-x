import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  GoldBatchPolicyError,
  GoldBatchService,
  type GoldBatchStore,
  type GoldPins,
} from '../apps/orchestrator-runtime/src/gold/gold-batch-service.ts';

type GoldFixture = {
  version: number;
  name: string;
  profiles: string[];
  scenarios: Array<{
    id: string;
    profile: string;
    taskType: string;
    businessDomain: string;
    input: string;
    researchGoal: string;
    sensitivity: 'public' | 'internal' | 'confidential';
    piiDetected: boolean;
    requiredCoreTool: string;
    expectedDeliverableType: string;
    minPublicSources: number;
    minVisualAssets: number;
  }>;
};

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/current-semantic-gold.json'), 'utf8'),
) as GoldFixture;

const TASK_TYPES = [
  'competitive_research',
  'user_research_planning',
  'voc_diagnosis',
  'design_audit',
  'a11y_audit',
] as const;

class MemoryGoldStore implements GoldBatchStore {
  batches = new Map<string, { pinsHash: string; state: string; decision: string | null }>();
  slots = new Map<string, Array<{ slotNo: number; attemptId: string | null; state: string; infraRetries: number }>>();
  reviews = new Map<string, Array<{ attemptId: string; reviewerId: string; verdict: string }>>();

  async createBatch(input: { batchId: string; pinsHash: string; pins: GoldPins }): Promise<void> {
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

function pins(overrides: Partial<GoldPins> = {}): GoldPins {
  return {
    scenarioId: 'semantic-gold',
    scenarioInputHash: 'sha256:input',
    policyHash: 'sha256:policy',
    provider: 'gateway',
    endpoint: 'llm-gw.jd.local',
    requestedModel: 'GPT-5.2-joybuilder',
    expectedActualModel: 'GPT-5.2-joybuilder',
    coreTool: 'tavily-web-search',
    buildHash: 'sha256:build',
    registryHash: 'sha256:registry',
    schemaHash: 'sha256:schema',
    reviewPolicyHash: 'sha256:review',
    ...overrides,
  };
}

function service(): GoldBatchService {
  return new GoldBatchService(new MemoryGoldStore());
}

test('semantic Gold fixture contains exactly 25 scenarios and five profiles', () => {
  assert.equal(fixture.version, 1);
  assert.deepEqual(fixture.profiles, [...TASK_TYPES]);
  assert.equal(fixture.scenarios.length, 25);
  assert.equal(new Set(fixture.scenarios.map((scenario) => scenario.id)).size, 25);

  for (const taskType of TASK_TYPES) {
    const scenarios = fixture.scenarios.filter((scenario) => scenario.taskType === taskType);
    assert.equal(scenarios.length, 5, `${taskType} must have five semantic scenarios`);
    assert.ok(scenarios.every((scenario) => scenario.profile === taskType));
  }
});

test('every semantic Gold scenario is public-safe and executable through the core tool', () => {
  for (const scenario of fixture.scenarios) {
    assert.ok(scenario.input.trim());
    assert.ok(scenario.researchGoal.trim());
    assert.equal(scenario.piiDetected, false, scenario.id);
    assert.equal(scenario.requiredCoreTool, 'tavily-web-search');
    assert.equal(scenario.expectedDeliverableType, 'research_plan');
    assert.ok(scenario.minPublicSources >= 1);
    assert.ok(scenario.minVisualAssets >= 0);
    assert.doesNotMatch(JSON.stringify(scenario), /Bearer |api[_-]?key|password|secret|base64|data:image/i);
  }
});

test('GoldBatchService rejects a non-real gateway, model drift, or non-core tool pin', async () => {
  for (const [name, invalidPins] of [
    ['provider', pins({ provider: 'mock' })],
    ['model', pins({ expectedActualModel: 'unapproved-model' })],
    ['core tool', pins({ coreTool: 'fake-web-search' })],
  ] as const) {
    await assert.rejects(
      () => service().createBatch({ batchId: `invalid-${name}`, pins: invalidPins }),
      (error: unknown) => error instanceof GoldBatchPolicyError,
      `${name} drift must be rejected before a Gold batch is created`,
    );
  }
});

test('GoldBatchService requires a sealed Report Package and authenticated independent review before pass', async () => {
  const gold = service();
  await gold.createBatch({ batchId: 'package-auth-gate', pins: pins() });

  await assert.rejects(
    () => gold.recordAttempt({
      batchId: 'package-auth-gate',
      slotNo: 1,
      attemptId: 'attempt-1',
      result: { kind: 'success', sealed: true, fullReal: true },
    }),
    (error: unknown) => error instanceof GoldBatchPolicyError,
    'a capability result without a sealed Report Package must not occupy a Gold slot',
  );

  for (const slotNo of [1, 2, 3] as const) {
    await gold.recordAttempt({
      batchId: 'package-auth-gate',
      slotNo,
      attemptId: `attempt-${slotNo}`,
      result: { kind: 'success', sealed: true, fullReal: true, reportPackageId: `package-${slotNo}` } as never,
    });
  }

  await assert.rejects(
    () => gold.submitReview({
      batchId: 'package-auth-gate',
      attemptId: 'attempt-1',
      reviewerId: 'unverified-user',
      independence: { capabilityOwner: false, operator: false, artifactEditor: false },
      verdict: 'usable',
    }),
    (error: unknown) => error instanceof GoldBatchPolicyError,
    'an unauthenticated review must not satisfy the Gold pass gate',
  );
});
