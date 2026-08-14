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
import type {
  CurrentResearchPlanningResult,
  ResearchPlanningInput,
} from '../apps/orchestrator-runtime/src/planners/research-planning-service.ts';
import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';

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
    await connection.query(
      `INSERT INTO control_model_calls
         (id, stage, attempt_id, step_no, provider, endpoint_host, requested_model, actual_model, model_version,
          prompt_hash, context_manifest_hash, trace_id, status, started_at, finished_at)
       VALUES ('11111111-1111-4111-8111-111111111111', 'problem_graph', NULL, NULL, 'fixture', 'fixture.test',
               'revision-fixture-model', 'revision-fixture-model', '1', 'sha256:revision-fixture-problem-graph',
               NULL, 'trace-revision-fixture-problem-graph', 'succeeded', now(), now())`,
    );
    await connection.query(
      `INSERT INTO control_model_calls
         (id, stage, attempt_id, step_no, provider, endpoint_host, requested_model, actual_model, model_version,
          prompt_hash, context_manifest_hash, trace_id, status, started_at, finished_at)
       VALUES ('22222222-2222-4222-8222-222222222222', 'problem_graph', NULL, NULL, 'fixture', 'fixture.test',
               'revision-planner', 'revision-planner', '1', 'sha256:problem-graph',
               NULL, 'revision-problem-graph', 'succeeded', now(), now())`,
    );
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

function finalizedTask(researchGoal = '研究国内宠物辅食品牌'): ResearchTaskV2 {
  return {
    version: 'research-task-v2',
    task_type: 'competitive_research',
    business_domain: '宠物辅食',
    research_goal: researchGoal,
    target_audience: ['产品团队'],
    scope: ['公开资料'],
    constraints: [],
    success_criteria: [{ id: 'source-backed', statement: '结论可追溯' }],
    expected_deliverables: ['研究计划'],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'public',
    pii_detected: false,
  };
}

