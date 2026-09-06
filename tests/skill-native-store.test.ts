import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { runMigrations, type MigrationConnection, type MigrationDatabase } from '../database/migration-runner.ts';
import type {
  ExecutionPlan,
  RequirementBrief,
  SkillNativeCandidate,
  SkillNativeExecutionState,
  SkillPackageDescriptor,
  SkillPackageSnapshot,
} from '../packages/api-contract/skill-native.ts';
import {
  PostgresSkillNativeTaskStore,
  SkillNativeStoreError,
} from '../apps/orchestrator-runtime/src/skill-native/store.ts';

class ScopedDatabase implements MigrationDatabase {
  constructor(private readonly database: Pool, private readonly schema: string) {}
  async connect(): Promise<MigrationConnection> {
    const client = await this.database.connect();
    await client.query(`SET search_path TO "${this.schema}", public`);
    return {
      async query(sql, values = []) {
        const result = await client.query(sql, [...values]);
        return { rows: result.rows };
      },
      release() { client.release(); },
    };
  }
}

class QueryHookDatabase implements MigrationDatabase {
  constructor(
    private readonly database: MigrationDatabase,
    private readonly beforeQuery: (sql: string) => Promise<void>,
  ) {}

  async connect(): Promise<MigrationConnection> {
    const connection = await this.database.connect();
    return {
      query: async (sql, values = []) => {
        await this.beforeQuery(sql);
        return connection.query(sql, values);
      },
      release: () => connection.release(),
    };
  }
}

const schema = `skill_native_${randomUUID().replaceAll('-', '')}`;
const database = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/user_research_ai_skill_native',
});
const scoped = new ScopedDatabase(database, schema);
const store = new PostgresSkillNativeTaskStore(scoped);
let ownerId = '';
let otherOwnerId = '';

async function query(sql: string, values: readonly unknown[] = []) {
  const connection = await scoped.connect();
  try {
    return await connection.query(sql, values);
  } finally {
    connection.release();
  }
}

before(async () => {
  await database.query(`CREATE SCHEMA "${schema}"`);
  const migration = await runMigrations({
    database: scoped,
    migrationsDir: join(process.cwd(), 'database', 'migrations'),
    lockKey: 761_832_018,
  });
  assert.ok(migration.applied.includes('018_unmodified_skill_runtime.sql'));
  ownerId = randomUUID();
  otherOwnerId = randomUUID();
  await query(
    `INSERT INTO users (id, email, display_name, password_hash, role)
     VALUES ($1, $2, 'Owner', 'x', 'member'), ($3, $4, 'Other', 'x', 'member')`,
    [ownerId, `native-owner-${ownerId}@test.local`, otherOwnerId, `native-other-${otherOwnerId}@test.local`],
  );
});

after(async () => {
  await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await database.end();
});

test('breaking migration removes obsolete material storage and Artifact input metadata', async () => {
  const tables = await query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = 'skill_native_materials'`,
  );
  assert.deepEqual(tables.rows, []);
  const columns = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'skill_native_artifacts'
       AND column_name IN ('input_id', 'material_label')`,
  );
  assert.deepEqual(columns.rows, []);
});

test('task creation rejects an Artifact outside the task ownership scope', async () => {
  const taskId = randomUUID();
  const bytes = Buffer.from('foreign');
  await assert.rejects(store.create({
    id: taskId,
    ownerUserId: ownerId,
    projectId: 'project-scope',
    originalInput: 'Reject foreign Artifact',
    orchestrationMode: 'single_skill',
    requirement,
    candidates: [candidate],
    artifacts: [{
      id: randomUUID(),
      taskId,
      ownerUserId: otherOwnerId,
      projectId: 'project-scope',
      relativePath: 'uploads/foreign.txt',
      fileName: 'foreign.txt',
      mediaType: 'text/plain',
      role: 'working',
      bytes,
      contentSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      sourceArtifactIds: [],
    }],
  }), /Artifact scope does not match its task/u);
  assert.equal(await store.getOwned(taskId, ownerId), null);
});

const descriptor: SkillPackageDescriptor = {
  id: 'test-skill',
  name: 'Test Skill',
  description: 'Test persistence',
  sourcePath: 'test-skill',
  packageHash: `sha256:${'1'.repeat(64)}`,
  fileCount: 1,
  byteSize: 20,
  frontmatter: { name: 'Test Skill', description: 'Test persistence' },
};

