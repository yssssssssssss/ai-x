import { createHash, randomUUID } from 'node:crypto';
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
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneRepository,
  canonicalPlanHash,
  type ControlPlanVersionDetail,
  type ControlTask,
} from '../database/control-plane.ts';
import type { ControlPlanCandidatesResponse } from '../packages/api-contract/control-workflow.ts';
import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
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
  persistExistingTaskWithCandidates(input: {
    taskId: string;
    conversationId: string;
    ownerUserId: string;
    expectedStateVersion: number;
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
  persistClarificationCandidatesAndCompleteCommand(
    input: AtomicClarificationInput,
  ): Promise<ControlPlanCandidatesResponse>;
};

interface AtomicClarificationInput {
  taskId: string;
  conversationId: string;
  ownerUserId: string;
  expectedStateVersion: number;
  taskType: string;
  structuredTask: ResearchTaskV2;
  activatedNodes: string[];
  candidates: Array<{
    candidateId: 'depth' | 'speed';
    title: string;
    rationale: string;
    tradeoffs: string;
    plan: Record<string, unknown>;
    pendingInputs: unknown[];
  }>;
  command: {
    commandType: 'clarification';
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    reservationToken: string;
    actorUserId: string;
  };
}

function readyRequirement(label: string): ResearchTaskV2 {
  return {
    version: 'research-task-v2',
    task_type: 'competitive_research',
    business_domain: 'atomic clarification',
    research_goal: label,
    target_audience: ['产品团队'],
    scope: ['公开资料'],
    constraints: [],
    success_criteria: [{ id: 'atomic', statement: '候选与命令一起提交' }],
    expected_deliverables: ['研究计划'],
    assumptions: [],
    ambiguities: [],
    clarification_questions: [],
    blocking_issues: [],
    sensitivity: 'public',
    pii_detected: false,
  };
}

function atomicCandidates(label: string): AtomicClarificationInput['candidates'] {
  return existingTaskCandidates(label).map((candidate) => ({
    ...candidate,
    candidateId: candidate.candidateId as 'depth' | 'speed',
    title: `${candidate.candidateId} title`,
    rationale: `${candidate.candidateId} rationale`,
    tradeoffs: `${candidate.candidateId} tradeoffs`,
  }));
}

type LeaseBoundArtifactRepository = ControlPlaneRepository & {
  sealArtifact(input: {
    artifactId: string;
    contentSha256: string;
    byteSize: number;
    taskId: string;
    planVersionId: string;
    attemptId: string;
    leaseOwner: string;
    leaseToken: string;
  }): Promise<{ state: string }>;
};

function existingTaskCandidates(label: string): Array<{
  candidateId: string;
  plan: Record<string, unknown>;
  pendingInputs: unknown[];
}> {
  return [
    {
      candidateId: 'depth',
      plan: { task_id: `provisional-${label}-depth`, deliverable_type: 'research_plan', steps: [{ step_no: 1, step_name: `${label}-depth` }] },
      pendingInputs: [],
    },
    {
      candidateId: 'speed',
      plan: { task_id: `provisional-${label}-speed`, deliverable_type: 'research_plan', steps: [{ step_no: 1, step_name: `${label}-speed` }] },
      pendingInputs: [],
    },
  ];
}

function assertPlanTaskId(plan: unknown, expectedTaskId: string): void {
  assert.ok(plan !== null && typeof plan === 'object' && 'task_id' in plan);
  assert.equal(plan.task_id, expectedTaskId);
}

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

class FailingQueryDatabase implements MigrationDatabase {
  private failed = false;

  constructor(
    private readonly delegate: MigrationDatabase,
    private readonly pattern: RegExp,
  ) {}

  async connect(): Promise<MigrationConnection> {
    const connection = await this.delegate.connect();
    return {
      query: async (sql, values = []) => {
        if (!this.failed && this.pattern.test(sql)) {
          this.failed = true;
          throw new Error('simulated atomic command completion failure');
        }
        return connection.query(sql, values);
      },
      release: () => connection.release(),
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

test('persists a Current task and its depth/speed candidates without activating either plan', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const candidateRepository = repository as unknown as CandidatePersistenceRepository;
  const depthPlan = {
    task_id: 'provisional-depth-task',
    title: 'Depth plan',
    steps: [{ step_no: 1, step_name: 'deep research' }],
  };
  const speedPlan = {
    task_id: 'provisional-speed-task',
    title: 'Speed plan',
    steps: [{ step_no: 1, step_name: 'fast research' }],
  };

  const created = await candidateRepository.createTaskWithCandidates({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'Current planning persistence',
    taskType: 'competitive_research',
    structuredTask: { research_goal: 'persist server candidates' },
    candidates: [
      {
        candidateId: 'depth',
        plan: depthPlan,
        pendingInputs: [{ role: 'brief' }],
      },
      {
        candidateId: 'speed',
        plan: speedPlan,
        pendingInputs: [],
      },
    ],
  });

  assert.equal(created.task.state, 'awaiting_selection');
  assert.equal(created.task.activePlanVersionId, null);
  assert.deepEqual(
    created.candidates.map((candidate) => ({
      taskId: candidate.taskId,
      version: candidate.version,
      candidateId: candidate.candidateId,
    })),
    [
      {
        taskId: created.task.id,
        version: 1,
        candidateId: 'depth',
      },
      {
        taskId: created.task.id,
        version: 2,
        candidateId: 'speed',
      },
    ],
  );
  const depthCandidate = created.candidates[0]!;
  const speedCandidate = created.candidates[1]!;
  assertPlanTaskId(depthCandidate.plan, created.task.id);
  assertPlanTaskId(speedCandidate.plan, created.task.id);
  assert.match(depthCandidate.planHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(speedCandidate.planHash, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(depthCandidate.planHash, speedCandidate.planHash);

  const persistedDepth = await repository.getPlanVersionDetail(depthCandidate.id);
  const persistedSpeed = await repository.getPlanVersionDetail(speedCandidate.id);
  assert.ok(persistedDepth);
  assert.ok(persistedSpeed);
  assertPlanTaskId(persistedDepth.plan, created.task.id);
  assertPlanTaskId(persistedSpeed.plan, created.task.id);
  assert.deepEqual(persistedDepth, depthCandidate);
  assert.deepEqual(persistedSpeed, speedCandidate);
});

test('persists clarified depth/speed plans on the same task and advances selection state atomically', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const candidateRepository = repository as unknown as CandidatePersistenceRepository;
  const created = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: '待澄清的原始需求',
    taskType: null,
    structuredTask: {},
    state: 'awaiting_clarification',
  });
  const before = await scopedDatabase.connect();
  let taskCountBefore = 0;
  try {
    const result = await before.query('SELECT count(*) AS count FROM control_tasks');
    taskCountBefore = Number(result.rows[0]?.count);
  } finally {
    before.release();
  }

  const persisted = await candidateRepository.persistExistingTaskWithCandidates({
    taskId: created.id,
    conversationId,
    ownerUserId: ownerId,
    expectedStateVersion: created.stateVersion,
    taskType: 'competitive_research',
    structuredTask: { task_type: 'competitive_research', research_goal: '澄清后目标' },
    candidates: existingTaskCandidates('same-task'),
  });

  assert.equal(persisted.task.id, created.id);
  assert.equal(persisted.task.state, 'awaiting_selection');
  assert.equal(persisted.task.stateVersion, created.stateVersion + 1);
  assert.deepEqual(persisted.candidates.map((candidate) => ({
    taskId: candidate.taskId,
    version: candidate.version,
    candidateId: candidate.candidateId,
  })), [
    { taskId: created.id, version: 1, candidateId: 'depth' },
    { taskId: created.id, version: 2, candidateId: 'speed' },
  ]);
  for (const candidate of persisted.candidates) {
    assertPlanTaskId(candidate.plan, created.id);
    assert.match(candidate.planHash, /^sha256:[0-9a-f]{64}$/);
  }
  const after = await scopedDatabase.connect();
  try {
    const result = await after.query('SELECT count(*) AS count FROM control_tasks');
    assert.equal(Number(result.rows[0]?.count), taskCountBefore);
  } finally {
    after.release();
  }
  const detail = await repository.getTaskDetail(created.id);
  assert.equal(detail?.state, 'awaiting_selection');
  assert.equal(detail?.stateVersion, created.stateVersion + 1);
  assert.deepEqual(detail?.structuredTask, { task_type: 'competitive_research', research_goal: '澄清后目标' });
});

test('fails closed for missing, foreign-owner, and stale existing-task planning requests', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const candidateRepository = repository as unknown as CandidatePersistenceRepository;
  const input = (taskId: string, expectedStateVersion: number, actor = ownerId) => ({
    taskId,
    conversationId,
    ownerUserId: actor,
    expectedStateVersion,
    taskType: 'competitive_research',
    structuredTask: { task_type: 'competitive_research', research_goal: 'must be accepted only once' },
    candidates: existingTaskCandidates(`reject-${taskId}`),
  });

  await assert.rejects(
    () => candidateRepository.persistExistingTaskWithCandidates(input(randomUUID(), 0)),
    ControlPlaneConflictError,
  );

  const foreignTask = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'foreign actor task',
    taskType: null,
    structuredTask: {},
    state: 'awaiting_clarification',
  });
  await assert.rejects(
    () => candidateRepository.persistExistingTaskWithCandidates(input(foreignTask.id, foreignTask.stateVersion, 'foreign-owner')),
    ControlPlaneAuthorizationError,
  );

  const staleTask = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'stale task',
    taskType: null,
    structuredTask: {},
    state: 'awaiting_clarification',
  });
  await assert.rejects(
    () => candidateRepository.persistExistingTaskWithCandidates(input(staleTask.id, staleTask.stateVersion + 1)),
    ControlPlaneConflictError,
  );
  const detail = await repository.getTaskDetail(staleTask.id);
  assert.equal(detail?.state, 'awaiting_clarification');
  assert.equal(detail?.stateVersion, staleTask.stateVersion);
});