function candidateSteps(mode: 'depth' | 'speed') {
  return [{
    step_no: 99,
    step_name: `${mode} search`,
    actor_type: 'tool' as const,
    actor_id: 'tavily-web-search',
    question_ids: ['source-question'],
    depends_on: [],
    input: { query: mode },
    input_bindings: [],
    expected_outputs: [{ pointer: '/results', description: '公开来源' }],
    acceptance_criteria: ['返回公开来源'],
    requires_approval: false,
    fallback_actor_ids: [],
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
    structuredTask: options.structuredTask ?? finalizedTask(),
    candidates: (['depth', 'speed'] as const).map((candidateId) => ({
      candidateId,
      plan: {
        task_id: '',
        deliverable_type: 'research_plan' as const,
        evidence_requirements: evidenceRequirements.map((requirement) => ({
          ...requirement,
          acceptedClasses: [...requirement.acceptedClasses],
        })),
        problem_graph: {
          version: 'problem-graph-v1' as const,
          questions: [{
            id: 'source-question',
            statement: '有哪些公开来源？',
            rationale: '支撑可追溯结论',
            priority: 'required' as const,
            success_criterion_ids: ['source-backed'],
            evidence_requirements: evidenceRequirements.map((requirement) => ({
              ...requirement,
              acceptedClasses: [...requirement.acceptedClasses],
            })),
            acceptance_criteria: ['至少一个公开来源'],
            depends_on: [],
          }],
        },
        problem_graph_provenance: {
          receiptId: '11111111-1111-4111-8111-111111111111',
          modelName: 'revision-fixture-model',
          modelVersion: '1',
          promptHash: 'sha256:revision-fixture-problem-graph',
          traceId: 'trace-revision-fixture-problem-graph',
        },
        capability_decisions: { eligible: [], rejected: [] },
        steps: candidateSteps(candidateId),
        candidate_metadata: {
          title: `${candidateId} original`,
          rationale: `${candidateId} original rationale`,
          tradeoffs: `${candidateId} original tradeoffs`,
        },
        activated_nodes: ['D5_competitive'],
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
async function overwriteActivePlan(input: {
  planVersionId: string;
  plan: unknown;
  pendingInputs: unknown;
}): Promise<void> {
  const connection = await scopedDatabase.connect();
  try {
    await connection.query(
      `UPDATE control_plan_versions
       SET plan_json = $1::jsonb, pending_inputs = $2::jsonb
       WHERE id = $3`,
      [JSON.stringify(input.plan), JSON.stringify(input.pendingInputs), input.planVersionId],
    );
  } finally {
    connection.release();
  }
}


function planningResult(originalInput: string): CurrentResearchPlanningResult {
  const structuredTask = finalizedTask(originalInput);
  const problemGraph = {
    version: 'problem-graph-v1' as const,
    questions: [{
      id: 'source-question',
      statement: '有哪些公开来源？',
      rationale: '支撑可追溯结论',
      priority: 'required' as const,
      success_criterion_ids: ['source-backed'],
      evidence_requirements: evidenceRequirements.map((requirement) => ({
        ...requirement,
        acceptedClasses: [...requirement.acceptedClasses],
      })),
      acceptance_criteria: ['至少一个公开来源'],
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
        required_tools: ['tavily-web-search'],
        risk_level: 'low' as const,
      },
      reasons: [{ code: 'eligible' as const, message: 'eligible' }],
      pending_inputs: [],
      required_approvals: [],
    }],
    rejected: [],
  };
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
    activatedNodes: ['D3_method_selection'],
    decisionStates: [],
    candidates: (['depth', 'speed'] as const).map((id) => ({
      id,
      title: id,
      rationale: id,
      tradeoffs: id,
      steps: candidateSteps(id),
      assumptions: [],
      activated_nodes: ['D3_method_selection'],
    })),
    guidanceSources: [],
    provenance: {
      modelName: 'revision-planner',
      modelVersion: '1',
      promptHash: originalInput,
      traceId: 'revision-trace',
    },
    problemGraph,
    problemGraphProvenance: {
      receiptId: '22222222-2222-4222-8222-222222222222',
      modelName: 'revision-planner',
      modelVersion: '1',
      promptHash: 'sha256:problem-graph',
      traceId: 'revision-problem-graph',
    },
    capabilityResolution,
  };
}

async function buildRuntime(planning: { plan(input: ResearchPlanningInput): Promise<CurrentResearchPlanningResult> }) {
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

function compiledRevisionPlan(taskId: string, title: string) {
  const result = planningResult(title);
  const candidate = result.candidates.find((item) => item.id === 'speed')!;
  return {
    task_id: taskId,
    deliverable_type: 'research_plan' as const,
    evidence_requirements: evidenceRequirements.map((requirement) => ({
      ...requirement,
      acceptedClasses: [...requirement.acceptedClasses],
    })),
    problem_graph: result.problemGraph,
    problem_graph_provenance: result.problemGraphProvenance,
    capability_decisions: result.capabilityResolution,
    steps: candidate.steps.map((step, index) => ({ ...step, step_no: index + 1 })),
    candidate_metadata: {
      title,
      rationale: 'Apply user instruction',
      tradeoffs: 'Replanned scope',
    },
    activated_nodes: result.activatedNodes,
  };
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
        plan: compiledRevisionPlan(input.taskId, 'speed revision'),
        pendingInputs: [],
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
  const plan = compiledRevisionPlan(seeded.created.task.id, 'speed canonical revision');
  const revision = await repository.createPlanRevision({
    taskId: seeded.created.task.id,
    expectedVersion: seeded.selected.stateVersion,
    from: 'awaiting_confirmation',
    to: 'awaiting_confirmation',
    candidateId: 'speed',
    plan,
    pendingInputs: [],
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
  assert.deepEqual(persisted.pendingInputs, []);
  assert.deepEqual((persisted.plan as Record<string, unknown>).candidate_metadata, {
    title: 'speed',
    rationale: 'speed',
    tradeoffs: 'speed',
  });
  assert.deepEqual((persisted.plan as Record<string, unknown>).activated_nodes, ['D3_method_selection']);
  const steps = (persisted.plan as { steps: Array<Record<string, unknown>> }).steps;
  assert.equal(steps[0]?.step_name, 'speed search');
  assert.equal(steps[0]?.step_no, 1);
  assert.equal('extra_client_field' in (steps[0] ?? {}), false);
  assert.equal(persisted.planHash, canonicalPlanHash(persisted.plan));
});
test('production runtime rejects malformed frozen revision fields before repository persistence', async () => {
  let plannerCalls = 0;
  const runtime = await buildRuntime({
    async plan(input) {
      plannerCalls += 1;
      return planningResult(input.originalInput);
    },
  });
  const malformedCases = [
    { suffix: 'malformed-frozen-evidence', evidenceRequirements: [null], pending: pendingInputs },
    { suffix: 'malformed-frozen-pending', evidenceRequirements, pending: [{ role: 'brief' }] },
  ];

  for (const malformed of malformedCases) {
    const seeded = await createSelectedTask({ suffix: malformed.suffix });
    const activePlan = await repository.getPlanVersionDetail(seeded.selected.planVersionId);
    assert.ok(activePlan);
    await overwriteActivePlan({
      planVersionId: activePlan.id,
      plan: {
        ...(activePlan.plan as Record<string, unknown>),
        evidence_requirements: malformed.evidenceRequirements,
        steps: candidateSteps('speed'),
      },
      pendingInputs: malformed.pending,
    });

    const nextVersion = await repository.nextPlanVersion(seeded.created.task.id);
    await assert.rejects(() => runtime.workflow.revise({
      taskId: seeded.created.task.id,
      expectedVersion: seeded.selected.stateVersion,
      revisionInstruction: '拒绝畸形冻结字段',
      idempotencyKey: malformed.suffix,
      actor: { userId: ownerId, role: 'owner' },
    }));
    assert.equal(await repository.nextPlanVersion(seeded.created.task.id), nextVersion);
  }
  assert.equal(plannerCalls, 0);
});
test('production runtime rejects malformed frozen step shape before repository persistence', async () => {
  let plannerCalls = 0;
  const runtime = await buildRuntime({
    async plan(input) {
      plannerCalls += 1;
      return planningResult(input.originalInput);
    },
  });
  const malformedSteps = [
    { suffix: 'malformed-step-null-input', step: { ...candidateSteps('speed')[0], input: null } },
    { suffix: 'malformed-step-array-input', step: { ...candidateSteps('speed')[0], input: [] } },
    { suffix: 'malformed-step-approval', step: { ...candidateSteps('speed')[0], requires_approval: 'yes' } },
    { suffix: 'malformed-step-purpose', step: { ...candidateSteps('speed')[0], purpose: 123 } },
    { suffix: 'malformed-step-extra-key', step: { ...candidateSteps('speed')[0], extra_client_field: 'reject-me' } },
  ];


  for (const malformed of malformedSteps) {
    const seeded = await createSelectedTask({ suffix: malformed.suffix });
    const activePlan = await repository.getPlanVersionDetail(seeded.selected.planVersionId);
    assert.ok(activePlan);
    await overwriteActivePlan({
      planVersionId: activePlan.id,
      plan: {
        ...(activePlan.plan as Record<string, unknown>),
        steps: [malformed.step],
      },
      pendingInputs: activePlan.pendingInputs,
    });

    const nextVersion = await repository.nextPlanVersion(seeded.created.task.id);
    await assert.rejects(() => runtime.workflow.revise({
      taskId: seeded.created.task.id,
      expectedVersion: seeded.selected.stateVersion,
      revisionInstruction: '拒绝畸形冻结步骤',
      idempotencyKey: malformed.suffix,
      actor: { userId: ownerId, role: 'owner' },
    }));
    assert.equal(await repository.nextPlanVersion(seeded.created.task.id), nextVersion);
  }
  assert.equal(plannerCalls, 0);
});

test('production runtime rejects a legacy purpose-only frozen step before persistence', async () => {
  let plannerCalls = 0;
  const runtime = await buildRuntime({
    async plan(input) {
      plannerCalls += 1;
      return planningResult(input.originalInput);
    },
  });
  const seeded = await createSelectedTask({ suffix: 'legacy-step-purpose-only', pendingInputs: [] });
  const activePlan = await repository.getPlanVersionDetail(seeded.selected.planVersionId);
  assert.ok(activePlan);
  await overwriteActivePlan({
    planVersionId: activePlan.id,
    plan: {
      ...(activePlan.plan as Record<string, unknown>),
      steps: [{
        step_no: 1,
        step_name: '公开资料检索',
        actor_type: 'tool',
        actor_id: 'tavily-web-search',
        purpose: '采集公开信息',
      }],
    },
    pendingInputs: [],
  });
  const nextVersion = await repository.nextPlanVersion(seeded.created.task.id);

  await assert.rejects(() => runtime.workflow.revise({
    taskId: seeded.created.task.id,
    expectedVersion: seeded.selected.stateVersion,
    revisionInstruction: '拒绝 Legacy 步骤',
    idempotencyKey: 'legacy-step-purpose-only',
    actor: { userId: ownerId, role: 'owner' },
  }), /current-execution-plan/);
  assert.equal(await repository.nextPlanVersion(seeded.created.task.id), nextVersion);
  assert.equal(plannerCalls, 0);
});

test('production runtime fails closed when regenerated steps leave pending input target dangling', async () => {
  let plannerCalls = 0;
  const runtime = await buildRuntime({
    async plan(input) {
      plannerCalls += 1;
      const result = planningResult(input.originalInput);
      return {
        ...result,
        candidates: result.candidates.map((candidate) => candidate.id === 'speed'
          ? {
            ...candidate,
            steps: candidate.steps.map((step) => ({
              ...step,
              actor_id: 'different-search-tool',
              input: { url: 'https://example.test' },
            })),
          }
          : candidate),
      };
    },
  });
  const seeded = await createSelectedTask({ workflow: runtime.workflow, suffix: 'dangling-pending-target' });
  const nextVersion = await repository.nextPlanVersion(seeded.created.task.id);

  await assert.rejects(() => runtime.workflow.revise({
    taskId: seeded.created.task.id,
    expectedVersion: seeded.selected.stateVersion,
    revisionInstruction: '生成无法绑定旧输入目标的步骤',
    idempotencyKey: 'dangling-pending-target',
    actor: { userId: ownerId, role: 'owner' },
  }));
  assert.equal(await repository.nextPlanVersion(seeded.created.task.id), nextVersion);
  assert.equal(plannerCalls, 1);
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
