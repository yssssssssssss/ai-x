import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ControlTaskDetail } from '../database/control-plane.ts';
import type { ControlRequirementVersion } from '../packages/api-contract/control-workflow.ts';
import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import { RequirementRefinementService } from '../apps/orchestrator-runtime/src/control/requirement-refinement-service.ts';
import { resolveCapabilities } from '../apps/orchestrator-runtime/src/planners/capability-resolver.ts';
import {
  resolveEvidenceRequirements,
  resolvePlanningDeliverableSelection,
} from '../apps/orchestrator-runtime/src/planners/research-planning-service.ts';
import { ExecutionScheduler } from '../apps/orchestrator-runtime/src/control/execution-scheduler.ts';
import { resolveExecutionDeliverableContract } from '../apps/orchestrator-runtime/src/report/deliverable-registry.ts';
import type {
  LLMClient,
  LLMResult,
  StructuredLLMCallOptions,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import {
  GoldBatchPolicyError,
  GoldBatchService,
  type GoldBatchDependencies,
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
    taskType: ResearchTaskV2['task_type'];
    businessDomain: string;
    input: string;
    researchGoal: string;
    sensitivity: 'public' | 'internal' | 'confidential';
    piiDetected: boolean;
    variant: 'clear' | 'ambiguous' | 'missing_input' | 'constraint_conflict' | 'pii';
    requiredCoreTool: string;
    expectedDeliverableType: string;
    expectedTaskType: ResearchTaskV2['task_type'];
    expectedDeliverableIds: string[];
    clarificationKeys: string[];
    clarificationThemes: string[];
    forbiddenCapabilities: string[];
    reportSections: string[];
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

type GoldScenario = GoldFixture['scenarios'][number];

function modelRequirement(
  scenario: GoldScenario,
  clarificationRequired: boolean,
): ResearchTaskV2 {
  const ambiguities = clarificationRequired
    ? scenario.clarificationKeys.map((key, index) => ({
        id: key,
        statement: scenario.clarificationThemes[index] ?? key,
        blocking: true,
      }))
    : [];
  return {
    version: 'research-task-v2',
    task_type: scenario.taskType,
    business_domain: scenario.businessDomain,
    research_goal: scenario.researchGoal,
    target_audience: ['Gold reviewer'],
    scope: [scenario.businessDomain],
    constraints: scenario.variant === 'constraint_conflict'
      ? [
          { id: `${scenario.id}-user-constraint`, statement: 'Prioritize delivery speed', source: 'user' },
          { id: `${scenario.id}-policy-constraint`, statement: 'Preserve required evidence', source: 'policy' },
        ]
      : [],
    success_criteria: [{ id: `${scenario.id}-success`, statement: scenario.researchGoal }],
    expected_deliverables: [...scenario.expectedDeliverableIds],
    assumptions: [],
    ambiguities,
    clarification_questions: clarificationRequired
      ? scenario.clarificationKeys.map((key, index) => ({
          key,
          question: `Clarify ${scenario.clarificationThemes[index] ?? key}`,
          rationale: scenario.clarificationThemes[index] ?? key,
        }))
      : [],
    blocking_issues: scenario.piiDetected
      ? [{ key: 'pii-handling', reason: 'PII requires controlled handling', kind: 'privacy' }]
      : [],
    sensitivity: scenario.sensitivity,
    pii_detected: scenario.piiDetected,
  };
}

class ScenarioLLM implements LLMClient {
  readonly calls: Array<{ stage: string; clarification: unknown }> = [];

  constructor(private readonly scenario: GoldScenario) {}

  get identity() {
    return {
      provider: 'semantic-gold-fixture',
      endpointHost: 'local-fixture',
      requestedModel: 'semantic-gold-model',
      mode: 'mock' as const,
      eligibleAsReal: false,
    };
  }

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    assert.equal(options.schemaName, 'research-task-v2');
    const context = options.context as {
      original_input: string;
      clarification: unknown;
    };
    assert.equal(context.original_input, this.scenario.input);
    const clarificationRequired = context.clarification === null
      && this.scenario.clarificationKeys.length > 0;
    if (context.clarification !== null) {
      assert.deepEqual(
        Object.keys(context.clarification as Record<string, unknown>).sort(),
        [...this.scenario.clarificationKeys].sort(),
      );
    }
    this.calls.push({
      stage: options.receipt.stage,
      clarification: context.clarification,
    });
    return {
      data: modelRequirement(this.scenario, clarificationRequired) as T,
      promptHash: `sha256:${this.scenario.id}`,
      modelName: 'semantic-gold-model',
      modelVersion: 'v1',
      traceId: `trace-${this.scenario.id}-${this.calls.length}`,
    };
  }

  async generateText(): Promise<never> {
    throw new Error('semantic Gold requirement refinement does not use text generation');
  }
}

class ScenarioRequirementRepository {
  readonly versions: ControlRequirementVersion[] = [];
  private stateVersion = 0;

  constructor(private readonly scenario: GoldScenario) {}

  async getTaskDetail(): Promise<ControlTaskDetail> {
    const active = this.versions.at(-1);
    return {
      id: `task-${this.scenario.id}`,
      conversationId: `conversation-${this.scenario.id}`,
      originalInput: this.scenario.input,
      ownerUserId: 'semantic-gold-owner',
      conversationOwnerUserId: 'semantic-gold-owner',
      structuredTask: active?.structuredTask ?? null,
      state: active?.structuredTask.ambiguities.some((ambiguity) => ambiguity.blocking)
        ? 'awaiting_clarification'
        : 'awaiting_selection',
      stateVersion: this.stateVersion,
      activePlanVersionId: null,
      currentAttemptId: null,
      activeRequirementVersionId: active?.id ?? null,
    };
  }

  async getActiveRequirementVersion(): Promise<ControlRequirementVersion | null> {
    return this.versions.at(-1) ?? null;
  }

  async createAndActivateRequirementVersion(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    rawInputHash: string;
    clarification: unknown;
    structuredTask: ResearchTaskV2;
    modelCallId?: string | null;
  }): Promise<{ version: ControlRequirementVersion; task: ControlTaskDetail }> {
    assert.equal(input.taskId, `task-${this.scenario.id}`);
    assert.equal(input.ownerUserId, 'semantic-gold-owner');
    assert.equal(input.expectedVersion, this.stateVersion);
    const version: ControlRequirementVersion = {
      id: `requirement-${this.scenario.id}-${this.versions.length + 1}`,
      taskId: input.taskId,
      version: this.versions.length + 1,
      rawInputHash: input.rawInputHash,
      clarification: input.clarification,
      structuredTask: input.structuredTask,
      modelCallId: input.modelCallId ?? null,
      createdAt: new Date(0),
    };
    this.versions.push(version);
    this.stateVersion += 1;
    return { version, task: await this.getTaskDetail() };
  }
}