test('atomically fences a reclaimed clarification token and lets only the winner create candidates', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const atomicRepository = repository as CandidatePersistenceRepository;
  const created = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'atomic reclaimed clarification',
    taskType: null,
    structuredTask: {},
    state: 'awaiting_clarification',
  });
  const key = `atomic-reclaim-${randomUUID()}`;
  const requestHash = `sha256:${'b'.repeat(64)}`;
  const command = {
    taskId: created.id,
    commandType: 'clarification' as const,
    idempotencyKey: key,
    requestHash,
    expectedVersion: created.stateVersion,
    actorUserId: ownerId,
  };
  const first = await repository.reserveCommand(command);
  assert.equal(first.status, 'reserved');
  const structuredTask = readyRequirement('atomic reclaimed clarification');
  const activated = await repository.createAndActivateRequirementVersion({
    taskId: created.id,
    ownerUserId: ownerId,
    expectedVersion: created.stateVersion,
    rawInputHash: requestHash,
    clarification: { audience: '产品团队' },
    structuredTask,
  });
  await repository.recoverCommandAfterFailure({
    ...command,
    reservationToken: first.reservationToken!,
  });
  const reclaimed = await repository.reserveCommand(command);
  assert.equal(reclaimed.status, 'reserved');
  assert.notEqual(reclaimed.reservationToken, first.reservationToken);
  const baseInput = {
    taskId: created.id,
    conversationId,
    ownerUserId: ownerId,
    expectedStateVersion: activated.task.stateVersion,
    taskType: structuredTask.task_type,
    structuredTask,
    activatedNodes: ['D5_competitive'],
    candidates: atomicCandidates('atomic-reclaim'),
  };

  await assert.rejects(
    () => atomicRepository.persistClarificationCandidatesAndCompleteCommand({
      ...baseInput,
      command: { ...command, reservationToken: first.reservationToken! },
    }),
    /reservation|fence|lost/i,
  );
  assert.equal((await repository.getTaskDetail(created.id))?.state, 'awaiting_clarification');
  assert.equal(await repository.nextPlanVersion(created.id), 1);

  const response = await atomicRepository.persistClarificationCandidatesAndCompleteCommand({
    ...baseInput,
    command: { ...command, reservationToken: reclaimed.reservationToken! },
  });
  assert.equal(response.task.state, 'awaiting_selection');
  assert.deepEqual(response.candidates.map((candidate) => candidate.candidateId), ['depth', 'speed']);
  assert.deepEqual((await repository.getCommand(created.id, 'clarification', key))?.response, response);
  assert.equal(await repository.nextPlanVersion(created.id), 3);
});

