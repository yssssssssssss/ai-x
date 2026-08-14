import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ControlTaskDetail } from '../database/control-plane.ts';
import type { ControlRequirementVersion } from '../packages/api-contract/control-workflow.ts';
import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import type {
  LLMClient,
  LLMResult,
  ModelCallRecordInput,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { ReceiptLLMClient, ModelDriftError } from '../apps/orchestrator-runtime/src/runtime/receipt-llm-client.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';

type RefinementModule = typeof import('../apps/orchestrator-runtime/src/control/requirement-refinement-service.ts');

const ownerUserId = 'owner-1';
const conversationId = 'conversation-1';
const taskId = 'task-1';

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
    expected_deliverables: ['research plan'],
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
  readonly calls: Array<{ context?: object; schemaName: string }> = [];
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
    this.calls.push({ context: opts.context, schemaName: opts.schemaName });
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
  async recordModelCall(input: ModelCallRecordInput): Promise<void> {
    this.calls.push(input);
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
  const llm = new FixtureLLM([requirement()]);
  const repository = makeRepository();
  const conversations = makeConversations();
  let planned: { originalInput: string; requirement: ResearchTaskV2 } | null = null;
  const service = new RequirementRefinementService({
    llm,
    validator: new SchemaValidator(),
    repository,
    conversations,
    expectedActualModel: 'pinned-model',
    planner: {
      async plan(input: { originalInput: string; requirement: ResearchTaskV2 }) {
        planned = input;
      },
    },
  });

  const result = await service.understand({
    taskId,
    conversationId,
    ownerUserId,
    originalInput: 'compare live-commerce competitors',
  });

  assert.equal(result.status, 'ready_to_plan');
  assert.deepEqual(result.requirement, requirement());
  assert.deepEqual(planned, { originalInput: 'compare live-commerce competitors', requirement: requirement() });
  assert.deepEqual(repository.events, ['persist_activate']);
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

test('clarification answers persist a new v2 and clear blocking ambiguity before planning', async () => {
  const { RequirementRefinementService } = await loadModule();
  const clearRequirement = requirement({ target_audience: ['enterprise buyers'] });
  const llm = new FixtureLLM([ambiguousRequirement, clearRequirement]);
  const repository = makeRepository();
  const conversations = makeConversations();
  const events = repository.events;
  let plannedInput = '';
  let plannerCalls = 0;
  const service = new RequirementRefinementService({
    llm,
    validator: new SchemaValidator(),
    repository,
    conversations,
    planner: {
      async plan(input: { originalInput: string }) {
        events.push('plan');
        plannedInput = input.originalInput;
        plannerCalls += 1;
      },
    },
  });

  await service.understand({ taskId, conversationId, ownerUserId, originalInput: 'compare competitors' });
  const result = await service.clarify({
    taskId,
    conversationId,
    ownerUserId,
    answers: { audience: 'enterprise buyers' },
  });

  assert.equal(result.status, 'ready_to_plan');
  assert.equal(result.requirement.version, 'research-task-v2');
  assert.equal(result.requirement.ambiguities.some((item) => item.blocking), false);
  assert.equal(result.requirement.clarification_questions.length, 0);
  assert.deepEqual(repository.versions.map((version) => version.version), [1, 2]);
  assert.deepEqual(events.slice(-2), ['persist_activate', 'plan']);
  assert.equal(plannedInput, 'raw original input from task');
  assert.equal(plannerCalls, 1);
});

test('post-activation retry reuses one requirement-version assistant message key', async () => {
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
    ['requirement:requirement-2:assistant', 'requirement:requirement-2:assistant'],
  );
  assert.equal(
    conversations.appended.filter((message) => message.content.includes('ready_to_plan')).length,
    1,
  );
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
