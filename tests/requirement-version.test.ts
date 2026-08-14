import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneRepository,
  type ControlRequirementVersion,
} from '../database/control-plane.ts';
import {
  runMigrations,
  type MigrationConnection,
  type MigrationDatabase,
} from '../database/migration-runner.ts';

class ScopedMigrationDatabase implements MigrationDatabase {
  constructor(private readonly database: Pool, private readonly schema: string) {}

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

type RequirementRepository = ControlPlaneRepository & {
  createRequirementVersion(input: {
    taskId: string;
    version: number;
    rawInputHash: string;
    clarification: unknown;
    structuredTask: unknown;
    modelCallId?: string | null;
  }): Promise<ControlRequirementVersion>;
  createAndActivateRequirementVersion(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    rawInputHash: string;
    clarification: unknown;
    structuredTask: unknown;
    modelCallId?: string | null;
  }): Promise<{ version: ControlRequirementVersion; task: { state: string; stateVersion: number; activeRequirementVersionId: string | null } }>;
  getActiveRequirementVersion(taskId: string): Promise<ControlRequirementVersion | null>;
  activateRequirementVersion(input: {
    taskId: string;
    requirementVersionId: string;
    expectedVersion: number;
    ownerUserId: string;
  }): Promise<{
    id: string;
    state: string;
    stateVersion: number;
    activePlanVersionId: string | null;
    currentAttemptId: string | null;
    activeRequirementVersionId: string | null;
    conversationId: string;
    ownerUserId: string;
    conversationOwnerUserId: string;
    structuredTask: unknown;
  }>;
};


const schema = `requirement_version_${randomUUID().replaceAll('-', '')}`;
const database = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/user_research_ai',
});
const scopedDatabase = new ScopedMigrationDatabase(database, schema);
const repository = new ControlPlaneRepository(scopedDatabase) as RequirementRepository;
let ownerId = '';
let conversationId = '';
let taskId = '';
let secondTaskId = '';

const taskShape = (suffix: string) => ({
  version: 'research-task-v2',
  task_type: 'competitive_research',
  business_domain: '宠物消费',
  research_goal: `分析宠物辅食竞品 ${suffix}`,
  target_audience: ['宠物主'],
  scope: ['国内电商'],
  constraints: [{ id: 'c1', statement: '仅使用公开来源', source: 'user' }],
  success_criteria: [{ id: 'sc1', statement: '形成竞品能力对比' }],
  expected_deliverables: ['research_report'],
  assumptions: [{ key: 'sample', value: '头部品牌', editable: true }],
  ambiguities: [],
  clarification_questions: [],
  blocking_issues: [],
  sensitivity: 'internal',
  pii_detected: false,
});

async function requirementCount(targetTaskId: string): Promise<number> {
  const connection = await scopedDatabase.connect();
  try {
    const result = await connection.query(
      'SELECT count(*) AS count FROM control_requirement_versions WHERE task_id = $1',
      [targetTaskId],
    );
    return Number(result.rows[0]?.count);
  } finally {
    connection.release();
  }
}


before(async () => {
  await database.query(`CREATE SCHEMA "${schema}"`);
  await runMigrations({
    database: scopedDatabase,
    migrationsDir: join(process.cwd(), 'database', 'migrations'),
    lockKey: 761_831_101,
  });
  const connection = await scopedDatabase.connect();
  try {
    const owner = await connection.query(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [`requirements-${Date.now()}@test.local`, 'requirements owner', 'x', 'member'],
    );
    ownerId = String(owner.rows[0]?.id);
    const conversation = await connection.query(
      `INSERT INTO conversations (owner_user_id, title) VALUES ($1, $2) RETURNING id`,
      [ownerId, 'requirements test'],
    );
    conversationId = String(conversation.rows[0]?.id);
  } finally {
    connection.release();
  }
  const first = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'versioned requirements',
    taskType: 'competitive_research',
    structuredTask: taskShape('initial'),
    state: 'awaiting_clarification',
  });
  taskId = first.id;
  const second = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'foreign task',
    taskType: 'competitive_research',
    structuredTask: taskShape('second'),
    state: 'awaiting_clarification',
  });
  secondTaskId = second.id;
});
test('atomically creates and activates a requirement version without an orphan on invalid state', async () => {
  const created = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'selection must reject clarification writes',
    taskType: null,
    structuredTask: {},
    state: 'awaiting_selection',
  });
  const before = await scopedDatabase.connect();
  try {
    const result = await before.query('SELECT count(*) AS count FROM control_requirement_versions WHERE task_id = $1', [created.id]);
    assert.equal(Number(result.rows[0]?.count), 0);
  } finally {
    before.release();
  }
  await assert.rejects(
    () => repository.createAndActivateRequirementVersion({
      taskId: created.id,
      ownerUserId: ownerId,
      expectedVersion: created.stateVersion,
      rawInputHash: 'sha256:invalid-state',
      clarification: {},
      structuredTask: taskShape('invalid-state'),
    }),
    ControlPlaneConflictError,
  );
  const after = await scopedDatabase.connect();
  try {
    const result = await after.query('SELECT count(*) AS count FROM control_requirement_versions WHERE task_id = $1', [created.id]);
    assert.equal(Number(result.rows[0]?.count), 0);
  } finally {
    after.release();
  }
  const detail = await repository.getTaskDetail(created.id);
  assert.equal(detail?.state, 'awaiting_selection');
  assert.equal(detail?.stateVersion, created.stateVersion);
  assert.equal(detail?.activeRequirementVersionId, null);
});

