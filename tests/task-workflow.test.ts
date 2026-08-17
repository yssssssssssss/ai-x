import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  ControlPlaneConflictError,
  ControlPlaneRepository,
  type ControlPlanVersionDetail,
  type ControlTask,
} from '../database/control-plane.ts';
import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import type {
  CurrentExecutionPlan,
  CurrentPlanStep,
} from '../packages/api-contract/research-deliverable.ts';
import {
  TaskWorkflowAuthorizationError,
  TaskWorkflowGateError,
  TaskWorkflowService,
} from '../apps/orchestrator-runtime/src/control/task-workflow.ts';
import { ControlArtifactStore } from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import { REPORT_REVIEW_DIMENSION_IDS } from '../packages/api-contract/control-workflow.ts';
import {
  runMigrations,
  type MigrationConnection,
  type MigrationDatabase,
} from '../database/migration-runner.ts';

type CandidatePersistenceRepository = ControlPlaneRepository & {
  createTaskWithCandidates(input: {
    conversationId: string;
    ownerUserId: string;
    originalInput: string;
    taskType: string | null;
    structuredTask: unknown;
    candidates: Array<{
      candidateId: string;
      plan: unknown;
      pendingInputs: unknown[];
    }>;
  }): Promise<{
    task: ControlTask;
    candidates: ControlPlanVersionDetail[];
  }>;
};

class ScopedWorkflowDatabase implements MigrationDatabase {
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

class SelectionCommandFailingDatabase implements MigrationDatabase {
  constructor(private readonly database: MigrationDatabase) {}

  async connect(): Promise<MigrationConnection> {
    const connection = await this.database.connect();
    return {
      async query(sql, values = []) {
        if (/^\s*INSERT\s+INTO\s+control_commands\b/i.test(sql) && values[1] === 'selection') {
          throw new Error('simulated command persistence failure');
        }
        return connection.query(sql, values);
      },
      release() {
        connection.release();
      },
    };
  }
}

const schema = `workflow_${randomUUID().replaceAll('-', '')}`;
const database = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/user_research_ai',
});
const scopedDatabase = new ScopedWorkflowDatabase(database, schema);
let ownerId = '';
let legalId = '';
let securityId = '';
let conversationId = '';
let foreignConversationId = '';

after(async () => {
  await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await database.end();
});

before(async () => {
  await database.query(`CREATE SCHEMA "${schema}"`);
  await runMigrations({
    database: scopedDatabase,
    migrationsDir: join(process.cwd(), 'database', 'migrations'),
  });
  const connection = await scopedDatabase.connect();
  try {
    const owner = await connection.query(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, 'owner', 'x', 'member') RETURNING id`,
      [`workflow-owner-${Date.now()}@test.local`],
    );
    ownerId = String(owner.rows[0]?.id);
    const legal = await connection.query(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, 'legal', 'x', 'legal') RETURNING id`,
      [`workflow-legal-${Date.now()}@test.local`],
    );
    legalId = String(legal.rows[0]?.id);
    const security = await connection.query(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, 'security', 'x', 'security') RETURNING id`,
      [`workflow-security-${Date.now()}@test.local`],
    );
    securityId = String(security.rows[0]?.id);
    const foreignOwner = await connection.query(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, 'foreign', 'x', 'member') RETURNING id`,
      [`workflow-foreign-${Date.now()}@test.local`],
    );
    const foreignConversation = await connection.query(
      `INSERT INTO conversations (owner_user_id, title) VALUES ($1, 'foreign') RETURNING id`,
      [String(foreignOwner.rows[0]?.id)],
    );
    foreignConversationId = String(foreignConversation.rows[0]?.id);
    const conversation = await connection.query(
      `INSERT INTO conversations (owner_user_id, title) VALUES ($1, 'workflow') RETURNING id`,
      [ownerId],
    );
    conversationId = String(conversation.rows[0]?.id);
    await connection.query(
      `INSERT INTO control_model_calls
         (id, stage, attempt_id, step_no, provider, endpoint_host, requested_model, actual_model, model_version,
          prompt_hash, context_manifest_hash, trace_id, status, started_at, finished_at)
       VALUES ('11111111-1111-4111-8111-111111111111', 'problem_graph', NULL, NULL, 'fixture', 'fixture.test',
               'workflow-fixture-model', 'workflow-fixture-model', '1', 'sha256:workflow-problem-graph',
               NULL, 'trace-workflow-problem-graph', 'succeeded', now(), now())`,
    );
  } finally {
    connection.release();
  }
});
const workflowEvidenceRequirement = {
  id: 'workflow-source',
  acceptedClasses: ['public_source'] as Array<'public_source'>,
  minimumCount: 1,
  required: true,
};

function currentTask(overrides: Partial<ResearchTaskV2> = {}): ResearchTaskV2 {
  return {
    version: 'research-task-v2',
    task_type: 'competitive_research',
    business_domain: 'workflow fixtures',
    research_goal: 'verify the Current workflow',
    target_audience: ['research team'],
    scope: ['public sources'],
    constraints: [],
    success_criteria: [{ id: 'workflow-ready', statement: 'the workflow remains executable' }],
    expected_deliverables: ['research plan'],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'public',
    pii_detected: false,
    ...overrides,
  };
}

function currentStep(overrides: Partial<CurrentPlanStep> = {}): CurrentPlanStep {
  return {
    step_no: 1,
    step_name: 'workflow analysis',
    actor_type: 'llm',
    actor_id: 'workflow-analysis',
    question_ids: ['workflow-question'],
    depends_on: [],
    input: {},
    input_bindings: [],
    expected_outputs: [{ pointer: '/result', description: 'workflow result' }],
    acceptance_criteria: ['workflow completes'],
    requires_approval: false,
    fallback_actor_ids: [],
    ...overrides,
  };
}

function currentPlan(
  taskId: string,
  label: string,
  steps: CurrentPlanStep[] = [currentStep()],
): CurrentExecutionPlan {
  const requiredTools = [...new Set(
    steps.filter((step) => step.actor_type === 'tool').map((step) => step.actor_id),
  )];
  return {
    task_id: taskId,
    deliverable_type: 'research_plan',
    evidence_requirements: [{
      ...workflowEvidenceRequirement,
      acceptedClasses: [...workflowEvidenceRequirement.acceptedClasses],
    }],
    problem_graph: {
      version: 'problem-graph-v1',
      questions: [{
        id: 'workflow-question',
        statement: 'Can the Current workflow complete safely?',
        rationale: 'Covers the workflow fixture contract',
        priority: 'required',
        success_criterion_ids: ['workflow-ready'],
        evidence_requirements: [{
          ...workflowEvidenceRequirement,
          acceptedClasses: [...workflowEvidenceRequirement.acceptedClasses],
        }],
        acceptance_criteria: ['At least one public source is traceable'],
        depends_on: [],
      }],
    },
    problem_graph_provenance: {
      receiptId: '11111111-1111-4111-8111-111111111111',
      modelName: 'workflow-fixture-model',
      modelVersion: '1',
      promptHash: 'sha256:workflow-problem-graph',
      traceId: 'trace-workflow-problem-graph',
    },
    capability_decisions: {
      eligible: requiredTools.length === 0 ? [] : [{
        skill: {
          id: `${label}-tool-provider`,
          status: 'active',
          task_types: ['competitive_research'],
          inputs: [],
          outputs: [],
          required_tools: requiredTools,
        },
        reasons: [{ code: 'eligible', message: 'fixture tools are eligible' }],
        pending_inputs: [],
        required_approvals: [],
      }],
      rejected: [],
    },
    steps,
    candidate_metadata: {
      title: label,
      rationale: `${label} rationale`,
      tradeoffs: `${label} tradeoffs`,
    },
    activated_nodes: ['D5_competitive'],
  };
}

