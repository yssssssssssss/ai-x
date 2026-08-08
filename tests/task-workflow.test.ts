import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Pool } from 'pg';
import { ControlPlaneRepository } from '../database/control-plane.ts';
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
  await assert.rejects(
    () => workflow.select({
      taskId: task.id,
      expectedVersion: task.stateVersion,
      idempotencyKey: 'cross-conversation-select',
      actor: { userId: ownerId, role: 'owner' },
      candidateId: 'speed',
      plan: { steps: [] },
      planHash: 'sha256:cross-conversation',
      pendingInputs: [],
    }),
    TaskWorkflowAuthorizationError,
  );
});


test('malformed persisted workflow gate fails closed during confirmation', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const workflow = new TaskWorkflowService(repository);
  const task = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'malformed workflow gate',
    taskType: 'competitive_research',
    structuredTask: { confirmations: 'not-an-array' },
    state: 'awaiting_selection',
  });
  const selection = await workflow.select({
    taskId: task.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: 'malformed-select',
    actor: { userId: ownerId, role: 'owner' },
    candidateId: 'speed',
    plan: { steps: [] },
    planHash: 'sha256:malformed',
    pendingInputs: [],
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
  const task = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'workflow gate',
    taskType: 'competitive_research',
    structuredTask: {
      confirmations: [{ key: 'competitors', question: '竞品范围?' }],
      blocking_issues: [
        { key: 'privacy', kind: 'privacy_compliance', reason: '敏感材料' },
        { key: 'gold-review', required_authority: 'gold', reason: 'Gold evidence review' },
      ],
    },
    state: 'awaiting_selection',
  });

  const selection = await workflow.select({
    taskId: task.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: 'select-1',
    actor: { userId: ownerId, role: 'owner' },
    candidateId: 'depth',
    plan: { steps: [{ step_no: 1, requires_approval: true, approval_role: 'security' }] },
    planHash: 'sha256:workflow-plan',
    pendingInputs: [{ role: 'brief' }],
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
  const task = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'disabled execution',
    taskType: 'competitive_research',
    structuredTask: { confirmations: [], blocking_issues: [] },
    state: 'awaiting_selection',
  });
  const selection = await workflow.select({
    taskId: task.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: 'disabled-select',
    actor: { userId: ownerId, role: 'owner' },
    candidateId: 'speed',
    plan: { steps: [] },
    planHash: 'sha256:disabled-plan',
    pendingInputs: [],
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
