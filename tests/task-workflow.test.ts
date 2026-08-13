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
let goldId = '';
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
    const gold = await connection.query(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, 'gold', 'x', 'gold') RETURNING id`,
      [`workflow-gold-${Date.now()}@test.local`],
    );
    goldId = String(gold.rows[0]?.id);
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

async function createCandidateTask(
  repository: ControlPlaneRepository,
  suffix: string,
  options: {
    structuredTask?: unknown;
    candidateId?: string;
    plan?: Record<string, unknown>;
    pendingInputs?: unknown[];
  } = {},
) {
  const candidateRepository = repository as unknown as CandidatePersistenceRepository;
  const candidateId = options.candidateId ?? 'depth';
  const alternateCandidateId = candidateId === 'depth' ? 'speed' : 'depth';
  const candidatePlan = options.plan ?? {
    title: `${candidateId} ${suffix}`,
    steps: [{ step_no: 1, step_name: candidateId }],
  };
  return candidateRepository.createTaskWithCandidates({
    conversationId,
    ownerUserId: ownerId,
    originalInput: `server candidate selection ${suffix}`,
    taskType: 'competitive_research',
    structuredTask: options.structuredTask ?? { confirmations: [], blocking_issues: [] },
    candidates: [
      {
        candidateId,
        plan: {
          ...candidatePlan,
          task_id: `provisional-${candidateId}-${suffix}`,
        },
        pendingInputs: options.pendingInputs ?? [],
      },
      {
        candidateId: alternateCandidateId,
        plan: {
          task_id: `provisional-${alternateCandidateId}-${suffix}`,
          title: `${alternateCandidateId} ${suffix}`,
          steps: [{ step_no: 1, step_name: alternateCandidateId }],
        },
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
    structuredTask: {},
    state: 'awaiting_selection',
  });
  const candidate = await repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    candidateId: 'speed',
    plan: { steps: [] },
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
    structuredTask: { confirmations: 'not-an-array' },
    candidateId: 'speed',
    plan: { steps: [] },
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
  const workflow = new TaskWorkflowService(repository);
  const created = await createCandidateTask(repository, 'workflow-gate', {
    structuredTask: {
      confirmations: [{ key: 'competitors', question: '竞品范围?' }],
      blocking_issues: [
        { key: 'privacy', kind: 'privacy_compliance', reason: '敏感材料' },
        { key: 'gold-review', required_authority: 'gold', reason: 'Gold evidence review' },
      ],
    },
    plan: { steps: [{ step_no: 1, requires_approval: true, approval_role: 'security' }] },
    pendingInputs: [{ role: 'brief' }],
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
      inputRoles: [],
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
  assert.equal(securityApproved.state, 'awaiting_approval');
  const approved = await workflow.approve({
    taskId: task.id,
    planVersionId: selection.planVersionId,
    expectedVersion: securityApproved.stateVersion,
    idempotencyKey: 'gold-approves-review',
    actor: { userId: goldId, role: 'gold', service: 'gold' },
    gateKey: 'gold-review',
    decision: 'approved',
  });
  assert.equal(approved.state, 'ready');
  const revision = await workflow.revise({
    taskId: task.id,
    expectedVersion: approved.stateVersion,
    idempotencyKey: 'revise-after-approval',
    actor: { userId: ownerId, role: 'owner' },
    candidateId: 'depth',
    plan: { steps: [] },
    planHash: 'sha256:revised-plan',
    pendingInputs: [],
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
    plan: { steps: [] },
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
    plan: { steps: [] },
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
    plan: { steps: [] },
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
    plan: { steps: [] },
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

test('resume rejects core skip and revises the plan for optional skip', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);

  async function pausedTask(kind: 'core' | 'optional') {
    const task = await repository.createTask({
      conversationId,
      ownerUserId: ownerId,
      originalInput: `${kind} resume`,
      taskType: 'competitive_research',
      structuredTask: {},
      state: 'ready',
    });
    const plan = await repository.createPlanVersion({
      taskId: task.id,
      version: 1,
      plan: {
        task_id: task.id,
        steps: [
          { step_no: 1, step_name: 'failed tool', actor_type: 'tool', actor_id: kind === 'core' ? 'tavily-web-search' : 'ai-spider-search' },
          { step_no: 2, step_name: 'analysis', actor_type: 'llm', actor_id: 'analysis' },
        ],
      },
      planHash: `sha256:${kind}-resume-plan`,
    });
    const claim = await repository.claimExecution({
      taskId: task.id,
      planVersionId: plan.id,
      expectedVersion: task.stateVersion,
      idempotencyKey: `${kind}-claim`,
      requestHash: `sha256:${kind}-claim`,
      leaseOwner: 'resume-test',
      leaseTokenHash: `sha256:${kind}-lease`,
    });
    await repository.recordExecutionStep({
      attemptId: claim.attemptId,
      stepNo: 1,
      stepName: 'failed tool',
      actorType: 'tool',
      actorId: kind === 'core' ? 'tavily-web-search' : 'ai-spider-search',
      state: 'failed',
      failure: {
        kind: 'network',
        toolTier: kind,
        allowedActions: kind === 'core' ? ['retry', 'abort'] : ['retry', 'skip', 'abort'],
      },
    });
    const paused = await repository.pauseExecution({
      taskId: task.id,
      attemptId: claim.attemptId,
      expectedVersion: claim.stateVersion,
      reason: 'network',
    });
    return { task, plan, paused };
  }

  const core = await pausedTask('core');
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

  const optional = await pausedTask('optional');
  const skipped = await workflow.resume({
    taskId: optional.task.id,
    expectedVersion: optional.paused.stateVersion,
    idempotencyKey: 'optional-skip',
    actor: { userId: ownerId, role: 'owner' },
    action: 'skip',
    failedStepNo: 1,
  });
  assert.equal(skipped.state, 'awaiting_confirmation');
  const revisedTask = await repository.getTaskDetail(optional.task.id);
  assert.notEqual(revisedTask?.activePlanVersionId, optional.plan.id);
  const revisedPlan = await repository.getPlanVersionDetail(revisedTask?.activePlanVersionId ?? '');
  assert.ok(revisedPlan?.plan && typeof revisedPlan.plan === 'object' && 'steps' in revisedPlan.plan);
  assert.deepEqual(revisedPlan.plan.steps, [
    { step_no: 1, step_name: 'analysis', actor_type: 'llm', actor_id: 'analysis' },
  ]);
});