async function createCandidateTask(
  repository: ControlPlaneRepository,
  suffix: string,
  options: {
    structuredTask?: unknown;
    candidateId?: 'depth' | 'speed';
    plan?: CurrentExecutionPlan;
    pendingInputs?: unknown[];
  } = {},
) {
  const candidateRepository = repository as unknown as CandidatePersistenceRepository;
  const candidateId = options.candidateId ?? 'depth';
  const alternateCandidateId = candidateId === 'depth' ? 'speed' : 'depth';
  return candidateRepository.createTaskWithCandidates({
    conversationId,
    ownerUserId: ownerId,
    originalInput: `server candidate selection ${suffix}`,
    taskType: 'competitive_research',
    structuredTask: options.structuredTask ?? currentTask(),
    candidates: [
      {
        candidateId,
        plan: options.plan ?? currentPlan('', `${candidateId} ${suffix}`),
        pendingInputs: options.pendingInputs ?? [],
      },
      {
        candidateId: alternateCandidateId,
        plan: currentPlan('', `${alternateCandidateId} ${suffix}`),
        pendingInputs: [],
      },
    ],
  });
}

test('selects an existing server candidate using only its planVersionId', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const created = await createCandidateTask(repository, 'selected');
  const selectedCandidate = created.candidates[0]!;

  const selection = await workflow.select({
    taskId: created.task.id,
    expectedVersion: created.task.stateVersion,
    idempotencyKey: 'select-server-depth-candidate',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: selectedCandidate.id,
  });

  assert.equal(selection.planVersionId, selectedCandidate.id);
  assert.equal(selection.state, 'awaiting_confirmation');
  const persistedTask = await repository.getTaskDetail(created.task.id);
  assert.equal(persistedTask?.state, 'awaiting_confirmation');
  assert.equal(persistedTask?.activePlanVersionId, selectedCandidate.id);
});

test('rolls back selection when command persistence fails and allows the same idempotency key to retry', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const created = await createCandidateTask(repository, 'atomic-selection');
  const planVersionId = created.candidates[0]!.id;
  const selectionInput = {
    taskId: created.task.id,
    expectedVersion: created.task.stateVersion,
    idempotencyKey: 'atomic-selection-command',
    actor: { userId: ownerId, role: 'owner' as const },
    planVersionId,
  };
  const failingRepository = new ControlPlaneRepository(
    new SelectionCommandFailingDatabase(scopedDatabase),
  );
  const failingWorkflow = new TaskWorkflowService(failingRepository);

  await assert.rejects(
    () => failingWorkflow.select(selectionInput),
    /simulated command persistence failure/,
  );

  const taskAfterFailure = await repository.getTaskDetail(created.task.id);
  assert.equal(taskAfterFailure?.state, 'awaiting_selection');
  assert.equal(taskAfterFailure?.activePlanVersionId, null);

  const recoveredSelection = await new TaskWorkflowService(repository).select(selectionInput);
  assert.equal(recoveredSelection.state, 'awaiting_confirmation');
  assert.equal(recoveredSelection.planVersionId, planVersionId);
});

test('rejects selecting a planVersionId that belongs to another task', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const target = await createCandidateTask(repository, 'target');
  const foreign = await createCandidateTask(repository, 'foreign');

  await assert.rejects(
    () => workflow.select({
      taskId: target.task.id,
      expectedVersion: target.task.stateVersion,
      idempotencyKey: 'reject-foreign-plan-version',
      actor: { userId: ownerId, role: 'owner' },
      planVersionId: foreign.candidates[0]!.id,
    }),
    ControlPlaneConflictError,
  );

  const persistedTarget = await repository.getTaskDetail(target.task.id);
  assert.equal(persistedTarget?.state, 'awaiting_selection');
  assert.equal(persistedTarget?.activePlanVersionId, null);
});

test('rejects a task owner when the linked conversation has another owner', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const task = await repository.createTask({
    conversationId: foreignConversationId,
    ownerUserId: ownerId,
    originalInput: 'cross-conversation attempt',
    taskType: 'competitive_research',
    structuredTask: currentTask(),
    state: 'awaiting_selection',
  });
  const candidate = await repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    candidateId: 'speed',
    plan: currentPlan(task.id, 'cross-conversation'),
    planHash: 'sha256:cross-conversation',
    pendingInputs: [],
  });
  await assert.rejects(
    () => workflow.select({
      taskId: task.id,
      expectedVersion: task.stateVersion,
      idempotencyKey: 'cross-conversation-select',
      actor: { userId: ownerId, role: 'owner' },
      planVersionId: candidate.id,
    }),
    TaskWorkflowAuthorizationError,
  );
});


test('malformed persisted workflow gate fails closed during confirmation', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const created = await createCandidateTask(repository, 'malformed', {
    structuredTask: { ...currentTask(), clarification_questions: 'not-an-array' },
    candidateId: 'speed',
    plan: currentPlan('', 'malformed'),
  });
  const task = created.task;
  const selection = await workflow.select({
    taskId: task.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: 'malformed-select',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: created.candidates[0]!.id,
  });
  await assert.rejects(
    () => workflow.confirm({
      taskId: task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'malformed-confirm',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: {},
    }),
    TaskWorkflowGateError,
  );
});

