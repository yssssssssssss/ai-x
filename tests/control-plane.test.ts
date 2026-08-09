import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import {
  ArtifactIntegrityError,
  ControlArtifactStore,
} from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import {
  ArtifactNotSealedError,
  ControlPlaneConflictError,
  ControlPlaneRepository,
} from '../database/control-plane.ts';
import {
  runMigrations,
  type MigrationConnection,
  type MigrationDatabase,
} from '../database/migration-runner.ts';

class ScopedMigrationDatabase implements MigrationDatabase {
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

const schema = `control_plane_${randomUUID().replaceAll('-', '')}`;
const workspaceRoot = mkdtempSync(join(tmpdir(), 'control-artifact-'));
const database = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/user_research_ai',
});
const scopedDatabase = new ScopedMigrationDatabase(database, schema);

let ownerId = '';
let conversationId = '';

after(async () => {
  await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await database.end();
  rmSync(workspaceRoot, { recursive: true, force: true });
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
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [`control-${Date.now()}@test.local`, 'control owner', 'x', 'member'],
    );
    ownerId = String(owner.rows[0]?.id);
    const conversation = await connection.query(
      `INSERT INTO conversations (owner_user_id, title)
       VALUES ($1, $2)
       RETURNING id`,
      [ownerId, 'control test'],
    );
    conversationId = String(conversation.rows[0]?.id);
  } finally {
    connection.release();
  }
});

test('keeps legacy schema available while creating the isolated control plane schema', async () => {
  const connection = await scopedDatabase.connect();
  try {
    const tables = await connection.query(
      `SELECT to_regclass('research_tasks') AS legacy_tasks,
              to_regclass('control_tasks') AS control_tasks`,
    );
    assert.equal(tables.rows[0]?.legacy_tasks, 'research_tasks');
    assert.equal(tables.rows[0]?.control_tasks, 'control_tasks');
  } finally {
    connection.release();
  }
});

test('claims one execution attempt and replays the same idempotency key', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const task = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: '控制面测试',
    taskType: 'competitive_research',
    structuredTask: { research_goal: '验证控制面' },
    state: 'ready',
  });
  const plan = await repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    plan: { steps: [] },
    planHash: 'sha256:plan-1',
  });

  const first = await repository.claimExecution({
    taskId: task.id,
    planVersionId: plan.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: 'claim-1',
    requestHash: 'sha256:request-1',
    leaseOwner: 'test-worker',
    leaseTokenHash: 'sha256:lease-1',
  });
  const replay = await repository.claimExecution({
    taskId: task.id,
    planVersionId: plan.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: 'claim-1',
    requestHash: 'sha256:request-1',
    leaseOwner: 'test-worker',
    leaseTokenHash: 'sha256:lease-1',
  });

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.attemptId, first.attemptId);
  assert.equal((await repository.listAttempts(task.id)).length, 1);

  await assert.rejects(
    () => repository.claimExecution({
      taskId: task.id,
      planVersionId: plan.id,
      expectedVersion: task.stateVersion,
      idempotencyKey: 'claim-stale',
      requestHash: 'sha256:request-stale',
      leaseOwner: 'test-worker',
      leaseTokenHash: 'sha256:lease-stale',
    }),
    ControlPlaneConflictError,
  );
});

test('rejects reuse of an idempotency key with a different request hash', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const task = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'idempotency hash 测试',
    taskType: 'competitive_research',
    structuredTask: { research_goal: '验证 idempotency hash' },
    state: 'ready',
  });
  const plan = await repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    plan: { steps: [] },
    planHash: 'sha256:idempotency-plan',
  });
  const claimInput = {
    taskId: task.id,
    planVersionId: plan.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: 'reused-key',
    leaseOwner: 'test-worker',
    leaseTokenHash: 'sha256:idempotency-lease',
  };

  await repository.claimExecution({ ...claimInput, requestHash: 'sha256:original' });
  await assert.rejects(
    () => repository.claimExecution({ ...claimInput, requestHash: 'sha256:changed' }),
    ControlPlaneConflictError,
  );
});


