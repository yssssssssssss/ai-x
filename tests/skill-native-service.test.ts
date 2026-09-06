import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type {
  SkillNativeExecutionState,
  SkillNativeTaskSummary,
  SkillOutcome,
  TaskArtifact,
} from '../packages/api-contract/skill-native.ts';
import type {
  LLMClient,
  LLMProviderIdentity,
  LLMResult,
  StructuredLLMCallOptions,
  TextLLMCallOptions,
  TextLLMResult,
} from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { MockLLMClient } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { SkillNativeCatalog } from '../apps/orchestrator-runtime/src/skill-native/catalog.ts';
import {
  SkillNativeCapabilityBroker,
  type SkillNativeToolPort,
} from '../apps/orchestrator-runtime/src/skill-native/capability-broker.ts';
import {
  SkillNativeExecutionEngine,
  type AgentTurn,
} from '../apps/orchestrator-runtime/src/skill-native/execution.ts';
import { SkillPackageStore } from '../apps/orchestrator-runtime/src/skill-native/package-store.ts';
import { RequirementPlanner } from '../apps/orchestrator-runtime/src/skill-native/requirement-planner.ts';
import { SkillNativeTaskService, SkillNativeWorkflowError } from '../apps/orchestrator-runtime/src/skill-native/service.ts';
import {
  SkillNativeStoreError,
  type SkillNativeArtifactInput,
  type SkillNativeArtifactRecord,
  type SkillNativeTaskRecord,
  type SkillNativeTaskStore,
  type SkillNativeToolCallRecordInput,
  type SkillNativeZeroPublicationReservation,
} from '../apps/orchestrator-runtime/src/skill-native/store.ts';
import type { ModelCallRecordInput } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import type {
  SkillNativeZeroPublication,
  SkillNativeZeroPublicationDraft,
} from '../packages/api-contract/skill-native.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemoryStore implements SkillNativeTaskStore {
  task: SkillNativeTaskRecord | null = null;
  readonly artifactRecords = new Map<string, SkillNativeArtifactRecord>();

  async create(input: Parameters<SkillNativeTaskStore['create']>[0]): Promise<SkillNativeTaskRecord> {
    const now = new Date();
    this.task = {
      id: input.id,
      ownerUserId: input.ownerUserId,
      projectId: input.projectId,
      originalInput: input.originalInput,
      orchestrationMode: input.orchestrationMode,
      state: 'awaiting_selection',
      stateVersion: 0,
      selectedCandidateId: null,
      requirement: structuredClone(input.requirement),
      candidates: structuredClone(input.candidates),
      materials: structuredClone(input.materials ?? []),
      plan: null,
      execution: { steps: [], checkpoint: null, externalKnowledge: [] },
      artifacts: [],
      result: null,
      warnings: [],
      failure: null,
      currentAttemptId: null,
      createdAt: now,
      updatedAt: now,
    };
    for (const artifact of input.artifacts ?? []) await this.writeArtifact(artifact);
    return this.view();
  }

  async getOwned(taskId: string, ownerUserId: string) {
    return this.task?.id === taskId && this.task.ownerUserId === ownerUserId ? this.view() : null;
  }

  async listOwned(ownerUserId: string): Promise<SkillNativeTaskSummary[]> {
    if (!this.task || this.task.ownerUserId !== ownerUserId) return [];
    return [{
      id: this.task.id,
      originalInput: this.task.originalInput,
      orchestrationMode: this.task.orchestrationMode,
      state: this.task.state,
      createdAt: this.task.createdAt.toISOString(),
      updatedAt: this.task.updatedAt.toISOString(),
    }];
  }

  async select(input: Parameters<SkillNativeTaskStore['select']>[0]) {
    this.guard(input.expectedVersion, ['awaiting_selection']);
    this.task!.selectedCandidateId = input.candidateId;
    this.task!.state = 'awaiting_confirmation';
    this.bump();
    return this.view();
  }

  async confirm(input: Parameters<SkillNativeTaskStore['confirm']>[0]) {
    this.guard(input.expectedVersion, ['awaiting_confirmation']);
    this.task!.plan = structuredClone(input.plan);
    this.task!.materials = structuredClone(input.materials);
    this.task!.state = 'ready';
    for (const artifact of input.artifacts ?? []) await this.writeArtifact(artifact);
    this.bump();
    return this.view();
  }

  async replan(input: Parameters<SkillNativeTaskStore['replan']>[0]) {
    this.guard(input.expectedVersion, [this.task!.state]);
    this.task!.state = 'awaiting_selection';
    this.task!.selectedCandidateId = null;
    this.task!.requirement = structuredClone(input.requirement);
    this.task!.candidates = structuredClone(input.candidates);
    this.task!.plan = null;
    this.task!.execution = { steps: [], checkpoint: null, externalKnowledge: [] };
    this.task!.result = null;
    this.bump();
    return this.view();
  }

  async beginExecution(input: Parameters<SkillNativeTaskStore['beginExecution']>[0]) {
    this.guard(input.expectedVersion, [input.from]);
    this.task!.state = 'executing';
    this.task!.currentAttemptId = input.attemptId;
    this.task!.materials = structuredClone(input.materials ?? []);
    for (const artifact of input.artifacts ?? []) await this.writeArtifact(artifact);
    this.bump();
    return this.view();
  }

  async saveExecution(input: Parameters<SkillNativeTaskStore['saveExecution']>[0]) {
    if (!this.task || this.task.state !== 'executing' || this.task.currentAttemptId !== input.attemptId) return false;
    this.task.execution = structuredClone(input.execution);
    return true;
  }

  async waitForUser(input: Parameters<SkillNativeTaskStore['waitForUser']>[0]) {
    return this.finishSegment(input.attemptId, 'waiting_for_user', input.execution, null, input.warnings, null);
  }

  async pauseExecution(input: Parameters<SkillNativeTaskStore['pauseExecution']>[0]) {
    return this.finishSegment(input.attemptId, 'paused', input.execution, null, [], input.failure);
  }

  async finishExecution(input: Parameters<SkillNativeTaskStore['finishExecution']>[0]) {
    return this.finishSegment(input.attemptId, input.state, input.execution, input.result, input.warnings, input.failure);
  }

  async cancel(input: Parameters<SkillNativeTaskStore['cancel']>[0]) {
    this.guard(input.expectedVersion, [this.task!.state]);
    this.task!.state = 'cancelled';
    this.task!.currentAttemptId = null;
    this.bump();
    return this.view();
  }

  async listArtifacts(input: { taskId: string; ownerUserId: string; projectId: string }): Promise<TaskArtifact[]> {
    return [...this.artifactRecords.values()].filter((artifact) => (
      artifact.taskId === input.taskId && artifact.ownerUserId === input.ownerUserId && artifact.projectId === input.projectId
    )).map((artifact) => ({
      id: artifact.id,
      ...(artifact.invocationId ? { invocationId: artifact.invocationId } : {}),
      relativePath: artifact.relativePath,
      fileName: artifact.fileName,
      mediaType: artifact.mediaType,
      role: artifact.role,
      byteSize: artifact.bytes.byteLength,
      contentSha256: artifact.contentSha256,
      sourceArtifactIds: [...artifact.sourceArtifactIds],
    }));
  }

  async getArtifactOwned(input: { artifactId: string; taskId: string; ownerUserId: string; projectId: string }) {
    const artifact = this.artifactRecords.get(input.artifactId);
    return artifact
      && artifact.taskId === input.taskId
      && artifact.ownerUserId === input.ownerUserId
      && artifact.projectId === input.projectId
      ? { ...artifact, bytes: Buffer.from(artifact.bytes) }
      : null;
  }

  async writeArtifact(input: SkillNativeArtifactInput): Promise<void> {
    this.artifactRecords.set(input.id, { ...structuredClone(input), bytes: Buffer.from(input.bytes), createdAt: new Date() });
    if (this.task) {
      this.task.artifacts = await this.listArtifacts({
        taskId: this.task.id,
        ownerUserId: this.task.ownerUserId,
        projectId: this.task.projectId,
      });
    }
  }

  async recordModelCall(_input: ModelCallRecordInput) { return 'model-call'; }
  async recordToolCall(_input: SkillNativeToolCallRecordInput) {}
  async reserveZeroPublication(): Promise<SkillNativeZeroPublicationReservation> { return { status: 'reserved' }; }
  async prepareZeroPublication(_input: { taskId: string; ownerUserId: string; draft: SkillNativeZeroPublicationDraft }) {}
  async completeZeroPublication(_input: { taskId: string; ownerUserId: string; publication: SkillNativeZeroPublication }) {}
  async failZeroPublication(_input: { taskId: string; ownerUserId: string; failure: string }) {}
  async recoverInterrupted() { return 0; }

  private finishSegment(
    attemptId: string,
    state: SkillNativeTaskRecord['state'],
    execution: SkillNativeExecutionState,
    result: SkillOutcome | null,
    warnings: string[],
    failure: string | null,
  ): SkillNativeTaskRecord | null {
    if (!this.task || this.task.currentAttemptId !== attemptId) return null;
    this.task.state = state;
    this.task.currentAttemptId = null;
    this.task.execution = structuredClone(execution);
    this.task.result = result ? structuredClone(result) : null;
    this.task.warnings = [...warnings];
    this.task.failure = failure;
    this.bump();
    return this.view();
  }

  private guard(version: number, states: SkillNativeTaskRecord['state'][]): void {
    if (!this.task) throw new SkillNativeStoreError('not_found', '任务不存在');
    if (this.task.stateVersion !== version || !states.includes(this.task.state)) {
      throw new SkillNativeStoreError('conflict', '任务状态已变化');
    }
  }

  private bump(): void {
    this.task!.stateVersion += 1;
    this.task!.updatedAt = new Date();
  }

  private view(): SkillNativeTaskRecord {
    return structuredClone(this.task!);
  }
}