test('rejects extra input roles before writing gates or transitioning state', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const created = await createCandidateTask(repository, 'extra-input', {
    candidateId: 'speed',
    plan: currentPlan('', 'extra-input', [currentStep({ input: { brief: null } })]),
    pendingInputs: [{
      role: 'brief',
      label: '研究简报',
      multiple: false,
      targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'brief', multiple: false }],
    }],
  });
  const selection = await workflow.select({
    taskId: created.task.id,
    expectedVersion: created.task.stateVersion,
    idempotencyKey: 'extra-input-select',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: created.candidates.find((candidate) => candidate.candidateId === 'speed')!.id,
  });
  await assert.rejects(
    () => workflow.confirm({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'extra-input-confirm',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: { brief: '已提供', unknown_role: '不应写入' },
    }),
    TaskWorkflowGateError,
  );
  const persisted = await repository.getTaskDetail(created.task.id);
  assert.equal(persisted?.state, 'awaiting_confirmation');
  assert.deepEqual(await repository.listGateRecords(created.task.id, selection.planVersionId), []);
});
test('confirmation, required input, role matrix, and plan revision gate ready state', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository, undefined, {
    async revise({ taskId }) {
      return {
        plan: currentPlan(taskId, 'revised workflow plan'),
        pendingInputs: [],
      };
    },
  });
  const created = await createCandidateTask(repository, 'workflow-gate', {
    structuredTask: currentTask({
      clarification_questions: [{
        key: 'competitors',
        question: '竞品范围?',
        rationale: '确认公开研究范围',
      }],
      blocking_issues: [{ key: 'privacy', kind: 'privacy_compliance', reason: '敏感材料' }],
    }),
    plan: currentPlan('', 'workflow-gate', [currentStep({
      requires_approval: true,
      approval_role: 'security',
    })]),
    pendingInputs: [{
      role: 'brief',
      label: '研究简报',
      multiple: false,
      targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'brief', multiple: false }],
    }],
  });
  const task = created.task;

  const selection = await workflow.select({
    taskId: task.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: 'select-1',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: created.candidates[0]!.id,
  });

  await assert.rejects(
    () => workflow.confirm({
      taskId: task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'confirm-missing',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: { brief: '研究简报' },
    }),
    TaskWorkflowGateError,
  );
  await assert.rejects(
    () => workflow.confirm({
      taskId: task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'confirm-missing-input',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: { competitors: '头部三家' },
      inputValues: {},
    }),
    TaskWorkflowGateError,
  );

  const confirmed = await workflow.confirm({
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: selection.stateVersion,
    idempotencyKey: 'confirm-1',
    actor: { userId: ownerId, role: 'owner' },
    confirmationAnswers: { competitors: '头部三家' },
    inputValues: { brief: '研究简报' },
  });
  assert.equal(confirmed.state, 'awaiting_approval');

  await assert.rejects(
    () => workflow.approve({
      taskId: task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: confirmed.stateVersion,
      idempotencyKey: 'owner-cannot-approve-privacy',
      actor: { userId: ownerId, role: 'owner' },
      gateKey: 'privacy',
      decision: 'approved',
    }),
    TaskWorkflowAuthorizationError,
  );

  const legalApproved = await workflow.approve({
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: confirmed.stateVersion,
    idempotencyKey: 'legal-approves-privacy',
    actor: { userId: legalId, role: 'legal' },
    gateKey: 'privacy',
    decision: 'approved',
  });
  assert.equal(legalApproved.state, 'awaiting_approval');
  const securityApproved = await workflow.approve({
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: legalApproved.stateVersion,
    idempotencyKey: 'security-approves-step',
    actor: { userId: securityId, role: 'security' },
    gateKey: 'step:1',
    decision: 'approved',
  });
  assert.equal(securityApproved.state, 'ready');
  const approved = securityApproved;
  const revision = await workflow.revise({
    taskId: task.id,
    expectedVersion: approved.stateVersion,
    idempotencyKey: 'revise-after-approval',
    actor: { userId: ownerId, role: 'owner' },
    revisionInstruction: 're-plan after approval',
  });
  const reconfirmed = await workflow.confirm({
    taskId: task.id,
    planVersionId: revision.planVersionId,
    expectedVersion: revision.stateVersion,
    idempotencyKey: 'confirm-revised-plan',
    actor: { userId: ownerId, role: 'owner' },
    confirmationAnswers: { competitors: '头部三家' },
    inputValues: {},
  });
  assert.equal(reconfirmed.state, 'awaiting_approval');
});

test('confirmation persists own input values for execution without mutating the frozen plan', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  let observedInputGates: Array<Record<string, unknown>> = [];
  const workflow = new TaskWorkflowService(repository, {
    execute: async ({ lease }) => {
      observedInputGates = (await repository.listGateRecords(lease.taskId, lease.planVersionId))
        .filter((gate) => gate.gateType === 'input')
        .map((gate) => {
          const record = gate as unknown as Record<string, unknown>;
          return {
            gateKey: gate.gateKey,
            requiredAuthority: gate.requiredAuthority,
            value: record.value,
            actorUserId: record.actorUserId,
            actorRole: record.actorRole,
            idempotencyKey: record.idempotencyKey,
          };
        })
        .sort((left, right) => String(left.gateKey).localeCompare(String(right.gateKey)));
      await repository.completeExecution(lease);
      return { status: 'completed', attemptId: lease.attemptId };
    },
  });
  const pendingInputs = [
    {
      role: 'brief',
      label: '研究简报',
      multiple: false,
      targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'brief', multiple: false }],
    },
    {
      role: 'includeArchived',
      label: '包含历史资料',
      multiple: false,
      targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'includeArchived', multiple: false }],
    },
    {
      role: 'reviewerNote',
      label: '审阅备注',
      multiple: false,
      targets: [{ step_no: 1, tool_id: 'workflow-analysis', field: 'reviewerNote', multiple: false }],
    },
  ];
  const created = await createCandidateTask(repository, 'input-values', {
    candidateId: 'depth',
    plan: currentPlan('', 'input-values', [currentStep({
      input: {
        brief: 'frozen placeholder',
        includeArchived: true,
        reviewerNote: 'frozen placeholder',
      },
    })]),
    pendingInputs,
  });
  const selection = await workflow.select({
    taskId: created.task.id,
    expectedVersion: created.task.stateVersion,
    idempotencyKey: 'input-values-select',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: created.candidates[0]!.id,
  });
  const selectedBeforeConfirmation = await repository.getPlanVersionDetail(selection.planVersionId);
  assert.ok(selectedBeforeConfirmation);
  const frozenPlan = structuredClone(selectedBeforeConfirmation.plan);
  const inheritedInputValues = Object.assign(
    Object.create({ brief: { competitors: ['A', 'B'] } }) as Record<string, unknown>,
    { includeArchived: false, reviewerNote: null },
  );

  await assert.rejects(
    () => workflow.confirm({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'input-values-inherited-confirm',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: inheritedInputValues,
    }),
    (error: unknown) => error instanceof TaskWorkflowGateError && error.unresolved.includes('brief'),
  );

  const ready = await workflow.confirm({
    taskId: created.task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: selection.stateVersion,
    idempotencyKey: 'input-values-confirm',
    actor: { userId: ownerId, role: 'owner' },
    confirmationAnswers: {},
    inputValues: {
      brief: { competitors: ['A', 'B'] },
      includeArchived: false,
      reviewerNote: null,
    },
  });
  assert.equal(ready.state, 'ready');

  const execution = await workflow.execute({
    taskId: created.task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: ready.stateVersion,
    idempotencyKey: 'input-values-execute',
    actor: { userId: ownerId, role: 'owner' },
  });
  assert.equal(execution.state, 'completed');
  assert.deepEqual(observedInputGates, [
    {
      gateKey: 'brief',
      requiredAuthority: 'owner',
      value: { competitors: ['A', 'B'] },
      actorUserId: ownerId,
      actorRole: 'owner',
      idempotencyKey: 'input-values-confirm:input:brief',
    },
    {
      gateKey: 'includeArchived',
      requiredAuthority: 'owner',
      value: false,
      actorUserId: ownerId,
      actorRole: 'owner',
      idempotencyKey: 'input-values-confirm:input:includeArchived',
    },
    {
      gateKey: 'reviewerNote',
      requiredAuthority: 'owner',
      value: null,
      actorUserId: ownerId,
      actorRole: 'owner',
      idempotencyKey: 'input-values-confirm:input:reviewerNote',
    },
  ]);
  assert.deepEqual((await repository.getPlanVersionDetail(selection.planVersionId))?.plan, frozenPlan);
});

