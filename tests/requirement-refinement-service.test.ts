import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ControlTaskDetail } from '../database/control-plane.ts';
import type { ControlRequirementVersion } from '../packages/api-contract/control-workflow.ts';
import type { PlanProgress, ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import type {
  LLMClient,
  LLMResult,
  ModelCallRecordInput,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { ReceiptLLMClient, ModelDriftError } from '../apps/orchestrator-runtime/src/runtime/receipt-llm-client.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import { resolveDeliverable } from '../apps/orchestrator-runtime/src/report/deliverable-registry.ts';

type RefinementModule = typeof import('../apps/orchestrator-runtime/src/control/requirement-refinement-service.ts');

const ownerUserId = 'owner-1';
const conversationId = 'conversation-1';
const taskId = 'task-1';
const planningProgress: PlanProgress = {
  phase: 'candidates',
  status: 'done',
  label: '生成候选方案',
  detail: 'depth · speed',
};

function requirement(overrides: Partial<ResearchTaskV2> = {}): ResearchTaskV2 {
  return {
    version: 'research-task-v2',
    task_type: 'competitive_research',
    business_domain: 'live-commerce',
    research_goal: 'compare live-commerce competitors',
    target_audience: ['product team'],
    scope: ['public web sources'],
    constraints: [],
    success_criteria: [{ id: 'criterion-1', statement: 'produce a comparison matrix' }],
    expected_deliverables: ['competitive_analysis_report'],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'internal',
    pii_detected: false,
    ...overrides,
  };
}

const ambiguousRequirement = requirement({
  ambiguities: [{ id: 'audience', statement: 'target audience is unclear', blocking: true }],
  clarification_questions: [{
    key: 'audience',
    question: 'Who is the target audience?',
    rationale: 'The comparison depends on audience needs',
  }],
});

class FixtureLLM implements LLMClient {
  readonly calls: Array<{ context?: object; schemaName: string; prompt: string }> = [];
  constructor(
    private readonly fixtures: ResearchTaskV2[],
    private readonly modelName = 'pinned-model',
  ) {}
  get identity() {
    return {
      provider: 'fixture', endpointHost: 'fixture', requestedModel: this.modelName,
      mode: 'mock' as const, eligibleAsReal: false,
    };
  }
  async generateStructured<T>(opts: { context?: object; schemaName: string; prompt: string; schema: object; receipt: { expectedModel?: string } }): Promise<LLMResult<T>> {
    this.calls.push({ context: opts.context, schemaName: opts.schemaName, prompt: opts.prompt });
    const data = this.fixtures.shift();
    if (!data) throw new Error('fixture exhausted');
    return {
      data: data as T,
      promptHash: 'sha256:fixture',
      modelName: this.modelName,
      modelVersion: 'v1',
      traceId: 'trace_fixture',
    };
  }
  async generateText(): Promise<never> {
    throw new Error('not used');
  }
}

class Recorder {
  readonly calls: ModelCallRecordInput[] = [];
  async recordModelCall(input: ModelCallRecordInput): Promise<string> {
    this.calls.push(input);
    return '11111111-1111-4111-8111-111111111123';
  }
}

function makeRepository() {
  const versions: ControlRequirementVersion[] = [];
  const activations: Array<{ id: string; expectedVersion: number }> = [];
  const events: string[] = [];
  let stateVersion = 1;
  const task: ControlTaskDetail = {
    id: taskId,
    conversationId,
    originalInput: 'raw original input from task',
    ownerUserId,
    conversationOwnerUserId: ownerUserId,
    structuredTask: null,
    state: 'awaiting_clarification',
    stateVersion,
    activePlanVersionId: null,
    currentAttemptId: null,
    activeRequirementVersionId: null,
  };
  return {
    versions,
    activations,
    events,
    async getTaskDetail() {
      const active = versions.at(-1);
      return {
        ...task,
        stateVersion,
        structuredTask: active?.structuredTask ?? null,
        activeRequirementVersionId: active?.id ?? null,
      };
    },
    async createAndActivateRequirementVersion(input: {
      taskId: string;
      ownerUserId: string;
      expectedVersion: number;
      rawInputHash: string;
      clarification: unknown;
      structuredTask: ResearchTaskV2;
      modelCallId?: string | null;
    }) {
      events.push('persist_activate');
      const stored: ControlRequirementVersion = {
        id: `requirement-${versions.length + 1}`,
        taskId: input.taskId,
        version: versions.length + 1,
        rawInputHash: input.rawInputHash,
        clarification: input.clarification,
        structuredTask: input.structuredTask,
        modelCallId: input.modelCallId ?? null,
        createdAt: new Date(),
      };
      versions.push(stored);
      stateVersion += 1;
      return { version: stored, task: { ...task, stateVersion, activeRequirementVersionId: stored.id } };
    },
    async getActiveRequirementVersion() {
      return versions.at(-1) ?? null;
    },
  };
}

function makeConversations() {
  const messages = [
    { role: 'user', content: 'owner history' },
    { role: 'assistant', content: 'owner answer' },
  ];
  const appended: Array<{
    role: 'user' | 'assistant';
    content: string;
    idempotencyKey?: string;
  }> = [];
  const appendAttempts: typeof appended = [];
  const keyedMessages = new Map<string, (typeof appended)[number]>();
  return {
    messages,
    appended,
    appendAttempts,
    async requireOwned(input: { conversationId: string; ownerUserId: string }) {
      assert.equal(input.conversationId, conversationId);
      assert.equal(input.ownerUserId, ownerUserId);
      return { id: conversationId };
    },
    async listMessages() {
      return messages;
    },
    async appendMessage(input: {
      conversationId: string;
      role: 'user' | 'assistant';
      content: string;
      idempotencyKey?: string;
    }) {
      assert.equal(input.conversationId, conversationId);
      appendAttempts.push(input);
      if (input.idempotencyKey) {
        if (keyedMessages.has(input.idempotencyKey)) return;
        keyedMessages.set(input.idempotencyKey, input);
      }
      appended.push(input);
    },
  };
}

async function loadModule(): Promise<RefinementModule> {
  return await import('../apps/orchestrator-runtime/src/control/requirement-refinement-service.ts');
}

test('explicit requirements return ready_to_plan and invoke planner with finalized requirement', async () => {
  const { RequirementRefinementService } = await loadModule();
  const finalized = requirement({
    comparison_dimensions: ['需求理解', '推荐可解释性', '内容可信度'],
  });
  const llm = new FixtureLLM([finalized]);
  const repository = makeRepository();
  const conversations = makeConversations();
  let planned: { originalInput: string; requirement: ResearchTaskV2 } | null = null;
  const progress: PlanProgress[] = [];
  const service = new RequirementRefinementService({
    llm,
    validator: new SchemaValidator(),
    repository,
    conversations,
    expectedActualModel: 'pinned-model',
    planner: {
      async plan(
        input: { originalInput: string; requirement: ResearchTaskV2 },
        onProgress?: (event: PlanProgress) => void,
      ) {
        planned = input;
        onProgress?.(planningProgress);
      },
    },
  });

  const result = await service.understand({
    taskId,
    conversationId,
    ownerUserId,
    originalInput: 'compare live-commerce competitors',
  }, (event) => progress.push(event));

  assert.equal(result.status, 'ready_to_plan');
  assert.deepEqual(result.requirement, finalized);
  assert.deepEqual(planned, { originalInput: 'compare live-commerce competitors', requirement: finalized });
  assert.match(llm.calls[0]?.prompt ?? '', /原顺序.*comparison_dimensions/u);
  assert.deepEqual(progress, [planningProgress]);
  assert.deepEqual(repository.events, ['persist_activate']);
});

test('explicit weighted scoring matrix overrides unrelated LLM comparison dimensions before persistence', async () => {
  const { RequirementRefinementService } = await loadModule();
  const weightedDimensions = [
    '宠物心智定位清晰度',
    '六类设计表达覆盖度',
    '功能适配与可达性',
    '情感叙事',
    '服务旅程闭环',
    '内容可信度与证据充分度',
    '可持续性与包容性',
  ];
  const generated = requirement({
    comparison_dimensions: ['品牌视觉', '包装', '产品', '空间', '数字体验', '内容与服务'],
    constraints: [
      {
        id: 'scoring-matrix',
        source: 'user',
        statement: '矩阵采用5分制并按权重：宠物心智定位清晰度20%、六类设计表达覆盖度20%、功能适配与可达性15%、情感叙事15%、服务旅程闭环15%、内容可信度与证据充分度10%、可持续性与包容性5%。',
      },
      {
        id: 'key-case-selection',
        source: 'user',
        statement: '关键案例按设计创新性30%、市场/地区/行业代表性25%、证据充分度25%、加权矩阵总分20%选择。',
      },
    ],
  });
  const repository = makeRepository();
  let plannedRequirement: ResearchTaskV2 | undefined;
  const service = new RequirementRefinementService({
    llm: new FixtureLLM([generated]),
    validator: new SchemaValidator(),
    repository,
    conversations: makeConversations(),
    planner: {
      async plan(input: { requirement: ResearchTaskV2 }) {
        plannedRequirement = input.requirement;
      },
    },
  });

  const result = await service.understand({
    taskId,
    conversationId,
    ownerUserId,
    originalInput: '研究宠物心智设计表达，并使用已声明的加权矩阵。',
  });

  assert.equal(result.status, 'ready_to_plan');
  assert.deepEqual(result.requirement.comparison_dimensions, weightedDimensions);
  assert.deepEqual(repository.versions[0]?.structuredTask.comparison_dimensions, weightedDimensions);
  assert.deepEqual(plannedRequirement?.comparison_dimensions, weightedDimensions);
});

test('explicit clarification questions remain before planning even when ambiguities are non-blocking', async () => {
  const { RequirementRefinementService } = await loadModule();
  const nonBlocking = requirement({
    ambiguities: [{ id: 'format', statement: 'report format can be confirmed later', blocking: false }],
    clarification_questions: [{
      key: 'format',
      question: 'Which report format is preferred?',
      rationale: 'This changes presentation but does not block research.',
    }],
  });
  const repository = makeRepository();
  let plannerCalls = 0;
  const service = new RequirementRefinementService({
    llm: new FixtureLLM([nonBlocking]),
    validator: new SchemaValidator(),
    repository,
    conversations: makeConversations(),
    planner: { async plan() { plannerCalls += 1; } },
  });

  const result = await service.understand({
    taskId,
    conversationId,
    ownerUserId,
    originalInput: 'compare competitors with screenshots',
  });

  assert.equal(result.status, 'clarification_required');
  assert.equal(plannerCalls, 0);
});

test('blocking issues proceed to planning and remain available for the approval gate', async () => {
  const { RequirementRefinementService } = await loadModule();
  const approvalRequired = requirement({
    blocking_issues: [{
      key: 'internal-screenshot-use',
      kind: 'compliance_risk',
      reason: 'Internal use is allowed but distribution requires approval.',
    }],
  });
  const plannedRequirements: ResearchTaskV2[] = [];
  const service = new RequirementRefinementService({
    llm: new FixtureLLM([approvalRequired]),
    validator: new SchemaValidator(),
    repository: makeRepository(),
    conversations: makeConversations(),
    planner: { async plan(input: { requirement: ResearchTaskV2 }) { plannedRequirements.push(input.requirement); } },
  });

  const result = await service.understand({
    taskId,
    conversationId,
    ownerUserId,
    originalInput: 'compare internal screenshots',
  });

  assert.equal(result.status, 'ready_to_plan');
  assert.deepEqual(plannedRequirements[0]?.blocking_issues, approvalRequired.blocking_issues);
});

test('ambiguous requirements return clarification_required without invoking planner', async () => {
  const { RequirementRefinementService } = await loadModule();
  const llm = new FixtureLLM([ambiguousRequirement]);
  const repository = makeRepository();
  const conversations = makeConversations();
  let plannerCalls = 0;
  const service = new RequirementRefinementService({
    llm,
    validator: new SchemaValidator(),
    repository,
    conversations,
    planner: { async plan() { plannerCalls += 1; } },
  });

  const result = await service.understand({
    taskId,
    conversationId,
    ownerUserId,
    originalInput: 'compare competitors',
  });

  assert.equal(result.status, 'clarification_required');
  assert.equal(result.requirement.ambiguities[0]?.blocking, true);
  assert.equal(plannerCalls, 0);
});

test('Planning Guidance direction selection is persisted and resumes planning without another requirement LLM call', async () => {
  const { InvalidScenarioSelectionError, RequirementRefinementService } = await loadModule();
  const finalized = requirement({
    task_type: 'user_research_planning',
    research_goal: '梳理宠物心智的设计表达策略全景',
    expected_deliverables: ['research_plan'],
  });
  const llm = new FixtureLLM([finalized]);
  const repository = makeRepository();
  const planningGuidance = {
    reasonCode: 'scenario_selection_required' as const,
    options: [
      { id: 'user-material-synthesis', label: '已有用户资料归纳' },
      { id: 'user-segmentation', label: '用户分层' },
      { id: 'user-journey-insight', label: '用户旅程与需求洞察' },
      { id: 'root-cause-analysis', label: '问题根因拆解' },
      { id: 'metrics-validation', label: '指标与验证计划' },
    ],
  };
  const plannedSelections: Array<string | undefined> = [];
  const service = new RequirementRefinementService({
    llm,
    validator: new SchemaValidator(),
    repository,
    conversations: makeConversations(),
    planner: {
      async plan(input) {
        plannedSelections.push(input.selectedScenarioId);
        if (plannedSelections.length === 1) {
          return {
            kind: 'planning_guidance_clarification' as const,
            activatedNodes: ['D1_research_goal'],
            planningGuidance,
          };
        }
      },
    },
  });

  const awaitingDirection = await service.understand({
    taskId,
    conversationId,
    ownerUserId,
    originalInput: finalized.research_goal,
  });

  assert.equal(awaitingDirection.status, 'clarification_required');
  assert.deepEqual(awaitingDirection.planningGuidance, planningGuidance);
  assert.deepEqual(awaitingDirection.activatedNodes, ['D1_research_goal']);
  assert.deepEqual(repository.versions[1]?.clarification, { planningGuidance });

  await assert.rejects(
    () => service.clarify({
      taskId,
      conversationId,
      ownerUserId,
      answers: { assumption_edits: {} },
      selectedScenarioId: 'competitor-benchmark-research',
      expectedVersion: 3,
    }),
    (error: unknown) => error instanceof InvalidScenarioSelectionError,
  );

  const resumed = await service.clarify({
    taskId,
    conversationId,
    ownerUserId,
    answers: { assumption_edits: {} },
    selectedScenarioId: 'user-journey-insight',
    expectedVersion: 3,
  });

  assert.equal(resumed.status, 'ready_to_plan');
  assert.deepEqual(plannedSelections, [undefined, 'user-journey-insight']);
  assert.equal(llm.calls.length, 1);
  assert.deepEqual(repository.versions[2]?.clarification, {
    planningGuidance,
    selectedScenarioId: 'user-journey-insight',
    answers: { assumption_edits: {} },
  });
});

test('a changed task type discards the stale Scenario and returns a fresh direction gate', async () => {
  const { RequirementRefinementService } = await loadModule();
  const initial = requirement({
    task_type: 'user_research_planning',
    research_goal: '规划用户研究',
    expected_deliverables: ['research_plan'],
  });
  const changed = requirement({
    task_type: 'design_audit',
    research_goal: '走查现有页面',
    expected_deliverables: ['design_audit_report'],
  });
  const oldGuidance = {
    reasonCode: 'scenario_selection_required' as const,
    options: [{ id: 'user-segmentation', label: '用户分层' }],
  };
  const newGuidance = {
    reasonCode: 'scenario_selection_required' as const,
    options: [{ id: 'experience-walkthrough', label: '页面与链路体验走查' }],
  };
  const llm = new FixtureLLM([initial, changed]);
  const repository = makeRepository();
  const plannedSelections: Array<string | undefined> = [];
  const service = new RequirementRefinementService({
    llm,
    validator: new SchemaValidator(),
    repository,
    conversations: makeConversations(),
    planner: {
      async plan(input) {
        plannedSelections.push(input.selectedScenarioId);
        return {
          kind: 'planning_guidance_clarification' as const,
          activatedNodes: ['D1_research_goal'],
          planningGuidance: plannedSelections.length === 1 ? oldGuidance : newGuidance,
        };
      },
    },
  });

  const awaitingDirection = await service.understand({
    taskId,
    conversationId,
    ownerUserId,
    originalInput: initial.research_goal,
  });
  assert.equal(awaitingDirection.status, 'clarification_required');

  const refreshedDirection = await service.clarify({
    taskId,
    conversationId,
    ownerUserId,
    answers: { actual_task: 'design audit' },
    selectedScenarioId: 'user-segmentation',
    expectedVersion: 3,
  });

  assert.equal(refreshedDirection.status, 'clarification_required');
  assert.deepEqual(refreshedDirection.planningGuidance, newGuidance);
  assert.deepEqual(plannedSelections, [undefined, undefined]);
  assert.equal(repository.versions.at(-1)?.structuredTask.task_type, 'design_audit');
  assert.deepEqual(repository.versions.at(-1)?.clarification, { planningGuidance: newGuidance });
});

test('Planning Guidance retries the same edited assumptions after post-activation planning failure', async () => {
  const { RequirementRefinementService } = await loadModule();
  const initial = requirement({
    task_type: 'user_research_planning',
    research_goal: '梳理宠物心智的设计表达策略全景',
    expected_deliverables: ['research_plan'],
    assumptions: [{ key: 'scope', value: 'public web sources', editable: true }],
  });
  const edited = requirement({
    ...initial,
    assumptions: [{ key: 'scope', value: 'customer interviews', editable: true }],
  });
  const llm = new FixtureLLM([initial, edited]);
  const repository = makeRepository();
  const planningGuidance = {
    reasonCode: 'scenario_selection_required' as const,
    options: [{ id: 'user-journey-insight', label: '用户旅程与需求洞察' }],
  };
  let plannerCalls = 0;
  const service = new RequirementRefinementService({
    llm,
    validator: new SchemaValidator(),
    repository,
    conversations: makeConversations(),
    planner: {
      async plan() {
        plannerCalls += 1;
        if (plannerCalls === 1) {
          return {
            kind: 'planning_guidance_clarification' as const,
            activatedNodes: ['D1_research_goal'],
            planningGuidance,
          };
        }
        if (plannerCalls === 2) throw new Error('simulated planning failure after Scenario activation');
      },
    },
  });

  await service.understand({
    taskId,
    conversationId,
    ownerUserId,
    originalInput: initial.research_goal,
  });
  const answers = { assumption_edits: { scope: 'customer interviews' } };
  await assert.rejects(
    () => service.clarify({
      taskId,
      conversationId,
      ownerUserId,
      answers,
      selectedScenarioId: 'user-journey-insight',
      expectedVersion: 3,
    }),
    /simulated planning failure after Scenario activation/,
  );

  const retried = await service.clarify({
    taskId,
    conversationId,
    ownerUserId,
    answers,
    selectedScenarioId: 'user-journey-insight',
    expectedVersion: 4,
  });

  assert.equal(retried.status, 'ready_to_plan');
  assert.deepEqual(retried.requirement, edited);
  assert.deepEqual(repository.versions[2]?.clarification, {
    planningGuidance,
    selectedScenarioId: 'user-journey-insight',
    answers,
  });
  assert.equal(repository.versions.length, 3, 'retry must reuse the activated Requirement');
  assert.equal(llm.calls.length, 2, 'retry must not call requirement clarification again');
  assert.equal(plannerCalls, 3);
});

test('clarification answers persist a new v2 and clear blocking ambiguity before planning', async () => {
  const { RequirementRefinementService } = await loadModule();
  const clearRequirement = requirement({
    target_audience: ['enterprise buyers'],
    scope: ['global market including overseas'],
  });
  const llm = new FixtureLLM([ambiguousRequirement, clearRequirement]);
  const repository = makeRepository();
  const conversations = makeConversations();
  const events = repository.events;
  let plannedInput = '';
  let plannerCalls = 0;
  const progress: PlanProgress[] = [];
  const service = new RequirementRefinementService({
    llm,
    validator: new SchemaValidator(),
    repository,
    conversations,
    planner: {
      async plan(
        input: { originalInput: string },
        onProgress?: (event: PlanProgress) => void,
      ) {
        events.push('plan');
        plannedInput = input.originalInput;
        plannerCalls += 1;
        onProgress?.(planningProgress);
      },
    },
  });

  await service.understand({ taskId, conversationId, ownerUserId, originalInput: 'compare competitors' });
  const result = await service.clarify({
    taskId,
    conversationId,
    ownerUserId,
    answers: { audience: 'enterprise buyers', geo_scope: 'include overseas markets' },
  }, (event) => progress.push(event));

  assert.equal(result.status, 'ready_to_plan');
  assert.equal(result.requirement.version, 'research-task-v2');
  assert.equal(result.requirement.ambiguities.some((item) => item.blocking), false);
  assert.equal(result.requirement.clarification_questions.length, 0);
  assert.deepEqual(result.requirement.scope, ['global market including overseas']);
  assert.deepEqual(
    (llm.calls[1]?.context as { clarification?: unknown } | undefined)?.clarification,
    { audience: 'enterprise buyers', geo_scope: 'include overseas markets' },
  );
  assert.deepEqual(repository.versions.map((version) => version.version), [1, 2]);
  assert.deepEqual(events.slice(-2), ['persist_activate', 'plan']);
  assert.equal(plannedInput, 'raw original input from task');
  assert.equal(plannerCalls, 1);
  assert.deepEqual(progress, [planningProgress]);
});

test('post-activation retry emits the ready message only after planning succeeds', async () => {
  const { RequirementRefinementService } = await loadModule();
  const clearRequirement = requirement({ target_audience: ['enterprise buyers'] });
  const llm = new FixtureLLM([ambiguousRequirement, clearRequirement]);
  const repository = makeRepository();
  const conversations = makeConversations();
  let plannerCalls = 0;
  const service = new RequirementRefinementService({
    llm,
    validator: new SchemaValidator(),
    repository,
    conversations,
    planner: {
      async plan() {
        plannerCalls += 1;
        if (plannerCalls === 1) throw new Error('simulated failure after assistant append');
      },
    },
  });

  await service.understand({
    taskId,
    conversationId,
    ownerUserId,
    originalInput: 'compare competitors',
  });
  const answers = { audience: 'enterprise buyers' };
  await assert.rejects(
    () => service.clarify({
      taskId,
      conversationId,
      ownerUserId,
      answers,
      expectedVersion: 2,
    }),
    /simulated failure after assistant append/,
  );
  const result = await service.clarify({
    taskId,
    conversationId,
    ownerUserId,
    answers,
    expectedVersion: 2,
  });

  assert.equal(result.status, 'ready_to_plan');
  const readyAttempts = conversations.appendAttempts.filter((message) =>
    message.content.includes('ready_to_plan')
  );
  assert.deepEqual(
    readyAttempts.map((message) => message.idempotencyKey),
    ['requirement:requirement-2:assistant'],
  );
  assert.equal(
    conversations.appended.filter((message) => message.content.includes('ready_to_plan')).length,
    1,
  );
});

test('hydrated assumption edits equal to the finalized active Requirement recover without another version or LLM call', async () => {
  const { RequirementRefinementService } = await loadModule();
  const finalized = requirement({
    target_audience: ['enterprise buyers'],
    assumptions: [{ key: 'scope', value: 'public web sources', editable: true }],
  });
  const llm = new FixtureLLM([ambiguousRequirement, finalized]);
  const repository = makeRepository();
  const conversations = makeConversations();
  let plannerCalls = 0;
  const service = new RequirementRefinementService({
    llm,
    validator: new SchemaValidator(),
    repository,
    conversations,
    planner: {
      async plan() {
        plannerCalls += 1;
        if (plannerCalls === 1) throw new Error('simulated failure after finalized Requirement activation');
      },
    },
  });

  await service.understand({
    taskId,
    conversationId,
    ownerUserId,
    originalInput: 'compare competitors',
  });
  await assert.rejects(
    () => service.clarify({
      taskId,
      conversationId,
      ownerUserId,
      answers: { audience: 'enterprise buyers' },
      expectedVersion: 2,
    }),
    /simulated failure after finalized Requirement activation/,
  );
  assert.equal(repository.versions.length, 2);
  assert.equal(llm.calls.length, 2);

  const result = await service.clarify({
    taskId,
    conversationId,
    ownerUserId,
    answers: { assumption_edits: { scope: 'public web sources' } },
    expectedVersion: 3,
  });

  assert.equal(result.status, 'ready_to_plan');
  assert.deepEqual(result.requirement, finalized);
  assert.deepEqual(result.clarificationRecovery, {
    mode: 'latest_finalized_requirement',
    activeRequirementVersionId: 'requirement-2',
  });
  assert.equal(repository.versions.length, 2, 'unchanged hydrated edits must not create Requirement v3');
  assert.equal(llm.calls.length, 2, 'unchanged hydrated edits must not call requirement clarification again');
  assert.equal(plannerCalls, 2);
});

test('only owner-scoped conversation history is sent to the refinement LLM', async () => {
  const { RequirementRefinementService } = await loadModule();
  const llm = new FixtureLLM([requirement()]);
  const repository = makeRepository();
  const conversations = makeConversations();
  const service = new RequirementRefinementService({
    llm,
    validator: new SchemaValidator(),
    repository,
    conversations,
  });

  await service.understand({ taskId, conversationId, ownerUserId, originalInput: 'compare competitors' });

  const context = llm.calls[0]?.context as { messages: Array<{ role: string; content: string }> };
  assert.deepEqual(context.messages, conversations.messages);
  assert.equal(context.messages.some((message) => message.content === 'foreign history'), false);
});

test('model drift fails closed before requirement activation', async () => {
  const { RequirementRefinementService } = await loadModule();
  const llm = new FixtureLLM([requirement()], 'actual-model');
  const recorder = new Recorder();
  const repository = makeRepository();
  const conversations = makeConversations();
  const service = new RequirementRefinementService({
    llm: new ReceiptLLMClient(llm, recorder),
    validator: new SchemaValidator(),
    repository,
    conversations,
    expectedActualModel: 'pinned-model',
  });

  await assert.rejects(
    () => service.understand({ taskId, conversationId, ownerUserId, originalInput: 'compare competitors' }),
    (error: unknown) => error instanceof ModelDriftError,
  );
  assert.equal(repository.versions.length, 0);
  assert.equal(repository.activations.length, 0);
  assert.equal(recorder.calls[0]?.status, 'failed');
});

const LOCALIZED_REFINEMENT_CASES: Array<{
  taskType: ResearchTaskV2['task_type'];
  localized: string;
  canonical: string;
}> = [
  { taskType: 'user_research_planning', localized: '用户研究计划', canonical: 'research_plan' },
  { taskType: 'competitive_research', localized: '竞品分析报告', canonical: 'competitive_analysis_report' },
  { taskType: 'voc_diagnosis', localized: '用户之声诊断报告', canonical: 'voc_diagnosis_report' },
  { taskType: 'design_audit', localized: '设计走查报告', canonical: 'design_audit_report' },
  { taskType: 'a11y_audit', localized: '无障碍审计报告', canonical: 'accessibility_audit_report' },
];

for (const refinementCase of LOCALIZED_REFINEMENT_CASES) {
  test(`canonicalizes ${refinementCase.taskType} localized expected_deliverables before persistence and planning`, async () => {
    const { RequirementRefinementService } = await loadModule();
    const generated = requirement({
      task_type: refinementCase.taskType,
      expected_deliverables: [refinementCase.localized],
    });
    const llm = new FixtureLLM([generated]);
    const repository = makeRepository();
    const conversations = makeConversations();
    let plannedRequirement: ResearchTaskV2 | undefined;
    const service = new RequirementRefinementService({
      llm,
      validator: new SchemaValidator(),
      repository,
      conversations,
      planner: {
        async plan(input: { requirement: ResearchTaskV2 }) {
          plannedRequirement = input.requirement;
        },
      },
    });

    const result = await service.understand({
      taskId,
      conversationId,
      ownerUserId,
      originalInput: `请生成${refinementCase.localized}`,
    });

    assert.equal(result.status, 'ready_to_plan');
    assert.deepEqual(result.requirement.expected_deliverables, [refinementCase.canonical]);
    assert.deepEqual(repository.versions[0]?.structuredTask.expected_deliverables, [refinementCase.canonical]);
    assert.deepEqual(plannedRequirement?.expected_deliverables, [refinementCase.canonical]);
    assert.deepEqual(repository.versions.map(({ version }) => version), [1]);
    assert.equal(result.requirement.version, 'research-task-v2');
    assert.equal(repository.versions[0]?.structuredTask.version, 'research-task-v2');
    assert.equal(plannedRequirement?.version, 'research-task-v2');
  });
}

test('clarification LLM output is canonicalized before Requirement v2 persistence and planning', async () => {
  const { RequirementRefinementService } = await loadModule();
  const clarified = requirement({
    task_type: 'competitive_research',
    target_audience: ['enterprise buyers'],
    expected_deliverables: ['竞品分析报告'],
  });
  const localizedAmbiguous = requirement({
    expected_deliverables: ['竞品分析报告'],
    ambiguities: [{ id: 'audience', statement: 'target audience is unclear', blocking: true }],
    clarification_questions: [{
      key: 'audience',
      question: 'Who is the target audience?',
      rationale: 'The comparison depends on audience needs',
    }],
  });
  const llm = new FixtureLLM([localizedAmbiguous, clarified]);
  const repository = makeRepository();
  const conversations = makeConversations();
  let plannedRequirement: ResearchTaskV2 | undefined;
  const service = new RequirementRefinementService({
    llm,
    validator: new SchemaValidator(),
    repository,
    conversations,
    planner: {
      async plan(input: { requirement: ResearchTaskV2 }) {
        plannedRequirement = input.requirement;
      },
    },
  });

  await service.understand({
    taskId,
    conversationId,
    ownerUserId,
    originalInput: '请生成竞品分析报告',
  });
  const result = await service.clarify({
    taskId,
    conversationId,
    ownerUserId,
    answers: { audience: 'enterprise buyers' },
  });

  assert.equal(result.status, 'ready_to_plan');
  assert.deepEqual(result.requirement.expected_deliverables, ['competitive_analysis_report']);
  assert.deepEqual(
    repository.versions.map(({ structuredTask }) => structuredTask.expected_deliverables),
    [['competitive_analysis_report'], ['competitive_analysis_report']],
  );
  assert.deepEqual(plannedRequirement?.expected_deliverables, ['competitive_analysis_report']);
  assert.deepEqual(repository.versions.map(({ version }) => version), [1, 2]);
  assert.ok(repository.versions.every(({ structuredTask }) => structuredTask.version === 'research-task-v2'));
  assert.equal(plannedRequirement?.version, 'research-task-v2');
});

test('strict Registry resolver still rejects arbitrary external expected_deliverables labels', () => {
  for (const refinementCase of LOCALIZED_REFINEMENT_CASES) {
    assert.throws(
      () => resolveDeliverable(refinementCase.taskType, ['外部任意报告标签']),
      /incompatible|expectedDeliverables/i,
    );
  }
});