function snapshot(taskId: string): SkillPackageSnapshot {
  return {
    version: 'skill-package-snapshot-v1',
    package: descriptor,
    packageHash: descriptor.packageHash,
    files: [{ path: 'SKILL.md', byteSize: 20, contentSha256: `sha256:${'2'.repeat(64)}`, executable: false }],
    directories: [],
    snapshotPath: `${taskId}/packages/test-skill`,
    createdAt: new Date().toISOString(),
  };
}

const candidate: SkillNativeCandidate = {
  id: 'single-test-skill',
  title: 'Test Skill',
  description: 'Test persistence',
  rationale: 'Test',
  tradeoffs: 'None',
  mode: 'single_skill',
  recommended: true,
  packages: [descriptor],
  finalReport: { kind: 'skill', packageId: 'test-skill' },
};

const requirement: RequirementBrief = {
  version: 'requirement-brief-v1',
  goal: 'Test persistence',
  desiredOutputs: ['Persisted result'],
  scope: ['Test fixture'],
  constraints: [],
  assumptions: [],
  openQuestions: [],
};

function plan(taskId: string): ExecutionPlan {
  return {
    version: 'skill-native-plan-v2',
    taskId,
    candidateId: candidate.id,
    title: candidate.title,
    rationale: candidate.rationale,
    tradeoffs: candidate.tradeoffs,
    mode: 'single_skill',
    requirement: {
      version: 'requirement-context-v2',
      goal: 'Test persistence',
      desiredOutputs: ['Persisted result'],
      scope: ['Test fixture'],
      constraints: [],
      materials: [{
        id: 'conversation:task-request',
        label: 'task-request',
        source: 'conversation',
        value: 'Test persistence',
        artifactIds: [],
      }],
      assumptions: [],
      openQuestions: [],
    },
    invocations: [{ id: 'invocation-1', package: snapshot(taskId), dependsOn: [] }],
    finalReport: { kind: 'skill', invocationId: 'invocation-1' },
  };
}

test('Postgres store persists package plans, checkpoints, dynamic questions, generic Artifacts, and outcomes', async () => {
  const taskId = randomUUID();
  const created = await store.create({
    id: taskId,
    ownerUserId: ownerId,
    projectId: 'project-a',
    originalInput: 'Test persistence',
    orchestrationMode: 'single_skill',
    requirement,
    candidates: [candidate],
    materials: [{
      id: 'conversation:task-request', label: 'task-request', source: 'conversation',
      value: 'Test persistence', artifactIds: [],
    }],
  });
  assert.equal(created.state, 'awaiting_selection');
  assert.equal(await store.getOwned(taskId, otherOwnerId), null);

  const selected = await store.select({
    taskId, ownerUserId: ownerId, expectedVersion: created.stateVersion, candidateId: candidate.id,
  });
  assert.equal(selected.selectedCandidateId, candidate.id);
  assert.equal(selected.state, 'awaiting_confirmation');

  const confirmed = await store.confirm({
    taskId,
    ownerUserId: ownerId,
    expectedVersion: selected.stateVersion,
    plan: plan(taskId),
    materials: selected.materials,
  });
  assert.equal(confirmed.state, 'ready');
  assert.equal(confirmed.plan?.version, 'skill-native-plan-v2');

  const firstAttempt = randomUUID();
  const executing = await store.beginExecution({
    taskId, ownerUserId: ownerId, expectedVersion: confirmed.stateVersion,
    attemptId: firstAttempt, from: 'ready', materials: confirmed.materials,
  });
  const waitingExecution: SkillNativeExecutionState = {
    steps: [{ invocationId: 'invocation-1', skillId: 'test-skill', state: 'waiting_for_user', turn: 1 }],
    checkpoint: {
      invocationIndex: 0,
      invocationId: 'invocation-1',
      turn: 1,
      toolCalls: 0,
      stateSummary: 'Need audience',
      pendingQuestions: [{ id: 'audience', prompt: 'Who?', required: true, answerType: 'text' }],
      answers: {},
    },
    externalKnowledge: [],
  };
  assert.equal(await store.saveExecution({
    taskId, ownerUserId: ownerId, attemptId: firstAttempt, execution: waitingExecution,
  }), true);
  const waiting = await store.waitForUser({
    taskId, ownerUserId: ownerId, attemptId: firstAttempt, execution: waitingExecution, warnings: [],
  });
  assert.equal(waiting?.state, 'waiting_for_user');
  assert.equal(waiting?.execution.checkpoint?.pendingQuestions[0]?.id, 'audience');

  const secondAttempt = randomUUID();
  const resumed = await store.beginExecution({
    taskId,
    ownerUserId: ownerId,
    expectedVersion: waiting!.stateVersion,
    attemptId: secondAttempt,
    from: 'waiting_for_user',
    materials: [...waiting!.materials, {
      id: 'conversation:audience', label: 'audience', source: 'conversation', value: 'Executives', artifactIds: [],
    }],
  });
  assert.equal(resumed.state, 'executing');

  const bytes = Buffer.from('# Result');
  const artifactId = randomUUID();
  await store.writeArtifact({
    id: artifactId,
    taskId,
    ownerUserId: ownerId,
    projectId: 'project-a',
    invocationId: 'invocation-1',
    relativePath: 'outputs/result.md',
    fileName: 'result.md',
    mediaType: 'text/markdown',
    role: 'report',
    bytes,
    contentSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    sourceArtifactIds: [],
  }, secondAttempt);
  const completeExecution: SkillNativeExecutionState = {
    steps: [{
      invocationId: 'invocation-1',
      skillId: 'test-skill',
      state: 'succeeded',
      turn: 2,
      outcome: {
        status: 'complete', summary: 'Done', primaryArtifactId: artifactId,
        artifactIds: [artifactId], gaps: [], missingCapabilities: [],
      },
    }],
    checkpoint: null,
    externalKnowledge: [],
  };
  const finished = await store.finishExecution({
    taskId,
    ownerUserId: ownerId,
    attemptId: secondAttempt,
    state: 'completed',
    execution: completeExecution,
    result: completeExecution.steps[0]!.outcome!,
    warnings: [],
    failure: null,
  });
  assert.equal(finished?.state, 'completed');
  assert.equal(finished?.materials.every(({ value }) => value === null), true);
  assert.equal(finished?.artifacts[0]?.mediaType, 'text/markdown');
  assert.equal((await store.getArtifactOwned({
    artifactId, taskId, ownerUserId: ownerId, projectId: 'project-a',
  }))?.bytes.toString(), '# Result');

  await assert.rejects(
    store.select({ taskId, ownerUserId: ownerId, expectedVersion: created.stateVersion, candidateId: candidate.id }),
    (error: unknown) => error instanceof SkillNativeStoreError && error.code === 'conflict',
  );
});

