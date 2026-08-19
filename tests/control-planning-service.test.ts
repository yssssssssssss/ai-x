import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import type {
  ControlPlanCandidatesResponse,
  ControlTaskResponse,
  PlanControlTaskRequest,
} from '../packages/api-contract/control-workflow.ts';
import type {
  CurrentExecutionPlan,
  EvidenceRequirement,
  PendingInput,
} from '../packages/api-contract/research-deliverable.ts';
import type {
  GuidanceRef,
  PlanCandidate,
  PlanProgress,
  ResearchTaskData,
  ResearchTaskV2,
} from '../packages/api-contract/plan.ts';
import type {
  DecisionStateRec,
  PlanProvenance,
} from '../apps/orchestrator-runtime/src/planners/plan-strategy.ts';
import {
  ResearchPlanningService,
  type CurrentResearchPlanningResult,
} from '../apps/orchestrator-runtime/src/planners/research-planning-service.ts';
import type {
  LLMClient,
  LLMResult,
  StructuredLLMCallOptions,
  TextLLMCallOptions,
  TextLLMResult,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { hashPrompt } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

type ResearchPlanningResult = CurrentResearchPlanningResult;

type ProvisionalExecutionPlan = Omit<CurrentExecutionPlan, 'task_id'> & {
  task_id?: '';
};

interface CreateTaskWithCandidatesInput {
  conversationId: string;
  ownerUserId: string;
  originalInput: string;
  taskType: string | null;
  structuredTask: unknown;
  candidates: Array<{
    candidateId: PlanCandidate['id'];
    plan: ProvisionalExecutionPlan;
    pendingInputs: PendingInput[];
  }>;
}

interface PersistedPlanVersion {
  id: string;
  taskId: string;
  version: number;
  candidateId: PlanCandidate['id'];
  plan: CurrentExecutionPlan;
  planHash: string;
  pendingInputs: PendingInput[];
}

interface ControlPlanningDependencies {
  planning: {
    plan(
      input: { originalInput: string },
      onProgress?: (event: PlanProgress) => void,
    ): Promise<ResearchPlanningResult>;
  };
  repository: {
    createTaskWithCandidates(input: CreateTaskWithCandidatesInput): Promise<{
      task: ControlTaskResponse;
      candidates: PersistedPlanVersion[];
    }>;
    persistExistingTaskWithCandidates?(input: {
      taskId: string;
      conversationId: string;
      ownerUserId: string;
      expectedStateVersion: number;
      taskType: string | null;
      structuredTask: unknown;
      candidates: Array<{
        candidateId: PlanCandidate['id'];
        plan: ProvisionalExecutionPlan;
        pendingInputs: PendingInput[];
      }>;
    }): Promise<{
      task: ControlTaskResponse;
      candidates: PersistedPlanVersion[];
    }>;
  };
  conversations: {
    create(input: { ownerUserId: string; title: string }): Promise<{ id: string }>;
    requireOwned(input: { conversationId: string; ownerUserId: string }): Promise<{ id: string }>;
  };
}

interface ControlPlanningServiceLike {
  plan(
    input: PlanControlTaskRequest & { ownerUserId: string },
    onProgress?: (event: PlanProgress) => void,
    onConversation?: (conversationId: string) => void,
  ): Promise<ControlPlanCandidatesResponse>;
  planExistingTask(
    input: {
      taskId: string;
      conversationId: string;
      ownerUserId: string;
      expectedStateVersion: number;
      originalInput: string;
    },
    planningResult: ResearchPlanningResult,
  ): Promise<ControlPlanCandidatesResponse>;
}

type ControlPlanningServiceConstructor = new (
  dependencies: ControlPlanningDependencies,
) => ControlPlanningServiceLike;

interface ControlPlanningModule {
  ControlPlanningService: ControlPlanningServiceConstructor;
}

const controlPlanningModulePath: string =
  '../apps/orchestrator-runtime/src/control/control-planning-service.ts';
const controlPlanningModuleFile = new URL(controlPlanningModulePath, import.meta.url);

async function loadControlPlanningModule(): Promise<ControlPlanningModule> {
  assert.equal(
    existsSync(controlPlanningModuleFile),
    true,
    'ControlPlanningService module must exist',
  );
  // Test-boundary exception: the application module is intentionally absent in this RED.
  // Keep the path non-literal so type-checking reaches the behavioral contract first.
  const moduleExports = await import(controlPlanningModulePath) as unknown as Record<string, unknown>;
  assert.equal(typeof moduleExports.ControlPlanningService, 'function');
  return moduleExports as unknown as ControlPlanningModule;
}

const evidencePolicy: EvidenceRequirement[] = [{
  id: 'research-plan',
  acceptedClasses: ['user_input', 'knowledge', 'public_source'],
  minimumCount: 1,
  required: true,
}];

function researchPlanningResult(originalInput: string): ResearchPlanningResult {
  const structuredTask: ResearchTaskV2 = {
    version: 'research-task-v2',
    task_type: 'user_research_planning',
    business_domain: '宠物辅食',
    research_goal: '形成可信的宠物辅食市场研究计划',
    target_audience: ['宠物食品产品与市场团队'],
    scope: ['公开可访问资料'],
    constraints: [{ id: 'c1', statement: '仅用公开来源', source: 'user' }],
    success_criteria: [{ id: 's1', statement: '所有结论可追溯' }],
    expected_deliverables: ['research_plan'],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'public',
    pii_detected: false,
  };
  const problemGraph = {
    version: 'problem-graph-v1' as const,
    questions: [{
      id: 'q-public-source',
      statement: '有哪些可信公开来源？',
      rationale: '支撑可追溯结论',
      priority: 'required' as const,
      success_criterion_ids: ['s1'],
      evidence_requirements: structuredClone(evidencePolicy),
      acceptance_criteria: ['至少一个可信公开来源'],
      depends_on: [],
    }],
  };
  const capabilityResolution = {
    eligible: [{
      skill: {
        id: 'competitive-web-research',
        name: '竞品公开研究',
        path: 'skills/competitive-analysis/web-research/SKILL.md',
        when_to_use: '公开资料研究',
        owner: '研究团队',
        status: 'active' as const,
        task_types: ['competitive_research'],
        inputs: ['research_goal'],
        outputs: ['competitive_analysis'],
        required_tools: ['tavily-search'],
        optional_tools: [],
        risk_level: 'low' as const,
      },
      reasons: [{ code: 'eligible' as const, message: 'eligible' }],
      pending_inputs: [],
      required_approvals: [],
      optional_tool_decisions: [],
    }],
    rejected: [],
  };
  const candidate = (id: 'depth' | 'speed') => ({
    id,
    title: id === 'depth' ? '深度研究' : '快速研究',
    rationale: id === 'depth' ? '优先覆盖来源与交叉验证' : '优先产出可执行框架',
    tradeoffs: id === 'depth' ? '耗时更长' : '来源覆盖较窄',
    steps: [{
      step_no: 99,
      step_name: id === 'depth' ? '公开来源深度检索' : '公开来源快速检索',
      actor_type: 'tool' as const,
      actor_id: 'tavily-search',
      question_ids: ['q-public-source'],
      depends_on: [],
      input: {
        query: originalInput,
        filters: id === 'depth'
          ? { language: 'zh-CN', freshness: 'year' }
          : { language: 'zh-CN' },
      },
      input_bindings: [],
      expected_outputs: [{ pointer: '/results', description: '公开来源结果' }],
      acceptance_criteria: ['至少返回一个公开来源'],
      requires_approval: false,
      fallback_actor_ids: [],
    }],
    assumptions: [],
    activated_nodes: ['D5_competitive', 'D6_evidence'],
  });
  return {
    task: {
      task_type: structuredTask.task_type,
      business_domain: structuredTask.business_domain,
      research_goal: structuredTask.research_goal,
      assumptions: [],
      confirmations: [],
      blocking_issues: [],
      sensitivity: 'public',
      pii_detected: false,
    },
    structuredTask,
    activatedNodes: ['D5_competitive', 'D6_evidence'],
    decisionStates: [],
    candidates: [candidate('depth'), candidate('speed')],
    guidanceSources: [],
    provenance: {
      modelName: 'planning-fake',
      modelVersion: '1',
      promptHash: 'sha256:planning-prompt',
      traceId: 'trace_control_planning',
    },
    problemGraph,
    problemGraphProvenance: {
      receiptId: '11111111-1111-4111-8111-111111111111',
      modelName: 'planning-fake',
      modelVersion: '1',
      promptHash: 'sha256:problem-graph',
      traceId: 'trace_problem_graph',
    },
    capabilityResolution,
  };
}

class V2ContextLLM implements LLMClient {
  readonly identity = {
    provider: 'v2-context-fixture',
    endpointHost: 'fixture.test',
    requestedModel: 'v2-context-model',
    mode: 'mock' as const,
    eligibleAsReal: false,
  };
  readonly calls: Array<{
    schemaName: string;
    context: object | undefined;
    contextManifestHash: string | undefined;
  }> = [];

  async generateStructured<T>(options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    this.calls.push({
      schemaName: options.schemaName,
      context: options.context,
      contextManifestHash: options.receipt.contextManifestHash,
    });
    const data = options.schemaName === 'decision-states'
      ? []
      : {
          candidates: [
            {
              id: 'depth',
              title: '完整 V2 深度计划',
              rationale: '覆盖全部约束',
              tradeoffs: '耗时更长',
              steps: [{ step_no: 1, step_name: '深度分析', actor_type: 'llm', actor_id: 'planner' }],
              assumptions: [],
            },
            {
              id: 'speed',
              title: '完整 V2 快速计划',
              rationale: '优先关键结论',
              tradeoffs: '覆盖较窄',
              steps: [{ step_no: 1, step_name: '快速分析', actor_type: 'llm', actor_id: 'planner' }],
              assumptions: [],
            },
          ],
        };
    return {
      data: data as T,
      promptHash: 'sha256:v2-context',
      modelName: this.identity.requestedModel,
      modelVersion: '1',
      traceId: `trace-${options.schemaName}`,
    };
  }

  async generateText(_options: TextLLMCallOptions): Promise<TextLLMResult> {
    throw new Error('not used');
  }
}

test('candidate planning and direct invoke retain every ResearchTaskV2 field', async () => {
  const requirement = researchPlanningResult('完整 V2 上下文').structuredTask!;
  const llm = new V2ContextLLM();
  const planning = new ResearchPlanningService({
    llm,
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
  });

  await planning.planFromRequirement(requirement, requirement.research_goal);

  const routedCalls = llm.calls.filter((call) =>
    call.schemaName === 'decision-states' || call.schemaName === 'current-plan-candidates'
  );
  assert.equal(routedCalls.length, 2);
  for (const call of routedCalls) {
    const context = call.context as Record<string, unknown>;
    assert.deepEqual(context.requirement, requirement);
    assert.deepEqual((context.requirement as ResearchTaskV2).target_audience, requirement.target_audience);
    assert.deepEqual((context.requirement as ResearchTaskV2).scope, requirement.scope);
    assert.deepEqual((context.requirement as ResearchTaskV2).constraints, requirement.constraints);
    assert.deepEqual((context.requirement as ResearchTaskV2).success_criteria, requirement.success_criteria);
    assert.deepEqual((context.requirement as ResearchTaskV2).expected_deliverables, requirement.expected_deliverables);
    assert.equal(call.contextManifestHash, hashPrompt('', context));
    const { requirement: _omitted, ...legacyContext } = context;
    assert.notEqual(call.contextManifestHash, hashPrompt('', legacyContext));
  }

  const direct = await planning.planFromRequirement(
    requirement,
    `$competitive-analysis ${requirement.research_goal}`,
  );
  assert.deepEqual(direct.candidates.map((candidate) => candidate.id), ['depth', 'speed']);
  assert.equal(direct.candidates.find((candidate) => candidate.id === 'speed')?.steps.length, 1);
  assert.equal(direct.candidates.find((candidate) => candidate.id === 'depth')?.steps.length, 2);
  for (const candidate of direct.candidates) {
    const directInput = candidate.steps[0]?.input as Record<string, unknown>;
    assert.deepEqual(directInput.requirement, requirement);
    assert.equal(directInput.brief, requirement.research_goal);
  }
  assert.equal(
    llm.calls.filter((call) => call.schemaName === 'current-plan-candidates').length,
    1,
    'direct planning must not add a routed candidate LLM call',
  );
});


test('announces a newly created conversation before planning begins', async () => {
  const { ControlPlanningService } = await loadControlPlanningModule();
  const conversationId = '00000000-0000-0000-0000-000000000205';
  const events: string[] = [];
  const service = new ControlPlanningService({
    planning: {
      async plan() {
        events.push('planning');
        throw new Error('stop after observing callback order');
      },
    },
    conversations: {
      async create() {
        events.push('create');
        return { id: conversationId };
      },
      async requireOwned(input) { return { id: input.conversationId }; },
    },
    repository: {
      async createTaskWithCandidates() {
        throw new Error('repository must not be called');
      },
    },
  });

  await assert.rejects(
    () => service.plan(
      {
        originalInput: '先返回新 conversation，再启动 planning',
        ownerUserId: '00000000-0000-0000-0000-000000000105',
      },
      undefined,
      (createdConversationId) => events.push(`conversation:${createdConversationId}`),
    ),
    /stop after observing callback order/,
  );
  assert.deepEqual(events, ['create', `conversation:${conversationId}`, 'planning']);
});
test('creates a conversation and persists ResearchPlanningResult candidates as Current research plans', async () => {
  const { ControlPlanningService } = await loadControlPlanningModule();
  const ownerUserId = '00000000-0000-0000-0000-000000000101';
  const conversationId = '00000000-0000-0000-0000-000000000201';
  const taskId = '00000000-0000-0000-0000-000000000301';
  const originalInput = '请为宠物辅食市场生成一份可信、可追溯、覆盖公开证据且包含竞品比较维度的研究计划，并保留原始问题。';
  const planningResult = researchPlanningResult(originalInput);
  const planningInputs: Array<{ originalInput: string }> = [];
  const createdConversations: Array<{ ownerUserId: string; title: string }> = [];
  const requiredConversations: Array<{ conversationId: string; ownerUserId: string }> = [];
  const repositoryInputs: CreateTaskWithCandidatesInput[] = [];
  const versionIds = {
    depth: '00000000-0000-0000-0000-000000000401',
    speed: '00000000-0000-0000-0000-000000000402',
  };
  const repositoryPlanHashes = {
    depth: `sha256:${'a'.repeat(64)}`,
    speed: `sha256:${'b'.repeat(64)}`,
  };
  let repositoryCandidates: PersistedPlanVersion[] = [];

  const dependencies: ControlPlanningDependencies = {
    planning: {
      async plan(input) {
        planningInputs.push(input);
        return planningResult;
      },
    },
    conversations: {
      async create(input) {
        createdConversations.push(input);
        return { id: conversationId };
      },
      async requireOwned(input) {
        requiredConversations.push(input);
        return { id: input.conversationId };
      },
    },
    repository: {
      async createTaskWithCandidates(input) {
        repositoryInputs.push(structuredClone(input));
        repositoryCandidates = input.candidates.map((candidate, index) => ({
          id: versionIds[candidate.candidateId],
          taskId,
          version: index + 1,
          candidateId: candidate.candidateId,
          plan: {
            ...candidate.plan,
            task_id: taskId,
          },
          planHash: repositoryPlanHashes[candidate.candidateId],
          pendingInputs: candidate.pendingInputs,
        }));
        return {
          task: {
            id: taskId,
            state: 'awaiting_selection',
            stateVersion: 0,
            activePlanVersionId: null,
            currentAttemptId: null,
          },
          candidates: repositoryCandidates,
        };
      },
    },
  };
  const service = new ControlPlanningService(dependencies);

  const response = await service.plan({ originalInput, ownerUserId });

  assert.deepEqual(createdConversations, [{
    ownerUserId,
    title: originalInput.slice(0, 40),
  }]);
  assert.deepEqual(requiredConversations, []);
  assert.deepEqual(planningInputs, [{ originalInput }]);
  assert.equal(repositoryInputs.length, 1);
  const persisted = repositoryInputs[0];
  assert.equal(persisted.conversationId, conversationId);
  assert.equal(persisted.ownerUserId, ownerUserId);
  assert.equal(persisted.originalInput, originalInput);
  assert.equal(persisted.taskType, planningResult.task.task_type);
  assert.deepEqual(persisted.structuredTask, planningResult.structuredTask);
  assert.deepEqual(persisted.candidates.map((candidate) => candidate.candidateId), ['depth', 'speed']);
  assert.ok(persisted.candidates.every(
    (candidate) => candidate.plan.task_id === undefined || candidate.plan.task_id === '',
  ));

  for (const [index, candidate] of persisted.candidates.entries()) {
    assert.deepEqual(Object.keys(candidate).sort(), ['candidateId', 'pendingInputs', 'plan']);
    assert.equal(candidate.plan.deliverable_type, 'research_plan');
    assert.deepEqual(candidate.plan.evidence_requirements, evidencePolicy);
    assert.deepEqual(candidate.plan.steps, planningResult.candidates[index]?.steps.map((step, stepIndex) => ({
      ...step,
      step_no: stepIndex + 1,
    })));
    assert.deepEqual(candidate.plan.problem_graph, planningResult.problemGraph);
    assert.deepEqual(candidate.plan.capability_decisions, planningResult.capabilityResolution);
    assert.deepEqual(candidate.plan.candidate_metadata, {
      title: planningResult.candidates[index]?.title,
      rationale: planningResult.candidates[index]?.rationale,
      tradeoffs: planningResult.candidates[index]?.tradeoffs,
    });
    assert.deepEqual(candidate.plan.activated_nodes, planningResult.activatedNodes);
    assert.deepEqual(candidate.pendingInputs, []);
  }

  assert.equal(response.kind, 'current');
  assert.equal(response.conversationId, conversationId);
  assert.deepEqual(response.task, {
    id: taskId,
    state: 'awaiting_selection',
    stateVersion: 0,
    activePlanVersionId: null,
    currentAttemptId: null,
  });
  assert.deepEqual(response.structuredTask, planningResult.structuredTask);
  assert.deepEqual(response.activatedNodes, planningResult.activatedNodes);
  assert.deepEqual(
    response.candidates.map((candidate) => ({
      planVersionId: candidate.planVersionId,
      candidateId: candidate.candidateId,
      title: candidate.title,
      rationale: candidate.rationale,
      tradeoffs: candidate.tradeoffs,
      planHash: candidate.planHash,
      plan: candidate.plan,
      pendingInputs: candidate.pendingInputs,
    })),
    planningResult.candidates.map((candidate, index) => ({
      planVersionId: versionIds[candidate.id],
      candidateId: candidate.id,
      title: candidate.title,
      rationale: candidate.rationale,
      tradeoffs: candidate.tradeoffs,
      planHash: repositoryPlanHashes[candidate.id],
      plan: repositoryCandidates[index]?.plan,
      pendingInputs: [],
    })),
  );
});

test('rejects generated Current step drift before repository persistence', async () => {
  const { ControlPlanningService } = await loadControlPlanningModule();
  const originalInput = '拒绝 Current 候选计划漂移';
  const planningResult = researchPlanningResult(originalInput);
  planningResult.candidates[0]!.steps[0] = {
    ...planningResult.candidates[0]!.steps[0]!,
    purpose: 'legacy-only field',
    schema_escape: 'must-not-persist',
  } as never;
  let repositoryCalls = 0;
  const service = new ControlPlanningService({
    planning: { async plan() { return planningResult; } },
    conversations: {
      async create() { return { id: '00000000-0000-0000-0000-000000000203' }; },
      async requireOwned(input) { return { id: input.conversationId }; },
    },
    repository: {
      async createTaskWithCandidates() {
        repositoryCalls += 1;
        throw new Error('repository must not be called');
      },
    },
  });

  await assert.rejects(
    () => service.plan({
      originalInput,
      ownerUserId: '00000000-0000-0000-0000-000000000103',
    }),
    /candidate_schema_invalid.*purpose.*schema_escape/,
  );
  assert.equal(repositoryCalls, 0);
});

test('rejects empty steps and unknown actor types before calling the repository', async () => {
  const { ControlPlanningService } = await loadControlPlanningModule();
  const invalidCases: Array<{
    label: string;
    steps: unknown[];
  }> = [
    { label: 'empty steps', steps: [] },
    {
      label: 'unknown actor type',
      steps: [{
        step_no: 1,
        step_name: '未知执行器',
        actor_type: 'agent',
        actor_id: 'invented-agent',
      }],
    },
  ];

  for (const invalid of invalidCases) {
    const planningResult = researchPlanningResult(invalid.label);
    planningResult.candidates[0]!.steps = invalid.steps as never;
    let repositoryCalls = 0;
    const service = new ControlPlanningService({
      planning: { async plan() { return planningResult; } },
      conversations: {
        async create() { return { id: '00000000-0000-0000-0000-000000000204' }; },
        async requireOwned(input) { return { id: input.conversationId }; },
      },
      repository: {
        async createTaskWithCandidates(input) {
          repositoryCalls += 1;
          return {
            task: {
              id: '00000000-0000-0000-0000-000000000304',
              state: 'awaiting_selection',
              stateVersion: 0,
              activePlanVersionId: null,
              currentAttemptId: null,
            },
            candidates: input.candidates.map((candidate, index) => ({
              id: `00000000-0000-0000-0000-0000000005${index + 10}`,
              taskId: '00000000-0000-0000-0000-000000000304',
              version: index + 1,
              candidateId: candidate.candidateId,
              plan: {
                ...candidate.plan,
                task_id: '00000000-0000-0000-0000-000000000304',
              },
              planHash: `sha256:${String(index + 3).repeat(64)}`,
              pendingInputs: candidate.pendingInputs,
            })),
          };
        },
      },
    });

    await assert.rejects(() => service.plan({
      originalInput: invalid.label,
      ownerUserId: '00000000-0000-0000-0000-000000000104',
    }));
    assert.equal(repositoryCalls, 0, invalid.label);
  }
});

test('rejects a foreign conversation before planning or candidate persistence', async () => {
  const { ControlPlanningService } = await loadControlPlanningModule();
  const ownerUserId = '00000000-0000-0000-0000-000000000102';
  const foreignConversationId = '00000000-0000-0000-0000-000000000299';
  const originalInput = '不得为其他用户的会话创建计划';
  const requiredConversations: Array<{ conversationId: string; ownerUserId: string }> = [];
  let planningCalls = 0;
  let repositoryCalls = 0;
  let conversationCreateCalls = 0;

  const service = new ControlPlanningService({
    planning: {
      async plan() {
        planningCalls += 1;
        return researchPlanningResult(originalInput);
      },
    },
    conversations: {
      async create() {
        conversationCreateCalls += 1;
        return { id: foreignConversationId };
      },
      async requireOwned(input) {
        requiredConversations.push(input);
        throw new Error('conversation not found for owner');
      },
    },
    repository: {
      async createTaskWithCandidates() {
        repositoryCalls += 1;
        throw new Error('repository must not be called');
      },
    },
  });

  await assert.rejects(
    () => service.plan({
      originalInput,
      ownerUserId,
      conversationId: foreignConversationId,
    }),
    /conversation not found for owner/,
  );
  assert.deepEqual(requiredConversations, [{
    conversationId: foreignConversationId,
    ownerUserId,
  }]);
  assert.equal(conversationCreateCalls, 0);
  assert.equal(planningCalls, 0);
  assert.equal(repositoryCalls, 0);
});

test('planExistingTask persists finalized candidates on the original task without creating a duplicate', async () => {
  const { ControlPlanningService } = await loadControlPlanningModule();
  const taskId = '00000000-0000-0000-0000-000000000901';
  const conversationId = '00000000-0000-0000-0000-000000000902';
  const ownerUserId = '00000000-0000-0000-0000-000000000903';
  const originalInput = '澄清后的原任务规划';
  const planningResult = researchPlanningResult(originalInput);
  const calls: Array<Record<string, unknown>> = [];
  const service = new ControlPlanningService({
    planning: { async plan() { throw new Error('plan must not run for finalized result'); } },
    conversations: {
      async create() { throw new Error('conversation must not be created'); },
      async requireOwned(input) { return { id: input.conversationId }; },
    },
    repository: {
      async createTaskWithCandidates() { throw new Error('duplicate task persistence must not run'); },
      async persistExistingTaskWithCandidates(input) {
        calls.push(input as unknown as Record<string, unknown>);
        return {
          task: {
            id: taskId,
            state: 'awaiting_selection',
            stateVersion: 2,
            activePlanVersionId: null,
            currentAttemptId: null,
          },
          candidates: input.candidates.map((candidate, index) => ({
            id: `00000000-0000-0000-0000-00000000091${index}`,
            taskId,
            version: index + 1,
            candidateId: candidate.candidateId,
            plan: { ...candidate.plan, task_id: taskId },
            planHash: `sha256:${String(index + 1).repeat(64)}`,
            pendingInputs: candidate.pendingInputs,
          })),
        };
      },
    },
  });

  const response = await service.planExistingTask({
    taskId,
    conversationId,
    ownerUserId,
    expectedStateVersion: 1,
    originalInput,
  }, planningResult);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.taskId, taskId);
  assert.equal(calls[0]?.conversationId, conversationId);
  assert.equal(calls[0]?.ownerUserId, ownerUserId);
  assert.equal(calls[0]?.expectedStateVersion, 1);
  assert.deepEqual((calls[0]?.candidates as Array<{ candidateId: string }>).map((candidate) => candidate.candidateId), ['depth', 'speed']);
  assert.deepEqual(calls[0]?.structuredTask, planningResult.structuredTask);
  assert.equal(response.task.id, taskId);
  assert.equal(response.task.state, 'awaiting_selection');
  assert.deepEqual(response.candidates.map((candidate) => candidate.candidateId), ['depth', 'speed']);
  assert.ok(response.candidates.every((candidate) => candidate.plan.task_id === taskId));
  assert.deepEqual(response.structuredTask, planningResult.structuredTask);
});