test('clarification writes reject executing and completed states without changing state version', async () => {
  for (const state of ['executing', 'completed'] as const) {
    const created = await repository.createTask({
      conversationId,
      ownerUserId: ownerId,
      originalInput: `reject ${state}`,
      taskType: null,
      structuredTask: {},
      state,
    });
    await assert.rejects(
      () => repository.createAndActivateRequirementVersion({
        taskId: created.id,
        ownerUserId: ownerId,
        expectedVersion: created.stateVersion,
        rawInputHash: `sha256:${state}`,
        clarification: {},
        structuredTask: taskShape(state),
      }),
      ControlPlaneConflictError,
    );
    const detail = await repository.getTaskDetail(created.id);
    assert.equal(detail?.state, state);
    assert.equal(detail?.stateVersion, created.stateVersion);
    assert.equal(detail?.activeRequirementVersionId, null);
  }
});

test('atomically persists the full structured task and activates it with one CAS', async () => {
  const created = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: '$competitive-research original direct invoke',
    taskType: null,
    structuredTask: {},
    state: 'awaiting_clarification',
  });
  const structuredTask = taskShape('atomic-success');
  const result = await repository.createAndActivateRequirementVersion({
    taskId: created.id,
    ownerUserId: ownerId,
    expectedVersion: created.stateVersion,
    rawInputHash: 'sha256:atomic-success',
    clarification: { audience: '宠物主' },
    structuredTask,
  });
  assert.equal(result.version.version, 1);
  assert.deepEqual(result.version.structuredTask, structuredTask);
  assert.equal(result.task.activeRequirementVersionId, result.version.id);
  assert.equal(result.task.state, 'awaiting_clarification');
  assert.equal(result.task.stateVersion, created.stateVersion + 1);
  assert.deepEqual(result.task.structuredTask, structuredTask);
  assert.equal(await requirementCount(created.id), 1);
});

