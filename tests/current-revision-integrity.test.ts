import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import express from 'express';
import { Pool } from 'pg';
import { ControlArtifactStore } from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import {
  TaskWorkflowService,
  type WorkflowPlanRevisionDriver,
} from '../apps/orchestrator-runtime/src/control/task-workflow.ts';
import { MockLLMClient } from '../apps/orchestrator-runtime/src/runtime/llm-client.ts';
import { SchemaValidator } from '../apps/orchestrator-runtime/src/schema/validator.ts';
import { SkillLoader } from '../apps/orchestrator-runtime/src/runtime/skill-loader.ts';
import { ToolRouter } from '../apps/orchestrator-runtime/src/runtime/tool-adapter.ts';
import {
  ControlPlaneConflictError,
  ControlPlaneRepository,
  canonicalPlanHash,
} from '../database/control-plane.ts';
import {
  runMigrations,
  type MigrationConnection,
  type MigrationDatabase,
} from '../database/migration-runner.ts';
import type { ResearchPlanningResult } from '../apps/orchestrator-runtime/src/planners/research-planning-service.ts';

class ScopedRevisionDatabase implements MigrationDatabase {
  constructor(
    private readonly database: Pool,
    private readonly schema: string,
  ) {}

  async connect(): Promise<MigrationConnection> {
    const client = await this.database.connect();
    await client.query(`SET search_path TO "${this.schema}", public`);
    return {
      async query(sql, values = []) {
        const result = await client.query(sql, [...values]);
        return { rows: result.rows };
      },
      release() {
        client.release();
      },
    };
  }
}

const schema = `revision_${randomUUID().replaceAll('-', '')}`;
const database = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/user_research_ai',
});
const scopedDatabase = new ScopedRevisionDatabase(database, schema);
const repository = new ControlPlaneRepository(scopedDatabase);
const artifactRoot = mkdtempSync(join(tmpdir(), 'current-revision-'));
const originalJwtSecret = process.env.JWT_SECRET;
const originalPgOptions = process.env.PGOPTIONS;
let ownerId = '';
let foreignOwnerId = '';
let conversationId = '';
let closeSharedPool: (() => Promise<void>) | undefined;

const evidenceRequirements = [{
  id: 'public-source',
  acceptedClasses: ['public_source'] as const,
  minimumCount: 1,
  required: true,
}];
const pendingInputs = [{
  role: 'brief',
  label: '研究简报',
  multiple: false,
  targets: [{ step_no: 1, tool_id: 'tavily-web-search', field: 'query', multiple: false }],
}];

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

before(async () => {
  await database.query(`CREATE SCHEMA "${schema}"`);
  await runMigrations({
    database: scopedDatabase,
    migrationsDir: join(process.cwd(), 'database', 'migrations'),
    lockKey: 761_831_103,
  });
  process.env.PGOPTIONS = `-c search_path=${schema},public`;
  process.env.JWT_SECRET = `current-revision-${randomUUID()}`;

  const connection = await scopedDatabase.connect();
  try {
    const users = await connection.query(
      `INSERT INTO users (email, display_name, password_hash, role, status)
       VALUES
         ($1, 'revision owner', 'x', 'member', 'active'),
         ($2, 'revision foreign owner', 'x', 'member', 'active')
       RETURNING id, email`,
      [`revision-owner-${randomUUID()}@test.local`, `revision-foreign-${randomUUID()}@test.local`],
    );
    ownerId = String(users.rows[0]?.id);
    foreignOwnerId = String(users.rows[1]?.id);
    const conversation = await connection.query(
      `INSERT INTO conversations (owner_user_id, title) VALUES ($1, 'revision') RETURNING id`,
      [ownerId],
    );
    conversationId = String(conversation.rows[0]?.id);
  } finally {
    connection.release();
  }
});

after(async () => {
  await closeSharedPool?.();
  await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await database.end();
  rmSync(artifactRoot, { recursive: true, force: true });
  restoreEnvironment('JWT_SECRET', originalJwtSecret);
  restoreEnvironment('PGOPTIONS', originalPgOptions);
});

function candidateSteps(mode: 'depth' | 'speed') {
  return [{
    step_no: 99,
    step_name: `${mode} search`,
    actor_type: 'tool' as const,
    actor_id: 'tavily-web-search',
    input: { query: mode },
    requires_approval: false,
  }];
}