test('disabled execution claim creates no real execution work and pauses the task', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const created = await createCandidateTask(repository, 'disabled', {
    candidateId: 'speed',
  });
  const task = created.task;
  const selection = await workflow.select({
    taskId: task.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: 'disabled-select',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: created.candidates[0]!.id,
  });
  const ready = await workflow.confirm({
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: selection.stateVersion,
    idempotencyKey: 'disabled-confirm',
    actor: { userId: ownerId, role: 'owner' },
    confirmationAnswers: {},
    inputValues: {},
  });

  const execution = await workflow.execute({
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: ready.stateVersion,
    idempotencyKey: 'disabled-execute',
    actor: { userId: ownerId, role: 'owner' },
  });
  const replay = await workflow.execute({
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: ready.stateVersion,
    idempotencyKey: 'disabled-execute',
    actor: { userId: ownerId, role: 'owner' },
  });
  assert.deepEqual(replay, execution);

  assert.equal(execution.executionDisabled, true);
  assert.equal(execution.state, 'paused');
  assert.equal((await repository.listAttempts(task.id)).length, 1);
  const resumed = await workflow.resume({
    taskId: task.id,
    expectedVersion: execution.stateVersion,
    idempotencyKey: 'disabled-resume',
    actor: { userId: ownerId, role: 'owner' },
  });
  assert.equal(resumed.state, 'ready');
  const rerun = await workflow.execute({
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: resumed.stateVersion,
    idempotencyKey: 'disabled-rerun',
    actor: { userId: ownerId, role: 'owner' },
  });
  assert.equal(rerun.state, 'paused');
  assert.equal((await repository.listAttempts(task.id)).length, 2);
});

test('Workflow owns the lease and invokes a real execution driver once per command', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  let driverCalls = 0;
  const workflow = new TaskWorkflowService(repository, {
    execute: async ({ lease }) => {
      driverCalls += 1;
      await repository.requireActiveLease(lease);
      await repository.completeExecution(lease);
      return { status: 'completed', attemptId: lease.attemptId };
    },
  });
  const created = await createCandidateTask(repository, 'real', {
    candidateId: 'depth',
  });
  const task = created.task;
  const selection = await workflow.select({
    taskId: task.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: 'real-select',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: created.candidates[0]!.id,
  });
  const ready = await workflow.confirm({
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: selection.stateVersion,
    idempotencyKey: 'real-confirm',
    actor: { userId: ownerId, role: 'owner' },
    confirmationAnswers: {},
    inputValues: {},
  });
  const command = {
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: ready.stateVersion,
    idempotencyKey: 'real-execute',
    actor: { userId: ownerId, role: 'owner' as const },
  };

  const execution = await workflow.execute(command);
  const replay = await workflow.execute(command);

  assert.equal(execution.executionDisabled, false);
  assert.equal(execution.state, 'completed');
  assert.equal('leaseToken' in execution, false);
  assert.deepEqual(replay, execution);
  assert.equal(driverCalls, 1);
});

test('concurrent execute commands invoke the external driver only once', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  let driverCalls = 0;
  let announceDriver: (() => void) | undefined;
  let releaseDriver: (() => void) | undefined;
  const driverStarted = new Promise<void>((resolve) => { announceDriver = resolve; });
  const driverRelease = new Promise<void>((resolve) => { releaseDriver = resolve; });
  const workflow = new TaskWorkflowService(repository, {
    execute: async ({ lease }) => {
      driverCalls += 1;
      announceDriver?.();
      await driverRelease;
      await repository.completeExecution(lease);
      return { status: 'completed', attemptId: lease.attemptId };
    },
  });
  const created = await createCandidateTask(repository, 'concurrent', {
    candidateId: 'depth',
  });
  const task = created.task;
  const selection = await workflow.select({
    taskId: task.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: 'concurrent-select',
    actor: { userId: ownerId, role: 'owner' },
    planVersionId: created.candidates[0]!.id,
  });
  const ready = await workflow.confirm({
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: selection.stateVersion,
    idempotencyKey: 'concurrent-confirm',
    actor: { userId: ownerId, role: 'owner' },
    confirmationAnswers: {},
    inputValues: {},
  });
  const base = {
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: ready.stateVersion,
    actor: { userId: ownerId, role: 'owner' as const },
  };

  const first = workflow.execute({ ...base, idempotencyKey: 'execute-a' });
  await driverStarted;
  const second = workflow.execute({ ...base, idempotencyKey: 'execute-b' });
  releaseDriver?.();
  const results = await Promise.allSettled([first, second]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(driverCalls, 1);
  assert.equal((await repository.listAttempts(task.id)).length, 1);
});

