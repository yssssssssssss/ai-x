import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { runMigrations, type MigrationConnection, type MigrationDatabase } from '../database/migration-runner.ts';
import type {
  ReportResult,
  SkillDefinition,
  SolutionDefinition,
  SolutionPlan,
} from '../packages/api-contract/skill-native.ts';
import {
  PostgresSkillNativeTaskStore,
  SkillNativeStoreError,
  type StoredSkillNativeCandidate,
} from '../apps/orchestrator-runtime/src/skill-native/store.ts';

class ScopedDatabase implements MigrationDatabase {
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

const schema = `skill_native_${randomUUID().replaceAll('-', '')}`;
const database = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/user_research_ai_skill_native',
});
const scoped = new ScopedDatabase(database, schema);
const store = new PostgresSkillNativeTaskStore(scoped);

const skill: SkillDefinition = {
  version: 'skill-definition-v1',
  id: 'test-skill',
  name: 'Test Skill',
  description: 'Test the native store',
  whenToUse: 'During the store roundtrip test',
  inputs: [{
    id: 'research_goal',
    label: '研究目标',
    description: '目标',
    required: true,
    multiple: false,
    acceptedSources: ['conversation', 'database'],
    toolIds: [],
    question: '目标是什么？',
    missingPolicy: 'stop',
  }],
  knowledge: [],
  tools: [],
  report: { title: '测试报告', summaryInstruction: '总结', sections: ['结论'] },
  allowPartial: true,
  body: '# Test Skill',
  sourcePath: 'skills/test/SKILL.md',
  contentHash: `sha256:${'1'.repeat(64)}`,
};

const solution: SolutionDefinition = {
  version: 'solution-definition-v1',
  id: 'test-solution',
  title: '测试方案',
  description: '测试持久化',
  whenToUse: '测试时',
  mode: 'single_skill',
  recommended: true,
  skills: [{ skillId: skill.id, dependsOn: [], failurePolicy: 'stop' }],
  finalReportSkillId: skill.id,
  sourcePath: 'orchestrator/solutions/test.yaml',
  contentHash: `sha256:${'2'.repeat(64)}`,
};

function candidate(materialId: string, value: string): StoredSkillNativeCandidate {
  return {
    solution,
    skills: [skill],
    initialMaterials: [{
      id: materialId,
      inputId: 'research_goal',
      source: 'upload',
      value,
    }],
    resolution: {
      inputs: [{
        inputId: 'research_goal',
        source: 'upload',
        value,
        referenceId: materialId,
        skillIds: [skill.id],
      }],
      questions: [],
      gaps: [],
      blockedInputIds: [],
      warnings: [],
    },
  };
}

function plan(taskId: string, value: string): SolutionPlan {
  return {
    version: 'skill-native-plan-v1',
    taskId,
    solutionId: solution.id,
    title: solution.title,
    rationale: solution.description,
    tradeoffs: solution.whenToUse,
    mode: 'single_skill',
    requirement: {
      version: 'requirement-context-v1',
      goal: value,
      scope: [],
      assumptions: [],
      gaps: [],
      inputs: [{
        inputId: 'research_goal',
        source: 'upload',
        value,
        referenceId: `upload:research_goal:${value}`,
        skillIds: [skill.id],
      }],
    },
    invocations: [{ id: `skill-1-${skill.id}`, skill, dependsOn: [], failurePolicy: 'stop' }],
    finalReportInvocationId: `skill-1-${skill.id}`,
    questions: [],
  };
}

async function query(sql: string, values: readonly unknown[] = []) {
  const connection = await scoped.connect();
  try {
    return await connection.query(sql, values);
  } finally {
    connection.release();
  }
}

let ownerId = '';
let otherOwnerId = '';