test('stale and foreign atomic requirement writes leave no orphan version', async () => {
  const stale = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'stale clarification write',
    taskType: null,
    structuredTask: {},
    state: 'awaiting_clarification',
  });
  await assert.rejects(() => repository.createAndActivateRequirementVersion({
    taskId: stale.id,
    ownerUserId: ownerId,
    expectedVersion: stale.stateVersion + 1,
    rawInputHash: 'sha256:stale',
    clarification: {},
    structuredTask: taskShape('stale'),
  }), ControlPlaneConflictError);
  assert.equal(await requirementCount(stale.id), 0);

  const connection = await scopedDatabase.connect();
  let foreignOwnerId = '';
  let splitConversationId = '';
  try {
    const foreignOwner = await connection.query(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, 'foreign requirement owner', 'x', 'member') RETURNING id`,
      [`foreign-requirement-${Date.now()}@test.local`],
    );
    foreignOwnerId = String(foreignOwner.rows[0]?.id);
    const splitConversation = await connection.query(
      `INSERT INTO conversations (owner_user_id, title) VALUES ($1, 'split owner') RETURNING id`,
      [ownerId],
    );
    splitConversationId = String(splitConversation.rows[0]?.id);
  } finally {
    connection.release();
  }
  const foreignActorTask = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'foreign actor clarification write',
    taskType: null,
    structuredTask: {},
    state: 'awaiting_clarification',
  });
  await assert.rejects(() => repository.createAndActivateRequirementVersion({
    taskId: foreignActorTask.id,
    ownerUserId: foreignOwnerId,
    expectedVersion: foreignActorTask.stateVersion,
    rawInputHash: 'sha256:foreign-actor',
    clarification: {},
    structuredTask: taskShape('foreign-actor'),
  }), ControlPlaneAuthorizationError);
  assert.equal(await requirementCount(foreignActorTask.id), 0);

  const splitOwnerTask = await repository.createTask({
    conversationId: splitConversationId,
    ownerUserId: ownerId,
    originalInput: 'conversation owner changed',
    taskType: null,
    structuredTask: {},
    state: 'awaiting_clarification',
  });
  const ownerChange = await scopedDatabase.connect();
  try {
    await ownerChange.query(
      'UPDATE conversations SET owner_user_id = $2 WHERE id = $1',
      [splitConversationId, foreignOwnerId],
    );
  } finally {
    ownerChange.release();
  }
  await assert.rejects(() => repository.createAndActivateRequirementVersion({
    taskId: splitOwnerTask.id,
    ownerUserId: ownerId,
    expectedVersion: splitOwnerTask.stateVersion,
    rawInputHash: 'sha256:split-owner',
    clarification: {},
    structuredTask: taskShape('split-owner'),
  }), ControlPlaneAuthorizationError);
  assert.equal(await requirementCount(splitOwnerTask.id), 0);
});

after(async () => {
  await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await database.end();
});

test('creates requirement versions, activates them with CAS, and reads the active version', async () => {
  const v1 = await repository.createRequirementVersion({
    taskId,
    version: 1,
    rawInputHash: 'sha256:raw-v1',
    clarification: { answers: {} },
    structuredTask: taskShape('v1'),
  });
  assert.equal(v1.taskId, taskId);
  assert.equal(v1.version, 1);
  assert.equal(v1.modelCallId, null);

  const v2 = await repository.createRequirementVersion({
    taskId,
    version: 2,
    rawInputHash: 'sha256:raw-v2',
    clarification: { answers: { audience: '宠物主' } },
    structuredTask: taskShape('v2'),
    modelCallId: null,
  });
  assert.equal(v2.version, 2);
  assert.equal(await repository.getActiveRequirementVersion(taskId), null);

  const activatedV1 = await repository.activateRequirementVersion({
    taskId,
    requirementVersionId: v1.id,
    expectedVersion: 0,
    ownerUserId: ownerId,
  });
  assert.equal(activatedV1.activeRequirementVersionId, v1.id);
  assert.equal(activatedV1.stateVersion, 1);
  assert.deepEqual(await repository.getActiveRequirementVersion(taskId), v1);

  await assert.rejects(
    () => repository.activateRequirementVersion({
      taskId,
      requirementVersionId: v2.id,
      expectedVersion: 0,
      ownerUserId: ownerId,
    }),
    ControlPlaneConflictError,
  );

  const activatedV2 = await repository.activateRequirementVersion({
    taskId,
    requirementVersionId: v2.id,
    expectedVersion: 1,
    ownerUserId: ownerId,
  });
  assert.equal(activatedV2.activeRequirementVersionId, v2.id);
  assert.equal(activatedV2.stateVersion, 2);
  assert.deepEqual(await repository.getActiveRequirementVersion(taskId), v2);
});

test('enforces requirement version uniqueness and rejects a version bound to another task', async () => {
  await assert.rejects(
    () => repository.createRequirementVersion({
      taskId,
      version: 1,
      rawInputHash: 'sha256:duplicate',
      clarification: {},
      structuredTask: taskShape('duplicate'),
    }),
    /duplicate|unique/i,
  );

  const foreignVersion = await repository.createRequirementVersion({
    taskId: secondTaskId,
    version: 1,
    rawInputHash: 'sha256:foreign',
    clarification: {},
    structuredTask: taskShape('foreign'),
  });
  await assert.rejects(
    () => repository.activateRequirementVersion({
      taskId,
      requirementVersionId: foreignVersion.id,
      expectedVersion: 2,
      ownerUserId: ownerId,
    }),
    ControlPlaneConflictError,
  );
});

test('rejects requirement writes for a non-existent task', async () => {
  await assert.rejects(
    () => repository.createRequirementVersion({
      taskId: randomUUID(),
      version: 1,
      rawInputHash: 'sha256:missing-task',
      clarification: {},
      structuredTask: taskShape('missing'),
    }),
    /foreign|task|violates|does not exist/i,
  );
});