async function createSelectedTask(options: {
  candidateId?: 'depth' | 'speed';
  structuredTask?: unknown;
  pendingInputs?: typeof pendingInputs;
  workflow?: TaskWorkflowService;
  suffix?: string;
} = {}) {
  const suffix = options.suffix ?? randomUUID();
  const selectedId = options.candidateId ?? 'speed';
  const created = await repository.createTaskWithCandidates({
    conversationId,
    ownerUserId: ownerId,
    originalInput: `original ${suffix}`,
    taskType: 'competitive_research',
    structuredTask: options.structuredTask ?? {
      research_goal: '研究国内宠物辅食品牌',
      confirmations: [],
      blocking_issues: [],
    },
    candidates: (['depth', 'speed'] as const).map((candidateId) => ({
      candidateId,
      plan: {
        task_id: '',
        deliverable_type: 'research_plan' as const,
        evidence_requirements: evidenceRequirements.map((requirement) => ({
          ...requirement,
          acceptedClasses: [...requirement.acceptedClasses],
        })),
        steps: candidateSteps(candidateId),
      },
      pendingInputs: candidateId === selectedId ? (options.pendingInputs ?? pendingInputs) : [],
    })),
  });
  const selectedPlan = created.candidates.find((candidate) => candidate.candidateId === selectedId);
  assert.ok(selectedPlan);
  const workflow = options.workflow ?? new TaskWorkflowService(repository);
  const selected = await workflow.select({
    taskId: created.task.id,
    expectedVersion: created.task.stateVersion,
    planVersionId: selectedPlan.id,
    idempotencyKey: `select-${suffix}`,
    actor: { userId: ownerId, role: 'owner' },
  });
  return { created, selected, selectedPlan };
}

function planningResult(originalInput: string): ResearchPlanningResult {
  return {
    task: {
      task_type: 'competitive_research',
      business_domain: '宠物辅食',
      research_goal: originalInput,
      assumptions: [],
      confirmations: [],
      blocking_issues: [],
      sensitivity: 'public',
      pii_detected: false,
    },
    activatedNodes: [],
    decisionStates: [],
    candidates: (['depth', 'speed'] as const).map((id) => ({
      id,
      title: id,
      rationale: id,
      tradeoffs: id,
      steps: candidateSteps(id).map((step) => ({
        ...step,
        step_no: 42,
        extra_client_field: 'drop-me',
      })) as never,
      assumptions: [],
      activated_nodes: [],
    })),
    guidanceSources: [],
    provenance: {
      modelName: 'revision-planner',
      modelVersion: '1',
      promptHash: originalInput,
      traceId: 'revision-trace',
    },
  };
}

async function buildRuntime(planning: { plan(input: { originalInput: string }): Promise<ResearchPlanningResult> }) {
  const { buildControlRuntime } = await import('../apps/agent-api/src/control-runtime.ts');
  const llm = new MockLLMClient();
  return buildControlRuntime({
    repository,
    conversations: {
      async create() { return { id: conversationId }; },
      async requireOwned() { return { id: conversationId }; },
    },
    planning,
    tools: new ToolRouter(),
    llm,
    validator: new SchemaValidator(),
    skillLoader: new SkillLoader(),
    artifacts: new ControlArtifactStore({ root: artifactRoot, registry: repository }),
    expectedActualModel: llm.identity.requestedModel,
  });
}