test('rolls back plans, task transition, and command completion when the atomic transaction fails', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const created = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'atomic transaction rollback',
    taskType: null,
    structuredTask: {},
    state: 'awaiting_clarification',
  });
  const command = {
    taskId: created.id,
    commandType: 'clarification' as const,
    idempotencyKey: `atomic-rollback-${randomUUID()}`,
    requestHash: `sha256:${'c'.repeat(64)}`,
    expectedVersion: created.stateVersion,
    actorUserId: ownerId,
  };
  const reservation = await repository.reserveCommand(command);
  assert.equal(reservation.status, 'reserved');
  const structuredTask = readyRequirement('atomic transaction rollback');
  const activated = await repository.createAndActivateRequirementVersion({
    taskId: created.id,
    ownerUserId: ownerId,
    expectedVersion: created.stateVersion,
    rawInputHash: command.requestHash,
    clarification: {},
    structuredTask,
  });
  const failingRepository = new ControlPlaneRepository(
    new FailingQueryDatabase(scopedDatabase, /UPDATE control_commands/u),
  ) as CandidatePersistenceRepository;

  await assert.rejects(
    () => failingRepository.persistClarificationCandidatesAndCompleteCommand({
      taskId: created.id,
      conversationId,
      ownerUserId: ownerId,
      expectedStateVersion: activated.task.stateVersion,
      taskType: structuredTask.task_type,
      structuredTask,
      activatedNodes: ['D5_competitive'],
      candidates: atomicCandidates('atomic-rollback'),
      command: { ...command, reservationToken: reservation.reservationToken! },
    }),
    /simulated atomic command completion failure/,
  );
  assert.equal((await repository.getTaskDetail(created.id))?.state, 'awaiting_clarification');
  assert.equal(await repository.nextPlanVersion(created.id), 1);
  assert.equal((await repository.getCommand(created.id, 'clarification', command.idempotencyKey))?.response, null);
});

