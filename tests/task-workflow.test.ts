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
      inputRoles: [],
    }),
    TaskWorkflowGateError,
  );
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
      inputRoles: ['brief'],
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
      inputRoles: [],
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
    inputRoles: ['brief'],
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
    inputRoles: [],
  });
  assert.equal(reconfirmed.state, 'awaiting_approval');
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
    inputRoles: [],
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
    inputRoles: [],
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
    inputRoles: [],
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

test('reconstructs an execution result after driver state commit but before command persistence', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  let driverCalls = 0;
  const workflow = new TaskWorkflowService(repository, {
    execute: async ({ lease }) => {
      driverCalls += 1;
      await repository.completeExecution(lease);
      throw new Error('simulated process crash after state commit');
    },
  });
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
    inputRoles: [],
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

  assert.equal(replay.executionDisabled, false);
  assert.equal(replay.state, 'completed');
  assert.equal('status' in replay && replay.status, 'completed');
  assert.equal(driverCalls, 1);
});

async function createPausedTask(input: {
  repository: ControlPlaneRepository;
  suffix: string;
  failedStepNo: number;
  steps: CurrentPlanStep[];
  allowedActions: string[];
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
    plan: currentPlan(task.id, input.suffix, input.steps),
    planHash: `sha256:${input.suffix}-resume-plan`,
    pendingInputs: [],
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
      kind: 'network',
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