test('reconstructs final artifact IDs after driver state commit but before command persistence', async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'task-workflow-command-loss-'));
  try {
    const repository = new ControlPlaneRepository(scopedDatabase);
    const artifacts = new ControlArtifactStore({ root: artifactRoot, registry: repository });
    let driverCalls = 0;
    let expectedArtifactIds: {
      deliverableArtifactId: string;
      evidenceManifestArtifactId: string;
      reportReviewArtifactId: string;
    } | undefined;
    const workflow = new TaskWorkflowService(repository, {
      execute: async ({ lease }) => {
        driverCalls += 1;
        const evidenceManifest = await artifacts.writeJson({
          taskId: lease.taskId,
          planVersionId: lease.planVersionId,
          attemptId: lease.attemptId,
          kind: 'evidence_manifest',
          relativePath: 'evidence/manifest.json',
          schemaVersion: 'evidence-v1',
          activeLease: lease,
          value: {
            version: 'evidence-v1',
            taskId: lease.taskId,
            planVersionId: lease.planVersionId,
            attemptId: lease.attemptId,
          },
        });
        const deliverable = await artifacts.writeJson({
          taskId: lease.taskId,
          planVersionId: lease.planVersionId,
          attemptId: lease.attemptId,
          kind: 'deliverable',
          relativePath: 'deliverables/final-r1.json',
          schemaVersion: 'research-deliverable-v1-review-gated',
          activeLease: lease,
          value: {
            version: 'research-deliverable-v1',
            taskId: lease.taskId,
            planVersionId: lease.planVersionId,
            attemptId: lease.attemptId,
            evidenceManifestArtifactId: evidenceManifest.id,
          },
        });
        const reportReview = await artifacts.writeJson({
          taskId: lease.taskId,
          planVersionId: lease.planVersionId,
          attemptId: lease.attemptId,
          kind: 'report_review',
          relativePath: 'reports/review-r1.json',
          schemaVersion: 'report-review-v1',
          activeLease: lease,
          value: {
            version: 'report-review-v1',
            taskId: lease.taskId,
            planVersionId: lease.planVersionId,
            attemptId: lease.attemptId,
            deliverableArtifactId: deliverable.id,
            verdict: 'pass',
            dimensions: REPORT_REVIEW_DIMENSION_IDS.map((id) => ({ id, passed: true, issues: [] })),
            revisionRound: 1,
          },
        });
        await artifacts.writeJson({
          taskId: lease.taskId,
          planVersionId: lease.planVersionId,
          attemptId: lease.attemptId,
          kind: 'evidence_manifest',
          relativePath: 'evidence/later-manifest.json',
          schemaVersion: 'evidence-v1',
          activeLease: lease,
          value: {
            version: 'evidence-v1',
            taskId: lease.taskId,
            planVersionId: lease.planVersionId,
            attemptId: lease.attemptId,
          },
        });
        expectedArtifactIds = {
          deliverableArtifactId: deliverable.id,
          evidenceManifestArtifactId: evidenceManifest.id,
          reportReviewArtifactId: reportReview.id,
        };
        await repository.completeExecution(lease);
        throw new Error('simulated process crash after state commit');
      },
    }, undefined, artifacts);
    const created = await createCandidateTask(repository, 'crash', {
      candidateId: 'depth',
    });
    const task = created.task;
    const selection = await workflow.select({
      taskId: task.id,
      expectedVersion: task.stateVersion,
      idempotencyKey: 'crash-select',
      actor: { userId: ownerId, role: 'owner' },
      planVersionId: created.candidates[0]!.id,
    });
    const ready = await workflow.confirm({
      taskId: task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'crash-confirm',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: {},
    });
    const command = {
      taskId: task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: ready.stateVersion,
      idempotencyKey: 'crash-execute',
      actor: { userId: ownerId, role: 'owner' as const },
    };

    await assert.rejects(() => workflow.execute(command), /simulated process crash/);
    const replay = await workflow.execute(command);

    assert.ok(expectedArtifactIds);
    assert.equal(replay.executionDisabled, false);
    assert.equal(replay.state, 'completed');
    assert.equal('status' in replay && replay.status, 'completed');
    assert.equal('deliverableArtifactId' in replay && replay.deliverableArtifactId, expectedArtifactIds.deliverableArtifactId);
    assert.equal('evidenceManifestArtifactId' in replay && replay.evidenceManifestArtifactId, expectedArtifactIds.evidenceManifestArtifactId);
    assert.equal('reportReviewArtifactId' in replay && replay.reportReviewArtifactId, expectedArtifactIds.reportReviewArtifactId);
    assert.equal('reviewStatus' in replay && replay.reviewStatus, 'completed');
    assert.equal(driverCalls, 1);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('replays a sealed pass Review as completed when post-review failure leaves the task paused', async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'task-workflow-paused-review-replay-'));
  try {
    const repository = new ControlPlaneRepository(scopedDatabase);
    const artifacts = new ControlArtifactStore({ root: artifactRoot, registry: repository });
    let driverCalls = 0;
    let expectedArtifactIds: {
      deliverableArtifactId: string;
      evidenceManifestArtifactId: string;
      reportReviewArtifactId: string;
    } | undefined;
    const workflow = new TaskWorkflowService(repository, {
      execute: async ({ lease }) => {
        driverCalls += 1;
        const evidenceManifest = await artifacts.writeJson({
          taskId: lease.taskId,
          planVersionId: lease.planVersionId,
          attemptId: lease.attemptId,
          kind: 'evidence_manifest',
          relativePath: 'evidence/manifest.json',
          schemaVersion: 'evidence-v1',
          activeLease: lease,
          value: {
            version: 'evidence-v1',
            taskId: lease.taskId,
            planVersionId: lease.planVersionId,
            attemptId: lease.attemptId,
          },
        });
        const deliverable = await artifacts.writeJson({
          taskId: lease.taskId,
          planVersionId: lease.planVersionId,
          attemptId: lease.attemptId,
          kind: 'deliverable',
          relativePath: 'deliverables/final-r1.json',
          schemaVersion: 'research-deliverable-v1-review-gated',
          activeLease: lease,
          value: {
            version: 'research-deliverable-v1',
            taskId: lease.taskId,
            planVersionId: lease.planVersionId,
            attemptId: lease.attemptId,
            evidenceManifestArtifactId: evidenceManifest.id,
          },
        });
        const reportReview = await artifacts.writeJson({
          taskId: lease.taskId,
          planVersionId: lease.planVersionId,
          attemptId: lease.attemptId,
          kind: 'report_review',
          relativePath: 'reports/review-r1.json',
          schemaVersion: 'report-review-v1',
          activeLease: lease,
          value: {
            version: 'report-review-v1',
            taskId: lease.taskId,
            planVersionId: lease.planVersionId,
            attemptId: lease.attemptId,
            deliverableArtifactId: deliverable.id,
            verdict: 'pass',
            dimensions: REPORT_REVIEW_DIMENSION_IDS.map((id) => ({ id, passed: true, issues: [] })),
            revisionRound: 1,
          },
        });
        expectedArtifactIds = {
          deliverableArtifactId: deliverable.id,
          evidenceManifestArtifactId: evidenceManifest.id,
          reportReviewArtifactId: reportReview.id,
        };
        await repository.recordExecutionStep({
          attemptId: lease.attemptId,
          stepNo: 99,
          stepName: 'post-review packaging',
          actorType: 'system',
          actorId: 'report-package',
          state: 'failed',
          failure: { kind: 'post_review', allowedActions: ['retry', 'abort'] },
        });
        const executingTask = await repository.getTaskDetail(lease.taskId);
        assert.ok(executingTask);
        await repository.pauseExecution({
          taskId: lease.taskId,
          attemptId: lease.attemptId,
          expectedVersion: executingTask.stateVersion,
          reason: 'post_review',
        });
        throw new Error('simulated process crash after post-review pause');
      },
    }, undefined, artifacts);
    const created = await createCandidateTask(repository, 'paused-review-replay', {
      candidateId: 'depth',
    });
    const selection = await workflow.select({
      taskId: created.task.id,
      expectedVersion: created.task.stateVersion,
      idempotencyKey: 'paused-review-select',
      actor: { userId: ownerId, role: 'owner' },
      planVersionId: created.candidates[0]!.id,
    });
    const ready = await workflow.confirm({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'paused-review-confirm',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: {},
    });
    const command = {
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: ready.stateVersion,
      idempotencyKey: 'paused-review-execute',
      actor: { userId: ownerId, role: 'owner' as const },
    };

    await assert.rejects(() => workflow.execute(command), /simulated process crash/);
    const replay = await workflow.execute(command);

    assert.ok(expectedArtifactIds);
    assert.equal(replay.state, 'paused');
    assert.equal('status' in replay && replay.status, 'paused');
    assert.equal('deliverableArtifactId' in replay && replay.deliverableArtifactId, expectedArtifactIds.deliverableArtifactId);
    assert.equal('evidenceManifestArtifactId' in replay && replay.evidenceManifestArtifactId, expectedArtifactIds.evidenceManifestArtifactId);
    assert.equal('reportReviewArtifactId' in replay && replay.reportReviewArtifactId, expectedArtifactIds.reportReviewArtifactId);
    assert.equal('reviewStatus' in replay && replay.reviewStatus, 'completed');
    assert.equal(driverCalls, 1);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('rejects a sealed hash-valid Review with an unknown verdict during paused replay', async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'task-workflow-unknown-review-replay-'));
  try {
    const repository = new ControlPlaneRepository(scopedDatabase);
    const artifacts = new ControlArtifactStore({ root: artifactRoot, registry: repository });
    const workflow = new TaskWorkflowService(repository, {
      execute: async ({ lease }) => {
        const evidenceManifest = await artifacts.writeJson({
          taskId: lease.taskId,
          planVersionId: lease.planVersionId,
          attemptId: lease.attemptId,
          kind: 'evidence_manifest',
          relativePath: 'evidence/manifest.json',
          schemaVersion: 'evidence-v1',
          activeLease: lease,
          value: { version: 'evidence-v1', taskId: lease.taskId, planVersionId: lease.planVersionId, attemptId: lease.attemptId },
        });
        const deliverable = await artifacts.writeJson({
          taskId: lease.taskId,
          planVersionId: lease.planVersionId,
          attemptId: lease.attemptId,
          kind: 'deliverable',
          relativePath: 'deliverables/final-r0.json',
          schemaVersion: 'research-deliverable-v1-review-gated',
          activeLease: lease,
          value: {
            version: 'research-deliverable-v1',
            taskId: lease.taskId,
            planVersionId: lease.planVersionId,
            attemptId: lease.attemptId,
            evidenceManifestArtifactId: evidenceManifest.id,
          },
        });
        await artifacts.writeJson({
          taskId: lease.taskId,
          planVersionId: lease.planVersionId,
          attemptId: lease.attemptId,
          kind: 'report_review',
          relativePath: 'reports/review-r0.json',
          schemaVersion: 'report-review-v1',
          activeLease: lease,
          value: {
            version: 'report-review-v1',
            taskId: lease.taskId,
            planVersionId: lease.planVersionId,
            attemptId: lease.attemptId,
            deliverableArtifactId: deliverable.id,
            verdict: 'unknown',
            dimensions: REPORT_REVIEW_DIMENSION_IDS.map((id) => ({ id, passed: true, issues: [] })),
            revisionRound: 0,
          },
        });
        const executingTask = await repository.getTaskDetail(lease.taskId);
        assert.ok(executingTask);
        await repository.pauseExecution({
          taskId: lease.taskId,
          attemptId: lease.attemptId,
          expectedVersion: executingTask.stateVersion,
          reason: 'post_review',
        });
        throw new Error('simulated process crash after unknown Review');
      },
    }, undefined, artifacts);
    const created = await createCandidateTask(repository, 'unknown-review-replay', { candidateId: 'depth' });
    const selection = await workflow.select({
      taskId: created.task.id,
      expectedVersion: created.task.stateVersion,
      idempotencyKey: 'unknown-review-select',
      actor: { userId: ownerId, role: 'owner' },
      planVersionId: created.candidates[0]!.id,
    });
    const ready = await workflow.confirm({
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: selection.stateVersion,
      idempotencyKey: 'unknown-review-confirm',
      actor: { userId: ownerId, role: 'owner' },
      confirmationAnswers: {},
      inputValues: {},
    });
    const command = {
      taskId: created.task.id,
      planVersionId: selection.planVersionId,
      expectedVersion: ready.stateVersion,
      idempotencyKey: 'unknown-review-execute',
      actor: { userId: ownerId, role: 'owner' as const },
    };

    await assert.rejects(() => workflow.execute(command), /simulated process crash/);
    await assert.rejects(() => workflow.execute(command), ControlPlaneConflictError);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

async function createPausedTask(input: {
  repository: ControlPlaneRepository;
  suffix: string;
  failedStepNo: number;
  steps: CurrentPlanStep[];
  allowedActions: string[];
  pendingInputs?: unknown[];
  failureKind?: string;
  planFactory?: (taskId: string, steps: CurrentPlanStep[]) => CurrentExecutionPlan;
}) {
  const task = await input.repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: `${input.suffix} resume`,
    taskType: 'competitive_research',
    structuredTask: currentTask(),
    state: 'ready',
  });
  const plan = await input.repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    candidateId: 'speed',
    plan: input.planFactory?.(task.id, input.steps) ?? currentPlan(task.id, input.suffix, input.steps),
    planHash: `sha256:${input.suffix}-resume-plan`,
    pendingInputs: input.pendingInputs ?? [],
  });
  const claim = await input.repository.claimExecution({
    taskId: task.id,
    planVersionId: plan.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: `${input.suffix}-claim`,
    requestHash: `sha256:${input.suffix}-claim`,
    leaseOwner: 'resume-test',
    leaseTokenHash: `sha256:${input.suffix}-lease`,
  });
  const failedStep = input.steps.find((step) => step.step_no === input.failedStepNo);
  assert.ok(failedStep && failedStep.actor_type === 'tool');
  await input.repository.recordExecutionStep({
    attemptId: claim.attemptId,
    stepNo: failedStep.step_no,
    stepName: failedStep.step_name,
    actorType: failedStep.actor_type,
    actorId: failedStep.actor_id,
    state: 'failed',
    failure: {
      kind: input.failureKind ?? 'network',
      toolTier: input.allowedActions.includes('skip') ? 'optional' : 'core',
      allowedActions: input.allowedActions,
    },
  });
  const paused = await input.repository.pauseExecution({
    taskId: task.id,
    attemptId: claim.attemptId,
    expectedVersion: claim.stateVersion,
    reason: 'network',
  });
  return { task, plan, paused };
}