test('hashes semantically identical plans independently of object key insertion order', () => {
  const taskId = randomUUID();
  const depthHash = canonicalPlanHash({
    task_id: taskId,
    title: 'Canonical plan',
    steps: [{ step_no: 1, step_name: 'research' }],
  });
  const speedHash = canonicalPlanHash({
    steps: [{ step_name: 'research', step_no: 1 }],
    title: 'Canonical plan',
    task_id: taskId,
  });

  assert.match(depthHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(speedHash, depthHash);
});

test('atomically rejects duplicate canonical candidate plans', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const candidateRepository = repository as unknown as CandidatePersistenceRepository;
  const connection = await scopedDatabase.connect();
  const before = await connection.query(
    `SELECT (SELECT count(*) FROM control_tasks) AS tasks,
            (SELECT count(*) FROM control_plan_versions) AS plans`,
  );
  connection.release();

  await assert.rejects(
    () => candidateRepository.createTaskWithCandidates({
      conversationId,
      ownerUserId: ownerId,
      originalInput: 'Reject duplicate canonical candidates',
      taskType: 'competitive_research',
      structuredTask: { research_goal: 'stable plan hashes' },
      candidates: [
        {
          candidateId: 'depth',
          plan: {
            task_id: 'provisional-canonical-depth',
            title: 'Canonical plan',
            steps: [{ step_no: 1, step_name: 'research' }],
          },
          pendingInputs: [],
        },
        {
          candidateId: 'speed',
          plan: {
            steps: [{ step_name: 'research', step_no: 1 }],
            title: 'Canonical plan',
            task_id: 'provisional-canonical-speed',
          },
          pendingInputs: [],
        },
      ],
    }),
    ControlPlaneConflictError,
  );

  const verificationConnection = await scopedDatabase.connect();
  try {
    const after = await verificationConnection.query(
      `SELECT (SELECT count(*) FROM control_tasks) AS tasks,
              (SELECT count(*) FROM control_plan_versions) AS plans`,
    );
    assert.deepEqual(after.rows[0], before.rows[0]);
  } finally {
    verificationConnection.release();
  }
});

