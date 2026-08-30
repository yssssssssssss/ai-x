import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  ARTIFACT_QUARANTINE_PENDING_MARKER,
  ARTIFACT_INVALIDATION_PROMOTION_VERSION,
  ControlPlaneConflictError,
  ControlPlaneRepository,
  type ControlExecutionLease,
  type ControlTask,
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

class AnnouncedStepWriteDatabase implements MigrationDatabase {
  private announced = false;
  private announce!: () => void;
  readonly taskFenceStarted = new Promise<void>((resolve) => {
    this.announce = resolve;
  });

  constructor(private readonly database: MigrationDatabase) {}

  async connect(): Promise<MigrationConnection> {
    const connection = await this.database.connect();
    return {
      query: async (sql, values = []) => {
        if (
          !this.announced
          && /SELECT\s+state,\s*current_attempt_id,\s*active_plan_version_id\s+FROM\s+control_tasks/iu.test(sql)
        ) {
          this.announced = true;
          this.announce();
        }
        return connection.query(sql, values);
      },
      release() {
        connection.release();
      },
    };
  }
}

class BlockedArtifactInsertDatabase implements MigrationDatabase {
  private announced = false;
  private announce!: () => void;
  private unblock!: () => void;
  readonly insertStarted = new Promise<void>((resolve) => {
    this.announce = resolve;
  });
  private readonly insertReleased = new Promise<void>((resolve) => {
    this.unblock = resolve;
  });

  constructor(private readonly database: MigrationDatabase) {}

  releaseInsert(): void {
    this.unblock();
  }

  async connect(): Promise<MigrationConnection> {
    const connection = await this.database.connect();
    return {
      query: async (sql, values = []) => {
        if (!this.announced && /INSERT\s+INTO\s+control_artifacts/iu.test(sql)) {
          this.announced = true;
          this.announce();
          await this.insertReleased;
        }
        return connection.query(sql, values);
      },
      release() {
        connection.release();
      },
    };
  }
}

class BlockedLeaseSealUpdateDatabase implements MigrationDatabase {
  private announced = false;
  private announce!: () => void;
  private unblock!: () => void;
  readonly updateStarted = new Promise<void>((resolve) => {
    this.announce = resolve;
  });
  private readonly updateReleased = new Promise<void>((resolve) => {
    this.unblock = resolve;
  });

  constructor(private readonly database: MigrationDatabase) {}

  releaseUpdate(): void {
    this.unblock();
  }