test('worker-loss retry without failedStepNo validates recovery before accepting recovered state', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const paused = await createPausedTask({
    repository,
    suffix: 'retry-recovered-state',
    failedStepNo: 1,
    steps: [currentStep({ actor_type: 'tool', actor_id: 'tavily-web-search' })],
    allowedActions: ['retry', 'abort'],
    failureKind: 'worker_loss',
  });

  const resumed = await workflow.resume({
    taskId: paused.task.id,
    expectedVersion: paused.paused.stateVersion,
    idempotencyKey: 'retry-recovered-state-first',
    actor: { userId: ownerId, role: 'owner' },
  });
  assert.equal(resumed.state, 'ready');
  const recovered = await workflow.resume({
    taskId: paused.task.id,
    expectedVersion: paused.paused.stateVersion,
    idempotencyKey: 'retry-recovered-state-legitimate',
    actor: { userId: ownerId, role: 'owner' },
    action: 'retry',
    failedStepNo: 1,
  });
  assert.deepEqual(recovered, resumed);
  await assert.rejects(
    () => workflow.resume({
      taskId: paused.task.id,
      expectedVersion: paused.paused.stateVersion,
      idempotencyKey: 'retry-recovered-state-wrong-step',
      actor: { userId: ownerId, role: 'owner' },
      action: 'retry',
      failedStepNo: 99,
    }),
    TaskWorkflowGateError,
  );
  await assert.rejects(
    () => workflow.resume({
      taskId: paused.task.id,
      expectedVersion: paused.paused.stateVersion,
      idempotencyKey: 'retry-recovered-state-wrong-action',
      actor: { userId: ownerId, role: 'owner' },
      action: 'skip',
      failedStepNo: 1,
    }),
    TaskWorkflowGateError,
  );
});

test('report review failure rejects retry and permits only abort recovery', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const task = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'non-retryable report review recovery',
    taskType: 'competitive_research',
    structuredTask: currentTask(),
    state: 'ready',
  });
  const planSteps = [currentStep({ actor_type: 'tool', actor_id: 'tavily-web-search' })];
  const plan = await repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    candidateId: 'speed',
    plan: currentPlan(task.id, 'report-review-recovery', planSteps),
    planHash: `sha256:${randomUUID()}`,
  });
  const claim = await repository.claimExecution({
    taskId: task.id,
    planVersionId: plan.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: `review-claim-${randomUUID()}`,
    requestHash: `sha256:${randomUUID()}`,
    leaseOwner: 'review-recovery-test',
    leaseTokenHash: `sha256:${randomUUID()}`,
  });
  const failedStepNo = planSteps.length + 2;
  await repository.recordExecutionStep({
    attemptId: claim.attemptId,
    stepNo: failedStepNo,
    stepName: 'report review',
    actorType: 'reviewer',
    actorId: 'report-review',
    state: 'failed',
    failure: {
      kind: 'report_review',
      retryable: false,
      allowedActions: ['abort'],
      verdict: 'block',
    },
  });
  const paused = await repository.pauseExecution({
    taskId: task.id,
    attemptId: claim.attemptId,
    expectedVersion: claim.stateVersion,
    reason: 'report_review',
  });

  await assert.rejects(
    () => workflow.resume({
      taskId: task.id,
      expectedVersion: paused.stateVersion,
      idempotencyKey: `review-forged-retry-${randomUUID()}`,
      actor: { userId: ownerId, role: 'owner' },
      action: 'retry',
      failedStepNo: failedStepNo + 100,
    }),
    TaskWorkflowGateError,
  );
  assert.equal((await repository.getTaskDetail(task.id))?.state, 'paused');
  assert.equal((await repository.listAttempts(task.id))[0]?.state, 'paused');

  await assert.rejects(
    () => workflow.resume({
      taskId: task.id,
      expectedVersion: paused.stateVersion,
      idempotencyKey: `review-retry-${randomUUID()}`,
      actor: { userId: ownerId, role: 'owner' },
      action: 'retry',
      failedStepNo,
    }),
    TaskWorkflowGateError,
  );
  assert.equal((await repository.getTaskDetail(task.id))?.state, 'paused');
  assert.equal((await repository.listAttempts(task.id))[0]?.state, 'paused');

  const aborted = await workflow.resume({
    taskId: task.id,
    expectedVersion: paused.stateVersion,
    idempotencyKey: `review-abort-${randomUUID()}`,
    actor: { userId: ownerId, role: 'owner' },
    action: 'abort',
    failedStepNo,
  });
  assert.equal(aborted.state, 'cancelled');
  assert.equal((await repository.listAttempts(task.id))[0]?.state, 'cancelled');
  const recoveredAbort = await workflow.resume({
    taskId: task.id,
    expectedVersion: paused.stateVersion,
    idempotencyKey: `review-abort-recovered-${randomUUID()}`,
    actor: { userId: ownerId, role: 'owner' },
    action: 'abort',
    failedStepNo,
  });
  assert.deepEqual(recoveredAbort, aborted);
  await assert.rejects(
    () => workflow.resume({
      taskId: task.id,
      expectedVersion: paused.stateVersion,
      idempotencyKey: `review-abort-wrong-step-${randomUUID()}`,
      actor: { userId: ownerId, role: 'owner' },
      action: 'abort',
      failedStepNo: failedStepNo + 1,
    }),
    TaskWorkflowGateError,
  );
});