test('atomically rejects duplicate candidate IDs even when plans differ', async () => {
  const candidateRepository = new ControlPlaneRepository(scopedDatabase) as unknown as CandidatePersistenceRepository;
  const connection = await scopedDatabase.connect();
  const before = await connection.query(
    `SELECT (SELECT count(*) FROM control_tasks) AS tasks,
            (SELECT count(*) FROM control_plan_versions) AS plans`,
  );
  connection.release();

  await assert.rejects(
    () => candidateRepository.createTaskWithCandidates({
      conversationId,
      ownerUserId: ownerId,
      originalInput: 'Reject duplicate candidate IDs',
      taskType: 'competitive_research',
      structuredTask: { research_goal: 'distinct candidate IDs' },
      candidates: [
        {
          candidateId: 'depth',
          plan: { task_id: 'provisional-depth-a', steps: [{ step_no: 1, step_name: 'first' }] },
          pendingInputs: [],
        },
        {
          candidateId: 'depth',
          plan: { task_id: 'provisional-depth-b', steps: [{ step_no: 1, step_name: 'second' }] },
          pendingInputs: [],
        },
      ],
    }),
    ControlPlaneConflictError,
  );

  const verificationConnection = await scopedDatabase.connect();
  try {
    const after = await verificationConnection.query(
      `SELECT (SELECT count(*) FROM control_tasks) AS tasks,
              (SELECT count(*) FROM control_plan_versions) AS plans`,
    );
    assert.deepEqual(after.rows[0], before.rows[0]);
  } finally {
    verificationConnection.release();
  }
});

