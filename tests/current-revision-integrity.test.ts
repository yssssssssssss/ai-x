import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  id: 'research-plan',
  acceptedClasses: ['user_input', 'knowledge', 'public_source'] as const,
  minimumCount: 1,
  required: true,
}];
const pendingInputs = [{
  kind: 'value' as const,
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
    task_type: 'user_research_planning',
    business_domain: '宠物辅食',
    research_goal: researchGoal,
    target_audience: ['产品团队'],
    scope: ['公开资料'],
    constraints: [],
    success_criteria: [{ id: 'source-backed', statement: '结论可追溯' }],
    expected_deliverables: ['research_plan'],
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
    taskType: 'user_research_planning',
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
      async listMessages() { return []; },
      async appendMessage() {},
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
  assert.ok(planningInputs[0]!.startsWith(instruction));
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
test('production runtime replaces legacy value and visual pending-input plans with wholly new revisions', async () => {
  let plannerCalls = 0;
  const runtime = await buildRuntime({
    async plan(input) {
      plannerCalls += 1;
      return planningResult(input.originalInput);
    },
  });
  const legacyCases = [
    {
      suffix: 'legacy-value-pending-kind',
      role: 'brief',
      suppliedValue: '只研究公开资料',
      pendingInput: {
        role: 'brief',
        label: '研究简报',
        multiple: false,
        targets: [{ step_no: 1, tool_id: 'tavily-web-search', field: 'query', multiple: false }],
      },
    },
    {
      suffix: 'legacy-visual-pending-kind',
      role: 'designImage',
      suppliedValue: { dataUrl: 'data:image/png;base64,legacy' },
      pendingInput: {
        role: 'designImage',
        label: '设计稿',
        multiple: false,
        targets: [{ step_no: 1, tool_id: 'tavily-web-search', field: 'query', multiple: false }],
      },
    },
  ];

  for (const legacy of legacyCases) {
    const seeded = await createSelectedTask({ suffix: legacy.suffix });
    const activePlan = await repository.getPlanVersionDetail(seeded.selected.planVersionId);
    assert.ok(activePlan);
    const legacyDecision = planningResult(legacy.suffix).capabilityResolution.eligible[0]!;
    await overwriteActivePlan({
      planVersionId: activePlan.id,
      plan: {
        ...(activePlan.plan as Record<string, unknown>),
        capability_decisions: {
          eligible: [{
            ...legacyDecision,
            pending_inputs: [{
              role: legacy.role,
              label: legacy.pendingInput.label,
              multiple: false,
              capability_id: legacyDecision.skill.id,
            }],
          }],
          rejected: [],
        },
      },
      pendingInputs: [legacy.pendingInput],
    });

    await assert.rejects(() => runtime.workflow.confirm({
      taskId: seeded.created.task.id,
      planVersionId: activePlan.id,
      expectedVersion: seeded.selected.stateVersion,
      idempotencyKey: `${legacy.suffix}-confirm`,
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: { [legacy.role]: legacy.suppliedValue },
    }));

    const revised = await runtime.workflow.revise({
      taskId: seeded.created.task.id,
      expectedVersion: seeded.selected.stateVersion,
      revisionInstruction: '按当前合同重新生成完整计划',
      idempotencyKey: `${legacy.suffix}-revise`,
      actor: { userId: ownerId, role: 'owner' },
    });
    const persisted = await repository.getPlanVersionDetail(revised.planVersionId);
    assert.ok(persisted);
    new SchemaValidator().validateOrThrow('current-execution-plan', persisted.plan);
    assert.deepEqual(persisted.pendingInputs, []);
    assert.equal(persisted.candidateId, activePlan.candidateId);
    assert.notEqual(persisted.id, activePlan.id);
    const preservedLegacy = await repository.getPlanVersionDetail(activePlan.id);
    assert.ok(Array.isArray(preservedLegacy?.pendingInputs));
    assert.equal(Object.hasOwn(preservedLegacy.pendingInputs[0] ?? {}, 'kind'), false);
  }
  assert.equal(plannerCalls, legacyCases.length);
});

test('revision driver rejects non-exact legacy and unrelated corruption before planner invocation', async () => {
  let plannerCalls = 0;
  const runtime = await buildRuntime({
    async plan(input) {
      plannerCalls += 1;
      return planningResult(input.originalInput);
    },
  });
  const cases = [
    {
      suffix: 'legacy-extra-field',
      mutate(plan: Record<string, unknown>) { return plan; },
      pendingInputs: [{
        role: 'brief',
        label: '研究简报',
        multiple: false,
        targets: [{ step_no: 1, tool_id: 'tavily-web-search', field: 'query', multiple: false }],
        unexpected: true,
      }],
    },
    {
      suffix: 'legacy-unrelated-corruption',
      mutate(plan: Record<string, unknown>) {
        return { ...plan, evidence_requirements: [null] };
      },
      pendingInputs: [{
        role: 'brief',
        label: '研究简报',
        multiple: false,
        targets: [{ step_no: 1, tool_id: 'tavily-web-search', field: 'query', multiple: false }],
      }],
    },
  ];

  for (const malformed of cases) {
    const seeded = await createSelectedTask({ suffix: malformed.suffix });
    const activePlan = await repository.getPlanVersionDetail(seeded.selected.planVersionId);
    assert.ok(activePlan);
    const legacyDecision = planningResult(malformed.suffix).capabilityResolution.eligible[0]!;
    await overwriteActivePlan({
      planVersionId: activePlan.id,
      plan: malformed.mutate({
        ...(activePlan.plan as Record<string, unknown>),
        capability_decisions: {
          eligible: [{
            ...legacyDecision,
            pending_inputs: [{
              role: 'brief',
              label: '研究简报',
              multiple: false,
              capability_id: legacyDecision.skill.id,
            }],
          }],
          rejected: [],
        },
      }),
      pendingInputs: malformed.pendingInputs,
    });
    const nextVersion = await repository.nextPlanVersion(seeded.created.task.id);
    await assert.rejects(() => runtime.workflow.revise({
      taskId: seeded.created.task.id,
      expectedVersion: seeded.selected.stateVersion,
      revisionInstruction: '不得容忍损坏的旧合同',
      idempotencyKey: `${malformed.suffix}-revise`,
      actor: { userId: ownerId, role: 'owner' },
    }));
    assert.equal(await repository.nextPlanVersion(seeded.created.task.id), nextVersion);
  }
  assert.equal(plannerCalls, 0);
});

test('revision driver rejects a schema-valid Deliverable Registry mismatch before planning', async () => {
  let plannerCalls = 0;
  const runtime = await buildRuntime({
    async plan(input) {
      plannerCalls += 1;
      return planningResult(input.originalInput);
    },
  });
  const seeded = await createSelectedTask({ suffix: 'deliverable-contract-mismatch' });
  const activePlan = await repository.getPlanVersionDetail(seeded.selected.planVersionId);
  assert.ok(activePlan);
  await overwriteActivePlan({
    planVersionId: activePlan.id,
    plan: {
      ...(activePlan.plan as Record<string, unknown>),
      deliverable_type: 'different-deliverable',
    },
    pendingInputs: activePlan.pendingInputs,
  });
  const nextVersion = await repository.nextPlanVersion(seeded.created.task.id);
  await assert.rejects(() => runtime.workflow.revise({
    taskId: seeded.created.task.id,
    expectedVersion: seeded.selected.stateVersion,
    revisionInstruction: '不得跨越交付物合同',
    idempotencyKey: 'deliverable-contract-mismatch-revise',
    actor: { userId: ownerId, role: 'owner' },
  }), /Deliverable Registry contract/u);
  assert.equal(plannerCalls, 0);
  assert.equal(await repository.nextPlanVersion(seeded.created.task.id), nextVersion);
});

test('migration 009 quarantines a legacy active plan and leaves it reachable through a new revision', async () => {
  const runtime = await buildRuntime({
    async plan(input) {
      return planningResult(input.originalInput);
    },
  });
  const seeded = await createSelectedTask({ suffix: 'migration-009-legacy-active' });
  const activePlan = await repository.getPlanVersionDetail(seeded.selected.planVersionId);
  assert.ok(activePlan);
  const legacyDecision = planningResult('migration-009').capabilityResolution.eligible[0]!;
  const legacyPendingInput = {
    role: 'brief',
    label: '研究简报',
    multiple: false,
    targets: [{ step_no: 1, tool_id: 'tavily-web-search', field: 'query', multiple: false }],
  };
  await overwriteActivePlan({
    planVersionId: activePlan.id,
    plan: {
      ...(activePlan.plan as Record<string, unknown>),
      capability_decisions: {
        eligible: [{
          ...legacyDecision,
          pending_inputs: [{
            role: 'brief',
            label: '研究简报',
            multiple: false,
            capability_id: legacyDecision.skill.id,
          }],
        }],
        rejected: [],
      },
    },
    pendingInputs: [legacyPendingInput],
  });
    const connection = await scopedDatabase.connect();
    try {
      const legacyPlan = await repository.getPlanVersionDetail(activePlan.id);
      assert.ok(legacyPlan);
      await connection.query(
        `UPDATE control_plan_versions SET plan_hash = $1 WHERE id = $2`,
        [canonicalPlanHash(legacyPlan.plan), activePlan.id],
      );
      await connection.query(
        `UPDATE control_tasks
       SET state = 'paused', state_version = state_version + 1
       WHERE id = $1`,
      [seeded.created.task.id],
    );
    const migration = readFileSync(
      join(process.cwd(), 'database', 'migrations', '009_quarantine_legacy_pending_input_plans.sql'),
      'utf8',
    );
    await connection.query(migration);
    const migrated = await repository.getTaskDetail(seeded.created.task.id);
    assert.equal(migrated?.state, 'awaiting_confirmation');
    assert.equal(migrated?.activePlanVersionId, activePlan.id);
    assert.ok(migrated);

    const { createControlTasksRouter } = await import('../apps/agent-api/src/routes/control-tasks.ts');
    const { signToken } = await import('../apps/agent-api/src/auth.ts');
    const app = express();
    app.use(express.json());
    app.use('/api/control-tasks', createControlTasksRouter({
      repository,
      workflow: runtime.workflow,
      getDeliverable: async () => null,
    }));
    const httpServer = createServer(app);
    httpServer.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    try {
      const address = httpServer.address();
      assert.ok(address && typeof address !== 'string');
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/control-tasks/${seeded.created.task.id}`,
        { headers: { authorization: `Bearer ${signToken({ userId: ownerId, email: 'revision-owner@test.local' })}` } },
      );
      assert.equal(response.status, 200, await response.clone().text());
      const body = await response.json() as { planRecovery?: unknown };
      assert.deepEqual(body.planRecovery, {
        kind: 'plan_revision_required',
        reason: 'legacy_pending_inputs',
      });
    } finally {
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    }

    const revised = await runtime.workflow.revise({
      taskId: seeded.created.task.id,
      expectedVersion: migrated.stateVersion,
      revisionInstruction: '升级为当前 PendingInput 合同',
      idempotencyKey: 'migration-009-revise',
      actor: { userId: ownerId, role: 'owner' },
    });
    const currentPlan = await repository.getPlanVersionDetail(revised.planVersionId);
    assert.ok(currentPlan);
    new SchemaValidator().validateOrThrow('current-execution-plan', currentPlan.plan);
    assert.deepEqual(currentPlan.pendingInputs, []);
    assert.notEqual(currentPlan.id, activePlan.id);

    const versionAfterRevision = (await repository.getTaskDetail(seeded.created.task.id))!.stateVersion;
    await connection.query(migration);
    assert.equal(
      (await repository.getTaskDetail(seeded.created.task.id))?.stateVersion,
      versionAfterRevision,
    );
    assert.ok(await repository.getPlanVersionDetail(activePlan.id));
  } finally {
    connection.release();
  }
});

test('migration 009 reconciles every recoverable legacy state and is replay-idempotent', async () => {
  const migration = readFileSync(
    join(process.cwd(), 'database', 'migrations', '009_quarantine_legacy_pending_input_plans.sql'),
    'utf8',
  );
  const legacyPendingInput = {
    role: 'brief',
    label: '研究简报',
    multiple: false,
    targets: [{ step_no: 1, tool_id: 'tavily-web-search', field: 'query', multiple: false }],
  };
  const selectionSuffix = `migration-009-awaiting-selection-${randomUUID()}`;
  const selection = await createSelectedTask({ suffix: selectionSuffix });
  await overwriteActivePlan({
    planVersionId: selection.selectedPlan.id,
    plan: selection.selectedPlan.plan,
    pendingInputs: [legacyPendingInput],
  });

  const recoverableStates = ['paused', 'executing', 'reviewing', 'composing_report'] as const;
  const fixtures = await Promise.all(recoverableStates.map(async (state) => {
    const seeded = await createSelectedTask({ suffix: `migration-009-${state}-${randomUUID()}` });
    await overwriteActivePlan({
      planVersionId: seeded.selectedPlan.id,
      plan: seeded.selectedPlan.plan,
      pendingInputs: [legacyPendingInput],
    });
    return { state, seeded };
  }));
  const passiveStates = ['awaiting_confirmation', 'awaiting_approval', 'ready'] as const;
  const passiveFixtures = await Promise.all(passiveStates.map(async (state) => {
    const seeded = await createSelectedTask({ suffix: `migration-009-${state}-${randomUUID()}` });
    await overwriteActivePlan({
      planVersionId: seeded.selectedPlan.id,
      plan: seeded.selectedPlan.plan,
      pendingInputs: [legacyPendingInput],
    });
    return { state, seeded };
  }));
  const foreignAttemptOwner = await createSelectedTask({
    suffix: `migration-009-foreign-attempt-owner-${randomUUID()}`,
  });

  const connection = await scopedDatabase.connect();
  try {
    const selectionBefore = await connection.query(
      `UPDATE control_tasks
       SET state = 'awaiting_selection',
           active_plan_version_id = NULL,
           current_attempt_id = NULL,
           state_version = state_version + 1
       WHERE id = $1
       RETURNING state_version, active_requirement_version_id`,
      [selection.created.task.id],
    );
    const selectionVersion = Number(selectionBefore.rows[0]?.state_version);
    assert.equal(selectionBefore.rows[0]?.active_requirement_version_id, null);

    const seededFixtures: Array<{
      state: typeof recoverableStates[number];
      taskId: string;
      planVersionId: string;
      attemptId: string;
      historicalAttemptId: string;
      existingFailureKind: string | null;
      commandId: string;
      stateVersion: number;
    }> = [];
    for (const { state, seeded } of fixtures) {
      const activeAttempt = state !== 'paused';
      const historicalAttempt = await connection.query(
        `INSERT INTO control_execution_attempts
           (task_id, plan_version_id, attempt_no, state, failure_kind, finished_at)
         VALUES ($1, $2, 1, 'cancelled', 'historical_failure', now() - interval '1 hour')
         RETURNING id`,
        [seeded.created.task.id, seeded.selectedPlan.id],
      );
      const historicalAttemptId = String(historicalAttempt.rows[0]?.id);
      const existingFailureKind = state === 'paused' ? 'preexisting_pause_failure' : null;
      const attempt = await connection.query(
        `INSERT INTO control_execution_attempts
           (task_id, plan_version_id, attempt_no, state, failure_kind,
            lease_owner, lease_token_hash, lease_expires_at, lease_heartbeat_at)
         VALUES ($1, $2, 2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          seeded.created.task.id,
          seeded.selectedPlan.id,
          activeAttempt ? 'active' : 'paused',
          existingFailureKind,
          activeAttempt ? `migration-worker-${state}` : null,
          activeAttempt ? `sha256:migration-lease-${state}` : null,
          activeAttempt ? new Date(Date.now() + 60_000) : null,
          activeAttempt ? new Date() : null,
        ],
      );
      const attemptId = String(attempt.rows[0]?.id);
      const updatedTask = await connection.query(
        `UPDATE control_tasks
         SET state = $2, current_attempt_id = $3, state_version = state_version + 1
         WHERE id = $1
         RETURNING state_version`,
        [seeded.created.task.id, state, attemptId],
      );
      const stateVersion = Number(updatedTask.rows[0]?.state_version);
      await connection.query(
        `INSERT INTO control_execution_steps
           (attempt_id, step_no, step_name, actor_type, actor_id, state, started_at, finished_at)
         VALUES
           ($1, 1, 'pending migration step', 'tool', 'fixture', 'pending', NULL, NULL),
           ($1, 2, 'running migration step', 'tool', 'fixture', 'running', now(), NULL),
           ($1, 3, 'finished migration step', 'tool', 'fixture', 'succeeded', now(), now())`,
        [attemptId],
      );
      await connection.query(
        `INSERT INTO control_artifacts
           (task_id, plan_version_id, attempt_id, kind, contract_version, schema_version,
            state, storage_uri, content_sha256, byte_size, sensitivity,
            redaction_policy_version, redaction_status, sealed_at)
         VALUES
           ($1, $2, $3, 'migration-staging', 'trusted-p0-v1', 'fixture-v1',
            'STAGING', $4, NULL, NULL, 'internal', 'fixture-v1', 'pending', NULL),
           ($1, $2, $3, 'migration-sealed', 'trusted-p0-v1', 'fixture-v1',
            'SEALED', $5, 'sha256:sealed', 6, 'internal', 'fixture-v1', 'passed', now())`,
        [
          seeded.created.task.id,
          seeded.selectedPlan.id,
          attemptId,
          `fixture://migration/${state}/staging`,
          `fixture://migration/${state}/sealed`,
        ],
      );
      const command = await connection.query(
        `INSERT INTO control_commands
           (task_id, command_type, idempotency_key, request_hash, expected_version,
            state_before, state_after, response_json, actor_user_id, command_status,
            reservation_token, reservation_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6, NULL, $7, 'pending', $8, now() + interval '1 hour')
         RETURNING id`,
        [
          seeded.created.task.id,
          `migration-${state}`,
          `migration-${state}-${randomUUID()}`,
          `sha256:migration-${state}`,
          stateVersion,
          state,
          ownerId,
          randomUUID(),
        ],
      );
      seededFixtures.push({
        state,
        taskId: seeded.created.task.id,
        planVersionId: seeded.selectedPlan.id,
        attemptId,
        historicalAttemptId,
        existingFailureKind,
        commandId: String(command.rows[0]?.id),
        stateVersion,
      });
    }
    const seededPassiveFixtures: Array<{
      state: typeof passiveStates[number];
      taskId: string;
      attemptId: string;
      ownsAttempt: boolean;
      stateVersion: number;
    }> = [];
    for (const { state, seeded } of passiveFixtures) {
      const ownsAttempt = state !== 'awaiting_confirmation';
      const priorPlan = ownsAttempt
        ? seeded.created.candidates.find((candidate) => candidate.id !== seeded.selectedPlan.id)
        : foreignAttemptOwner.selectedPlan;
      assert.ok(priorPlan);
      const attempt = await connection.query(
        `INSERT INTO control_execution_attempts
           (task_id, plan_version_id, attempt_no, state, failure_kind, finished_at)
         VALUES ($1, $2, 1, 'paused', 'preexisting_pause_failure', now())
         RETURNING id`,
        [ownsAttempt ? seeded.created.task.id : foreignAttemptOwner.created.task.id, priorPlan.id],
      );
      const attemptId = String(attempt.rows[0]?.id);
      const updated = await connection.query(
        `UPDATE control_tasks
         SET state = $2, current_attempt_id = $3, state_version = state_version + 1
         WHERE id = $1
         RETURNING state_version`,
        [seeded.created.task.id, state, attemptId],
      );
      seededPassiveFixtures.push({
        state,
        taskId: seeded.created.task.id,
        attemptId,
        ownsAttempt,
        stateVersion: Number(updated.rows[0]?.state_version),
      });
    }

    await connection.query(migration);

    const migratedSelection = await connection.query(
      `SELECT task.state, task.state_version, task.active_plan_version_id,
              task.current_attempt_id, task.active_requirement_version_id,
              requirement.version AS requirement_version,
              requirement.raw_input_hash,
              requirement.clarification_json,
              requirement.structured_task_json
       FROM control_tasks AS task
       LEFT JOIN control_requirement_versions AS requirement
         ON requirement.id = task.active_requirement_version_id
       WHERE task.id = $1`,
      [selection.created.task.id],
    );
    const selectionRow = migratedSelection.rows[0];
    assert.equal(selectionRow?.state, 'awaiting_clarification');
    assert.equal(Number(selectionRow?.state_version), selectionVersion + 1);
    assert.equal(selectionRow?.active_plan_version_id, null);
    assert.equal(selectionRow?.current_attempt_id, null);
    assert.ok(selectionRow?.active_requirement_version_id);
    assert.equal(Number(selectionRow?.requirement_version), 1);
    assert.equal(
      selectionRow?.raw_input_hash,
      `sha256:${createHash('sha256').update(`original ${selectionSuffix}`).digest('hex')}`,
    );
    assert.deepEqual(selectionRow?.clarification_json, {});
    assert.deepEqual(selectionRow?.structured_task_json, finalizedTask());

    const runtime = await buildRuntime({
      async plan() {
        return planningResult(finalizedTask().research_goal);
      },
    });
    const clarificationCommand = {
      taskId: selection.created.task.id,
      commandType: 'clarification' as const,
      idempotencyKey: `migration-009-clarify-${randomUUID()}`,
      requestHash: `sha256:${createHash('sha256').update(selectionSuffix).digest('hex')}`,
      expectedVersion: Number(selectionRow?.state_version),
      actorUserId: ownerId,
    };
    const reservation = await repository.reserveCommand(clarificationCommand);
    assert.equal(reservation.status, 'reserved');
    assert.ok(reservation.reservationToken);
    const refinement = await runtime.requirementRefinement.clarify({
      taskId: selection.created.task.id,
      conversationId,
      ownerUserId: ownerId,
      answers: {},
      expectedVersion: clarificationCommand.expectedVersion,
    });
    assert.equal(refinement.status, 'ready_to_plan');
    assert.ok(refinement.planningResult);
    const recoveredCandidates = await runtime.controlPlanning.planExistingTask({
      taskId: selection.created.task.id,
      conversationId,
      ownerUserId: ownerId,
      expectedStateVersion: clarificationCommand.expectedVersion,
      originalInput: `original ${selectionSuffix}`,
      commandReservation: {
        ...clarificationCommand,
        reservationToken: reservation.reservationToken!,
      },
      clarificationRecovery: refinement.clarificationRecovery,
    }, refinement.planningResult!);
    assert.equal(recoveredCandidates.task.state, 'awaiting_selection');
    const recoveredVersions = await Promise.all(recoveredCandidates.candidates.map(async (candidate) => (
      (await repository.getPlanVersionDetail(candidate.planVersionId))?.version
    )));
    assert.deepEqual(recoveredVersions, [3, 4]);
    const recoveredForOwner = await repository.listCandidatePlanVersionsForOwner({
      taskId: selection.created.task.id,
      ownerUserId: ownerId,
    });
    assert.deepEqual(
      recoveredForOwner?.candidates.map(({ planVersionId, candidateId }) => ({ planVersionId, candidateId })),
      recoveredCandidates.candidates.map(({ planVersionId, candidateId }) => ({ planVersionId, candidateId })),
    );
    await assert.rejects(() => runtime.workflow.select({
      taskId: selection.created.task.id,
      expectedVersion: recoveredCandidates.task.stateVersion,
      planVersionId: selection.selectedPlan.id,
      idempotencyKey: `migration-009-stale-select-${randomUUID()}`,
      actor: { userId: ownerId, role: 'owner' },
    }), /latest consecutive|not a candidate/u);
    assert.equal(
      (await repository.getTaskDetail(selection.created.task.id))?.state,
      'awaiting_selection',
    );

    for (const fixture of seededPassiveFixtures) {
      const task = await connection.query(
        `SELECT state, state_version, current_attempt_id
         FROM control_tasks WHERE id = $1`,
        [fixture.taskId],
      );
      assert.equal(task.rows[0]?.state, 'awaiting_confirmation');
      assert.equal(Number(task.rows[0]?.state_version), fixture.stateVersion + 1);
      assert.equal(task.rows[0]?.current_attempt_id, null);
      const attempt = await connection.query(
        `SELECT state, failure_kind, finished_at
         FROM control_execution_attempts WHERE id = $1`,
        [fixture.attemptId],
      );
      assert.equal(attempt.rows[0]?.state, fixture.ownsAttempt ? 'cancelled' : 'paused');
      assert.equal(attempt.rows[0]?.failure_kind, 'preexisting_pause_failure');
      assert.ok(attempt.rows[0]?.finished_at);
    }

    for (const fixture of seededFixtures) {
      const task = await connection.query(
        `SELECT state, state_version, active_plan_version_id, current_attempt_id
         FROM control_tasks WHERE id = $1`,
        [fixture.taskId],
      );
      assert.equal(task.rows[0]?.state, 'awaiting_confirmation');
      assert.equal(Number(task.rows[0]?.state_version), fixture.stateVersion + 1);
      assert.equal(task.rows[0]?.active_plan_version_id, fixture.planVersionId);
      assert.equal(task.rows[0]?.current_attempt_id, null);

      const attempt = await connection.query(
        `SELECT state, failure_kind, lease_owner, lease_token_hash, lease_expires_at,
                lease_heartbeat_at, finished_at
         FROM control_execution_attempts WHERE id = $1`,
        [fixture.attemptId],
      );
      assert.equal(attempt.rows[0]?.state, 'cancelled');
      assert.equal(
        attempt.rows[0]?.failure_kind,
        fixture.existingFailureKind ?? 'legacy_plan_quarantine',
      );
      assert.equal(attempt.rows[0]?.lease_owner, null);
      assert.equal(attempt.rows[0]?.lease_token_hash, null);
      assert.equal(attempt.rows[0]?.lease_expires_at, null);
      assert.equal(attempt.rows[0]?.lease_heartbeat_at, null);
      assert.ok(attempt.rows[0]?.finished_at);

      const historicalAttempt = await connection.query(
        `SELECT state, failure_kind, finished_at
         FROM control_execution_attempts WHERE id = $1`,
        [fixture.historicalAttemptId],
      );
      assert.equal(historicalAttempt.rows[0]?.state, 'cancelled');
      assert.equal(historicalAttempt.rows[0]?.failure_kind, 'historical_failure');
      assert.ok(historicalAttempt.rows[0]?.finished_at);

      const steps = await connection.query(
        `SELECT step_no, state, failure_json, finished_at
         FROM control_execution_steps WHERE attempt_id = $1 ORDER BY step_no`,
        [fixture.attemptId],
      );
      assert.deepEqual(steps.rows.map((row) => [Number(row.step_no), row.state]), [
        [1, 'skipped'],
        [2, 'failed'],
        [3, 'succeeded'],
      ]);
      assert.equal(steps.rows[0]?.failure_json, null);
      assert.deepEqual(steps.rows[1]?.failure_json, {
        kind: 'legacy_plan_quarantine',
        retryable: false,
      });
      assert.ok(steps.rows.every((row) => row.finished_at));

      const artifacts = await connection.query(
        `SELECT kind, state, failure_reason, redaction_status
         FROM control_artifacts WHERE attempt_id = $1 ORDER BY kind`,
        [fixture.attemptId],
      );
      assert.deepEqual(artifacts.rows, [
        {
          kind: 'migration-sealed',
          state: 'SEALED',
          failure_reason: null,
          redaction_status: 'passed',
        },
        {
          kind: 'migration-staging',
          state: 'FAILED',
          failure_reason: 'legacy plan quarantined before recovery',
          redaction_status: 'failed',
        },
      ]);
      const command = await connection.query(
        `SELECT command_status, reservation_token,
                reservation_expires_at <= now() AS expired
         FROM control_commands WHERE id = $1`,
        [fixture.commandId],
      );
      assert.equal(command.rows[0]?.command_status, 'pending');
      assert.ok(command.rows[0]?.reservation_token);
      assert.equal(command.rows[0]?.expired, true);
    }

    const snapshot = await connection.query(
      `SELECT task.id, task.state_version, command.reservation_expires_at
       FROM control_tasks AS task
       LEFT JOIN control_commands AS command
         ON command.task_id = task.id AND command.command_status = 'pending'
       WHERE task.id = ANY($1::uuid[])
       ORDER BY task.id`,
      [[
        selection.created.task.id,
        ...seededFixtures.map((fixture) => fixture.taskId),
        ...seededPassiveFixtures.map((fixture) => fixture.taskId),
      ]],
    );
    await connection.query(migration);
    const replayedSnapshot = await connection.query(
      `SELECT task.id, task.state_version, command.reservation_expires_at
       FROM control_tasks AS task
       LEFT JOIN control_commands AS command
         ON command.task_id = task.id AND command.command_status = 'pending'
       WHERE task.id = ANY($1::uuid[])
       ORDER BY task.id`,
      [[
        selection.created.task.id,
        ...seededFixtures.map((fixture) => fixture.taskId),
        ...seededPassiveFixtures.map((fixture) => fixture.taskId),
      ]],
    );
    assert.deepEqual(replayedSnapshot.rows, snapshot.rows);
    const requirementCount = await connection.query(
      `SELECT COUNT(*)::int AS count FROM control_requirement_versions WHERE task_id = $1`,
      [selection.created.task.id],
    );
    assert.equal(Number(requirementCount.rows[0]?.count), 1);
  } finally {
    connection.release();
  }
});

test('migration 009 makes every malformed PendingInput quarantine recoverable through a full revision', async () => {
  const migration = readFileSync(
    join(process.cwd(), 'database', 'migrations', '009_quarantine_legacy_pending_input_plans.sql'),
    'utf8',
  );
  const planningInputs: ResearchPlanningInput[] = [];
  const runtime = await buildRuntime({
    async plan(input) {
      planningInputs.push(structuredClone(input));
      return planningResult(input.originalInput);
    },
  });
  const validPending = {
    kind: 'value' as const,
    role: 'brief',
    label: '研究简报',
    multiple: false,
    targets: [{ step_no: 1, tool_id: 'tavily-web-search', field: 'query', multiple: false }],
  };
  const malformedCases: Array<{
    suffix: string;
    pendingInputs: unknown[];
    nestedExtra?: boolean;
    unrelatedPlanCorruption?: boolean;
  }> = [
    {
      suffix: 'extra-field',
      pendingInputs: [{ ...validPending, unexpected: true }],
      unrelatedPlanCorruption: true,
    },
    { suffix: 'wrong-multiple-type', pendingInputs: [{ ...validPending, multiple: 'false' }] },
    { suffix: 'empty-targets', pendingInputs: [{ ...validPending, targets: [] }] },
    {
      suffix: 'duplicate-role',
      pendingInputs: [
        validPending,
        {
          ...validPending,
          targets: [{ step_no: 1, tool_id: 'tavily-web-search', field: 'other', multiple: false }],
        },
      ],
    },
    {
      suffix: 'duplicate-target',
      pendingInputs: [validPending, { ...validPending, role: 'other', label: '其他输入' }],
    },
    { suffix: 'nested-extra-field', pendingInputs: [validPending], nestedExtra: true },
  ];
  const fixtures = [] as Array<{
    taskId: string;
    stateVersion: number;
    planVersionId: string;
    suffix: string;
  }>;
  for (const malformed of malformedCases) {
    const seeded = await createSelectedTask({ suffix: `migration-009-strict-${malformed.suffix}` });
    const plan = await repository.getPlanVersionDetail(seeded.selectedPlan.id);
    assert.ok(plan);
    const decision = planningResult(malformed.suffix).capabilityResolution.eligible[0]!;
    let untrustedPlan = plan.plan;
    if (malformed.nestedExtra) {
      untrustedPlan = {
        ...(plan.plan as Record<string, unknown>),
        capability_decisions: {
          eligible: [{
            ...decision,
            pending_inputs: [{
              kind: 'value',
              role: 'brief',
              label: '研究简报',
              multiple: false,
              capability_id: decision.skill.id,
              unexpected: true,
            }],
          }],
          rejected: [],
        },
      };
    }
    if (malformed.unrelatedPlanCorruption) {
      untrustedPlan = {
        ...(untrustedPlan as Record<string, unknown>),
        deliverable_type: 'untrusted-legacy-deliverable',
        evidence_requirements: [null],
      };
    }
    await overwriteActivePlan({
      planVersionId: plan.id,
      plan: untrustedPlan,
      pendingInputs: malformed.pendingInputs,
    });
    const connection = await scopedDatabase.connect();
    try {
      const ready = await connection.query(
        `UPDATE control_tasks
         SET state = 'ready', state_version = state_version + 1
         WHERE id = $1
         RETURNING state_version`,
        [seeded.created.task.id],
      );
      fixtures.push({
        taskId: seeded.created.task.id,
        stateVersion: Number(ready.rows[0]?.state_version),
        planVersionId: plan.id,
        suffix: malformed.suffix,
      });
    } finally {
      connection.release();
    }
  }
  const valid = await createSelectedTask({ suffix: 'migration-009-strict-valid-control' });
  const validConnection = await scopedDatabase.connect();
  let validVersion = 0;
  try {
    const ready = await validConnection.query(
      `UPDATE control_tasks
       SET state = 'ready', state_version = state_version + 1
       WHERE id = $1
       RETURNING state_version`,
      [valid.created.task.id],
    );
    validVersion = Number(ready.rows[0]?.state_version);
    await validConnection.query(migration);
  } finally {
    validConnection.release();
  }

  for (const fixture of fixtures) {
    const task = await repository.getTaskDetail(fixture.taskId);
    assert.equal(task?.state, 'awaiting_confirmation');
    assert.equal(task?.stateVersion, fixture.stateVersion + 1);
    assert.equal(
      await repository.isPlanPendingInputQuarantined(fixture.planVersionId),
      true,
    );
    assert.ok(task);

    const revised = await runtime.workflow.revise({
      taskId: fixture.taskId,
      expectedVersion: task.stateVersion,
      revisionInstruction: '完全重新生成当前合同计划',
      idempotencyKey: `migration-009-strict-${fixture.suffix}-revise`,
      actor: { userId: ownerId, role: 'owner' },
    });
    const currentPlan = await repository.getPlanVersionDetail(revised.planVersionId);
    assert.ok(currentPlan);
    new SchemaValidator().validateOrThrow('current-execution-plan', currentPlan.plan);
    assert.deepEqual(currentPlan.pendingInputs, []);
    assert.equal(await repository.isPlanPendingInputQuarantined(currentPlan.id), false);
    assert.equal(
      await repository.isPlanPendingInputQuarantined(fixture.planVersionId),
      true,
    );
  }
  assert.equal(planningInputs.length, malformedCases.length);
  for (const [index, planningInput] of planningInputs.entries()) {
    assert.deepEqual(planningInput.requirement, finalizedTask());
    assert.doesNotMatch(planningInput.originalInput, new RegExp(malformedCases[index]!.suffix, 'u'));
  }
  const validTask = await repository.getTaskDetail(valid.created.task.id);
  assert.equal(validTask?.state, 'ready');
  assert.equal(validTask?.stateVersion, validVersion);
});

test('plan history uses version identity and permits repeated content', async () => {
  const seeded = await createSelectedTask({ suffix: 'same-plan-corrected-pending-input' });
  const plan = await repository.getPlanVersionDetail(seeded.selectedPlan.id);
  assert.ok(plan);
  const legacyPending = pendingInputs.map(({ kind: _kind, ...pending }) => pending);
  await overwriteActivePlan({
    planVersionId: plan.id,
    plan: plan.plan,
    pendingInputs: legacyPending,
  });
  const connection = await scopedDatabase.connect();
  try {
    const corrected = await connection.query(
      `INSERT INTO control_plan_versions
         (task_id, version, candidate_id, plan_json, plan_hash, pending_inputs)
       VALUES ($1, 3, $2, $3, $4, $5)
       RETURNING version, plan_hash, pending_inputs`,
      [
        seeded.created.task.id,
        plan.candidateId,
        JSON.stringify(plan.plan),
        plan.planHash,
        JSON.stringify(pendingInputs),
      ],
    );
    assert.equal(Number(corrected.rows[0]?.version), 3);
    assert.equal(corrected.rows[0]?.plan_hash, plan.planHash);
    assert.deepEqual(corrected.rows[0]?.pending_inputs, pendingInputs);
    const repeated = await connection.query(
      `INSERT INTO control_plan_versions
         (task_id, version, candidate_id, plan_json, plan_hash, pending_inputs)
       VALUES ($1, 4, $2, $3, $4, $5)
       RETURNING version, plan_hash, pending_inputs`,
      [
        seeded.created.task.id,
        plan.candidateId,
        JSON.stringify(plan.plan),
        plan.planHash,
        JSON.stringify(pendingInputs),
      ],
    );
    assert.equal(Number(repeated.rows[0]?.version), 4);
    assert.equal(repeated.rows[0]?.plan_hash, plan.planHash);
    assert.deepEqual(repeated.rows[0]?.pending_inputs, pendingInputs);
  } finally {
    connection.release();
  }
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
    taskType: 'user_research_planning',
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
    taskType: 'user_research_planning',
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