test('binds existing-task persistence to a class-backed repository', async () => {
  const { ControlPlanningService } = await loadControlPlanningModule();
  const taskId = '00000000-0000-0000-0000-000000000911';
  const conversationId = '00000000-0000-0000-0000-000000000912';
  const ownerUserId = '00000000-0000-0000-0000-000000000913';
  const planningResult = researchPlanningResult('类仓储方法必须保留 this');
  type PersistInput = Parameters<NonNullable<
    ControlPlanningDependencies['repository']['persistExistingTaskWithCandidates']
  >>[0];
  class ClassBackedRepository {
    readonly calls: PersistInput[] = [];

    async createTaskWithCandidates(): Promise<never> {
      throw new Error('duplicate task persistence must not run');
    }

    async persistExistingTaskWithCandidates(input: PersistInput) {
      this.calls.push(input);
      return {
        task: {
          id: taskId,
          state: 'awaiting_selection' as const,
          stateVersion: 2,
          activePlanVersionId: null,
          currentAttemptId: null,
        },
        candidates: input.candidates.map((candidate, index) => ({
          id: `00000000-0000-0000-0000-00000000092${index}`,
          taskId,
          version: index + 1,
          candidateId: candidate.candidateId,
          plan: { ...candidate.plan, task_id: taskId },
          planHash: `sha256:${String(index + 1).repeat(64)}`,
          pendingInputs: candidate.pendingInputs,
        })),
      };
    }
  }

  const repository = new ClassBackedRepository();
  const service = new ControlPlanningService({
    planning: { async plan() { throw new Error('plan must not run for finalized result'); } },
    conversations: {
      async create() { throw new Error('conversation must not be created'); },
      async requireOwned(input) { return { id: input.conversationId }; },
    },
    repository,
  });

  const response = await service.planExistingTask({
    taskId,
    conversationId,
    ownerUserId,
    expectedStateVersion: 1,
    originalInput: '类仓储方法必须保留 this',
  }, planningResult);

  assert.equal(repository.calls.length, 1);
  assert.equal(response.task.id, taskId);
  assert.deepEqual(response.candidates.map((candidate) => candidate.candidateId), ['depth', 'speed']);
});