async function refineScenario(scenario: GoldScenario): Promise<{
  task: ResearchTaskV2;
  llm: ScenarioLLM;
  repository: ScenarioRequirementRepository;
}> {
  const llm = new ScenarioLLM(scenario);
  const repository = new ScenarioRequirementRepository(scenario);
  const service = new RequirementRefinementService({
    llm,
    validator: new SchemaValidator(),
    repository,
    conversations: {
      async requireOwned({ conversationId, ownerUserId }) {
        assert.equal(conversationId, `conversation-${scenario.id}`);
        assert.equal(ownerUserId, 'semantic-gold-owner');
        return { id: conversationId };
      },
      async listMessages() {
        return [{ role: 'user', content: scenario.input }];
      },
      async appendMessage() {},
    },
    expectedActualModel: 'semantic-gold-model',
  });
  const input = {
    taskId: `task-${scenario.id}`,
    conversationId: `conversation-${scenario.id}`,
    ownerUserId: 'semantic-gold-owner',
  };
  const understood = await service.understand({ ...input, originalInput: scenario.input });
  if (scenario.clarificationKeys.length === 0) {
    assert.equal(understood.status, 'ready_to_plan', scenario.id);
    return { task: understood.requirement, llm, repository };
  }

  assert.equal(understood.status, 'clarification_required', scenario.id);
  assert.deepEqual(
    understood.requirement.clarification_questions.map(({ key }) => key),
    scenario.clarificationKeys,
    scenario.id,
  );
  assert.deepEqual(
    understood.requirement.ambiguities.map(({ statement }) => statement),
    scenario.clarificationThemes,
    scenario.id,
  );
  const clarified = await service.clarify({
    ...input,
    answers: Object.fromEntries(
      scenario.clarificationKeys.map((key, index) => [key, scenario.clarificationThemes[index] ?? key]),
    ),
  });
  assert.equal(clarified.status, 'ready_to_plan', scenario.id);
  return { task: clarified.requirement, llm, repository };
}

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

  async createBatch(input: { batchId: string; pinsHash: string; pins: GoldPins }): Promise<void> {
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
  const dependencies: GoldBatchDependencies = {
    reportPackages: {
      verify: async ({ artifactId, attemptId }) => {
        if (artifactId !== `package-${attemptId.replace(/^attempt-/u, '')}`) {
          throw new Error('Report Package is not verified');
        }
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
      verifyReviewer: async () => ({
        authenticated: false,
        independence: { capabilityOwner: false, operator: false, artifactEditor: false },
      }),
    },
  };
  return new GoldBatchService(new MemoryGoldStore(), dependencies);
}

test('semantic Gold fixture contains exactly 27 scenarios and distinct digital-human fixtures', () => {
  assert.equal(fixture.version, 1);
  assert.deepEqual(fixture.profiles, [...TASK_TYPES]);
  assert.equal(fixture.scenarios.length, 27);
  assert.equal(new Set(fixture.scenarios.map((scenario) => scenario.id)).size, 27);
  const scenario = fixture.scenarios.find(({ id }) => id === 'competitive-ai-shopping-assistant');
  assert.ok(scenario);
  assert.equal(scenario.profile, 'competitive_research');
  assert.equal(scenario.variant, 'clear');
  assert.equal(scenario.minVisualAssets, 0, 'draft Registry smoke must retain text fallback');
  assert.equal(
    scenario.input,
    '请对比中国主流电商平台的 AI 购物助手在消费者决策支持体验上的差异，重点比较需求理解、推荐可解释性、商品参数与价格对比、内容可信度、购买转化闭环，并给出京东下一季度产品优先级建议。仅使用 2025—2026 年公开可访问资料，所有关键结论必须附可追溯来源。',
  );

  const ambiguous = fixture.scenarios.find(({ id }) => id === 'competitive-digital-human');
  const gold = fixture.scenarios.find(({ id }) => id === 'competitive-digital-human-gold');
  assert.ok(ambiguous);
  assert.ok(gold);
  assert.equal(ambiguous.variant, 'ambiguous');
  assert.deepEqual(ambiguous.clarificationKeys, ['scope', 'audience']);
  assert.equal(gold.variant, 'clear');
  assert.equal(gold.profile, 'competitive_research');
  assert.equal(gold.piiDetected, false);
  assert.deepEqual(gold.clarificationKeys, []);
});
test('every semantic Gold scenario carries profile contracts and exactly five PII variants', () => {
  const variants = new Set(['clear', 'ambiguous', 'missing_input', 'constraint_conflict', 'pii']);
  assert.equal(fixture.scenarios.filter((scenario) => scenario.piiDetected).length, 5);
  for (const taskType of TASK_TYPES) {
    const scenarios = fixture.scenarios.filter((scenario) => scenario.taskType === taskType);
    assert.deepEqual(new Set(scenarios.map((scenario) => scenario.variant)), variants);
    assert.equal(scenarios.filter((scenario) => scenario.piiDetected).length, 1);
  }
  for (const scenario of fixture.scenarios) {
    assert.ok(scenario.input.trim());
    assert.ok(scenario.researchGoal.trim());
    assert.equal(scenario.expectedTaskType, scenario.taskType, scenario.id);
    assert.deepEqual(scenario.expectedDeliverableIds, [scenario.expectedDeliverableType]);
    assert.ok(Array.isArray(scenario.clarificationKeys));
    assert.ok(Array.isArray(scenario.clarificationThemes));
    assert.ok(scenario.forbiddenCapabilities.length > 0);
    assert.ok(scenario.reportSections.length > 0);
    assert.ok(scenario.reportSections.includes('findings'));
    assert.equal(scenario.requiredCoreTool, 'tavily-web-search');
    assert.ok(scenario.minPublicSources >= 1);
    assert.ok(scenario.minVisualAssets >= 0);
    assert.doesNotMatch(JSON.stringify(scenario), /Bearer |api[_-]?key|password|secret|base64|data:image/i);
  }
});
test('every semantic Gold scenario exercises requirement, planning, capability, deliverable, section, Evidence, and scheduling seams', async () => {
  const professionalId = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u;
  const calls: string[] = [];
  for (const scenario of fixture.scenarios) {
    for (const id of [scenario.id, scenario.profile, scenario.taskType, scenario.expectedDeliverableType, ...scenario.reportSections, ...scenario.forbiddenCapabilities]) {
      assert.match(id, professionalId, `${scenario.id} contains a non-canonical id`);
    }
    const refinement = await refineScenario(scenario);
    const task = refinement.task;
    assert.equal(task.task_type, scenario.expectedTaskType, scenario.id);
    assert.equal(task.business_domain, scenario.businessDomain, scenario.id);
    assert.equal(task.research_goal, scenario.researchGoal, scenario.id);
    assert.deepEqual(task.expected_deliverables, scenario.expectedDeliverableIds, scenario.id);
    assert.equal(task.sensitivity, scenario.sensitivity, scenario.id);
    assert.equal(task.pii_detected, scenario.piiDetected, scenario.id);
    assert.equal(task.ambiguities.some(({ blocking }) => blocking), false, scenario.id);
    assert.deepEqual(task.clarification_questions, [], scenario.id);
    assert.equal(
      refinement.llm.calls.length,
      scenario.clarificationKeys.length > 0 ? 2 : 1,
      scenario.id,
    );
    assert.equal(
      refinement.repository.versions.length,
      scenario.clarificationKeys.length > 0 ? 2 : 1,
      scenario.id,
    );
    const planned = resolvePlanningDeliverableSelection(task);
    assert.equal(planned.deliverableId, scenario.expectedDeliverableType);
    const execution = resolveExecutionDeliverableContract(
      task.task_type,
      task.expected_deliverables,
      scenario.expectedDeliverableType,
    );
    assert.equal(execution.entry.id, scenario.expectedDeliverableType);
    assert.ok(execution.reportTemplate.sections.some((section) => section.id === 'findings'));
    assert.ok(resolveEvidenceRequirements(task.task_type, scenario.expectedDeliverableType as never).length > 0);
    const capability = resolveCapabilities({
      task,
      available_input_roles: [],
      skills: [{
        id: `${scenario.profile}-skill`, name: 'Gold capability', path: 'gold', status: 'active',
        task_types: [task.task_type], inputs: [], outputs: [], required_tools: [scenario.requiredCoreTool],
        optional_tools: [], risk_level: 'low',
      } as never],
      tools: [{
        id: scenario.requiredCoreTool, name: 'Gold core tool', path: 'gold', adapter_type: 'tavily',
        auth_required: true, risk_level: 'low', status: 'active', tier: 'core',
      }],
      tool_states: [{ tool_id: scenario.requiredCoreTool, health: 'healthy', real_adapter_qualified: true }],
      tool_manifests: [{
        id: scenario.requiredCoreTool, name: 'Gold core tool', adapter_type: 'tavily', auth_required: true,
        risk_level: 'low', input_schema: 'gold', output_schema: 'gold',
      }],
      approval_capabilities: [],
    });
    assert.equal(capability.eligible.length, 1);
    const scheduled = await new ExecutionScheduler({
      execute: async (step) => { calls.push(`${scenario.id}:${step.key}`); return step.key; },
    }).schedule({ steps: [{ key: scenario.id, dependsOn: [] }] }, {});
    assert.equal(scheduled.statuses[scenario.id], 'succeeded');
  }
  assert.equal(calls.length, fixture.scenarios.length);
});

test('GoldBatchService rejects a non-real gateway, empty model pin, or non-core tool pin', async () => {
  for (const [name, invalidPins] of [
    ['provider', pins({ provider: 'mock' })],
    ['model', pins({ expectedActualModel: '' })],
    ['core tool', pins({ coreTool: 'fake-web-search' })],
  ] as const) {
    await assert.rejects(
      () => service().createBatch({ batchId: `invalid-${name}`, pins: invalidPins }),
      (error: unknown) => error instanceof GoldBatchPolicyError,
      `${name} drift must be rejected before a Gold batch is created`,
    );
  }
});

test('GoldBatchService accepts a requested model alias pinned to its canonical actual model', async () => {
  await assert.doesNotReject(() => service().createBatch({
    batchId: 'model-alias',
    pins: pins({ requestedModel: 'gateway-route', expectedActualModel: 'canonical-model' }),
  }));
});

test('GoldBatchService requires a sealed Report Package and authenticated independent review before pass', async () => {
  const gold = service();
  await gold.createBatch({ batchId: 'package-auth-gate', pins: pins() });

  await assert.rejects(
    () => gold.recordAttempt({
      batchId: 'package-auth-gate',
      slotNo: 1,
      attemptId: 'attempt-1',
      result: { kind: 'success', fullReal: true },
    }),
    (error: unknown) => error instanceof GoldBatchPolicyError,
    'a capability result without a sealed Report Package must not occupy a Gold slot',
  );

  for (const slotNo of [1, 2, 3] as const) {
    await gold.recordAttempt({
      batchId: 'package-auth-gate',
      slotNo,
      attemptId: `attempt-${slotNo}`,
      result: { kind: 'success', fullReal: true, reportPackageId: `package-${slotNo}` },
    });
  }

  await assert.rejects(
    () => gold.submitReview({
      batchId: 'package-auth-gate',
      attemptId: 'attempt-1',
      reviewerId: 'unverified-user',
      verdict: 'usable',
    }),
    (error: unknown) => error instanceof GoldBatchPolicyError,
    'an unauthenticated review must not satisfy the Gold pass gate',
  );
});