test('resume rejects core skip and safely renumbers a strict Current plan after optional skip', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const core = await createPausedTask({
    repository,
    suffix: 'core-resume',
    failedStepNo: 1,
    steps: [
      currentStep({
        step_name: 'failed core tool',
        actor_type: 'tool',
        actor_id: 'tavily-web-search',
        expected_outputs: [{ pointer: '/results', description: 'core results' }],
      }),
      currentStep({ step_no: 2, step_name: 'analysis', actor_id: 'analysis' }),
    ],
    allowedActions: ['retry', 'abort'],
  });
  await assert.rejects(
    () => workflow.resume({
      taskId: core.task.id,
      expectedVersion: core.paused.stateVersion,
      idempotencyKey: 'core-skip',
      actor: { userId: ownerId, role: 'owner' },
      action: 'skip',
      failedStepNo: 1,
    }),
    TaskWorkflowGateError,
  );
  const aborted = await workflow.resume({
    taskId: core.task.id,
    expectedVersion: core.paused.stateVersion,
    idempotencyKey: 'core-abort',
    actor: { userId: ownerId, role: 'owner' },
    action: 'abort',
    failedStepNo: 1,
  });
  assert.equal(aborted.state, 'cancelled');
  assert.equal((await repository.listAttempts(core.task.id))[0]?.state, 'cancelled');

  const originalOptionalSteps = [
    currentStep({
      step_name: 'core search',
      actor_type: 'tool',
      actor_id: 'tavily-web-search',
      expected_outputs: [{ pointer: '/results', description: 'core results' }],
    }),
    currentStep({
      step_no: 2,
      step_name: 'failed optional search',
      actor_type: 'tool',
      actor_id: 'ai-spider-search',
      expected_outputs: [{ pointer: '/results', description: 'optional results' }],
    }),
    currentStep({
      step_no: 3,
      step_name: 'analysis',
      actor_id: 'analysis',
      depends_on: [1],
      input: { sources: null },
      input_bindings: [{ target_pointer: '/sources', source_step_no: 1, source_pointer: '/results' }],
      expected_outputs: [{ pointer: '/analysis', description: 'analysis result' }],
    }),
    currentStep({
      step_no: 4,
      step_name: 'review',
      actor_type: 'reviewer',
      actor_id: 'reviewer',
      depends_on: [3],
      input: { analysis: null },
      input_bindings: [{ target_pointer: '/analysis', source_step_no: 3, source_pointer: '/analysis' }],
      expected_outputs: [{ pointer: '/review', description: 'review result' }],
    }),
  ];
  const optional = await createPausedTask({
    repository,
    suffix: 'optional-resume',
    failedStepNo: 2,
    steps: originalOptionalSteps,
    allowedActions: ['retry', 'skip', 'abort'],
  });
  const skipped = await workflow.resume({
    taskId: optional.task.id,
    expectedVersion: optional.paused.stateVersion,
    idempotencyKey: 'optional-skip',
    actor: { userId: ownerId, role: 'owner' },
    action: 'skip',
    failedStepNo: 2,
  });
  assert.equal(skipped.state, 'awaiting_confirmation');
  const recoveredSkip = await workflow.resume({
    taskId: optional.task.id,
    expectedVersion: optional.paused.stateVersion,
    idempotencyKey: 'optional-skip-recovered',
    actor: { userId: ownerId, role: 'owner' },
    action: 'skip',
    failedStepNo: 2,
  });
  assert.deepEqual(recoveredSkip, skipped);
  await assert.rejects(
    () => workflow.resume({
      taskId: optional.task.id,
      expectedVersion: optional.paused.stateVersion,
      idempotencyKey: 'optional-skip-wrong-step',
      actor: { userId: ownerId, role: 'owner' },
      action: 'skip',
      failedStepNo: 99,
    }),
    TaskWorkflowGateError,
  );
  const revisedTask = await repository.getTaskDetail(optional.task.id);
  assert.notEqual(revisedTask?.activePlanVersionId, optional.plan.id);
  const revisedPlan = await repository.getPlanVersionDetail(revisedTask?.activePlanVersionId ?? '');
  assert.equal(revisedPlan?.candidateId, 'speed');
  const expectedSteps = [
    originalOptionalSteps[0]!,
    { ...originalOptionalSteps[2]!, step_no: 2 },
    {
      ...originalOptionalSteps[3]!,
      step_no: 3,
      depends_on: [2],
      input_bindings: [{ target_pointer: '/analysis', source_step_no: 2, source_pointer: '/analysis' }],
    },
  ];
  assert.deepEqual(revisedPlan?.plan, {
    ...currentPlan(optional.task.id, 'optional-resume', originalOptionalSteps),
    steps: expectedSteps,
  });
});

