import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  ControlPlaneConflictError,
  ControlPlaneRepository,
  type ControlExecutionLease,
} from '../database/control-plane.ts';
import {
  runMigrations,
  type MigrationConnection,
  type MigrationDatabase,
} from '../database/migration-runner.ts';

class ScopedExecutionDatabase implements MigrationDatabase {
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

const schema = `execution_control_${randomUUID().replaceAll('-', '')}`;
const database = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/user_research_ai',
});
const scopedDatabase = new ScopedExecutionDatabase(database, schema);
let ownerId = '';
let conversationId = '';

function leaseHash(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

after(async () => {
  await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await database.end();
});

before(async () => {
  await database.query(`CREATE SCHEMA "${schema}"`);
  await runMigrations({
    lockKey: 761_830_933,
    database: scopedDatabase,
    migrationsDir: join(process.cwd(), 'database', 'migrations'),
  });
  const connection = await scopedDatabase.connect();
  try {
    const owner = await connection.query(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, 'execution owner', 'x', 'member') RETURNING id`,
      [`execution-${Date.now()}@test.local`],
    );
    ownerId = String(owner.rows[0]?.id);
    const conversation = await connection.query(
      `INSERT INTO conversations (owner_user_id, title)
       VALUES ($1, 'execution control') RETURNING id`,
      [ownerId],
    );
    conversationId = String(conversation.rows[0]?.id);
  } finally {
    connection.release();
  }
});

async function claimedLease(options: { expiresAt?: Date } = {}): Promise<{
  repository: ControlPlaneRepository;
  lease: ControlExecutionLease;
  token: string;
}> {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const task = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'lease execution',
    taskType: 'competitive_research',
    structuredTask: { research_goal: 'verify lease execution' },
    state: 'ready',
  });
  const plan = await repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    plan: { steps: [] },
    planHash: `sha256:${randomUUID()}`,
  });
  const token = randomUUID();
  const claim = await repository.claimExecution({
    taskId: task.id,
    planVersionId: plan.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: randomUUID(),
    requestHash: `sha256:${randomUUID()}`,
    leaseOwner: 'execution-worker',
    leaseTokenHash: leaseHash(token),
    leaseExpiresAt: options.expiresAt,
  });
  return {
    repository,
    token,
    lease: {
      taskId: task.id,
      planVersionId: plan.id,
      attemptId: claim.attemptId,
      leaseOwner: 'execution-worker',
      leaseToken: token,
    },
  };
}

test('accepts only the current unexpired execution lease and heartbeats it', async () => {
  const { repository, lease, token } = await claimedLease({
    expiresAt: new Date(Date.now() + 60_000),
  });

  const verified = await repository.requireActiveLease(lease);
  assert.equal(verified.attemptId, lease.attemptId);
  assert.equal(verified.taskId, lease.taskId);
  assert.equal(verified.planVersionId, lease.planVersionId);

  const heartbeat = await repository.heartbeatExecutionLease({
    ...lease,
    extendUntil: new Date(Date.now() + 120_000),
  });
  assert.ok(heartbeat.leaseExpiresAt.getTime() > verified.leaseExpiresAt.getTime());

  await assert.rejects(
    () => repository.requireActiveLease({ ...lease, leaseToken: `${token}-wrong` }),
    ControlPlaneConflictError,
  );
});

test('rejects an expired lease before an external side effect', async () => {
  const { repository, lease } = await claimedLease({
    expiresAt: new Date(Date.now() - 1_000),
  });

  await assert.rejects(
    () => repository.requireActiveLease(lease),
    ControlPlaneConflictError,
  );
});

test('completes task and attempt only with the current active lease', async () => {
  const { repository, lease } = await claimedLease();
  const completed = await repository.completeExecution(lease);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.currentAttemptId, lease.attemptId);
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'completed');
  await assert.rejects(
    () => repository.completeExecution(lease),
    ControlPlaneConflictError,
  );
});

test('classifies an expired lease as worker loss and pauses for explicit resume', async () => {
  const { repository, lease } = await claimedLease({
    expiresAt: new Date(Date.now() - 1_000),
  });
  const paused = await repository.expireExecutionLease({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
  });
  assert.equal(paused.state, 'paused');
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
  await assert.rejects(
    () => repository.expireExecutionLease({ taskId: lease.taskId, attemptId: lease.attemptId }),
    ControlPlaneConflictError,
  );
});

test('persists structured tool provenance and failure on execution steps', async () => {
  const { repository, lease } = await claimedLease();
  await repository.recordExecutionStep({
    attemptId: lease.attemptId,
    stepNo: 1,
    stepName: 'public search',
    actorType: 'tool',
    actorId: 'tavily-web-search',
    state: 'succeeded',
    toolProvenance: {
      registryHash: 'sha256:registry',
      manifestHash: 'sha256:manifest',
      inputSchemaHash: 'sha256:input-schema',
      outputSchemaHash: 'sha256:output-schema',
      inputHash: 'sha256:input',
      outputHash: 'sha256:output',
      configHash: 'sha256:config',
      declaredAdapterType: 'tavily',
      resolvedAdapterType: 'tavily',
      implementationId: 'tavily-rest-v1',
      executionMode: 'real',
      sourceRefs: ['https://example.test/source'],
      status: 'succeeded',
    },
    latencyMs: 42,
    startedAt: new Date('2026-08-09T00:00:00Z'),
    finishedAt: new Date('2026-08-09T00:00:01Z'),
  });
  await repository.recordExecutionStep({
    attemptId: lease.attemptId,
    stepNo: 2,
    stepName: 'optional source',
    actorType: 'tool',
    actorId: 'optional-tool',
    state: 'failed',
    failure: {
      kind: 'network',
      retryable: true,
      providerStatus: null,
      message: 'sanitized network failure',
    },
    startedAt: new Date('2026-08-09T00:00:02Z'),
    finishedAt: new Date('2026-08-09T00:00:03Z'),
  });

  const steps = await repository.listExecutionSteps(lease.attemptId);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].toolProvenance?.executionMode, 'real');
  assert.equal(steps[1].failure?.kind, 'network');
});

test('persists complete model receipts including drift and structured failure status', async () => {
  const { repository, lease } = await claimedLease();
  await repository.recordModelCall({
    attemptId: lease.attemptId,
    stage: 'skill',
    stepNo: 2,
    provider: 'gateway',
    endpointHost: 'llm-gateway.test',
    requestedModel: 'gpt-pinned',
    actualModel: 'gpt-pinned',
    promptHash: 'sha256:prompt',
    contextManifestHash: 'sha256:context',
    traceId: 'trace-1',
    tokens: { prompt: 10, completion: 5, total: 15 },
    status: 'succeeded',
    failure: null,
    startedAt: new Date('2026-08-09T00:00:00Z'),
    finishedAt: new Date('2026-08-09T00:00:02Z'),
  });

  const calls = await repository.listModelCalls(lease.attemptId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'gateway');
  assert.equal(calls[0].requestedModel, 'gpt-pinned');
  assert.equal(calls[0].actualModel, 'gpt-pinned');
  assert.equal(calls[0].status, 'succeeded');
  assert.deepEqual(calls[0].tokens, { prompt: 10, completion: 5, total: 15 });
});