class NoTools implements SkillNativeToolPort {
  list() { return []; }
  async invoke(): Promise<never> { throw new Error('no tools'); }
}

class SequenceLLM implements LLMClient {
  readonly identity: LLMProviderIdentity = {
    provider: 'mock', endpointHost: 'local', requestedModel: 'mock', mode: 'mock', eligibleAsReal: false,
  };
  constructor(private readonly turns: AgentTurn[], private readonly text = '# Default') {}
  async generateStructured<T>(_options: StructuredLLMCallOptions): Promise<LLMResult<T>> {
    const turn = this.turns.shift();
    if (!turn) throw new Error('missing turn');
    return { data: structuredClone(turn) as T, promptHash: 'hash', modelName: 'mock', modelVersion: 'v1', traceId: 'trace' };
  }
  async generateText(_options: TextLLMCallOptions): Promise<TextLLMResult> {
    return { text: this.text, promptHash: 'hash', modelName: 'mock', modelVersion: 'v1', traceId: 'trace' };
  }
}

async function fixture(turns: AgentTurn[]) {
  const root = await mkdtemp(join(tmpdir(), 'skill-service-'));
  roots.push(root);
  const sourceRoot = join(root, 'skill-packages');
  mkdirSync(join(sourceRoot, 'market-analysis', 'references'), { recursive: true });
  writeFileSync(join(sourceRoot, 'market-analysis', 'SKILL.md'), '---\nname: Market analysis\ndescription: Analyze market trends and competitors\n---\n\nUse the evidence.\n');
  writeFileSync(join(sourceRoot, 'market-analysis', 'references', 'method.md'), 'Original method');
  const packages = new SkillPackageStore({ sourceRoot, snapshotRoot: join(root, 'snapshots') });
  const catalog = new SkillNativeCatalog(packages);
  const store = new MemoryStore();
  const broker = new SkillNativeCapabilityBroker({ packages, artifacts: store, tools: new NoTools() });
  const plannerLlm = new MockLLMClient({
    'skill-requirement-analysis-v1:single_skill': {
      goal: 'Analyze market trends',
      desiredOutputs: ['Market report'],
      scope: ['Market trends'],
      constraints: [],
      assumptions: [],
      openQuestions: [],
      needsClarification: false,
      clarifyingQuestion: '',
      shortlistSkillIds: ['market-analysis'],
    },
    'skill-requirement-candidates-v1:single_skill': {
      candidates: [{
        title: 'Market analysis',
        description: 'Analyze market trends and competitors',
        rationale: 'Matches the requested market analysis',
        tradeoffs: 'Focused single-Skill execution',
        skillIds: ['market-analysis'],
        finalReportSkillId: 'market-analysis',
      }],
    },
  });
  const service = new SkillNativeTaskService({
    store,
    catalog,
    planner: new RequirementPlanner({ llm: plannerLlm, packages }),
    execution: new SkillNativeExecutionEngine({ llm: new SequenceLLM(turns), broker }),
  });
  return { root, store, service };
}