test('resume skip remaps every remaining PendingInput target with the step map', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const steps = [
    currentStep({
      step_name: 'core search',
      actor_type: 'tool',
      actor_id: 'tavily-web-search',
      expected_outputs: [{ pointer: '/results', description: 'core results' }],
    }),
    currentStep({
      step_no: 2,
      step_name: 'failed optional search',
      actor_type: 'tool',
      actor_id: 'ai-spider-search',
      expected_outputs: [{ pointer: '/results', description: 'optional results' }],
    }),
    currentStep({
      step_no: 3,
      step_name: 'analysis skill',
      actor_type: 'skill',
      actor_id: 'analysis-skill',
      depends_on: [1],
      input: { brief: null, sources: null },
      input_bindings: [{ target_pointer: '/sources', source_step_no: 1, source_pointer: '/results' }],
      expected_outputs: [{ pointer: '/analysis', description: 'analysis result' }],
    }),
    currentStep({
      step_no: 4,
      step_name: 'review skill',
      actor_type: 'skill',
      actor_id: 'review-skill',
      depends_on: [3],
      input: { brief: null, analysis: null },
      input_bindings: [{ target_pointer: '/analysis', source_step_no: 3, source_pointer: '/analysis' }],
      expected_outputs: [{ pointer: '/review', description: 'review result' }],
    }),
  ];
  const pendingInputs = [{
    role: 'brief',
    label: '研究简报',
    multiple: true,
    targets: [
      { step_no: 3, tool_id: 'analysis-skill', field: 'brief', multiple: true },
      { step_no: 4, tool_id: 'review-skill', field: 'brief', multiple: true },
    ],
  }];
  const paused = await createPausedTask({
    repository,
    suffix: 'pending-target-remap',
    failedStepNo: 2,
    steps,
    allowedActions: ['retry', 'skip', 'abort'],
    pendingInputs,
    planFactory(taskId, planSteps) {
      const plan = currentPlan(taskId, 'pending-target-remap', planSteps);
      plan.capability_decisions.eligible.push(
        {
          skill: {
            id: 'analysis-skill',
            status: 'active',
            task_types: ['competitive_research'],
            inputs: ['brief'],
            outputs: ['analysis'],
            required_tools: [],
          },
          reasons: [
            { code: 'pending_input_required', message: 'analysis requires a brief' },
            { code: 'eligible', message: 'analysis skill is eligible' },
          ],
          pending_inputs: [{
            role: 'brief',
            label: '研究简报',
            multiple: true,
            capability_id: 'analysis-skill',
          }],
          required_approvals: [],
        },
        {
          skill: {
            id: 'review-skill',
            status: 'active',
            task_types: ['competitive_research'],
            inputs: ['brief'],
            outputs: ['review'],
            required_tools: [],
          },
          reasons: [
            { code: 'pending_input_required', message: 'review requires a brief' },
            { code: 'eligible', message: 'review skill is eligible' },
          ],
          pending_inputs: [{
            role: 'brief',
            label: '研究简报',
            multiple: true,
            capability_id: 'review-skill',
          }],
          required_approvals: [],
        },
      );
      return plan;
    },
  });

  const resumed = await workflow.resume({
    taskId: paused.task.id,
    expectedVersion: paused.paused.stateVersion,
    idempotencyKey: 'pending-target-remap-skip',
    actor: { userId: ownerId, role: 'owner' },
    action: 'skip',
    failedStepNo: 2,
  });
  assert.equal(resumed.state, 'awaiting_confirmation');
  const revisedTask = await repository.getTaskDetail(paused.task.id);
  const revisedPlan = await repository.getPlanVersionDetail(revisedTask?.activePlanVersionId ?? '');
  assert.deepEqual(revisedPlan?.pendingInputs, [{
    role: 'brief',
    label: '研究简报',
    multiple: true,
    targets: [
      { step_no: 2, tool_id: 'analysis-skill', field: 'brief', multiple: true },
      { step_no: 3, tool_id: 'review-skill', field: 'brief', multiple: true },
    ],
  }]);
});

test('resume skip rejects a PendingInput target that points at the removed step', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const paused = await createPausedTask({
    repository,
    suffix: 'removed-pending-target',
    failedStepNo: 1,
    steps: [
      currentStep({
        step_name: 'failed optional search',
        actor_type: 'tool',
        actor_id: 'ai-spider-search',
        input: { brief: null },
        expected_outputs: [{ pointer: '/results', description: 'optional results' }],
      }),
      currentStep({ step_no: 2, step_name: 'remaining analysis' }),
    ],
    allowedActions: ['retry', 'skip', 'abort'],
    pendingInputs: [{
      role: 'brief',
      label: '研究简报',
      multiple: false,
      targets: [{ step_no: 1, tool_id: 'ai-spider-search', field: 'brief', multiple: false }],
    }],
  });

  await assert.rejects(
    () => workflow.resume({
      taskId: paused.task.id,
      expectedVersion: paused.paused.stateVersion,
      idempotencyKey: 'removed-pending-target-skip',
      actor: { userId: ownerId, role: 'owner' },
      action: 'skip',
      failedStepNo: 1,
    }),
    TaskWorkflowGateError,
  );
  const unchanged = await repository.getTaskDetail(paused.task.id);
  assert.equal(unchanged?.state, 'paused');
  assert.equal(unchanged?.activePlanVersionId, paused.plan.id);
});

test('resume rejects skipping an optional step referenced by a remaining dependency or input binding', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const references = [
    {
      kind: 'dependency',
      step: currentStep({ step_no: 2, depends_on: [1] }),
    },
    {
      kind: 'binding',
      step: currentStep({
        step_no: 2,
        input: { source: null },
        input_bindings: [{ target_pointer: '/source', source_step_no: 1, source_pointer: '/results' }],
      }),
    },
  ] as const;

  for (const reference of references) {
    const paused = await createPausedTask({
      repository,
      suffix: `referenced-${reference.kind}`,
      failedStepNo: 1,
      steps: [
        currentStep({
          step_name: 'failed optional search',
          actor_type: 'tool',
          actor_id: 'ai-spider-search',
          expected_outputs: [{ pointer: '/results', description: 'optional results' }],
        }),
        reference.step,
      ],
      allowedActions: ['retry', 'skip', 'abort'],
    });
    await assert.rejects(
      () => workflow.resume({
        taskId: paused.task.id,
        expectedVersion: paused.paused.stateVersion,
        idempotencyKey: `referenced-${reference.kind}-skip`,
        actor: { userId: ownerId, role: 'owner' },
        action: 'skip',
        failedStepNo: 1,
      }),
      TaskWorkflowGateError,
    );
    const unchanged = await repository.getTaskDetail(paused.task.id);
    assert.equal(unchanged?.state, 'paused');
    assert.equal(unchanged?.activePlanVersionId, paused.plan.id);
  }
});

test('resume rejects non-contiguous or out-of-order Current step numbers before skip remapping', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const malformedPlans = [
    {
      kind: 'gapped',
      failedStepNo: 1,
      steps: [
        currentStep({
          step_name: 'failed optional search',
          actor_type: 'tool',
          actor_id: 'ai-spider-search',
          expected_outputs: [{ pointer: '/results', description: 'optional results' }],
        }),
        currentStep({ step_no: 3 }),
      ],
    },
    {
      kind: 'out-of-order',
      failedStepNo: 2,
      steps: [
        currentStep({
          step_no: 2,
          step_name: 'failed optional search',
          actor_type: 'tool',
          actor_id: 'ai-spider-search',
          expected_outputs: [{ pointer: '/results', description: 'optional results' }],
        }),
        currentStep(),
      ],
    },
  ] as const;

  for (const malformed of malformedPlans) {
    const paused = await createPausedTask({
      repository,
      suffix: `malformed-${malformed.kind}`,
      failedStepNo: malformed.failedStepNo,
      steps: [...malformed.steps],
      allowedActions: ['retry', 'skip', 'abort'],
    });
    await assert.rejects(
      () => workflow.resume({
        taskId: paused.task.id,
        expectedVersion: paused.paused.stateVersion,
        idempotencyKey: `malformed-${malformed.kind}-skip`,
        actor: { userId: ownerId, role: 'owner' },
        action: 'skip',
        failedStepNo: malformed.failedStepNo,
      }),
      TaskWorkflowGateError,
    );
    const unchanged = await repository.getTaskDetail(paused.task.id);
    assert.equal(unchanged?.state, 'paused');
    assert.equal(unchanged?.activePlanVersionId, paused.plan.id);
  }
});