test('rejects an execution claim that pairs a task with another task plan version', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const firstTask = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'first task',
    taskType: 'competitive_research',
    structuredTask: { research_goal: 'first' },
    state: 'ready',
  });
  const secondTask = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'second task',
    taskType: 'competitive_research',
    structuredTask: { research_goal: 'second' },
    state: 'ready',
  });
  const secondPlan = await repository.createPlanVersion({
    taskId: secondTask.id,
    version: 1,
    plan: { steps: [] },
    planHash: 'sha256:second-plan',
  });

  await assert.rejects(
    () => repository.claimExecution({
      taskId: firstTask.id,
      planVersionId: secondPlan.id,
      expectedVersion: firstTask.stateVersion,
      idempotencyKey: 'cross-task-plan',
      requestHash: 'sha256:cross-task-request',
      leaseOwner: 'test-worker',
      leaseTokenHash: 'sha256:cross-task-lease',
    }),
    ControlPlaneConflictError,
  );
});
test('allows one concurrent execution claim and replays the duplicate command', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const task = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: '并发 claim 测试',
    taskType: 'competitive_research',
    structuredTask: { research_goal: '验证并发 claim' },
    state: 'ready',
  });
  const plan = await repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    plan: { steps: [] },
    planHash: 'sha256:concurrent-plan',
  });
  const claim = () => repository.claimExecution({
    taskId: task.id,
    planVersionId: plan.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: 'concurrent-claim',
    requestHash: 'sha256:concurrent-request',
    leaseOwner: 'test-worker',
    leaseTokenHash: 'sha256:concurrent-lease',
  });

  const results = await Promise.all([claim(), claim()]);

  assert.equal(results.filter((result) => !result.replayed).length, 1);
  assert.equal(results.filter((result) => result.replayed).length, 1);
  assert.equal((await repository.listAttempts(task.id)).length, 1);
});

test('enforces one active attempt per task and one capability attempt per gold slot', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const task = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'unique constraint 测试',
    taskType: 'competitive_research',
    structuredTask: { research_goal: '验证 schema 约束' },
    state: 'ready',
  });
  const plan = await repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    plan: { steps: [] },
    planHash: 'sha256:unique-plan',
  });
  const claim = await repository.claimExecution({
    taskId: task.id,
    planVersionId: plan.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: 'unique-claim',
    requestHash: 'sha256:unique-request',
    leaseOwner: 'test-worker',
    leaseTokenHash: 'sha256:unique-lease',
  });
  const connection = await scopedDatabase.connect();
  try {
    await assert.rejects(
      () => connection.query(
        `INSERT INTO control_execution_attempts
           (task_id, plan_version_id, attempt_no, state, lease_owner, lease_token_hash, lease_expires_at)
         VALUES ($1, $2, 2, 'active', 'other-worker', 'sha256:other', now() + interval '5 minutes')`,
        [task.id, plan.id],
      ),
    );
    const batch = await connection.query(
      `INSERT INTO gold_batches (batch_key, pins_json, pins_hash, machine_state, scenario_id, scenario_input_hash)
       VALUES ($1, '{}'::jsonb, $2, 'COLLECTING', 'scenario', 'sha256:input')
       RETURNING id`,
      [`batch-${randomUUID()}`, 'sha256:pins'],
    );
    const batchId = String(batch.rows[0]?.id);
    await connection.query(
      `INSERT INTO gold_batch_slots (batch_id, slot_no, capability_attempt_id, state)
       VALUES ($1, 1, $2, 'occupied')`,
      [batchId, claim.attemptId],
    );
    await assert.rejects(
      () => connection.query(
        `INSERT INTO gold_batch_slots (batch_id, slot_no, capability_attempt_id, state)
         VALUES ($1, 2, $2, 'occupied')`,
        [batchId, claim.attemptId],
      ),
    );
  } finally {
    connection.release();
  }
});