test('cancelling an execution prevents a late Artifact write bound to its attempt', async () => {
  const taskId = randomUUID();
  const created = await store.create({
    id: taskId,
    ownerUserId: ownerId,
    projectId: 'project-b',
    originalInput: 'Cancel me',
    orchestrationMode: 'single_skill',
    requirement,
    candidates: [candidate],
  });
  const selected = await store.select({
    taskId, ownerUserId: ownerId, expectedVersion: created.stateVersion, candidateId: candidate.id,
  });
  const confirmed = await store.confirm({
    taskId, ownerUserId: ownerId, expectedVersion: selected.stateVersion, plan: plan(taskId), materials: [],
  });
  const attemptId = randomUUID();
  const executing = await store.beginExecution({
    taskId, ownerUserId: ownerId, expectedVersion: confirmed.stateVersion, attemptId, from: 'ready',
  });
  await store.cancel({ taskId, ownerUserId: ownerId, expectedVersion: executing.stateVersion });
  const bytes = Buffer.from('late');
  await assert.rejects(store.writeArtifact({
    id: randomUUID(), taskId, ownerUserId: ownerId, projectId: 'project-b',
    invocationId: 'invocation-1', relativePath: 'outputs/late.txt', fileName: 'late.txt',
    mediaType: 'text/plain', role: 'output', bytes,
    contentSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    sourceArtifactIds: [],
  }, attemptId), SkillNativeStoreError);
});