async function confirmedService(turns: AgentTurn[]) {
  const result = await fixture(turns);
  const created = await result.service.create('owner-1', {
    originalInput: 'Analyze market trends',
    orchestrationMode: 'single_skill',
    inputs: { audience: { source: 'conversation', value: 'Executives' } },
  });
  const selected = await result.service.select({
    taskId: created.id,
    ownerUserId: 'owner-1',
    expectedVersion: created.stateVersion,
    candidateId: created.candidates[0]!.candidateId,
  });
  const confirmed = await result.service.confirm({
    taskId: created.id,
    ownerUserId: 'owner-1',
    body: { expectedVersion: selected.stateVersion, answers: {} },
  });
  return { ...result, created, confirmed };
}

test('service preserves analysis, selection, confirmation, frozen package execution, and Artifact delivery', async () => {
  const run = await confirmedService([{
    action: 'finish', stateSummary: 'Done',
    finish: {
      status: 'complete', summary: 'Market complete', gaps: [], missingCapabilities: [],
      disposition: { kind: 'final_text', content: '# Market report\n\nEvidence.' },
    },
  }]);
  assert.equal(run.created.state, 'awaiting_selection');
  assert.equal(run.confirmed.state, 'ready');
  assert.equal(run.confirmed.plan?.invocations[0]?.packageHash.length, 71);
  assert.equal(run.confirmed.plan?.requirement.materials.some(({ label }) => label === 'audience'), true);

  writeFileSync(join(run.root, 'skill-packages', 'market-analysis', 'references', 'method.md'), 'Changed after confirmation');
  const completed = await run.service.execute({
    taskId: run.confirmed.id,
    ownerUserId: 'owner-1',
    expectedVersion: run.confirmed.stateVersion,
  });

  assert.equal(completed.state, 'completed');
  assert.equal(completed.result?.summary, 'Market complete');
  assert.ok(completed.result?.primaryArtifactId);
  assert.match((await run.service.html(completed.id, 'owner-1'))!, /Market report/u);
});