test('seals versioned attempt artifacts and rejects staged or tampered artifacts', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const task = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'artifact 测试',
    taskType: 'competitive_research',
    structuredTask: { research_goal: '验证 artifact' },
    state: 'ready',
  });
  const plan = await repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    plan: { steps: [] },
    planHash: 'sha256:artifact-plan',
  });
  const claim = await repository.claimExecution({
    taskId: task.id,
    planVersionId: plan.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: 'artifact-claim',
    requestHash: 'sha256:artifact-request',
    leaseOwner: 'test-worker',
    leaseTokenHash: 'sha256:artifact-lease',
  });
  const store = new ControlArtifactStore({ root: workspaceRoot, registry: repository });

  const sealed = await store.writeJson({
    taskId: task.id,
    planVersionId: plan.id,
    attemptId: claim.attemptId,
    kind: 'context_manifest',
    relativePath: 'context/context-manifest.json',
    value: { task: task.id },
  });
  const planArtifact = await store.writeJson({
    taskId: task.id,
    planVersionId: plan.id,
    kind: 'plan',
    relativePath: 'plan.json',
    value: { version: plan.version },
  });
  assert.match(planArtifact.storageUri, new RegExp(`tasks/${task.id}/plans/${plan.id}/plan\\.json`));
  assert.equal(sealed.state, 'SEALED');
  assert.ok(existsSync(sealed.storageUri));
  assert.match(sealed.storageUri, new RegExp(`tasks/${task.id}/attempts/${claim.attemptId}/context`));
  assert.equal((await repository.requireSealedArtifact(sealed.id)).id, sealed.id);

  const staged = await repository.createStagingArtifact({
    taskId: task.id,
    planVersionId: plan.id,
    attemptId: claim.attemptId,
    kind: 'report',
    storageUri: join(workspaceRoot, 'missing.json'),
    schemaVersion: 'v1',
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
  });
  await assert.rejects(() => repository.requireSealedArtifact(staged.id), ArtifactNotSealedError);
  await store.reconcileStaging();
  assert.equal((await repository.getArtifact(staged.id))?.state, 'FAILED');

  writeFileSync(sealed.storageUri, '{"tampered":true}');
  await assert.rejects(() => store.verifySealed(sealed.id), ArtifactIntegrityError);
});

test('refuses to overwrite an already sealed artifact path', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const task = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'artifact overwrite 测试',
    taskType: 'competitive_research',
    structuredTask: { research_goal: '验证不可覆盖 artifact' },
    state: 'ready',
  });
  const plan = await repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    plan: { steps: [] },
    planHash: 'sha256:overwrite-plan',
  });
  const claim = await repository.claimExecution({
    taskId: task.id,
    planVersionId: plan.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: 'overwrite-claim',
    requestHash: 'sha256:overwrite-request',
    leaseOwner: 'test-worker',
    leaseTokenHash: 'sha256:overwrite-lease',
  });
  const store = new ControlArtifactStore({ root: workspaceRoot, registry: repository });
  const first = await store.writeJson({
    taskId: task.id,
    planVersionId: plan.id,
    attemptId: claim.attemptId,
    kind: 'step_output',
    relativePath: 'steps/1/output.json',
    value: { original: true },
  });

  await assert.rejects(
    () => store.writeJson({
      taskId: task.id,
      planVersionId: plan.id,
      attemptId: claim.attemptId,
      kind: 'step_output',
      relativePath: 'steps/1/output.json',
      value: { overwritten: true },
    }),
  );
  assert.deepEqual(JSON.parse(readFileSync(first.storageUri, 'utf8')), { original: true });
});

test('rejects artifact paths outside the versioned workspace directory', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const task = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'artifact path 测试',
    taskType: 'competitive_research',
    structuredTask: { research_goal: '验证 artifact path' },
    state: 'ready',
  });
  const plan = await repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    plan: { steps: [] },
    planHash: 'sha256:path-plan',
  });
  const store = new ControlArtifactStore({ root: workspaceRoot, registry: repository });

  await assert.rejects(
    () => store.writeJson({
      taskId: task.id,
      planVersionId: plan.id,
      kind: 'report',
      relativePath: '../outside.json',
      value: { unsafe: true },
    }),
    /must stay under its versioned directory/,
  );
});