test('replanning removes generated Artifacts but retains user uploads', async () => {
  const taskId = randomUUID();
  const uploadBytes = Buffer.from('source');
  const uploadId = randomUUID();
  const created = await store.create({
    id: taskId,
    ownerUserId: ownerId,
    projectId: 'project-replan',
    originalInput: 'Replan me',
    orchestrationMode: 'single_skill',
    requirement,
    candidates: [candidate],
    artifacts: [{
      id: uploadId,
      taskId,
      ownerUserId: ownerId,
      projectId: 'project-replan',
      relativePath: 'uploads/source.txt',
      fileName: 'source.txt',
      mediaType: 'text/plain',
      role: 'working',
      bytes: uploadBytes,
      contentSha256: `sha256:${createHash('sha256').update(uploadBytes).digest('hex')}`,
      sourceArtifactIds: [],
    }],
  });
  const selected = await store.select({
    taskId, ownerUserId: ownerId, expectedVersion: created.stateVersion, candidateId: candidate.id,
  });
  const confirmed = await store.confirm({
    taskId, ownerUserId: ownerId, expectedVersion: selected.stateVersion, plan: plan(taskId), materials: [],
  });
  const attemptId = randomUUID();
  await store.beginExecution({
    taskId, ownerUserId: ownerId, expectedVersion: confirmed.stateVersion, attemptId, from: 'ready',
  });
  const generatedBytes = Buffer.from('generated');
  const generatedId = randomUUID();
  await store.writeArtifact({
    id: generatedId,
    taskId,
    ownerUserId: ownerId,
    projectId: 'project-replan',
    invocationId: 'invocation-1',
    relativePath: 'outputs/generated.txt',
    fileName: 'generated.txt',
    mediaType: 'text/plain',
    role: 'output',
    bytes: generatedBytes,
    contentSha256: `sha256:${createHash('sha256').update(generatedBytes).digest('hex')}`,
    sourceArtifactIds: [uploadId],
  }, attemptId);
  const paused = await store.pauseExecution({
    taskId,
    ownerUserId: ownerId,
    attemptId,
    execution: { steps: [], checkpoint: null, externalKnowledge: [] },
    failure: 'interrupted',
  });
  const replanned = await store.replan({
    taskId,
    ownerUserId: ownerId,
    expectedVersion: paused!.stateVersion,
    requirement,
    candidates: [candidate],
  });

  assert.deepEqual(replanned.artifacts.map(({ id }) => id), [uploadId]);
  assert.equal(await store.getArtifactOwned({
    artifactId: generatedId, taskId, ownerUserId: ownerId, projectId: 'project-replan',
  }), null);
});

test('completion material cleanup cannot overwrite a concurrent replan', async () => {
  const taskId = randomUUID();
  const materials = [{
    id: 'conversation:secret',
    label: 'secret',
    source: 'conversation' as const,
    value: 'raw material',
    artifactIds: [],
  }];
  const created = await store.create({
    id: taskId,
    ownerUserId: ownerId,
    projectId: 'project-race',
    originalInput: 'Race replan',
    orchestrationMode: 'single_skill',
    requirement,
    candidates: [candidate],
    materials,
  });
  const selected = await store.select({
    taskId, ownerUserId: ownerId, expectedVersion: created.stateVersion, candidateId: candidate.id,
  });
  const confirmed = await store.confirm({
    taskId, ownerUserId: ownerId, expectedVersion: selected.stateVersion, plan: plan(taskId), materials,
  });
  const attemptId = randomUUID();
  await store.beginExecution({
    taskId, ownerUserId: ownerId, expectedVersion: confirmed.stateVersion,
    attemptId, from: 'ready', materials,
  });
  let raced = false;
  const racingStore = new PostgresSkillNativeTaskStore(new QueryHookDatabase(scoped, async (sql) => {
    if (raced || !sql.includes('SET materials_json = $3, plan_json = $4')) return;
    raced = true;
    const completed = await store.getOwned(taskId, ownerId);
    assert.equal(completed?.state, 'completed');
    await store.replan({
      taskId,
      ownerUserId: ownerId,
      expectedVersion: completed!.stateVersion,
      requirement,
      candidates: [candidate],
    });
  }));
  const outcome = {
    status: 'complete' as const,
    summary: 'Done',
    artifactIds: [],
    gaps: [],
    missingCapabilities: [],
  };
  const finished = await racingStore.finishExecution({
    taskId,
    ownerUserId: ownerId,
    attemptId,
    state: 'completed',
    execution: {
      steps: [{ invocationId: 'invocation-1', skillId: 'test-skill', state: 'succeeded', turn: 1, outcome }],
      checkpoint: null,
      externalKnowledge: [],
    },
    result: outcome,
    warnings: [],
    failure: null,
  });

  assert.equal(raced, true);
  assert.equal(finished?.state, 'completed');
  assert.equal(finished?.materials[0]?.value, null);
  const persisted = await store.getOwned(taskId, ownerId);
  assert.equal(persisted?.state, 'awaiting_selection');
  assert.equal(persisted?.plan, null);
});