  async connect(): Promise<MigrationConnection> {
    const connection = await this.database.connect();
    return {
      query: async (sql, values = []) => {
        if (
          !this.announced
          && /UPDATE\s+control_artifacts\s+AS\s+artifact[\s\S]+FROM\s+control_execution_attempts\s+AS\s+attempt/iu.test(sql)
        ) {
          this.announced = true;
          this.announce();
          await this.updateReleased;
        }
        return connection.query(sql, values);
      },
      release() {
        connection.release();
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

async function createResidualArtifact(
  repository: ControlPlaneRepository,
  lease: ControlExecutionLease,
) {
  return repository.createStagingArtifact({
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    activeLease: lease,
    kind: 'visual_asset',
    storageUri: `/tmp/${randomUUID()}.png`,
    schemaVersion: 'visual-asset-v1',
    sensitivity: 'internal',
    redactionPolicyVersion: 'trusted-p0-v1',
  });
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

test('completion atomically fences the selected fixed-path Report Package root', async () => {
  const { repository, lease } = await claimedLease();
  const reportPackage = await repository.createStagingArtifact({
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    activeLease: lease,
    kind: 'report_package',
    storageUri: `/tmp/tasks/${lease.taskId}/attempts/${lease.attemptId}/reports/report-package.json`,
    schemaVersion: 'report-package-v2',
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
  });
  await repository.sealArtifact({
    ...lease,
    artifactId: reportPackage.id,
    contentSha256: `sha256:${'2'.repeat(64)}`,
    byteSize: 2,
  });

  const completed = await repository.completeExecution(lease, {
    status: 'completed',
    reportPackageArtifactId: reportPackage.id,
  });

  assert.equal(completed.state, 'completed');
});

test('completion rejects a Report Package outside the fixed report root without consuming the lease', async () => {
  const { repository, lease } = await claimedLease();
  const reportPackage = await repository.createStagingArtifact({
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    activeLease: lease,
    kind: 'report_package',
    storageUri: `/tmp/${lease.attemptId}-report-package.json`,
    schemaVersion: 'report-package-v2',
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
  });
  await repository.sealArtifact({
    ...lease,
    artifactId: reportPackage.id,
    contentSha256: `sha256:${'3'.repeat(64)}`,
    byteSize: 2,
  });

  await assert.rejects(
    () => repository.completeExecution(lease, {
      status: 'completed',
      reportPackageArtifactId: reportPackage.id,
    }),
    ControlPlaneConflictError,
  );
  assert.equal((await repository.requireActiveLease(lease)).attemptId, lease.attemptId);
});

test('completes the task with gaps while the attempt remains completed', async () => {
  const { repository, lease } = await claimedLease();
  const completeExecution = repository.completeExecution.bind(repository) as unknown as (
    input: ControlExecutionLease,
    options: { status: 'completed' | 'completed_with_gaps' },
  ) => Promise<ControlTask>;
  const completed = await completeExecution(lease, { status: 'completed_with_gaps' });

  assert.equal(completed.state, 'completed_with_gaps');
  assert.equal(completed.currentAttemptId, lease.attemptId);
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'completed');
});

test('rejects completion while an execution step is pending or running without consuming the lease', async () => {
  for (const state of ['pending', 'running'] as const) {
    const { repository, lease } = await claimedLease();
    await repository.recordExecutionStep({
      ...lease,
      stepNo: 1,
      stepName: `${state} completion fence`,
      actorType: 'system',
      actorId: 'completion-fence',
      state,
      startedAt: new Date(),
    });

    await assert.rejects(
      () => repository.completeExecution(lease),
      ControlPlaneConflictError,
    );
    assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'active');
    assert.equal((await repository.requireActiveLease(lease)).attemptId, lease.attemptId);

    await repository.recordExecutionStep({
      ...lease,
      stepNo: 1,
      stepName: `${state} completion fence`,
      actorType: 'system',
      actorId: 'completion-fence',
      state: 'succeeded',
      finishedAt: new Date(),
    });
    assert.equal((await repository.completeExecution(lease)).state, 'completed');
  }
});

test('classifies an expired lease as worker loss without scheduling empty cleanup', async () => {
  const { repository, lease } = await claimedLease({
    expiresAt: new Date(Date.now() - 1_000),
  });
  const paused = await repository.expireExecutionLease({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
  });
  assert.equal(paused.state, 'paused');
  assert.equal((await repository.listAttempts(lease.taskId))[0]?.state, 'paused');
  assert.equal(
    (await repository.listRecoverableExecutions())
      .some(({ attemptId }) => attemptId === lease.attemptId),
    false,
  );
  await assert.rejects(
    () => repository.expireExecutionLease({ taskId: lease.taskId, attemptId: lease.attemptId }),
    ControlPlaneConflictError,
  );
});

test('keeps an artifact-invalidation attempt recoverable when only a sealed visual Manifest remains', async () => {
  const { repository, lease } = await claimedLease();
  const manifest = await repository.createStagingArtifact({
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    activeLease: lease,
    kind: 'visual_asset_manifest',
    storageUri: `/tmp/${randomUUID()}.json`,
    schemaVersion: 'visual-asset-manifest-v2',
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
  });
  await repository.sealArtifact({
    ...lease,
    artifactId: manifest.id,
    contentSha256: `sha256:${'1'.repeat(64)}`,
    byteSize: 1,
  });
  const active = await repository.requireActiveLease(lease);
  await repository.pauseExecution({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
    expectedVersion: active.stateVersion,
    reason: 'artifact_invalidation',
  });

  const recoverable = (await repository.listRecoverableExecutions())
    .find(({ attemptId }) => attemptId === lease.attemptId);
  assert.equal(recoverable?.attemptState, 'paused');
  assert.equal(recoverable?.failureKind, 'artifact_invalidation');
});

test('artifact-invalidation promotion is fenced and preserves the first terminal payload', async () => {
  const { repository, lease } = await claimedLease();
  const firstArtifact = await createResidualArtifact(repository, lease);
  const secondArtifact = await createResidualArtifact(repository, lease);
  const identity = {
    stepNo: 1,
    stepName: 'browser publication',
    actorType: 'tool',
    actorId: 'playwright-page-capture',
  };
  const toolProvenance = { outputHash: 'sha256:browser-output' };
  const previousFailure = {
    kind: 'persistence',
    retryable: false,
    artifactInvalidationPromotion: {
      version: ARTIFACT_INVALIDATION_PROMOTION_VERSION,
      eligibleArtifactIds: [firstArtifact.id],
    },
  };
  await repository.recordExecutionStep({
    ...lease,
    ...identity,
    state: 'failed',
    failure: previousFailure,
    toolProvenance,
    startedAt: new Date('2026-08-19T00:00:00.000Z'),
    finishedAt: new Date('2026-08-19T00:00:01.000Z'),
  });

  const firstFailure = {
    kind: 'artifact_invalidation',
    retryable: false,
    message: 'unpublished step Artifact could not be invalidated',
    failedArtifactIds: [firstArtifact.id],
    allowedActions: ['abort'],
  };
  const firstPromotion = {
    ...lease,
    ...identity,
    failedArtifactIds: [firstArtifact.id],
    expectedPreviousFailure: previousFailure,
  };
  assert.equal(await repository.promoteExecutionStepArtifactInvalidation({
    ...firstPromotion,
    leaseToken: 'wrong-token',
  }), null);
  assert.deepEqual(
    await repository.promoteExecutionStepArtifactInvalidation(firstPromotion),
    firstFailure,
  );
  assert.deepEqual(
    await repository.promoteExecutionStepArtifactInvalidation(firstPromotion),
    firstFailure,
  );
  assert.equal(await repository.promoteExecutionStepArtifactInvalidation({
    ...firstPromotion,
    failedArtifactIds: [secondArtifact.id],
  }), null);

  await repository.recordExecutionStep({
    ...lease,
    stepNo: 2,
    stepName: 'completed browser publication',
    actorType: 'tool',
    actorId: 'playwright-page-capture',
    state: 'succeeded',
    startedAt: new Date('2026-08-19T00:00:04.000Z'),
    finishedAt: new Date('2026-08-19T00:00:05.000Z'),
  });
  assert.equal(await repository.promoteExecutionStepArtifactInvalidation({
    ...lease,
    stepNo: 2,
    stepName: 'completed browser publication',
    actorType: 'tool',
    actorId: 'playwright-page-capture',
    failedArtifactIds: [firstArtifact.id],
    expectedPreviousFailure: previousFailure,
  }), null);

  const steps = await repository.listExecutionSteps(lease.attemptId);
  assert.deepEqual(steps.find(({ stepNo }) => stepNo === 1)?.failure, firstFailure);
  assert.equal(
    steps.find(({ stepNo }) => stepNo === 1)?.finishedAt?.toISOString(),
    '2026-08-19T00:00:01.000Z',
  );
  assert.equal(steps.find(({ stepNo }) => stepNo === 2)?.state, 'succeeded');
});

test('artifact-invalidation promotion rejects an expired active lease', async () => {
  const { repository, lease } = await claimedLease();
  const artifact = await createResidualArtifact(repository, lease);
  await repository.recordExecutionStep({
    ...lease,
    stepNo: 1,
    stepName: 'browser publication',
    actorType: 'tool',
    actorId: 'playwright-page-capture',
    state: 'failed',
    failure: { kind: 'persistence', retryable: false, allowedActions: ['abort'] },
    finishedAt: new Date('2026-08-19T00:00:01.000Z'),
  });
  const connection = await scopedDatabase.connect();
  try {
    await connection.query(
      `UPDATE control_execution_attempts
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [lease.attemptId],
    );
  } finally {
    connection.release();
  }

  assert.equal(await repository.promoteExecutionStepArtifactInvalidation({
    ...lease,
    stepNo: 1,
    stepName: 'browser publication',
    actorType: 'tool',
    actorId: 'playwright-page-capture',
    failedArtifactIds: [artifact.id],
    expectedPreviousFailure: {
      kind: 'persistence',
      retryable: false,
      allowedActions: ['abort'],
    },
  }), null);
  const [step] = await repository.listExecutionSteps(lease.attemptId);
  assert.equal(step?.failure?.kind, 'persistence');
  assert.equal(step?.finishedAt?.toISOString(), '2026-08-19T00:00:01.000Z');
  const recoverable = (await repository.listRecoverableExecutions())
    .find(({ attemptId }) => attemptId === lease.attemptId);
  assert.equal(recoverable?.attemptState, 'paused');
  assert.equal(recoverable?.failureKind, 'worker_loss');
});

test('artifact-invalidation promotion consumes a bound deferred-cleanup marker after lease recovery', async () => {
  const { repository, lease } = await claimedLease();
  const artifact = await createResidualArtifact(repository, lease);
  const unrelatedArtifact = await createResidualArtifact(repository, lease);
  const identity = {
    stepNo: 1,
    stepName: 'browser publication',
    actorType: 'tool',
    actorId: 'playwright-page-capture',
  };
  const previousFailure = {
    kind: 'capability',
    retryable: false,
    allowedActions: ['abort'],
    artifactInvalidationPromotion: {
      version: ARTIFACT_INVALIDATION_PROMOTION_VERSION,
      eligibleArtifactIds: [artifact.id],
    },
  };
  const toolProvenance = { outputHash: 'sha256:deferred-browser-output' };
  const finishedAt = new Date('2026-08-19T00:00:01.000Z');
  await repository.recordExecutionStep({
    ...lease,
    ...identity,
    state: 'failed',
    failure: previousFailure,
    toolProvenance,
    finishedAt,
  });
  const connection = await scopedDatabase.connect();
  try {
    await connection.query(
      `UPDATE control_execution_attempts
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [lease.attemptId],
    );
  } finally {
    connection.release();
  }

  await repository.expireExecutionLease({ taskId: lease.taskId, attemptId: lease.attemptId });
  assert.equal((await repository.listExecutionSteps(lease.attemptId)).length, 1);

  assert.equal(await repository.promoteExecutionStepArtifactInvalidation({
    ...lease,
    ...identity,
    expectedPreviousFailure: previousFailure,
    failedArtifactIds: [unrelatedArtifact.id],
  }), null);
  const promoted = await repository.promoteExecutionStepArtifactInvalidation({
    ...lease,
    ...identity,
    expectedPreviousFailure: previousFailure,
    failedArtifactIds: [artifact.id],
  });
  assert.ok(promoted);
  assert.equal(promoted.kind, 'artifact_invalidation');
  assert.equal(promoted.artifactInvalidationPromotion, undefined);
  assert.deepEqual(promoted.failedArtifactIds, [artifact.id]);
  assert.deepEqual(promoted.allowedActions, ['abort']);
  const [step] = await repository.listExecutionSteps(lease.attemptId);
  assert.deepEqual(step?.failure, promoted);
  assert.deepEqual(step?.toolProvenance, toolProvenance);
  assert.equal(step?.finishedAt?.getTime(), finishedAt.getTime());
  const recoverable = (await repository.listRecoverableExecutions())
    .find(({ attemptId }) => attemptId === lease.attemptId);
  assert.equal(recoverable?.failureKind, 'artifact_invalidation');
});

test('lease expiry cannot downgrade a promoted artifact-invalidation failure', async () => {
  const { repository, lease } = await claimedLease();
  const artifact = await createResidualArtifact(repository, lease);
  const identity = {
    stepNo: 1,
    stepName: 'browser publication',
    actorType: 'tool',
    actorId: 'playwright-page-capture',
  };
  const previousFailure = {
    kind: 'persistence',
    retryable: false,
    allowedActions: ['abort'],
    artifactInvalidationPromotion: {
      version: ARTIFACT_INVALIDATION_PROMOTION_VERSION,
      eligibleArtifactIds: [artifact.id],
    },
  };
  await repository.recordExecutionStep({
    ...lease,
    ...identity,
    state: 'failed',
    failure: previousFailure,
  });
  const promoted = await repository.promoteExecutionStepArtifactInvalidation({
    ...lease,
    ...identity,
    failedArtifactIds: [artifact.id],
    expectedPreviousFailure: previousFailure,
  });
  assert.equal(promoted?.kind, 'artifact_invalidation');
  const connection = await scopedDatabase.connect();
  try {
    await connection.query(
      `UPDATE control_execution_attempts
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [lease.attemptId],
    );
  } finally {
    connection.release();
  }

  await repository.expireExecutionLease({ taskId: lease.taskId, attemptId: lease.attemptId });

  const recoverable = (await repository.listRecoverableExecutions())
    .find(({ attemptId }) => attemptId === lease.attemptId);
  assert.equal(recoverable?.failureKind, 'artifact_invalidation');
  const steps = await repository.listExecutionSteps(lease.attemptId);
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0]?.failure, promoted);
});

test('deferred-cleanup marker stays internal and is consumed only after every bound Artifact is FAILED', async () => {
  const { repository, lease } = await claimedLease();
  const artifact = await createResidualArtifact(repository, lease);
  const unrelatedArtifact = await createResidualArtifact(repository, lease);
  const identity = {
    stepNo: 1,
    stepName: 'browser publication',
    actorType: 'tool',
    actorId: 'playwright-page-capture',
  };
  const publicFailure = { kind: 'persistence', retryable: false, allowedActions: ['abort'] };
  const pendingCleanupFailure = {
    kind: 'artifact_invalidation',
    retryable: false,
    allowedActions: ['abort'],
  };
  const persistedFailure = {
    ...publicFailure,
    artifactInvalidationPromotion: {
      version: ARTIFACT_INVALIDATION_PROMOTION_VERSION,
      eligibleArtifactIds: [artifact.id],
    },
  };
  const toolProvenance = { outputHash: 'sha256:deferred-browser-output' };
  const finishedAt = new Date('2026-08-19T00:00:01.000Z');
  await repository.recordExecutionStep({
    ...lease,
    ...identity,
    state: 'failed',
    failure: persistedFailure,
    toolProvenance,
    finishedAt,
  });

  assert.deepEqual(
    (await repository.listExecutionSteps(lease.attemptId))[0]?.failure,
    pendingCleanupFailure,
  );
  assert.equal(await repository.clearExecutionStepArtifactInvalidationPromotion({
    ...lease,
    ...identity,
    expectedPreviousFailure: persistedFailure,
  }), null);

  await repository.invalidateArtifactPublication(artifact.id, 'deferred cleanup completed');
  await repository.invalidateArtifactPublication(unrelatedArtifact.id, 'unrelated cleanup completed');
  assert.equal(await repository.clearExecutionStepArtifactInvalidationPromotion({
    ...lease,
    ...identity,
    leaseToken: 'wrong-token',
    expectedPreviousFailure: persistedFailure,
  }), null);
  assert.deepEqual(await repository.clearExecutionStepArtifactInvalidationPromotion({
    ...lease,
    ...identity,
    expectedPreviousFailure: persistedFailure,
  }), publicFailure);
  assert.deepEqual(await repository.clearExecutionStepArtifactInvalidationPromotion({
    ...lease,
    ...identity,
    expectedPreviousFailure: persistedFailure,
  }), publicFailure);
  assert.deepEqual(
    (await repository.listExecutionSteps(lease.attemptId))[0]?.failure,
    publicFailure,
  );
  assert.equal(await repository.clearExecutionStepArtifactInvalidationPromotion({
    ...lease,
    ...identity,
    expectedPreviousFailure: {
      ...publicFailure,
      artifactInvalidationPromotion: {
        version: ARTIFACT_INVALIDATION_PROMOTION_VERSION,
        eligibleArtifactIds: [unrelatedArtifact.id],
      },
    },
  }), null);

  const connection = await scopedDatabase.connect();
  try {
    const raw = await connection.query(
      `SELECT failure_json, tool_provenance, finished_at
       FROM control_execution_steps
       WHERE attempt_id = $1 AND step_no = $2`,
      [lease.attemptId, identity.stepNo],
    );
    const rawFailure = raw.rows[0]?.failure_json as Record<string, unknown> | undefined;
    assert.ok(rawFailure);
    assert.equal(rawFailure.artifactInvalidationPromotion, undefined);
    const clearReceipt = rawFailure.artifactInvalidationClearReceipt as Record<string, unknown>;
    assert.equal(clearReceipt.version, 'artifact-invalidation-clear-receipt-v1');
    assert.match(
      String(clearReceipt.expectedFailureHash),
      /^sha256:[a-f0-9]{64}$/,
    );
    const rawPublicFailure = { ...rawFailure };
    delete rawPublicFailure.artifactInvalidationClearReceipt;
    assert.deepEqual(rawPublicFailure, publicFailure);
    assert.deepEqual(raw.rows[0]?.tool_provenance, toolProvenance);
    assert.equal(new Date(String(raw.rows[0]?.finished_at)).getTime(), finishedAt.getTime());
  } finally {
    connection.release();
  }
});

test('deferred-cleanup marker requires either an active lease or its current worker-loss recovery', async () => {
  const { repository, lease } = await claimedLease();
  const artifact = await createResidualArtifact(repository, lease);
  const identity = {
    stepNo: 1,
    stepName: 'browser publication',
    actorType: 'tool',
    actorId: 'playwright-page-capture',
  };
  const persistedFailure = {
    kind: 'persistence',
    retryable: false,
    allowedActions: ['retry', 'abort'],
    artifactInvalidationPromotion: {
      version: ARTIFACT_INVALIDATION_PROMOTION_VERSION,
      eligibleArtifactIds: [artifact.id],
    },
  };
  await repository.recordExecutionStep({
    ...lease,
    ...identity,
    state: 'failed',
    failure: persistedFailure,
  });
  await repository.invalidateArtifactPublication(artifact.id, 'deferred cleanup completed');
  const connection = await scopedDatabase.connect();
  try {
    await connection.query(
      `UPDATE control_execution_attempts
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [lease.attemptId],
    );
  } finally {
    connection.release();
  }

  assert.equal(await repository.clearExecutionStepArtifactInvalidationPromotion({
    ...lease,
    ...identity,
    expectedPreviousFailure: persistedFailure,
  }), null);
  await repository.expireExecutionLease({ taskId: lease.taskId, attemptId: lease.attemptId });
  const paused = await repository.getTaskDetail(lease.taskId);
  assert.ok(paused);
  assert.equal(await repository.retryPausedExecution({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
    expectedVersion: paused.stateVersion,
    failedStepNo: 1,
  }), null);
  assert.deepEqual(await repository.clearExecutionStepArtifactInvalidationPromotion({
    ...lease,
    ...identity,
    expectedPreviousFailure: persistedFailure,
  }), { kind: 'persistence', retryable: false, allowedActions: ['retry', 'abort'] });
  assert.equal((await repository.retryPausedExecution({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
    expectedVersion: paused.stateVersion,
    failedStepNo: 1,
  }))?.state, 'ready');
  assert.equal((await repository.listExecutionSteps(lease.attemptId)).length, 1);
  assert.equal(
    (await repository.listExecutionSteps(lease.attemptId))[0]?.failure
      ?.artifactInvalidationPromotion,
    undefined,
  );
});

test('current artifact-invalidation recovery can clear a compensated sibling marker without downgrading', async () => {
  const { repository, lease } = await claimedLease();
  const compensatedArtifact = await createResidualArtifact(repository, lease);
  const failedArtifact = await createResidualArtifact(repository, lease);
  const compensatedFailure = {
    kind: 'persistence',
    retryable: false,
    artifactInvalidationPromotion: {
      version: ARTIFACT_INVALIDATION_PROMOTION_VERSION,
      eligibleArtifactIds: [compensatedArtifact.id],
    },
  };
  const failedFailure = {
    kind: 'persistence',
    retryable: false,
    artifactInvalidationPromotion: {
      version: ARTIFACT_INVALIDATION_PROMOTION_VERSION,
      eligibleArtifactIds: [failedArtifact.id],
    },
  };
  await repository.recordExecutionStep({
    ...lease,
    stepNo: 1,
    stepName: 'compensated publication',
    actorType: 'tool',
    actorId: 'playwright-page-capture',
    state: 'failed',
    failure: compensatedFailure,
  });
  await repository.recordExecutionStep({
    ...lease,
    stepNo: 2,
    stepName: 'failed publication',
    actorType: 'tool',
    actorId: 'playwright-page-capture',
    state: 'failed',
    failure: failedFailure,
  });
  await repository.invalidateArtifactPublication(compensatedArtifact.id, 'compensation completed');
  assert.equal((await repository.promoteExecutionStepArtifactInvalidation({
    ...lease,
    stepNo: 2,
    stepName: 'failed publication',
    actorType: 'tool',
    actorId: 'playwright-page-capture',
    failedArtifactIds: [failedArtifact.id],
    expectedPreviousFailure: failedFailure,
  }))?.kind, 'artifact_invalidation');
  const connection = await scopedDatabase.connect();
  try {
    await connection.query(
      `UPDATE control_execution_attempts
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [lease.attemptId],
    );
  } finally {
    connection.release();
  }
  await repository.expireExecutionLease({ taskId: lease.taskId, attemptId: lease.attemptId });

  assert.deepEqual(await repository.clearExecutionStepArtifactInvalidationPromotion({
    ...lease,
    stepNo: 1,
    stepName: 'compensated publication',
    actorType: 'tool',
    actorId: 'playwright-page-capture',
    expectedPreviousFailure: compensatedFailure,
  }), { kind: 'persistence', retryable: false });
  const recoverable = (await repository.listRecoverableExecutions())
    .find(({ attemptId }) => attemptId === lease.attemptId);
  assert.equal(recoverable?.failureKind, 'artifact_invalidation');
  assert.equal((await repository.listExecutionSteps(lease.attemptId)).length, 2);
});

test('artifact-invalidation promotion only advances the worker-loss step monotonically', async () => {
  const { repository, lease } = await claimedLease();
  const artifact = await createResidualArtifact(repository, lease);
  const conflictingArtifact = await createResidualArtifact(repository, lease);
  await repository.recordExecutionStep({
    ...lease,
    stepNo: 1,
    stepName: 'existing safety failure',
    actorType: 'tool',
    actorId: 'safety-tool',
    state: 'failed',
    failure: { kind: 'safety', retryable: false, allowedActions: ['abort'] },
  });
  await repository.recordExecutionStep({
    ...lease,
    stepNo: 2,
    stepName: 'browser publication',
    actorType: 'tool',
    actorId: 'playwright-page-capture',
    state: 'running',
  });
  const connection = await scopedDatabase.connect();
  try {
    await connection.query(
      `UPDATE control_execution_attempts
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [lease.attemptId],
    );
  } finally {
    connection.release();
  }
  await repository.expireExecutionLease({ taskId: lease.taskId, attemptId: lease.attemptId });
  const beforePromotion = await repository.listExecutionSteps(lease.attemptId);
  const workerLossStep = beforePromotion.find(({ stepNo }) => stepNo === 2);
  assert.equal(workerLossStep?.failure?.kind, 'worker_loss');

  const failure = {
    kind: 'artifact_invalidation',
    retryable: false,
    message: 'unpublished step Artifact could not be invalidated',
    failedArtifactIds: [artifact.id],
    allowedActions: ['abort'],
  };
  assert.equal(await repository.promoteExecutionStepArtifactInvalidation({
    ...lease,
    stepNo: 1,
    stepName: 'existing safety failure',
    actorType: 'tool',
    actorId: 'safety-tool',
    failedArtifactIds: [artifact.id],
    expectedPreviousFailure: {
      kind: 'safety',
      retryable: false,
      allowedActions: ['abort'],
    },
  }), null);
  assert.equal(await repository.promoteExecutionStepArtifactInvalidation({
    ...lease,
    stepNo: 2,
    stepName: 'browser publication',
    actorType: 'tool',
    actorId: 'playwright-page-capture',
    failedArtifactIds: ['not-an-artifact'],
  }), null);
  assert.deepEqual(await repository.promoteExecutionStepArtifactInvalidation({
    ...lease,
    stepNo: 2,
    stepName: 'browser publication',
    actorType: 'tool',
    actorId: 'playwright-page-capture',
    failedArtifactIds: [artifact.id],
  }), failure);
  assert.deepEqual(await repository.promoteExecutionStepArtifactInvalidation({
    ...lease,
    stepNo: 2,
    stepName: 'browser publication',
    actorType: 'tool',
    actorId: 'playwright-page-capture',
    failedArtifactIds: [artifact.id],
  }), failure);
  assert.equal(await repository.promoteExecutionStepArtifactInvalidation({
    ...lease,
    stepNo: 2,
    stepName: 'browser publication',
    actorType: 'tool',
    actorId: 'playwright-page-capture',
    failedArtifactIds: [conflictingArtifact.id],
  }), null);

  const [safetyStep, browserStep] = await repository.listExecutionSteps(lease.attemptId);
  assert.equal((await repository.listExecutionSteps(lease.attemptId)).length, 2);
  assert.equal(safetyStep?.failure?.kind, 'safety');
  assert.deepEqual(browserStep?.failure, failure);
  assert.equal(browserStep?.toolProvenance, null);
  assert.equal(browserStep?.finishedAt?.getTime(), workerLossStep?.finishedAt?.getTime());
  const recoverable = (await repository.listRecoverableExecutions())
    .find(({ attemptId }) => attemptId === lease.attemptId);
  assert.equal(recoverable?.failureKind, 'artifact_invalidation');
});

test('worker-loss retry cannot outrun artifact-invalidation promotion', async () => {
  const { repository, lease } = await claimedLease();
  const artifact = await createResidualArtifact(repository, lease);
  await repository.recordExecutionStep({
    ...lease,
    stepNo: 1,
    stepName: 'browser publication',
    actorType: 'tool',
    actorId: 'playwright-page-capture',
    state: 'running',
  });
  const connection = await scopedDatabase.connect();
  try {
    await connection.query(
      `UPDATE control_execution_attempts
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [lease.attemptId],
    );
  } finally {
    connection.release();
  }
  const paused = await repository.expireExecutionLease({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
  });

  const [retried, promoted] = await Promise.all([
    repository.retryPausedExecution({
      taskId: lease.taskId,
      attemptId: lease.attemptId,
      expectedVersion: paused.stateVersion,
      failedStepNo: 1,
    }),
    repository.promoteExecutionStepArtifactInvalidation({
      ...lease,
      stepNo: 1,
      stepName: 'browser publication',
      actorType: 'tool',
      actorId: 'playwright-page-capture',
      failedArtifactIds: [artifact.id],
    }),
  ]);

  assert.equal(retried, null);
  assert.equal(promoted?.kind, 'artifact_invalidation');
  assert.equal((await repository.getTaskDetail(lease.taskId))?.state, 'paused');
  const recoverable = (await repository.listRecoverableExecutions())
    .find(({ attemptId }) => attemptId === lease.attemptId);
  assert.equal(recoverable?.failureKind, 'artifact_invalidation');
});

test('worker-loss retry waits for sealed chart data cleanup', async () => {
  const { repository, lease } = await claimedLease();
  const chartData = await repository.createStagingArtifact({
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    activeLease: lease,
    kind: 'chart_data',
    storageUri: `/tmp/${randomUUID()}.json`,
    schemaVersion: 'chart-data-v1',
    sensitivity: 'internal',
    redactionPolicyVersion: 'trusted-p0-v1',
  });
  await repository.sealArtifact({
    ...lease,
    artifactId: chartData.id,
    contentSha256: `sha256:${'4'.repeat(64)}`,
    byteSize: 1,
  });
  await repository.recordExecutionStep({
    ...lease,
    stepNo: 1,
    stepName: 'interrupted step',
    actorType: 'tool',
    actorId: 'tavily-web-search',
    state: 'running',
  });
  const connection = await scopedDatabase.connect();
  try {
    await connection.query(
      `UPDATE control_execution_attempts
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [lease.attemptId],
    );
  } finally {
    connection.release();
  }
  const paused = await repository.expireExecutionLease({ taskId: lease.taskId, attemptId: lease.attemptId });

  assert.equal(await repository.retryPausedExecution({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
    expectedVersion: paused.stateVersion,
    failedStepNo: 1,
  }), null);

  await repository.invalidateArtifactPublication(chartData.id, 'worker-loss chart data cleanup');

  assert.equal((await repository.retryPausedExecution({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
    expectedVersion: paused.stateVersion,
    failedStepNo: 1,
  }))?.state, 'ready');
});

test('worker-loss retry waits for sealed Showcase Artifact cleanup', async () => {
  const { repository, lease } = await claimedLease();
  const showcaseArtifacts = await Promise.all([
    ['report_editorial_showcase_spec', 'editorial-presentation-spec-v1'],
    ['editorial_showcase_html', 'editorial-showcase-html-v1'],
  ].map(async ([kind, schemaVersion]) => {
    const staging = await repository.createStagingArtifact({
      taskId: lease.taskId,
      planVersionId: lease.planVersionId,
      attemptId: lease.attemptId,
      activeLease: lease,
      kind: kind!,
      storageUri: `/tmp/${randomUUID()}.json`,
      schemaVersion: schemaVersion!,
      sensitivity: 'internal',
      redactionPolicyVersion: 'trusted-p0-v1',
    });
    return repository.sealArtifact({
      ...lease,
      artifactId: staging.id,
      contentSha256: `sha256:${'5'.repeat(64)}`,
      byteSize: 1,
    });
  }));
  await repository.recordExecutionStep({
    ...lease,
    stepNo: 1,
    stepName: 'interrupted Showcase publication',
    actorType: 'system',
    actorId: 'editorial-showcase-publication',
    state: 'running',
  });
  const connection = await scopedDatabase.connect();
  try {
    await connection.query(
      `UPDATE control_execution_attempts
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [lease.attemptId],
    );
  } finally {
    connection.release();
  }
  const paused = await repository.expireExecutionLease({ taskId: lease.taskId, attemptId: lease.attemptId });

  assert.equal(
    (await repository.listRecoverableExecutions()).some(({ attemptId }) => attemptId === lease.attemptId),
    true,
  );
  assert.equal(await repository.retryPausedExecution({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
    expectedVersion: paused.stateVersion,
    failedStepNo: 1,
  }), null);

  for (const artifact of showcaseArtifacts) {
    await repository.invalidateArtifactPublication(artifact.id, 'worker-loss Showcase cleanup');
  }
  assert.equal((await repository.retryPausedExecution({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
    expectedVersion: paused.stateVersion,
    failedStepNo: 1,
  }))?.state, 'ready');
});

test('worker-loss retry waits for pending physical Artifact quarantine', async () => {
  const { repository, lease } = await claimedLease();
  const artifact = await createResidualArtifact(repository, lease);
  await repository.recordExecutionStep({
    ...lease,
    stepNo: 1,
    stepName: 'interrupted step',
    actorType: 'tool',
    actorId: 'tavily-web-search',
    state: 'running',
  });
  const connection = await scopedDatabase.connect();
  try {
    await connection.query(
      `UPDATE control_artifacts
       SET state = 'FAILED', failure_reason = $2
       WHERE id = $1`,
      [artifact.id, `quarantine pending${ARTIFACT_QUARANTINE_PENDING_MARKER}2026-08-19T00:00:00.000Z`],
    );
    await connection.query(
      `UPDATE control_execution_attempts
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [lease.attemptId],
    );
  } finally {
    connection.release();
  }
  const paused = await repository.expireExecutionLease({ taskId: lease.taskId, attemptId: lease.attemptId });

  assert.equal(await repository.retryPausedExecution({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
    expectedVersion: paused.stateVersion,
    failedStepNo: 1,
  }), null);
});

test('attempt-bound staging holds the task fence until its registry row is inserted', { timeout: 5_000 }, async () => {
  const { lease } = await claimedLease();
  const blockedDatabase = new BlockedArtifactInsertDatabase(scopedDatabase);
  const repository = new ControlPlaneRepository(blockedDatabase);
  const creation = repository.createStagingArtifact({
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    activeLease: lease,
    kind: 'tool_output',
    storageUri: `/tmp/${randomUUID()}.json`,
    schemaVersion: 'tool-output-v1',
    sensitivity: 'internal',
    redactionPolicyVersion: 'trusted-p0-v1',
  });
  await blockedDatabase.insertStarted;

  const competing = await scopedDatabase.connect();
  try {
    await competing.query("SET lock_timeout TO '100ms'");
    await assert.rejects(
      () => competing.query(
        `UPDATE control_tasks
         SET updated_at = updated_at
         WHERE id = $1`,
        [lease.taskId],
      ),
      /lock timeout/u,
    );
  } finally {
    competing.release();
    blockedDatabase.releaseInsert();
  }

  const artifact = await creation;
  assert.equal(artifact.state, 'STAGING');
  const connection = await scopedDatabase.connect();
  try {
    await connection.query(
      `UPDATE control_execution_attempts
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [lease.attemptId],
    );
  } finally {
    connection.release();
  }
  const baseRepository = new ControlPlaneRepository(scopedDatabase);
  const paused = await baseRepository.expireExecutionLease({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
  });
  assert.equal(await baseRepository.retryPausedExecution({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
    expectedVersion: paused.stateVersion,
  }), null);
  assert.equal((await baseRepository.getTaskDetail(lease.taskId))?.state, 'paused');
});

test('attempt-bound staging rejects a stale lease after worker-loss retry', async () => {
  const { repository, lease } = await claimedLease();
  await repository.recordExecutionStep({
    ...lease,
    stepNo: 1,
    stepName: 'interrupted step',
    actorType: 'tool',
    actorId: 'tavily-web-search',
    state: 'failed',
    failure: { kind: 'worker_loss', retryable: true, allowedActions: ['retry', 'abort'] },
  });
  const executing = await repository.getTaskDetail(lease.taskId);
  assert.ok(executing);
  const paused = await repository.pauseExecution({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
    expectedVersion: executing.stateVersion,
    reason: 'worker_loss',
  });
  assert.equal((await repository.retryPausedExecution({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
    expectedVersion: paused.stateVersion,
  }))?.state, 'ready');

  await assert.rejects(
    () => repository.createStagingArtifact({
      taskId: lease.taskId,
      planVersionId: lease.planVersionId,
      attemptId: lease.attemptId,
      activeLease: lease,
      kind: 'tool_output',
      storageUri: `/tmp/${randomUUID()}.json`,
      schemaVersion: 'tool-output-v1',
      sensitivity: 'internal',
      redactionPolicyVersion: 'trusted-p0-v1',
    }),
    ControlPlaneConflictError,
  );
  assert.deepEqual(await repository.listArtifactsForAttempt(lease), []);
});

test('attempt-bound seal requires a complete lease without mutating caller-shape failures', async () => {
  const { repository, lease } = await claimedLease();
  const artifact = await createResidualArtifact(repository, lease);
  const seal = {
    artifactId: artifact.id,
    contentSha256: `sha256:${'5'.repeat(64)}`,
    byteSize: 1,
  };

  await assert.rejects(
    () => repository.sealArtifact({ ...seal, taskId: lease.taskId }),
    ControlPlaneConflictError,
  );
  assert.equal((await repository.getArtifact(artifact.id))?.state, 'STAGING');
  await assert.rejects(
    () => repository.sealArtifact(seal),
    ControlPlaneConflictError,
  );
  assert.equal((await repository.getArtifact(artifact.id))?.state, 'STAGING');
  assert.equal((await repository.sealArtifact({ ...seal, ...lease })).state, 'SEALED');
});

test('lease-bound seal holds task and attempt fences before touching its Artifact', { timeout: 5_000 }, async () => {
  const { repository, lease } = await claimedLease();
  const artifact = await createResidualArtifact(repository, lease);
  const connection = await scopedDatabase.connect();
  try {
    await connection.query(
      `UPDATE control_execution_attempts
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [lease.attemptId],
    );
  } finally {
    connection.release();
  }

  const blockedDatabase = new BlockedLeaseSealUpdateDatabase(scopedDatabase);
  const blockedRepository = new ControlPlaneRepository(blockedDatabase);
  const sealing = blockedRepository.sealArtifact({
    ...lease,
    artifactId: artifact.id,
    contentSha256: `sha256:${'6'.repeat(64)}`,
    byteSize: 1,
  }).then(
    () => null,
    (error: unknown) => error,
  );
  await blockedDatabase.updateStarted;

  const competing = await scopedDatabase.connect();
  try {
    await competing.query("SET lock_timeout TO '100ms'");
    await assert.rejects(
      () => competing.query(
        'UPDATE control_tasks SET updated_at = updated_at WHERE id = $1',
        [lease.taskId],
      ),
      /lock timeout/u,
    );
    await assert.rejects(
      () => competing.query(
        `UPDATE control_execution_attempts
         SET lease_expires_at = lease_expires_at
         WHERE id = $1`,
        [lease.attemptId],
      ),
      /lock timeout/u,
    );
  } finally {
    competing.release();
    blockedDatabase.releaseUpdate();
  }

  const error = await sealing;
  assert.ok(error instanceof ControlPlaneConflictError);
  assert.equal((await repository.getArtifact(artifact.id))?.state, 'FAILED');
  assert.equal((await repository.getTaskDetail(lease.taskId))?.state, 'paused');
});

test('artifact-invalidation promotion rejects unbound or non-residual Artifact ids atomically', async () => {
  const { repository, lease } = await claimedLease();
  const validArtifact = await createResidualArtifact(repository, lease);
  const failedArtifact = await createResidualArtifact(repository, lease);
  await repository.invalidateArtifactPublication(failedArtifact.id, 'already cleaned');
  const foreign = await claimedLease();
  const foreignArtifact = await createResidualArtifact(foreign.repository, foreign.lease);
  const publicPreviousFailure = { kind: 'persistence', retryable: false, allowedActions: ['abort'] };
  const pendingCleanupFailure = {
    ...publicPreviousFailure,
    kind: 'artifact_invalidation',
  };
  const previousFailure = {
    ...publicPreviousFailure,
    artifactInvalidationPromotion: {
      version: ARTIFACT_INVALIDATION_PROMOTION_VERSION,
      eligibleArtifactIds: [validArtifact.id, failedArtifact.id],
    },
  };
  const identity = {
    stepNo: 1,
    stepName: 'browser publication',
    actorType: 'tool',
    actorId: 'playwright-page-capture',
  };
  await repository.recordExecutionStep({
    ...lease,
    ...identity,
    state: 'failed',
    failure: previousFailure,
  });

  for (const failedArtifactIds of [
    [],
    [validArtifact.id, validArtifact.id],
    ['missing-artifact'],
    [failedArtifact.id],
    [foreignArtifact.id],
    [validArtifact.id, foreignArtifact.id],
  ]) {
    assert.equal(await repository.promoteExecutionStepArtifactInvalidation({
      ...lease,
      ...identity,
      expectedPreviousFailure: previousFailure,
      failedArtifactIds,
    }), null, failedArtifactIds.join(','));
    assert.deepEqual(
      (await repository.listExecutionSteps(lease.attemptId))[0]?.failure,
      pendingCleanupFailure,
      failedArtifactIds.join(','),
    );
  }

  const promoted = await repository.promoteExecutionStepArtifactInvalidation({
    ...lease,
    ...identity,
    expectedPreviousFailure: previousFailure,
    failedArtifactIds: [validArtifact.id],
  });
  assert.deepEqual(promoted?.failedArtifactIds, [validArtifact.id]);
  assert.deepEqual(promoted?.allowedActions, ['abort']);
});

test('artifact-invalidation promotion serializes conflicting writers and keeps exact retries idempotent', async () => {
  const { repository, lease } = await claimedLease();
  const firstArtifact = await createResidualArtifact(repository, lease);
  const secondArtifact = await createResidualArtifact(repository, lease);
  const previousFailure = {
    kind: 'persistence',
    retryable: false,
    artifactInvalidationPromotion: {
      version: ARTIFACT_INVALIDATION_PROMOTION_VERSION,
      eligibleArtifactIds: [firstArtifact.id, secondArtifact.id],
    },
  };
  const identity = {
    stepNo: 1,
    stepName: 'browser publication',
    actorType: 'tool',
    actorId: 'playwright-page-capture',
  };
  const finishedAt = new Date('2026-08-19T00:00:01.000Z');
  await repository.recordExecutionStep({
    ...lease,
    ...identity,
    state: 'failed',
    failure: previousFailure,
    finishedAt,
  });

  const competing = await Promise.all([
    repository.promoteExecutionStepArtifactInvalidation({
      ...lease,
      ...identity,
      expectedPreviousFailure: previousFailure,
      failedArtifactIds: [firstArtifact.id],
    }),
    repository.promoteExecutionStepArtifactInvalidation({
      ...lease,
      ...identity,
      expectedPreviousFailure: previousFailure,
      failedArtifactIds: [secondArtifact.id],
    }),
  ]);
  const winner = competing.find((failure) => failure !== null);
  assert.ok(winner);
  assert.equal(competing.filter((failure) => failure !== null).length, 1);
  const winnerIds = winner.failedArtifactIds as string[];
  const exactRetries = await Promise.all([
    repository.promoteExecutionStepArtifactInvalidation({
      ...lease,
      ...identity,
      failedArtifactIds: winnerIds,
    }),
    repository.promoteExecutionStepArtifactInvalidation({
      ...lease,
      ...identity,
      failedArtifactIds: winnerIds,
    }),
  ]);
  assert.ok(exactRetries.every((failure) => failure !== null));
  const [step] = await repository.listExecutionSteps(lease.attemptId);
  assert.deepEqual(step?.failure, winner);
  assert.equal(step?.finishedAt?.getTime(), finishedAt.getTime());
});

test('lets the fenced worker record the real failed step after external lease recovery', async () => {
  const { repository, lease } = await claimedLease();
  const connection = await scopedDatabase.connect();
  try {
    await connection.query(
      `UPDATE control_execution_attempts
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [lease.attemptId],
    );
  } finally {
    connection.release();
  }
  await repository.expireExecutionLease({ taskId: lease.taskId, attemptId: lease.attemptId });
  const [sentinel] = await repository.listExecutionSteps(lease.attemptId);
  assert.ok(sentinel);
  assert.equal(sentinel.stepNo, 1);
  assert.equal(sentinel.stepName, 'worker lease expired');
  assert.equal(sentinel.actorType, 'system');
  assert.equal(sentinel.actorId, 'worker-loss');
  assert.equal(sentinel.state, 'failed');
  assert.equal(sentinel.failure?.kind, 'worker_loss');

  assert.equal(await repository.recordLeaseLostExecutionStep({
    ...lease,
    leaseToken: 'wrong-token',
    stepNo: sentinel.stepNo,
    stepName: 'forged interrupted step',
    actorType: 'skill',
    actorId: 'attacker',
    failure: { kind: 'lease_lost', retryable: true },
  }), false);
  assert.equal(
    (await repository.listExecutionSteps(lease.attemptId))[0]?.actorId,
    'worker-loss',
  );

  const startedAt = new Date('2026-08-18T00:00:00.000Z');
  const finishedAt = new Date('2026-08-18T00:00:01.000Z');
  assert.equal(await repository.recordLeaseLostExecutionStep({
    ...lease,
    stepNo: sentinel.stepNo,
    stepName: 'actual interrupted step',
    actorType: 'tool',
    actorId: 'trusted-tool',
    failure: { kind: 'lease_lost', retryable: true },
    toolProvenance: { outputHash: 'sha256:interrupted' },
    startedAt,
    finishedAt,
  }), true);
  const [step] = await repository.listExecutionSteps(lease.attemptId);
  assert.equal(step?.stepName, 'actual interrupted step');
  assert.equal(step?.actorType, 'tool');
  assert.equal(step?.actorId, 'trusted-tool');
  assert.equal(step?.state, 'failed');
  assert.deepEqual(step?.toolProvenance, { outputHash: 'sha256:interrupted' });
  assert.equal(step?.skillProvenance, null);
  assert.deepEqual(step?.failure, { kind: 'lease_lost', retryable: true });
  assert.equal(step?.startedAt?.toISOString(), startedAt.toISOString());
  assert.equal(step?.finishedAt?.toISOString(), finishedAt.toISOString());
});

test('persists structured tool provenance and failure on execution steps', async () => {
  const { repository, lease } = await claimedLease();
  await repository.recordExecutionStep({
    ...lease,
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
    ...lease,
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

test('persists Skill provenance independently from Tool provenance', async () => {
  const { repository, lease } = await claimedLease();
  await repository.recordExecutionStep({
    ...lease,
    stepNo: 1,
    stepName: 'skill analysis',
    actorType: 'skill',
    actorId: 'digital-human-competitive-analysis',
    state: 'succeeded',
    skillProvenance: {
      skillBodyHash: 'sha256:body',
      inputSchemaHash: 'sha256:input-schema',
      outputSchemaHash: 'sha256:output-schema',
      inputHash: 'sha256:input',
      outputHash: 'sha256:output',
      promptHash: 'sha256:prompt',
      traceId: 'trace-skill',
      modelReceiptId: '11111111-1111-4111-8111-111111111111',
      outputArtifactId: '22222222-2222-4222-8222-222222222222',
      status: 'succeeded',
    },
    startedAt: new Date('2026-08-09T00:00:00Z'),
    finishedAt: new Date('2026-08-09T00:00:01Z'),
  });

  const steps = await repository.listExecutionSteps(lease.attemptId);
  assert.equal(steps[0].toolProvenance, null);
  assert.equal(steps[0].skillProvenance?.skillBodyHash, 'sha256:body');
  assert.equal(steps[0].skillProvenance?.modelReceiptId, '11111111-1111-4111-8111-111111111111');
});

test('legacy Skill output schema failures become retryable without weakening input failures', async () => {
  const { repository, lease } = await claimedLease();
  await repository.recordExecutionStep({
    ...lease,
    stepNo: 1,
    stepName: 'legacy skill output schema failure',
    actorType: 'skill',
    actorId: 'research-strategy-synthesis',
    state: 'failed',
    failure: { kind: 'schema', retryable: false, allowedActions: ['abort'] },
    skillProvenance: {
      status: 'failed',
      modelReceiptId: '11111111-1111-4111-8111-111111111111',
      outputHash: `sha256:${'1'.repeat(64)}`,
    },
  });
  const executing = await repository.getTaskDetail(lease.taskId);
  assert.ok(executing);
  const paused = await repository.pauseExecution({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
    expectedVersion: executing.stateVersion,
    reason: 'schema',
  });

  const [step] = await repository.listExecutionSteps(lease.attemptId);
  assert.equal(step?.failure?.retryable, true);
  assert.deepEqual(step?.failure?.allowedActions, ['retry', 'abort']);
  assert.equal((await repository.retryPausedExecution({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
    expectedVersion: paused.stateVersion,
    failedStepNo: 1,
  }))?.state, 'ready');

  const inputCase = await claimedLease();
  await inputCase.repository.recordExecutionStep({
    ...inputCase.lease,
    stepNo: 1,
    stepName: 'skill input schema failure',
    actorType: 'skill',
    actorId: 'research-strategy-synthesis',
    state: 'failed',
    failure: { kind: 'schema', retryable: false, allowedActions: ['abort'] },
    skillProvenance: { status: 'failed', modelReceiptId: null, outputHash: null },
  });
  const inputExecuting = await inputCase.repository.getTaskDetail(inputCase.lease.taskId);
  assert.ok(inputExecuting);
  const inputPaused = await inputCase.repository.pauseExecution({
    taskId: inputCase.lease.taskId,
    attemptId: inputCase.lease.attemptId,
    expectedVersion: inputExecuting.stateVersion,
    reason: 'schema',
  });
  assert.deepEqual(
    (await inputCase.repository.listExecutionSteps(inputCase.lease.attemptId))[0]?.failure,
    { kind: 'schema', retryable: false, allowedActions: ['abort'] },
  );
  assert.equal(await inputCase.repository.retryPausedExecution({
    taskId: inputCase.lease.taskId,
    attemptId: inputCase.lease.attemptId,
    expectedVersion: inputPaused.stateVersion,
    failedStepNo: 1,
  }), null);
});

test('enforces monotonic execution step transitions', async () => {
  const { repository, lease } = await claimedLease();
  const record = (
    stepNo: number,
    state: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped',
  ) => repository.recordExecutionStep({
    ...lease,
    stepNo,
    stepName: `monotonic step ${stepNo}`,
    actorType: 'system',
    actorId: 'transition-fence',
    state,
  });

  await record(1, 'pending');
  await record(1, 'running');
  await record(1, 'succeeded');
  await record(1, 'succeeded');
  for (const regressed of ['pending', 'running', 'failed', 'skipped'] as const) {
    await assert.rejects(() => record(1, regressed), ControlPlaneConflictError);
  }

  await record(2, 'running');
  await assert.rejects(() => record(2, 'running'), ControlPlaneConflictError);
  await assert.rejects(() => record(2, 'pending'), ControlPlaneConflictError);
  await record(2, 'failed');
  await assert.rejects(() => record(2, 'skipped'), ControlPlaneConflictError);

  await record(3, 'pending');
  await record(3, 'skipped');
  await assert.rejects(() => record(3, 'failed'), ControlPlaneConflictError);

  assert.deepEqual(
    (await repository.listExecutionSteps(lease.attemptId)).map(({ stepNo, state }) => ({ stepNo, state })),
    [
      { stepNo: 1, state: 'succeeded' },
      { stepNo: 2, state: 'failed' },
      { stepNo: 3, state: 'skipped' },
    ],
  );
});

test('rejects terminal execution step replay mutations and preserves the original evidence', async () => {
  const { repository, lease } = await claimedLease();
  const originalArtifact = await repository.createStagingArtifact({
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    activeLease: lease,
    kind: 'tool_output',
    storageUri: `/tmp/${randomUUID()}.json`,
    schemaVersion: 'tool-output-v1',
    sensitivity: 'internal',
    redactionPolicyVersion: 'trusted-p0-v1',
  });
  const replacementArtifact = await repository.createStagingArtifact({
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    activeLease: lease,
    kind: 'tool_output',
    storageUri: `/tmp/${randomUUID()}.json`,
    schemaVersion: 'tool-output-v1',
    sensitivity: 'internal',
    redactionPolicyVersion: 'trusted-p0-v1',
  });

  await repository.recordExecutionStep({
    ...lease,
    stepNo: 1,
    stepName: 'sealed tool step',
    actorType: 'tool',
    actorId: 'trusted-tool',
    state: 'succeeded',
    outputArtifactId: originalArtifact.id,
    toolProvenance: { outputHash: 'sha256:trusted' },
    latencyMs: 10,
  });
  await assert.rejects(
    () => repository.recordExecutionStep({
      ...lease,
      stepNo: 1,
      stepName: 'sealed tool step',
      actorType: 'tool',
      actorId: 'trusted-tool',
      state: 'succeeded',
      outputArtifactId: replacementArtifact.id,
      toolProvenance: { outputHash: 'sha256:trusted' },
      latencyMs: 10,
    }),
    ControlPlaneConflictError,
  );

  await repository.recordExecutionStep({
    ...lease,
    stepNo: 2,
    stepName: 'failed tool step',
    actorType: 'tool',
    actorId: 'trusted-tool',
    state: 'failed',
    failure: { kind: 'network', retryable: true },
  });
  await assert.rejects(
    () => repository.recordExecutionStep({
      ...lease,
      stepNo: 2,
      stepName: 'rewritten failure',
      actorType: 'system',
      actorId: 'untrusted-rewriter',
      state: 'failed',
      failure: { kind: 'safety', retryable: false },
    }),
    ControlPlaneConflictError,
  );

  const [succeeded, failed] = await repository.listExecutionSteps(lease.attemptId);
  assert.equal(succeeded?.stepName, 'sealed tool step');
  assert.equal(succeeded?.actorType, 'tool');
  assert.equal(succeeded?.actorId, 'trusted-tool');
  assert.equal(succeeded?.outputArtifactId, originalArtifact.id);
  assert.equal(succeeded?.toolProvenance?.outputHash, 'sha256:trusted');
  assert.equal(succeeded?.failure, null);
  assert.equal(succeeded?.latencyMs, 10);
  assert.equal(failed?.stepName, 'failed tool step');
  assert.equal(failed?.actorType, 'tool');
  assert.equal(failed?.actorId, 'trusted-tool');
  assert.equal(failed?.failure?.kind, 'network');
});

test('authenticates the original lease before finalizing a running step after worker loss', async () => {
  const { repository, lease } = await claimedLease();
  await repository.recordExecutionStep({
    ...lease,
    stepNo: 1,
    stepName: 'worker-owned step',
    actorType: 'tool',
    actorId: 'trusted-tool',
    state: 'running',
  });
  const connection = await scopedDatabase.connect();
  try {
    await connection.query(
      `UPDATE control_execution_attempts
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [lease.attemptId],
    );
  } finally {
    connection.release();
  }
  await repository.expireExecutionLease({ taskId: lease.taskId, attemptId: lease.attemptId });

  assert.equal(await repository.recordLeaseLostExecutionStep({
    ...lease,
    leaseToken: 'wrong-token',
    stepNo: 1,
    stepName: 'worker-owned step',
    actorType: 'tool',
    actorId: 'trusted-tool',
    failure: { kind: 'lease_lost', retryable: true },
  }), false);
  assert.equal((await repository.listExecutionSteps(lease.attemptId))[0]?.failure?.kind, 'worker_loss');

  assert.equal(await repository.recordLeaseLostExecutionStep({
    ...lease,
    stepNo: 1,
    stepName: 'attacker step',
    actorType: 'skill',
    actorId: 'attacker',
    failure: { kind: 'lease_lost', retryable: true },
    skillProvenance: { outputHash: 'sha256:attacker' },
  }), false);
  const unchanged = (await repository.listExecutionSteps(lease.attemptId))[0];
  assert.equal(unchanged?.stepName, 'worker-owned step');
  assert.equal(unchanged?.actorType, 'tool');
  assert.equal(unchanged?.actorId, 'trusted-tool');
  assert.equal(unchanged?.skillProvenance, null);
  assert.equal(unchanged?.failure?.kind, 'worker_loss');

  assert.equal(await repository.recordLeaseLostExecutionStep({
    ...lease,
    stepNo: 1,
    stepName: 'worker-owned step',
    actorType: 'tool',
    actorId: 'trusted-tool',
    failure: { kind: 'lease_lost', retryable: true },
  }), true);
  const finalized = await repository.listExecutionSteps(lease.attemptId);
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0]?.state, 'failed');
  assert.equal(finalized[0]?.failure?.kind, 'lease_lost');
  assert.equal(
    finalized.some(({ state }) => state === 'pending' || state === 'running'),
    false,
  );
});

test('keeps an interrupted historical attempt recoverable after a retry becomes current', async () => {
  const { repository, lease } = await claimedLease();
  await repository.createStagingArtifact({
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    activeLease: lease,
    kind: 'tool_output',
    storageUri: `/tmp/${randomUUID()}.json`,
    schemaVersion: 'tool-output-v1',
    sensitivity: 'internal',
    redactionPolicyVersion: 'trusted-p0-v1',
  });
  const connection = await scopedDatabase.connect();
  try {
    await connection.query(
      `UPDATE control_execution_attempts
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [lease.attemptId],
    );
  } finally {
    connection.release();
  }
  const paused = await repository.expireExecutionLease({ taskId: lease.taskId, attemptId: lease.attemptId });
  const ready = await repository.transitionTask({
    taskId: lease.taskId,
    expectedVersion: paused.stateVersion,
    from: 'paused',
    to: 'ready',
  });
  const retryToken = randomUUID();
  const retry = await repository.claimExecution({
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    expectedVersion: ready.stateVersion,
    idempotencyKey: randomUUID(),
    requestHash: `sha256:${randomUUID()}`,
    leaseOwner: 'retry-worker',
    leaseTokenHash: leaseHash(retryToken),
    retryOf: lease.attemptId,
  });

  const recoverable = await repository.listRecoverableExecutions();
  assert.ok(recoverable.some((execution) => (
    execution.attemptId === lease.attemptId
    && execution.attemptState === 'paused'
    && execution.failureKind === 'worker_loss'
    && execution.taskState === 'executing'
  )));
  assert.ok(recoverable.some(({ attemptId }) => attemptId === retry.attemptId));
});

test('stops recovering a historical worker-loss attempt when only referenced succeeded output remains', async () => {
  const { repository, lease } = await claimedLease();
  const artifact = await repository.createStagingArtifact({
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    activeLease: lease,
    kind: 'tool_output',
    storageUri: `/tmp/${randomUUID()}.json`,
    schemaVersion: 'tool-output-v1',
    sensitivity: 'internal',
    redactionPolicyVersion: 'trusted-p0-v1',
  });
  await repository.sealArtifact({
    ...lease,
    artifactId: artifact.id,
    contentSha256: `sha256:${'1'.repeat(64)}`,
    byteSize: 1,
  });
  await repository.recordExecutionStep({
    ...lease,
    stepNo: 1,
    stepName: 'published step',
    actorType: 'tool',
    actorId: 'trusted-tool',
    state: 'succeeded',
    outputArtifactId: artifact.id,
  });
  const connection = await scopedDatabase.connect();
  try {
    await connection.query(
      `UPDATE control_execution_attempts
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [lease.attemptId],
    );
  } finally {
    connection.release();
  }
  const paused = await repository.expireExecutionLease({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
  });
  const ready = await repository.transitionTask({
    taskId: lease.taskId,
    expectedVersion: paused.stateVersion,
    from: 'paused',
    to: 'ready',
  });
  const retry = await repository.claimExecution({
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    expectedVersion: ready.stateVersion,
    idempotencyKey: randomUUID(),
    requestHash: `sha256:${randomUUID()}`,
    leaseOwner: 'retry-worker',
    leaseTokenHash: leaseHash(randomUUID()),
    retryOf: lease.attemptId,
  });

  const recoverable = await repository.listRecoverableExecutions();
  assert.equal(recoverable.some(({ attemptId }) => attemptId === lease.attemptId), false);
  assert.equal(recoverable.some(({ attemptId }) => attemptId === retry.attemptId), true);
});

test('keeps worker-loss Artifact cleanup recoverable after the user aborts', async () => {
  const { repository, lease } = await claimedLease();
  await repository.createStagingArtifact({
    taskId: lease.taskId,
    planVersionId: lease.planVersionId,
    attemptId: lease.attemptId,
    activeLease: lease,
    kind: 'tool_output',
    storageUri: `/tmp/${randomUUID()}.json`,
    schemaVersion: 'tool-output-v1',
    sensitivity: 'internal',
    redactionPolicyVersion: 'trusted-p0-v1',
  });
  const connection = await scopedDatabase.connect();
  try {
    await connection.query(
      `UPDATE control_execution_attempts
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [lease.attemptId],
    );
  } finally {
    connection.release();
  }
  const paused = await repository.expireExecutionLease({ taskId: lease.taskId, attemptId: lease.attemptId });
  await repository.cancelPausedExecution({
    taskId: lease.taskId,
    attemptId: lease.attemptId,
    expectedVersion: paused.stateVersion,
  });

  assert.ok((await repository.listRecoverableExecutions()).some((execution) => (
    execution.attemptId === lease.attemptId
    && execution.attemptState === 'cancelled'
    && execution.failureKind === 'worker_loss'
  )));
});

test('rejects a stale step writer queued behind the quarantine table fence', { timeout: 5_000 }, async () => {
  const { lease } = await claimedLease();
  const blocker = await scopedDatabase.connect();
  let transactionOpen = false;
  try {
    await blocker.query('BEGIN');
    transactionOpen = true;
    await blocker.query(
      `LOCK TABLE
         control_tasks,
         control_plan_versions,
         control_requirement_versions,
         control_execution_attempts,
         control_execution_steps,
         control_artifacts,
         control_commands
       IN ACCESS EXCLUSIVE MODE`,
    );

    const announcedDatabase = new AnnouncedStepWriteDatabase(scopedDatabase);
    const repository = new ControlPlaneRepository(announcedDatabase);
    const writeOutcome = repository.recordExecutionStep({
      ...lease,
      stepNo: 1,
      stepName: 'stale worker write',
      actorType: 'tool',
      actorId: 'stale-worker',
      state: 'running',
      startedAt: new Date(),
    }).then(
      () => null,
      (error: unknown) => error,
    );
    await announcedDatabase.taskFenceStarted;

    await blocker.query(
      `UPDATE control_execution_attempts
       SET state = 'cancelled', lease_owner = NULL, lease_token_hash = NULL,
           lease_expires_at = NULL, lease_heartbeat_at = NULL, finished_at = now()
       WHERE id = $1`,
      [lease.attemptId],
    );
    await blocker.query(
      `UPDATE control_tasks
       SET state = 'awaiting_confirmation', current_attempt_id = NULL,
           state_version = state_version + 1, updated_at = now()
       WHERE id = $1`,
      [lease.taskId],
    );
    await blocker.query('COMMIT');
    transactionOpen = false;

    const error = await writeOutcome;
    assert.ok(error instanceof ControlPlaneConflictError);
    const steps = await new ControlPlaneRepository(scopedDatabase).listExecutionSteps(lease.attemptId);
    assert.deepEqual(steps, []);
  } finally {
    if (transactionOpen) await blocker.query('ROLLBACK');
    blocker.release();
  }
});

test('persists complete model receipts including drift and structured failure status', async () => {
  const { repository, lease } = await claimedLease();
  const receiptId = await repository.recordModelCall({
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
  assert.match(receiptId, /^[0-9a-f-]{36}$/u);

  const calls = await repository.listModelCalls(lease.attemptId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, receiptId);
  assert.equal(calls[0].provider, 'gateway');
  assert.equal(calls[0].requestedModel, 'gpt-pinned');
  assert.equal(calls[0].actualModel, 'gpt-pinned');
  assert.equal(calls[0].status, 'succeeded');
  assert.deepEqual(calls[0].tokens, { prompt: 10, completion: 5, total: 15 });
});