before(async () => {
  await database.query(`CREATE SCHEMA "${schema}"`);
  const migration = await runMigrations({
    database: scoped,
    migrationsDir: join(process.cwd(), 'database', 'migrations'),
    lockKey: 761_832_016,
  });
  assert.ok(migration.applied.includes('016_skill_native_delivery.sql'));
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

test('Postgres native store preserves scope, concurrency, attempts, receipts, and reusable inputs', async () => {
  const taskId = randomUUID();
  const projectId = 'project-a';
  const initialMaterial = candidate('upload:initial', 'initial evidence').initialMaterials[0]!;
  const initialBytes = Buffer.from([137, 80, 78, 71]);
  const initialArtifactId = randomUUID();
  const supportArtifactId = randomUUID();
  const unusedArtifactId = randomUUID();
  const imageMaterial = {
    id: 'upload:image',
    inputId: 'design_image',
    source: 'upload' as const,
    value: { name: 'input.png', mediaType: 'image/png', artifactId: initialArtifactId },
  };
  const created = await store.create({
    id: taskId,
    ownerUserId: ownerId,
    projectId,
    originalInput: 'test native task',
    orchestrationMode: 'single_skill',
    candidates: [candidate(initialMaterial.id, String(initialMaterial.value))],
    materials: [initialMaterial, imageMaterial],
    artifacts: [{
      id: initialArtifactId,
      taskId,
      ownerUserId: ownerId,
      projectId,
      inputId: 'research_goal',
      fileName: 'input.png',
      mediaType: 'image/png',
      bytes: initialBytes,
      contentSha256: `sha256:${createHash('sha256').update(initialBytes).digest('hex')}`,
    }, {
      id: supportArtifactId,
      taskId,
      ownerUserId: ownerId,
      projectId,
      inputId: 'support_image',
      fileName: 'support.png',
      mediaType: 'image/png',
      bytes: initialBytes,
      contentSha256: `sha256:${createHash('sha256').update(initialBytes).digest('hex')}`,
    }, {
      id: unusedArtifactId,
      taskId,
      ownerUserId: ownerId,
      projectId,
      inputId: 'unused_image',
      fileName: 'unused.png',
      mediaType: 'image/png',
      bytes: initialBytes,
      contentSha256: `sha256:${createHash('sha256').update(initialBytes).digest('hex')}`,
    }],
  });

  assert.equal(created.stateVersion, 0);
  assert.equal(await store.getOwned(taskId, otherOwnerId), null);
  assert.equal((await store.listOwned(otherOwnerId)).length, 0);
  assert.equal(await store.getArtifactOwned({ artifactId: initialArtifactId, taskId, ownerUserId: otherOwnerId, projectId }), null);
  assert.equal(await store.getArtifactOwned({ artifactId: initialArtifactId, taskId, ownerUserId: ownerId, projectId: 'project-b' }), null);
  assert.deepEqual((await store.getArtifactOwned({ artifactId: initialArtifactId, taskId, ownerUserId: ownerId, projectId }))?.bytes, initialBytes);

  const reusable = await store.listReusableMaterials({ ownerUserId: ownerId, projectId, inputIds: ['research_goal'] });
  assert.deepEqual(reusable.map(({ inputId, value }) => [inputId, value]), [['research_goal', 'initial evidence']]);
  assert.equal((await store.listReusableMaterials({ ownerUserId: ownerId, projectId, inputIds: ['unrelated'] })).length, 0);
  assert.equal((await store.listReusableMaterials({ ownerUserId: ownerId, projectId: 'project-b', inputIds: ['research_goal'] })).length, 0);
  assert.equal((await store.listReusableMaterials({ ownerUserId: otherOwnerId, projectId, inputIds: ['research_goal'] })).length, 0);

  await assert.rejects(
    store.reserveSelection({ taskId, ownerUserId: ownerId, expectedVersion: 1, solutionId: solution.id }),
    (error: unknown) => error instanceof SkillNativeStoreError && error.code === 'conflict',
  );
  const reserved = await store.reserveSelection({
    taskId,
    ownerUserId: ownerId,
    expectedVersion: 0,
    solutionId: solution.id,
  });
  const selected = await store.completeSelection({
    taskId,
    ownerUserId: ownerId,
    expectedVersion: reserved.stateVersion,
    solutionId: solution.id,
    candidates: created.candidates,
  });
  const confirmed = await store.confirm({
    taskId,
    ownerUserId: ownerId,
    expectedVersion: selected.stateVersion,
    plan: plan(taskId, 'confirmed evidence'),
    materials: [{ id: 'upload:confirmed', inputId: 'research_goal', source: 'upload', value: 'confirmed evidence' }],
  });
  const attemptId = randomUUID();
  const executing = await store.beginExecution({
    taskId,
    ownerUserId: ownerId,
    expectedVersion: confirmed.stateVersion,
    attemptId,
  });
  assert.equal(executing.state, 'executing');

  await store.recordModelCall({
    attemptId,
    stage: 'skill_native_final_report',
    provider: 'test-provider',
    endpointHost: 'localhost',
    requestedModel: 'test-model',
    actualModel: 'test-model',
    modelVersion: '1',
    promptHash: `sha256:${'3'.repeat(64)}`,
    status: 'succeeded',
    failure: null,
    startedAt: new Date('2026-09-04T00:00:00Z'),
    finishedAt: new Date('2026-09-04T00:00:01Z'),
  });
  await store.recordToolCall({
    attemptId,
    invocationId: `skill-1-${skill.id}`,
    toolId: 'tavily-web-search',
    inputHash: `sha256:${'4'.repeat(64)}`,
    output: { results: [] },
    sources: [],
    receipt: {
      declaredAdapterType: 'tavily',
      resolvedAdapterType: 'tavily',
      implementationId: 'test',
      executionMode: 'fake',
      endpointHost: null,
      status: 'ok',
      latencyMs: 1,
    },
    status: 'succeeded',
    startedAt: new Date('2026-09-04T00:00:00Z'),
    finishedAt: new Date('2026-09-04T00:00:01Z'),
  });

  const report: ReportResult = {
    version: 'report-result-v1',
    title: '测试报告',
    summary: '完成',
    status: 'complete',
    sections: [{
      id: 'one',
      title: '结论',
      blocks: [
        { type: 'text', text: '结果' },
        { type: 'image', artifactId: initialArtifactId, alt: '保留图片' },
      ],
    }],
    sources: [{ id: `artifact:${initialArtifactId}`, kind: 'upload', label: 'input.png', artifactId: initialArtifactId }],
    gaps: [],
  };
  const supportReport: ReportResult = {
    ...report,
    title: '支持结果',
    sections: [{
      id: 'support',
      title: '支持结果',
      blocks: [{ type: 'image', artifactId: supportArtifactId, alt: '支持图片' }],
    }],
    sources: [{ id: `artifact:${supportArtifactId}`, kind: 'upload', label: 'support.png', artifactId: supportArtifactId }],
  };
  const supportStep = { invocationId: 'skill-1-support', skillId: 'support', state: 'succeeded' as const, report: supportReport };
  const step = { invocationId: `skill-2-${skill.id}`, skillId: skill.id, state: 'succeeded' as const, report };
  const steps = [supportStep, step];
  assert.equal(await store.saveExecutionSteps({ taskId, ownerUserId: ownerId, attemptId, steps }), true);
  const finished = await store.finishExecution({
    taskId,
    ownerUserId: ownerId,
    attemptId,
    state: 'completed',
    steps,
    report,
    html: '<!doctype html>',
    markdown: '# 测试报告\n',
    warnings: [],
    failure: null,
  });
  assert.equal(finished?.state, 'completed');
  assert.equal(finished?.stateVersion, 5);
  assert.equal(finished?.candidates[0]?.initialMaterials[0]?.value, null);
  assert.equal(finished?.plan?.requirement.inputs[0]?.value, null);
  assert.equal((await store.listReusableMaterials({ ownerUserId: ownerId, projectId, inputIds: ['research_goal'] })).length, 0);
  assert.deepEqual((await store.getArtifactOwned({
    artifactId: initialArtifactId,
    taskId,
    ownerUserId: ownerId,
    projectId,
  }))?.bytes, initialBytes);
  assert.deepEqual((await store.getArtifactOwned({
    artifactId: supportArtifactId,
    taskId,
    ownerUserId: ownerId,
    projectId,
  }))?.bytes, initialBytes);
  assert.equal(await store.getArtifactOwned({
    artifactId: unusedArtifactId,
    taskId,
    ownerUserId: ownerId,
    projectId,
  }), null);

  assert.deepEqual(await store.reserveZeroPublication({
    taskId,
    ownerUserId: ownerId,
    expectedVersion: finished!.stateVersion,
  }), { status: 'reserved' });
  await assert.rejects(store.replan({
    taskId,
    ownerUserId: ownerId,
    expectedVersion: finished!.stateVersion,
    candidates: created.candidates,
  }), (error: unknown) => error instanceof SkillNativeStoreError && error.code === 'conflict');
  await store.failZeroPublication({ taskId, ownerUserId: ownerId, failure: 'temporary outage' });
  assert.deepEqual(await store.reserveZeroPublication({
    taskId,
    ownerUserId: ownerId,
    expectedVersion: finished!.stateVersion,
  }), { status: 'reserved' });
  const publication = {
    taskId,
    fileKey: 'file-1',
    pageId: 'page-1',
    pageName: '报告',
    rootNodeId: 'node-1',
  };
  const draft = {
    taskId,
    fileKey: publication.fileKey,
    pageId: publication.pageId,
    pageName: publication.pageName,
    draftRootNodeId: publication.rootNodeId,
    finalName: '测试报告',
  };
  await store.prepareZeroPublication({ taskId, ownerUserId: ownerId, draft });
  await assert.rejects(store.replan({
    taskId,
    ownerUserId: ownerId,
    expectedVersion: finished!.stateVersion,
    candidates: created.candidates,
  }), (error: unknown) => error instanceof SkillNativeStoreError && error.code === 'conflict');
  assert.equal(await store.recoverInterrupted(), 0);
  assert.deepEqual(await store.reserveZeroPublication({
    taskId,
    ownerUserId: ownerId,
    expectedVersion: finished!.stateVersion,
  }), { status: 'prepared', draft });
  await store.completeZeroPublication({ taskId, ownerUserId: ownerId, publication });
  assert.deepEqual(await store.reserveZeroPublication({
    taskId,
    ownerUserId: ownerId,
    expectedVersion: finished!.stateVersion,
  }), { status: 'completed', publication });

  const audit = await query(
    `SELECT
       (SELECT status FROM skill_native_attempts WHERE id = $1) AS attempt_status,
       (SELECT count(*)::int FROM skill_native_model_calls WHERE attempt_id = $1) AS model_calls,
       (SELECT count(*)::int FROM skill_native_tool_calls WHERE attempt_id = $1) AS tool_calls`,
    [attemptId],
  );
  assert.deepEqual(audit.rows[0], { attempt_status: 'completed', model_calls: 1, tool_calls: 1 });

  const replanned = await store.replan({
    taskId,
    ownerUserId: ownerId,
    expectedVersion: finished!.stateVersion,
    candidates: created.candidates,
  });
  assert.equal(replanned.state, 'awaiting_selection');
  assert.equal(replanned.report, null);
  const publicationAfterReplan = await query(
    `SELECT zero_publication_status, zero_publication_json, zero_publication_failure
     FROM skill_native_tasks WHERE id = $1`,
    [taskId],
  );
  assert.deepEqual(publicationAfterReplan.rows[0], {
    zero_publication_status: null,
    zero_publication_json: null,
    zero_publication_failure: null,
  });
});

test('a cancelled execution cannot persist a late Tool artifact', async () => {
  const taskId = randomUUID();
  const projectId = 'cancelled-tool-artifact';
  const created = await store.create({
    id: taskId,
    ownerUserId: ownerId,
    projectId,
    originalInput: 'test cancellation fence',
    orchestrationMode: 'single_skill',
    candidates: [candidate('conversation:goal', 'goal')],
  });
  const reserved = await store.reserveSelection({
    taskId,
    ownerUserId: ownerId,
    expectedVersion: created.stateVersion,
    solutionId: solution.id,
  });
  const selected = await store.completeSelection({
    taskId,
    ownerUserId: ownerId,
    expectedVersion: reserved.stateVersion,
    solutionId: solution.id,
    candidates: created.candidates,
  });
  const confirmed = await store.confirm({
    taskId,
    ownerUserId: ownerId,
    expectedVersion: selected.stateVersion,
    plan: plan(taskId, 'goal'),
    materials: [],
  });
  const attemptId = randomUUID();
  const executing = await store.beginExecution({
    taskId,
    ownerUserId: ownerId,
    expectedVersion: confirmed.stateVersion,
    attemptId,
  });
  const cancelled = await store.cancel({
    taskId,
    ownerUserId: ownerId,
    expectedVersion: executing.stateVersion,
  });
  assert.equal(cancelled.state, 'cancelled');

  const bytes = Buffer.from([137, 80, 78, 71]);
  const artifactId = randomUUID();
  await assert.rejects(store.writeArtifact({
    id: artifactId,
    taskId,
    ownerUserId: ownerId,
    projectId,
    fileName: 'late.png',
    mediaType: 'image/png',
    bytes,
    contentSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  }, attemptId), (error: unknown) => (
    error instanceof SkillNativeStoreError && error.code === 'not_found'
  ));
  assert.equal(await store.getArtifactOwned({ artifactId, taskId, ownerUserId: ownerId, projectId }), null);
});

test('selection reservation excludes concurrent select and replan mutations', async () => {
  const taskId = randomUUID();
  const created = await store.create({
    id: taskId,
    ownerUserId: ownerId,
    projectId: 'selection-reservation',
    originalInput: 'test selection reservation',
    orchestrationMode: 'single_skill',
    candidates: [candidate('conversation:goal', 'goal')],
  });
  const reserved = await store.reserveSelection({
    taskId,
    ownerUserId: ownerId,
    expectedVersion: created.stateVersion,
    solutionId: solution.id,
  });

  await assert.rejects(store.reserveSelection({
    taskId,
    ownerUserId: ownerId,
    expectedVersion: reserved.stateVersion,
    solutionId: solution.id,
  }), (error: unknown) => error instanceof SkillNativeStoreError && error.code === 'conflict');

  await assert.rejects(store.replan({
    taskId,
    ownerUserId: ownerId,
    expectedVersion: reserved.stateVersion,
    candidates: created.candidates,
  }), (error: unknown) => error instanceof SkillNativeStoreError && error.code === 'conflict');
});