test('service exposes dynamic questions and resumes the same Invocation after an answer', async () => {
  const run = await confirmedService([
    {
      action: 'ask_user', stateSummary: 'Need scope',
      questions: [{ id: 'scope', prompt: 'Which market?', required: true, answerType: 'text' }],
    },
    {
      action: 'finish', stateSummary: 'Done',
      finish: {
        status: 'complete', summary: 'Scoped', gaps: [], missingCapabilities: [],
        disposition: { kind: 'final_text', content: '# Scoped report' },
      },
    },
  ]);
  const waiting = await run.service.execute({
    taskId: run.confirmed.id,
    ownerUserId: 'owner-1',
    expectedVersion: run.confirmed.stateVersion,
  });
  assert.equal(waiting.state, 'waiting_for_user');
  assert.equal(waiting.pendingQuestions[0]?.id, 'scope');

  const completed = await run.service.resume({
    taskId: waiting.id,
    ownerUserId: 'owner-1',
    body: {
      expectedVersion: waiting.stateVersion,
      answers: { scope: { source: 'conversation', value: 'Pet supplies' } },
    },
  });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.executionSteps[0]?.turn, 2);
});

test('service accepts generic task materials without a per-Skill input schema', async () => {
  const run = await fixture([]);
  const created = await run.service.create('owner-1', {
    originalInput: 'Analyze market trends',
    orchestrationMode: 'single_skill',
    inputs: {
      arbitrary_context_from_another_team: { source: 'conversation', value: 'Keep this material' },
    },
  });
  assert.equal(run.store.task?.materials.some(({ label }) => label === 'arbitrary_context_from_another_team'), true);
  assert.equal(created.candidates.length, 1);
});

test('direct Skill requests work without registry or Solution YAML entries', async () => {
  const run = await fixture([]);
  const created = await run.service.create('owner-1', {
    originalInput: '$market-analysis compare pet retail',
    orchestrationMode: 'single_skill',
  });
  assert.equal(created.candidates[0]?.skills[0]?.skillId, 'market-analysis');

  await assert.rejects(
    run.service.create('owner-1', { originalInput: '$missing-skill do work', orchestrationMode: 'single_skill' }),
    (error: unknown) => error instanceof SkillNativeWorkflowError && error.code === 'unavailable',
  );
});

test('service rejects oversized and empty task input at its public boundary', async () => {
  const run = await fixture([]);
  await assert.rejects(
    run.service.create('owner-1', { originalInput: ' ', orchestrationMode: 'single_skill' }),
    (error: unknown) => error instanceof SkillNativeWorkflowError && error.code === 'invalid_request',
  );
  await assert.rejects(
    run.service.create('owner-1', { originalInput: 'x'.repeat(20_001), orchestrationMode: 'single_skill' }),
    (error: unknown) => error instanceof SkillNativeWorkflowError && error.code === 'invalid_request',
  );
});