test('revision HTTP endpoint rejects client plan and planHash', async () => {
  const seeded = await createSelectedTask({ suffix: 'route-rejects-forgery' });
  const { createControlTasksRouter } = await import('../apps/agent-api/src/routes/control-tasks.ts');
  const { signToken } = await import('../apps/agent-api/src/auth.ts');
  ({ closePool: closeSharedPool } = await import('../database/db.ts'));
  const app = express();
  app.use(express.json());
  app.use('/api/control-tasks', createControlTasksRouter({
    repository,
    workflow: new TaskWorkflowService(repository),
    getDeliverable: async () => null,
  }));
  const server: Server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/control-tasks/${seeded.created.task.id}/revise`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signToken({ userId: ownerId, email: 'revision-owner@test.local' })}`,
        'content-type': 'application/json',
        'idempotency-key': 'forged-revision',
      },
      body: JSON.stringify({
        expectedVersion: seeded.selected.stateVersion,
        revisionInstruction: '限制为国内品牌',
        candidateId: 'speed',
        plan: { steps: [] },
        planHash: 'sha256:forged',
        pendingInputs: [],
      }),
    });
    assert.equal(response.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('workflow requires a revision driver and repository persists a canonical hash', async () => {
  const calls: Array<{ taskId: string; activePlanVersionId: string; instruction: string }> = [];
  const driver: WorkflowPlanRevisionDriver = {
    async revise(input) {
      calls.push(input);
      return {
        plan: {
          task_id: input.taskId,
          deliverable_type: 'research_plan',
          evidence_requirements: evidenceRequirements,
          steps: candidateSteps('speed').map((step) => ({ ...step, purpose: input.instruction })),
        },
        pendingInputs,
      };
    },
  };
  const workflow = new TaskWorkflowService(repository, undefined, driver);
  const seeded = await createSelectedTask({ workflow, suffix: 'workflow-driver' });
  const instruction = '减少样本数并保留公开来源';
  const revised = await workflow.revise({
    taskId: seeded.created.task.id,
    expectedVersion: seeded.selected.stateVersion,
    revisionInstruction: instruction,
    idempotencyKey: 'revise-with-driver',
    actor: { userId: ownerId, role: 'owner' },
  });
  const persisted = await repository.getPlanVersionDetail(revised.planVersionId);
  assert.ok(persisted);
  assert.equal(persisted.planHash, canonicalPlanHash(persisted.plan));
  assert.equal(persisted.candidateId, 'speed');
  assert.deepEqual(calls, [{
    taskId: seeded.created.task.id,
    activePlanVersionId: seeded.selectedPlan.id,
    instruction,
  }]);

  const replayed = await workflow.revise({
    taskId: seeded.created.task.id,
    expectedVersion: seeded.selected.stateVersion,
    revisionInstruction: instruction,
    idempotencyKey: 'revise-with-driver',
    actor: { userId: ownerId, role: 'owner' },
  });
  assert.deepEqual(replayed, revised);
  assert.equal(calls.length, 1);
  await assert.rejects(
    () => workflow.revise({
      taskId: seeded.created.task.id,
      expectedVersion: seeded.selected.stateVersion,
      revisionInstruction: '另一条修订指令',
      idempotencyKey: 'revise-with-driver',
      actor: { userId: ownerId, role: 'owner' },
    }),
    ControlPlaneConflictError,
  );
});

test('repository computes the revision hash instead of accepting one from its caller', async () => {
  const seeded = await createSelectedTask({ suffix: 'repository-canonical' });
  const plan = {
    task_id: seeded.created.task.id,
    deliverable_type: 'research_plan',
    evidence_requirements: evidenceRequirements,
    steps: candidateSteps('speed').map((step) => ({ ...step, purpose: 'canonical revision' })),
  };
  const revision = await repository.createPlanRevision({
    taskId: seeded.created.task.id,
    expectedVersion: seeded.selected.stateVersion,
    from: 'awaiting_confirmation',
    to: 'awaiting_confirmation',
    candidateId: 'speed',
    plan,
    pendingInputs,
  });
  const persisted = await repository.getPlanVersionDetail(revision.plan.id);
  assert.ok(persisted);
  assert.equal(persisted.planHash, canonicalPlanHash(plan));
});

test('production runtime replans from research goal and instruction while preserving frozen plan fields', async () => {
  const planningInputs: string[] = [];
  const runtime = await buildRuntime({
    async plan(input) {
      planningInputs.push(input.originalInput);
      return planningResult(input.originalInput);
    },
  });
  const seeded = await createSelectedTask({
    candidateId: 'speed',
    workflow: runtime.workflow,
    suffix: 'production-driver',
  });
  const instruction = '聚焦国内品牌并减少样本';
  const revised = await runtime.workflow.revise({
    taskId: seeded.created.task.id,
    expectedVersion: seeded.selected.stateVersion,
    revisionInstruction: instruction,
    idempotencyKey: 'production-revision',
    actor: { userId: ownerId, role: 'owner' },
  });
  const persisted = await repository.getPlanVersionDetail(revised.planVersionId);
  assert.ok(persisted);
  assert.equal(planningInputs.length, 1);
  assert.match(planningInputs[0]!, /研究国内宠物辅食品牌/);
  assert.match(planningInputs[0]!, /聚焦国内品牌并减少样本/);
  assert.equal(persisted.candidateId, 'speed');
  assert.equal((persisted.plan as Record<string, unknown>).deliverable_type, 'research_plan');
  assert.deepEqual((persisted.plan as Record<string, unknown>).evidence_requirements, evidenceRequirements);
  assert.deepEqual(persisted.pendingInputs, pendingInputs);
  const steps = (persisted.plan as { steps: Array<Record<string, unknown>> }).steps;
  assert.equal(steps[0]?.step_name, 'speed search');
  assert.equal(steps[0]?.step_no, 1);
  assert.equal('extra_client_field' in (steps[0] ?? {}), false);
  assert.equal(persisted.planHash, canonicalPlanHash(persisted.plan));
});

test('production runtime fails closed before creating a revision when planning context is invalid', async () => {
  let plannerCalls = 0;
  const runtime = await buildRuntime({
    async plan(input) {
      plannerCalls += 1;
      return planningResult(input.originalInput);
    },
  });

  await assert.rejects(() => runtime.workflow.revise({
    taskId: randomUUID(),
    expectedVersion: 0,
    revisionInstruction: '不存在的任务',
    idempotencyKey: 'missing-task-revision',
    actor: { userId: ownerId, role: 'owner' },
  }));

  const noActivePlan = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'no active plan',
    taskType: 'competitive_research',
    structuredTask: { research_goal: '缺少 active plan', confirmations: [], blocking_issues: [] },
    state: 'awaiting_confirmation',
  });
  await assert.rejects(() => runtime.workflow.revise({
    taskId: noActivePlan.id,
    expectedVersion: noActivePlan.stateVersion,
    revisionInstruction: '任意修订',
    idempotencyKey: 'missing-active-plan-revision',
    actor: { userId: ownerId, role: 'owner' },
  }));
  assert.equal(await repository.nextPlanVersion(noActivePlan.id), 1);

  const noCandidate = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'no candidate',
    taskType: 'competitive_research',
    structuredTask: { research_goal: '缺少 candidate', confirmations: [], blocking_issues: [] },
    state: 'awaiting_confirmation',
  });
  const candidateLessPlan = {
    task_id: noCandidate.id,
    deliverable_type: 'research_plan',
    evidence_requirements: evidenceRequirements,
    steps: candidateSteps('depth'),
  };
  await repository.createPlanVersion({
    taskId: noCandidate.id,
    version: 1,
    plan: candidateLessPlan,
    planHash: canonicalPlanHash(candidateLessPlan),
    pendingInputs,
  });
  await assert.rejects(() => runtime.workflow.revise({
    taskId: noCandidate.id,
    expectedVersion: noCandidate.stateVersion,
    revisionInstruction: '任意修订',
    idempotencyKey: 'missing-candidate-revision',
    actor: { userId: ownerId, role: 'owner' },
  }));
  assert.equal(await repository.nextPlanVersion(noCandidate.id), 2);

  const missingGoal = await createSelectedTask({
    structuredTask: { confirmations: [], blocking_issues: [] },
    workflow: runtime.workflow,
    suffix: 'missing-research-goal',
  });
  const missingGoalNextVersion = await repository.nextPlanVersion(missingGoal.created.task.id);
  await assert.rejects(() => runtime.workflow.revise({
    taskId: missingGoal.created.task.id,
    expectedVersion: missingGoal.selected.stateVersion,
    revisionInstruction: '任意修订',
    idempotencyKey: 'missing-goal-revision',
    actor: { userId: ownerId, role: 'owner' },
  }));
  assert.equal(await repository.nextPlanVersion(missingGoal.created.task.id), missingGoalNextVersion);

  const malformedRuntime = await buildRuntime({
    async plan(input) {
      plannerCalls += 1;
      return { ...planningResult(input.originalInput), candidates: [] };
    },
  });
  const malformed = await createSelectedTask({ workflow: malformedRuntime.workflow, suffix: 'malformed-planning' });
  const malformedNextVersion = await repository.nextPlanVersion(malformed.created.task.id);
  await assert.rejects(() => malformedRuntime.workflow.revise({
    taskId: malformed.created.task.id,
    expectedVersion: malformed.selected.stateVersion,
    revisionInstruction: '触发畸形 planner 输出',
    idempotencyKey: 'malformed-planning-revision',
    actor: { userId: ownerId, role: 'owner' },
  }));
  assert.equal(await repository.nextPlanVersion(malformed.created.task.id), malformedNextVersion);

  const foreign = await createSelectedTask({ workflow: runtime.workflow, suffix: 'foreign-owner' });
  await assert.rejects(() => runtime.workflow.revise({
    taskId: foreign.created.task.id,
    expectedVersion: foreign.selected.stateVersion,
    revisionInstruction: '绕过 owner',
    idempotencyKey: 'foreign-owner-revision',
    actor: { userId: foreignOwnerId, role: 'owner' },
  }));
  assert.equal(await repository.nextPlanVersion(foreign.created.task.id), 3);
  assert.equal(plannerCalls, 1);
});
