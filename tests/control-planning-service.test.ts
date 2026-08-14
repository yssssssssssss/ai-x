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

interface ResearchPlanningResult {
  task: ResearchTaskData;
  structuredTask?: ResearchTaskV2;
  activatedNodes: string[];
  decisionStates: DecisionStateRec[];
  candidates: PlanCandidate[];
  guidanceSources: GuidanceRef[];
  provenance: PlanProvenance;
}

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
  id: 'public-market-evidence',
  acceptedClasses: ['public_source'],
  minimumCount: 1,
  required: true,
}];

function researchPlanningResult(originalInput: string): ResearchPlanningResult {
  return {
    task: {
      task_type: 'competitive_research',
      business_domain: '宠物辅食',
      research_goal: '形成可信的宠物辅食市场研究计划',
      assumptions: [],
      confirmations: [],
      blocking_issues: [],
      sensitivity: 'public',
      pii_detected: false,
    },
    structuredTask: {
      version: 'research-task-v2',
      task_type: 'competitive_research',
      business_domain: '宠物辅食',
      research_goal: '形成可信的宠物辅食市场研究计划',
      target_audience: ['宠物食品产品与市场团队'],
      scope: ['公开可访问资料'],
      constraints: [{ id: 'c1', statement: '仅用公开来源', source: 'user' }],
      success_criteria: [{ id: 's1', statement: '所有结论可追溯' }],
      expected_deliverables: ['研究计划'],
      assumptions: [],
      ambiguities: [],
      clarification_questions: [],
      blocking_issues: [],
      sensitivity: 'public',
      pii_detected: false,
    },
    activatedNodes: ['D5_competitive', 'D6_evidence'],
    decisionStates: [],
    candidates: [
      {
        id: 'depth',
        title: '深度研究',
        rationale: '优先覆盖来源与交叉验证',
        tradeoffs: '耗时更长',
        steps: [{
          step_no: 1,
          step_name: '公开来源深度检索',
          actor_type: 'tool',
          actor_id: 'tavily-search',
          input: {
            query: originalInput,
            filters: { language: 'zh-CN', freshness: 'year' },
          },
        }],
        assumptions: [],
        activated_nodes: ['D5_competitive', 'D6_evidence'],
      },
      {
        id: 'speed',
        title: '快速研究',
        rationale: '优先产出可执行框架',
        tradeoffs: '来源覆盖较窄',
        steps: [{
          step_no: 1,
          step_name: '公开来源快速检索',
          actor_type: 'tool',
          actor_id: 'tavily-search',
          input: {
            query: originalInput,
            filters: { language: 'zh-CN' },
          },
        }],
        assumptions: [],
        activated_nodes: ['D5_competitive'],
      },
    ],
    guidanceSources: [],
    provenance: {
      modelName: 'planning-fake',
      modelVersion: '1',
      promptHash: 'sha256:planning-prompt',
      traceId: 'trace_control_planning',
    },
  };
}


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
    assert.deepEqual(candidate.plan.steps, planningResult.candidates[index]?.steps);
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

test('normalizes and whitelists generated Current plan steps before repository persistence', async () => {
  const { ControlPlanningService } = await loadControlPlanningModule();
  const ownerUserId = '00000000-0000-0000-0000-000000000103';
  const conversationId = '00000000-0000-0000-0000-000000000203';
  const taskId = '00000000-0000-0000-0000-000000000303';
  const originalInput = '归一化 Current 候选计划';
  const planningResult = researchPlanningResult(originalInput);
  planningResult.candidates[0]!.steps = [
    {
      step_no: 9,
      actor_type: 'tool',
      actor_id: 'tavily-search',
      purpose: '检索公开来源',
      input: { query: originalInput },
      requires_approval: false,
      step_id: 'untrusted-step-id',
      schema_escape: 'must-not-persist',
    },
    {
      step_no: 9,
      step_name: '综合分析',
      actor_type: 'llm',
      actor_id: 'research-synthesis',
      input: ['not', 'an', 'object'],
      ignored: true,
    },
  ] as unknown as PlanCandidate['steps'];
  let repositoryInput: CreateTaskWithCandidatesInput | undefined;

  const service = new ControlPlanningService({
    planning: { async plan() { return planningResult; } },
    conversations: {
      async create() { return { id: conversationId }; },
      async requireOwned(input) { return { id: input.conversationId }; },
    },
    repository: {
      async createTaskWithCandidates(input) {
        repositoryInput = structuredClone(input);
        return {
          task: {
            id: taskId,
            state: 'awaiting_selection',
            stateVersion: 0,
            activePlanVersionId: null,
            currentAttemptId: null,
          },
          candidates: input.candidates.map((candidate, index) => ({
            id: `00000000-0000-0000-0000-0000000004${index + 10}`,
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

  await service.plan({ originalInput, ownerUserId });

  assert.ok(repositoryInput);
  assert.deepEqual(repositoryInput.candidates[0]?.plan.steps, [
    {
      step_no: 1,
      step_name: 'tavily-search',
      actor_type: 'tool',
      actor_id: 'tavily-search',
      purpose: '检索公开来源',
      input: { query: originalInput },
      requires_approval: false,
    },
    {
      step_no: 2,
      step_name: '综合分析',
      actor_type: 'llm',
      actor_id: 'research-synthesis',
    },
  ]);
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
    planningResult.candidates[0]!.steps = invalid.steps as PlanCandidate['steps'];
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