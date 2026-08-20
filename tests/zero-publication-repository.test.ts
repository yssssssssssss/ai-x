import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import {
  ControlPlaneConflictError,
  ControlPlaneRepository,
} from '../database/control-plane.ts';
import {
  runMigrations,
  type MigrationConnection,
  type MigrationDatabase,
} from '../database/migration-runner.ts';

class ScopedPublicationDatabase implements MigrationDatabase {
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

const schema = `zero_publication_${randomUUID().replaceAll('-', '')}`;
const database = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/user_research_ai',
});
const scoped = new ScopedPublicationDatabase(database, schema);
const repository = new ControlPlaneRepository(scoped);

let ownerId = '';
let otherOwnerId = '';
let taskId = '';
let planVersionId = '';
let attemptId = '';
let reportPackageArtifactId = '';

async function query(sql: string, values: readonly unknown[] = []) {
  const connection = await scoped.connect();
  try {
    return await connection.query(sql, values);
  } finally {
    connection.release();
  }
}

async function createReceiptArtifact(publicationId: string): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO control_artifacts
       (id, task_id, plan_version_id, attempt_id, kind, contract_version,
        schema_version, state, storage_uri, content_sha256, byte_size,
        sensitivity, redaction_policy_version, redaction_status, sealed_at)
     VALUES ($1, $2, $3, $4, 'zero_publication_receipt', 'trusted-p0-v1',
             'zero-publication-receipt-v1', 'SEALED', $5, $6, 2,
             'internal', 'v1', 'sealed', now())`,
    [
      id,
      taskId,
      planVersionId,
      null,
      `/tmp/${publicationId}-zero-receipt.json`,
      `sha256:${'b'.repeat(64)}`,
    ],
  );
  return id;
}

before(async () => {
  await database.query(`CREATE SCHEMA "${schema}"`);
  const first = await runMigrations({
    database: scoped,
    migrationsDir: join(process.cwd(), 'database', 'migrations'),
    lockKey: 761_832_014,
  });
  const second = await runMigrations({
    database: scoped,
    migrationsDir: join(process.cwd(), 'database', 'migrations'),
    lockKey: 761_832_014,
  });
  assert.ok(first.applied.includes('014_zero_publications.sql'));
  assert.ok(second.skipped.includes('014_zero_publications.sql'));

  ownerId = randomUUID();
  otherOwnerId = randomUUID();
  const conversationId = randomUUID();
  taskId = randomUUID();
  planVersionId = randomUUID();
  attemptId = randomUUID();
  reportPackageArtifactId = randomUUID();

  await query(
    `INSERT INTO users (id, email, display_name, password_hash, role)
     VALUES ($1, $2, 'Zero owner', 'x', 'member'),
            ($3, $4, 'Other owner', 'x', 'member')`,
    [ownerId, `zero-owner-${ownerId}@test.local`, otherOwnerId, `zero-other-${otherOwnerId}@test.local`],
  );
  await query(
    `INSERT INTO conversations (id, owner_user_id, title)
     VALUES ($1, $2, 'Zero publication test')`,
    [conversationId, ownerId],
  );
  await query(
    `INSERT INTO control_tasks
       (id, conversation_id, owner_user_id, original_input, task_type,
        structured_task, state, state_version)
     VALUES ($1, $2, $3, 'publish report', 'competitive_research', '{}', 'completed', 7)`,
    [taskId, conversationId, ownerId],
  );
  await query(
    `INSERT INTO control_plan_versions
       (id, task_id, version, candidate_id, plan_json, plan_hash, pending_inputs)
     VALUES ($1, $2, 1, 'depth', '{"steps":[]}', $3, '[]')`,
    [planVersionId, taskId, `sha256:${'1'.repeat(64)}`],
  );
  await query(
    `INSERT INTO control_execution_attempts
       (id, task_id, plan_version_id, attempt_no, state, finished_at)
     VALUES ($1, $2, $3, 1, 'completed', now())`,
    [attemptId, taskId, planVersionId],
  );
  await query(
    `UPDATE control_tasks
     SET active_plan_version_id = $2, current_attempt_id = $3
     WHERE id = $1`,
    [taskId, planVersionId, attemptId],
  );
  await query(
    `INSERT INTO control_artifacts
       (id, task_id, plan_version_id, attempt_id, kind, contract_version,
        schema_version, state, storage_uri, content_sha256, byte_size,
        sensitivity, redaction_policy_version, redaction_status, sealed_at)
     VALUES ($1, $2, $3, $4, 'report_package', 'trusted-p0-v1',
             'report-package-v1', 'SEALED', $5, $6, 2,
             'internal', 'v1', 'sealed', now())`,
    [
      reportPackageArtifactId,
      taskId,
      planVersionId,
      attemptId,
      `/tmp/${taskId}-report-package.json`,
      `sha256:${'a'.repeat(64)}`,
    ],
  );
});

after(async () => {
  await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await database.end();
});

test('Migration 014 creates the Zero publication ledger and constraints', async () => {
  const table = await query(`SELECT to_regclass('control_zero_publications') AS name`);
  assert.equal(table.rows[0]?.name, 'control_zero_publications');

  await assert.rejects(
    () => query(
      `INSERT INTO control_zero_publications
         (task_id, owner_user_id, plan_version_id, attempt_id,
          report_package_artifact_id, report_package_hash, idempotency_key,
          request_hash, template_version, status, stage, progress,
          zero_page_id, zero_page_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'zero-report-v1',
               'unknown', 'checking_zero', 101, '30:1', '[p]demo')`,
      [
        taskId,
        ownerId,
        planVersionId,
        attemptId,
        reportPackageArtifactId,
        `sha256:${'a'.repeat(64)}`,
        randomUUID(),
        `sha256:${'c'.repeat(64)}`,
      ],
    ),
  );
});

test('repository creates and replays one publication per idempotency key', async () => {
  const idempotencyKey = randomUUID();
  const input = {
    taskId,
    ownerUserId: ownerId,
    planVersionId,
    attemptId,
    reportPackageArtifactId,
    reportPackageHash: `sha256:${'a'.repeat(64)}`,
    idempotencyKey,
    requestHash: `sha256:${'c'.repeat(64)}`,
    templateVersion: 'zero-report-v1',
    zeroFileKey: 'file-zero-1',
    zeroPageId: '30:1',
    zeroPageName: '[p]demo',
  };

  const created = await repository.createZeroPublication(input);
  const replayed = await repository.createZeroPublication(input);
  assert.equal(created.id, replayed.id);
  assert.equal(created.status, 'queued');
  assert.equal(created.stage, 'checking_zero');
  assert.equal(created.progress, 0);
  assert.equal(created.reportPackageArtifactId, reportPackageArtifactId);

  await assert.rejects(
    () => repository.createZeroPublication({
      ...input,
      requestHash: `sha256:${'d'.repeat(64)}`,
    }),
    ControlPlaneConflictError,
  );
  assert.equal(
    await repository.getZeroPublicationForOwner({
      publicationId: created.id,
      taskId,
      ownerUserId: otherOwnerId,
    }),
    null,
  );
});

test('repository claims, updates, heartbeats, and completes a publication', async () => {
  const publication = await repository.createZeroPublication({
    taskId,
    ownerUserId: ownerId,
    planVersionId,
    attemptId,
    reportPackageArtifactId,
    reportPackageHash: `sha256:${'a'.repeat(64)}`,
    idempotencyKey: randomUUID(),
    requestHash: `sha256:${'e'.repeat(64)}`,
    templateVersion: 'zero-report-v1',
    zeroFileKey: 'file-zero-1',
    zeroPageId: '30:1',
    zeroPageName: '[p]demo',
  });
  const claimed = await repository.claimZeroPublication({
    publicationId: publication.id,
    leaseOwner: 'zero-worker-1',
    leaseExpiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal(claimed?.status, 'running');
  assert.equal(
    await repository.claimZeroPublication({
      publicationId: publication.id,
      leaseOwner: 'zero-worker-2',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    }),
    null,
  );

  const updated = await repository.updateZeroPublication({
    publicationId: publication.id,
    leaseOwner: 'zero-worker-1',
    stage: 'writing_images',
    progress: 55,
    draftRootNodeId: '31:1242',
    zeroNodeMap: { cover: '31:1243' },
    imageManifest: [{ nodeId: '31:1450', status: 'written' }],
  });
  assert.equal(updated.stage, 'writing_images');
  assert.equal(updated.progress, 55);
  assert.equal(updated.draftRootNodeId, '31:1242');

  const heartbeat = await repository.heartbeatZeroPublication({
    publicationId: publication.id,
    leaseOwner: 'zero-worker-1',
    extendUntil: new Date(Date.now() + 120_000),
  });
  assert.equal(heartbeat.id, publication.id);

  const receiptArtifactId = await createReceiptArtifact(publication.id);
  const completed = await repository.completeZeroPublication({
    publicationId: publication.id,
    leaseOwner: 'zero-worker-1',
    finalRootNodeId: '31:1242',
    receiptArtifactId,
    screenshotManifest: [{ artifactId: randomUUID(), nodeId: '31:1242' }],
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.progress, 100);
  assert.equal(completed.finalRootNodeId, '31:1242');
  assert.equal(completed.receiptArtifactId, receiptArtifactId);
});

test('repository lists expired publications and records terminal failure', async () => {
  const publication = await repository.createZeroPublication({
    taskId,
    ownerUserId: ownerId,
    planVersionId,
    attemptId,
    reportPackageArtifactId,
    reportPackageHash: `sha256:${'a'.repeat(64)}`,
    idempotencyKey: randomUUID(),
    requestHash: `sha256:${'f'.repeat(64)}`,
    templateVersion: 'zero-report-v1',
    zeroFileKey: 'file-zero-1',
    zeroPageId: '30:1',
    zeroPageName: '[p]demo',
  });
  await repository.claimZeroPublication({
    publicationId: publication.id,
    leaseOwner: 'expired-worker',
    leaseExpiresAt: new Date(Date.now() + 60_000),
  });
  await query(
    `UPDATE control_zero_publications SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [publication.id],
  );
  const expired = await repository.listExpiredZeroPublications({ limit: 10 });
  assert.ok(expired.some((candidate) => candidate.id === publication.id));

  const failed = await repository.failZeroPublication({
    publicationId: publication.id,
    leaseOwner: 'expired-worker',
    failure: { code: 'zero_offline', message: 'Zero is offline', retryable: true },
  });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.failure, {
    code: 'zero_offline',
    message: 'Zero is offline',
    retryable: true,
  });
});