test('atomically rejects candidate persistence when the conversation belongs to another owner', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const candidateRepository = repository as unknown as CandidatePersistenceRepository;
  const connection = await scopedDatabase.connect();
  let foreignConversationId = '';
  let countsBefore: Record<string, unknown> = {};
  try {
    const foreignOwner = await connection.query(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, 'foreign owner', 'x', 'member')
       RETURNING id`,
      [`control-foreign-${randomUUID()}@test.local`],
    );
    const foreignConversation = await connection.query(
      `INSERT INTO conversations (owner_user_id, title)
       VALUES ($1, 'foreign control conversation')
       RETURNING id`,
      [String(foreignOwner.rows[0]?.id)],
    );
    foreignConversationId = String(foreignConversation.rows[0]?.id);
    const counts = await connection.query(
      `SELECT (SELECT count(*) FROM control_tasks) AS tasks,
              (SELECT count(*) FROM control_plan_versions) AS plans`,
    );
    countsBefore = counts.rows[0] ?? {};
  } finally {
    connection.release();
  }

  await assert.rejects(
    () => candidateRepository.createTaskWithCandidates({
      conversationId: foreignConversationId,
      ownerUserId: ownerId,
      originalInput: 'must roll back',
      taskType: 'competitive_research',
      structuredTask: { research_goal: 'reject foreign conversation' },
      candidates: [
        {
          candidateId: 'depth',
          plan: { task_id: 'provisional-foreign-depth', steps: [] },
          pendingInputs: [],
        },
        {
          candidateId: 'speed',
          plan: { task_id: 'provisional-foreign-speed', steps: [] },
          pendingInputs: [],
        },
      ],
    }),
    ControlPlaneConflictError,
  );

  const verificationConnection = await scopedDatabase.connect();
  try {
    const countsAfter = await verificationConnection.query(
      `SELECT (SELECT count(*) FROM control_tasks) AS tasks,
              (SELECT count(*) FROM control_plan_versions) AS plans`,
    );
    assert.deepEqual(countsAfter.rows[0], countsBefore);
  } finally {
    verificationConnection.release();
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
  const verifiedStore = store as unknown as {
    readVerifiedJson<T>(artifactId: string): Promise<{ artifact: { id: string }; value: T }>;
  };
  const contextValue = { task: task.id };

  const sealed = await store.writeJson({
    taskId: task.id,
    planVersionId: plan.id,
    attemptId: claim.attemptId,
    kind: 'context_manifest',
    relativePath: 'context/context-manifest.json',
    value: contextValue,
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
  const verified = await verifiedStore.readVerifiedJson<typeof contextValue>(sealed.id);
  assert.equal(verified.artifact.id, sealed.id);
  assert.deepEqual(verified.value, contextValue);

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
  await assert.rejects(
    () => verifiedStore.readVerifiedJson(staged.id),
    ArtifactNotSealedError,
  );
  await assert.rejects(() => repository.requireSealedArtifact(staged.id), ArtifactNotSealedError);
  await store.reconcileStaging();
  assert.equal((await repository.getArtifact(staged.id))?.state, 'FAILED');
  await assert.rejects(
    () => verifiedStore.readVerifiedJson(staged.id),
    ArtifactNotSealedError,
  );

  writeFileSync(sealed.storageUri, '{"tampered":true}');
  await assert.rejects(
    () => verifiedStore.readVerifiedJson(sealed.id),
    ArtifactIntegrityError,
  );
  await assert.rejects(() => store.verifySealed(sealed.id), ArtifactIntegrityError);
});

test('atomically refuses to seal a terminal artifact after its execution lease expires', async () => {
  const repository = new ControlPlaneRepository(scopedDatabase);
  const task = await repository.createTask({
    conversationId,
    ownerUserId: ownerId,
    originalInput: 'terminal artifact lease 测试',
    taskType: 'competitive_research',
    structuredTask: { research_goal: '验证 terminal artifact lease' },
    state: 'ready',
  });
  const plan = await repository.createPlanVersion({
    taskId: task.id,
    version: 1,
    plan: { steps: [] },
    planHash: `sha256:${randomUUID()}`,
  });
  const leaseToken = randomUUID();
  const leaseOwner = 'terminal-artifact-worker';
  const claim = await repository.claimExecution({
    taskId: task.id,
    planVersionId: plan.id,
    expectedVersion: task.stateVersion,
    idempotencyKey: randomUUID(),
    requestHash: `sha256:${randomUUID()}`,
    leaseOwner,
    leaseTokenHash: `sha256:${createHash('sha256').update(leaseToken).digest('hex')}`,
    leaseExpiresAt: new Date(Date.now() - 1_000),
  });
  const staged = await repository.createStagingArtifact({
    taskId: task.id,
    planVersionId: plan.id,
    attemptId: claim.attemptId,
    kind: 'deliverable',
    storageUri: join(workspaceRoot, `${claim.attemptId}-terminal.json`),
    schemaVersion: 'research-deliverable-v1',
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
  });
  await repository.expireExecutionLease({ taskId: task.id, attemptId: claim.attemptId });

  const leaseBound = repository as LeaseBoundArtifactRepository;
  await assert.rejects(
    () => leaseBound.sealArtifact({
      artifactId: staged.id,
      contentSha256: `sha256:${'a'.repeat(64)}`,
      byteSize: 2,
      taskId: task.id,
      planVersionId: plan.id,
      attemptId: claim.attemptId,
      leaseOwner,
      leaseToken,
    }),
    ControlPlaneConflictError,
  );
  assert.equal((await repository.getArtifact(staged.id))?.state, 'FAILED');
  assert.equal((await repository.getTaskDetail(task.id))?.state, 'paused');
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
