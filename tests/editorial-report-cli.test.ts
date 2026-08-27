import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { Pool } from 'pg';

import {
  EditorialReportCliError,
  createPhase1EditorialReportPipeline,
  parseEditorialReportArgs,
  runEditorialReportCli,
  type EditorialReportCliPipeline,
} from '../apps/orchestrator-runtime/src/editorial-report.ts';
import { ControlArtifactStore } from '../apps/orchestrator-runtime/src/control/artifact-store.ts';
import { EvidenceService } from '../apps/orchestrator-runtime/src/evidence/evidence-service.ts';
import { EditorialPipelineError } from '../apps/orchestrator-runtime/src/report/editorial-report-pipeline.ts';
import { EditorialSourceError } from '../apps/orchestrator-runtime/src/report/editorial-report-source-reader.ts';
import { ControlPlaneRepository } from '../database/control-plane.ts';
import {
  runMigrations,
  type MigrationConnection,
  type MigrationDatabase,
} from '../database/migration-runner.ts';
import { REPORT_REVIEW_DIMENSION_IDS } from '../packages/api-contract/control-workflow.ts';

const TASK_ID = 'a1111111-b222-4333-8444-555555555555';
const PLAN_ID = '155a2658-8b6c-4bd7-9078-43636feb9df7';
const ATTEMPT_ID = '255a2658-8b6c-4bd7-9078-43636feb9df7';
const RESULT = {
  status: 'degraded' as const,
  taskId: TASK_ID,
  planVersionId: PLAN_ID,
  attemptId: ATTEMPT_ID,
  requestKey: `erq_${'a'.repeat(64)}`,
  generationId: `er_${'b'.repeat(64)}`,
  reportPath: '/tmp/editorial-report.html',
  manifestPath: '/tmp/manifest.json',
};

function capture(options: {
  pipeline: EditorialReportCliPipeline;
  close?: () => Promise<void>;
}): {
  dependencies: Parameters<typeof runEditorialReportCli>[1];
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    dependencies: {
      createPipeline: () => options.pipeline,
      close: options.close ?? (async () => undefined),
      writeStdout: (line) => stdout.push(line),
      writeStderr: (line) => stderr.push(line),
    },
  };
}

class ScopedEditorialCliDatabase implements MigrationDatabase {
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

interface TreeEntry {
  path: string;
  type: 'directory' | 'file' | 'symlink';
  contentSha256?: string;
  target?: string;
}

function portablePath(value: string): string {
  return sep === '/' ? value : value.replaceAll(sep, '/');
}

function snapshotTree(root: string): TreeEntry[] {
  if (!existsSync(root)) return [];
  const entries: TreeEntry[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => (
      left.name.localeCompare(right.name)
    ))) {
      const absolutePath = join(directory, entry.name);
      const path = portablePath(relative(root, absolutePath));
      if (entry.isDirectory()) {
        entries.push({ path, type: 'directory' });
        walk(absolutePath);
      } else if (entry.isFile()) {
        entries.push({
          path,
          type: 'file',
          contentSha256: createHash('sha256').update(readFileSync(absolutePath)).digest('hex'),
        });
      } else if (entry.isSymbolicLink()) {
        entries.push({ path, type: 'symlink', target: readlinkSync(absolutePath) });
      } else {
        throw new Error(`unsupported fixture entry ${absolutePath}`);
      }
    }
  };
  walk(root);
  return entries;
}

function fileHashes(root: string): Array<Pick<TreeEntry, 'path' | 'contentSha256'>> {
  return snapshotTree(root)
    .filter((entry): entry is TreeEntry & { type: 'file'; contentSha256: string } => entry.type === 'file')
    .map(({ path, contentSha256 }) => ({ path, contentSha256 }));
}

async function relationBytes(
  connection: MigrationConnection,
  selectSql: string,
  values: readonly unknown[] = [],
): Promise<string> {
  const result = await connection.query(
    `SELECT COALESCE(
       jsonb_agg(to_jsonb(snapshot_row) ORDER BY snapshot_row.id),
       '[]'::jsonb
     )::text AS bytes
     FROM (${selectSql}) AS snapshot_row`,
    values,
  );
  const bytes = result.rows[0]?.bytes;
  if (typeof bytes !== 'string') throw new Error('database snapshot did not return bytes');
  return bytes;
}

interface MainStateSnapshot {
  task: string;
  attempts: string;
  artifacts: string;
  modelCalls: string;
}

async function snapshotMainDatabase(
  database: MigrationDatabase,
  taskId: string,
): Promise<MainStateSnapshot> {
  const connection = await database.connect();
  try {
    await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const task = await relationBytes(connection, 'SELECT * FROM control_tasks WHERE id = $1', [taskId]);
    const attempts = await relationBytes(
      connection,
      'SELECT * FROM control_execution_attempts WHERE task_id = $1',
      [taskId],
    );
    const artifacts = await relationBytes(
      connection,
      'SELECT * FROM control_artifacts WHERE task_id = $1',
      [taskId],
    );
    const modelCalls = await relationBytes(connection, 'SELECT * FROM control_model_calls');
    await connection.query('COMMIT');
    return { task, attempts, artifacts, modelCalls };
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

function researchPlanPayload(): Record<string, unknown> {
  return {
    title: 'Verified editorial CLI plan',
    researchGoal: 'Verify that sidecar generation leaves main unchanged',
    scope: { market: 'CN', subjects: ['researchers'], timeWindow: '2026 Q3' },
    competitorSampling: {
      strategy: 'purposive',
      targetCount: 1,
      inclusionCriteria: ['relevant'],
      exclusionCriteria: ['irrelevant'],
    },
    researchQuestions: ['Does the sidecar preserve main state?'],
    comparisonDimensions: [{
      id: 'dimension-1',
      name: 'Integrity',
      purpose: 'Compare snapshots',
      collectionFields: ['score'],
    }],
    sourcePlan: [{
      evidenceClass: 'dataset',
      sourceTypes: ['verified fixture'],
      purpose: 'Support the integrity finding',
    }],
    executionPlan: [{
      phase: 'verify',
      activities: ['snapshot before and after'],
      duration: '1 day',
      outputs: ['integrity report'],
    }],
    collectionTemplate: [{
      field: 'score',
      description: 'Observed integrity score',
      evidenceRequired: true,
    }],
    analysisMethods: ['byte comparison'],
    deliverables: ['research_plan'],
    qualityChecks: ['source traceability'],
  };
}

async function seedCompletedReportPackage(
  database: MigrationDatabase,
  workspaceRoot: string,
): Promise<void> {
  const ownerId = randomUUID();
  const conversationId = randomUUID();
  const leaseToken = `editorial-cli-${randomUUID()}`;
  const leaseOwner = 'editorial-cli-integration';
  const leaseTokenHash = `sha256:${createHash('sha256').update(leaseToken).digest('hex')}`;
  const connection = await database.connect();
  try {
    await connection.query('BEGIN');
    await connection.query(
      `INSERT INTO users (id, email, display_name, password_hash, role)
       VALUES ($1, $2, 'editorial owner', 'x', 'member')`,
      [ownerId, `editorial-cli-${randomUUID()}@test.local`],
    );
    await connection.query(
      `INSERT INTO conversations (id, owner_user_id, title)
       VALUES ($1, $2, 'editorial CLI integration')`,
      [conversationId, ownerId],
    );
    await connection.query(
      `INSERT INTO control_tasks
         (id, conversation_id, owner_user_id, original_input, task_type, structured_task,
          state, state_version, sensitivity, pii_detected)
       VALUES ($1, $2, $3, 'Create a verified research plan', 'research_plan', '{}'::jsonb,
               'composing_report', 12, 'internal', false)`,
      [TASK_ID, conversationId, ownerId],
    );
    await connection.query(
      `INSERT INTO control_plan_versions
         (id, task_id, version, candidate_id, plan_json, plan_hash, pending_inputs)
       VALUES ($1, $2, 1, 'editorial-cli', $3::jsonb, $4, '[]'::jsonb)`,
      [
        PLAN_ID,
        TASK_ID,
        JSON.stringify({ task_id: TASK_ID, deliverable_type: 'research_plan', steps: [] }),
        `sha256:${'1'.repeat(64)}`,
      ],
    );
    await connection.query(
      `INSERT INTO control_execution_attempts
         (id, task_id, plan_version_id, attempt_no, state, lease_owner, lease_token_hash,
          lease_expires_at, lease_heartbeat_at)
       VALUES ($1, $2, $3, 1, 'active', $4, $5, now() + interval '1 hour', now())`,
      [ATTEMPT_ID, TASK_ID, PLAN_ID, leaseOwner, leaseTokenHash],
    );
    await connection.query(
      `UPDATE control_tasks
       SET active_plan_version_id = $2, current_attempt_id = $3
       WHERE id = $1`,
      [TASK_ID, PLAN_ID, ATTEMPT_ID],
    );
    await connection.query(
      `INSERT INTO control_model_calls
         (id, stage, attempt_id, step_no, provider, endpoint_host, requested_model, actual_model,
          model_version, prompt_hash, context_manifest_hash, trace_id, status, started_at, finished_at)
       VALUES
         ($1, 'problem_graph', NULL, NULL, 'fixture', 'fixture.test', 'fixture-model',
          'fixture-model', '1', 'sha256:fixture-null-attempt', NULL, 'trace-null-attempt',
          'succeeded', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:01.000Z'),
         ($2, 'report', $3, 1, 'fixture', 'fixture.test', 'fixture-model',
          'fixture-model', '1', 'sha256:fixture-attempt', NULL, 'trace-attempt',
          'succeeded', '2026-08-27T00:00:02.000Z', '2026-08-27T00:00:03.000Z')`,
      [randomUUID(), randomUUID(), ATTEMPT_ID],
    );
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }

  const repository = new ControlPlaneRepository(database);
  const artifacts = new ControlArtifactStore({
    root: join(workspaceRoot, 'current-control'),
    registry: repository,
  });
  const activeLease = {
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    leaseOwner,
    leaseToken,
  };
  const artifactBase = {
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    activeLease,
    sensitivity: 'internal',
    redactionPolicyVersion: 'v1',
  };
  const evidenceValue = { output: { results: [{ score: 87 }] } };
  const evidenceArtifact = await artifacts.writeJson({
    ...artifactBase,
    kind: 'tool_output',
    relativePath: 'evidence/verified-source.json',
    schemaVersion: 'tool-output-v1',
    value: evidenceValue,
  });
  assert.ok(evidenceArtifact.contentSha256);
  const evidenceManifest = new EvidenceService().createManifest({
    taskId: TASK_ID,
    planVersionId: PLAN_ID,
    attemptId: ATTEMPT_ID,
    collectedAt: '2026-08-27T00:00:00.000Z',
    entries: [{
      id: 'evidence-1',
      kind: 'tool_output',
      evidenceClass: 'dataset',
      artifactId: evidenceArtifact.id,
      artifactContentSha256: evidenceArtifact.contentSha256,
      jsonPointer: '/output/results/0/score',
      sensitivity: 'internal',
      redaction: 'none',
    }],
  }, {
    resolveArtifact: (artifactId) => artifactId === evidenceArtifact.id
      ? {
          artifact: { id: evidenceArtifact.id, contentSha256: evidenceArtifact.contentSha256! },
          value: evidenceValue,
        }
      : null,
  });
  const manifestArtifact = await artifacts.writeJson({
    ...artifactBase,
    kind: 'evidence_manifest',
    relativePath: 'evidence/manifest.json',
    schemaVersion: 'evidence-v1',
    value: evidenceManifest,
  });
  const deliverableArtifact = await artifacts.writeJson({
    ...artifactBase,
    kind: 'deliverable',
    relativePath: 'deliverables/final-r0.json',
    schemaVersion: 'research-deliverable-v1-review-gated',
    value: {
      version: 'research-deliverable-v1',
      taskId: TASK_ID,
      planVersionId: PLAN_ID,
      attemptId: ATTEMPT_ID,
      deliverableType: 'research_plan',
      evidenceManifestArtifactId: manifestArtifact.id,
      methodSummary: 'Verified synthesis from a sealed fixture source.',
      findingGraph: {
        findings: [{
          id: 'finding-1',
          kind: 'fact',
          statement: 'The verified integrity score is 87.',
          evidenceIds: ['evidence-1'],
        }],
        analyses: [{
          id: 'analysis-1',
          statement: 'The score supports a byte-level regression check.',
          findingIds: ['finding-1'],
        }],
        subQuestionSummaries: [{
          id: 'summary-1',
          summary: 'The fixture can exercise a successful sidecar generation.',
          findingIds: ['finding-1'],
          analysisIds: ['analysis-1'],
        }],
        overallConclusions: [{
          id: 'conclusion-1',
          statement: 'Generate the sidecar and verify main remains unchanged.',
          summaryIds: ['summary-1'],
        }],
      },
      payload: researchPlanPayload(),
      recommendations: [{
        id: 'recommendation-1',
        statement: 'Compare authoritative state before and after generation.',
        summaryIds: ['summary-1'],
      }],
      coverage: {
        questionBindings: [{ questionId: 'question-1', summaryIds: ['summary-1'] }],
        successCriterionBindings: [{
          successCriterionId: 'criterion-1',
          conclusionIds: ['conclusion-1'],
          recommendationIds: ['recommendation-1'],
        }],
      },
      risksAndOpenIssues: [],
      capabilityProvenance: [],
    },
  });
  const reviewArtifact = await artifacts.writeJson({
    ...artifactBase,
    kind: 'report_review',
    relativePath: 'reports/review-r0.json',
    schemaVersion: 'report-review-v1',
    value: {
      version: 'report-review-v1',
      taskId: TASK_ID,
      planVersionId: PLAN_ID,
      attemptId: ATTEMPT_ID,
      deliverableArtifactId: deliverableArtifact.id,
      verdict: 'pass',
      dimensions: REPORT_REVIEW_DIMENSION_IDS.map((id) => ({ id, passed: true, issues: [] })),
      revisionRound: 0,
    },
  });
  await artifacts.writeJson({
    ...artifactBase,
    kind: 'report_package',
    relativePath: 'reports/report-package.json',
    schemaVersion: 'report-package-v1',
    value: {
      version: 'report-package-v1',
      taskId: TASK_ID,
      planVersionId: PLAN_ID,
      attemptId: ATTEMPT_ID,
      presentationMode: 'current_text',
      deliverableArtifactId: deliverableArtifact.id,
      evidenceManifestArtifactId: manifestArtifact.id,
      reportReviewArtifactId: reviewArtifact.id,
    },
  });

  const completion = await database.connect();
  try {
    await completion.query('BEGIN');
    await completion.query(
      `UPDATE control_execution_attempts
       SET state = 'completed', finished_at = '2026-08-27T00:00:04.000Z'
       WHERE id = $1`,
      [ATTEMPT_ID],
    );
    await completion.query(
      `UPDATE control_tasks
       SET state = 'completed', updated_at = '2026-08-27T00:00:04.000Z'
       WHERE id = $1`,
      [TASK_ID],
    );
    await completion.query('COMMIT');
  } catch (error) {
    await completion.query('ROLLBACK');
    throw error;
  } finally {
    completion.release();
  }
}

test('editorial report CLI accepts exactly one canonical task UUID', () => {
  assert.deepEqual(parseEditorialReportArgs(['--task-id', TASK_ID]), { taskId: TASK_ID });
  assert.deepEqual(parseEditorialReportArgs(['--', '--task-id', TASK_ID]), { taskId: TASK_ID });
});

test('editorial report CLI rejects missing, malformed, duplicate, and unsupported arguments', () => {
  const invalid = [
    [],
    ['--task-id'],
    ['--task-id', 'not-a-uuid'],
    ['--task-id', TASK_ID.toUpperCase()],
    ['--task-id', TASK_ID, '--task-id', TASK_ID],
    ['--', '--', '--task-id', TASK_ID],
    ['--attempt-id', TASK_ID],
    ['--task-id', TASK_ID, '--input', '/tmp/report.json'],
    [`--task-id=${TASK_ID}`],
  ];
  for (const args of invalid) {
    assert.throws(
      () => parseEditorialReportArgs(args),
      (error: unknown) => error instanceof EditorialReportCliError
        && error.code === 'EDITORIAL_CLI_ARGUMENT_INVALID',
      args.join(' '),
    );
  }
});

test('editorial report CLI prints one JSON result and exits zero for degraded output', async () => {
  let closeCalls = 0;
  const captured = capture({
    pipeline: { generate: async () => RESULT },
    close: async () => { closeCalls += 1; },
  });

  const exitCode = await runEditorialReportCli(['--task-id', TASK_ID], captured.dependencies);

  assert.equal(exitCode, 0);
  assert.equal(closeCalls, 1);
  assert.deepEqual(captured.stderr, []);
  assert.deepEqual(captured.stdout, [JSON.stringify(RESULT)]);
  assert.deepEqual(JSON.parse(captured.stdout[0]!), RESULT);
});

test('editorial report CLI prints one JSON result and exits zero for ready output', async () => {
  const ready = { ...RESULT, status: 'ready' as const };
  const captured = capture({ pipeline: { generate: async () => ready } });

  const exitCode = await runEditorialReportCli(['--task-id', TASK_ID], captured.dependencies);

  assert.equal(exitCode, 0);
  assert.deepEqual(captured.stderr, []);
  assert.deepEqual(captured.stdout, [JSON.stringify(ready)]);
});

test('editorial report CLI reports only a typed hard-failure code and always closes', async () => {
  let closeCalls = 0;
  const secret = 'postgres://operator:password@example.invalid/main';
  const captured = capture({
    pipeline: {
      generate: async () => {
        throw new EditorialSourceError('SOURCE_BINDING_CHANGED');
      },
    },
    close: async () => { closeCalls += 1; },
  });
  const unknown = capture({
    pipeline: {
      generate: async () => {
        throw new Error(secret);
      },
    },
  });

  assert.equal(await runEditorialReportCli(['--task-id', TASK_ID], captured.dependencies), 1);
  assert.equal(closeCalls, 1);
  assert.deepEqual(captured.stdout, []);
  assert.deepEqual(captured.stderr, ['SOURCE_BINDING_CHANGED']);

  assert.equal(await runEditorialReportCli(['--task-id', TASK_ID], unknown.dependencies), 1);
  assert.deepEqual(unknown.stdout, []);
  assert.deepEqual(unknown.stderr, ['EDITORIAL_REPORT_FAILED']);
  assert.equal(unknown.stderr.join('').includes(secret), false);
});

test('editorial report CLI safely includes a published failure Diagnostic path', async () => {
  const diagnosticPath = '/tmp/editorial-reports/tasks/a1111111-b222-4333-8444-555555555555/failures/failure-1/editorial-diagnostic.json';
  const captured = capture({
    pipeline: {
      generate: async () => {
        throw new EditorialPipelineError('SOURCE_NOT_RENDERABLE', { diagnosticPath });
      },
    },
  });

  assert.equal(await runEditorialReportCli(['--task-id', TASK_ID], captured.dependencies), 1);
  assert.deepEqual(captured.stdout, []);
  assert.deepEqual(captured.stderr, [JSON.stringify({ code: 'SOURCE_NOT_RENDERABLE', diagnosticPath })]);

  const unsafe = capture({
    pipeline: {
      generate: async () => {
        throw new EditorialPipelineError('SOURCE_NOT_RENDERABLE', {
          diagnosticPath: '/tmp/editorial-diagnostic.json\nSECRET',
        });
      },
    },
  });
  assert.equal(await runEditorialReportCli(['--task-id', TASK_ID], unsafe.dependencies), 1);
  assert.deepEqual(unsafe.stderr, ['SOURCE_NOT_RENDERABLE']);
});

test('editorial report CLI closes the pool on argument, pipeline construction, and close failures', async () => {
  let argumentCloseCalls = 0;
  const invalid = capture({
    pipeline: { generate: async () => RESULT },
    close: async () => { argumentCloseCalls += 1; },
  });
  assert.equal(await runEditorialReportCli([], invalid.dependencies), 1);
  assert.equal(argumentCloseCalls, 1);
  assert.deepEqual(invalid.stderr, ['EDITORIAL_CLI_ARGUMENT_INVALID']);

  let constructionCloseCalls = 0;
  const constructionStdout: string[] = [];
  const constructionStderr: string[] = [];
  const constructionExit = await runEditorialReportCli(['--task-id', TASK_ID], {
    createPipeline: () => { throw new EditorialPipelineError('EDITORIAL_PHASE1_MODEL_FORBIDDEN'); },
    close: async () => { constructionCloseCalls += 1; },
    writeStdout: (line) => constructionStdout.push(line),
    writeStderr: (line) => constructionStderr.push(line),
  });
  assert.equal(constructionExit, 1);
  assert.equal(constructionCloseCalls, 1);
  assert.deepEqual(constructionStdout, []);
  assert.deepEqual(constructionStderr, ['EDITORIAL_PHASE1_MODEL_FORBIDDEN']);

  const closeFailure = capture({
    pipeline: { generate: async () => RESULT },
    close: async () => { throw new Error('connection details must not escape'); },
  });
  assert.equal(await runEditorialReportCli(['--task-id', TASK_ID], closeFailure.dependencies), 1);
  assert.deepEqual(closeFailure.stdout, []);
  assert.deepEqual(closeFailure.stderr, ['EDITORIAL_REPORT_FAILED']);
});

test('official Phase 1 CLI composition has no main writer or model client', () => {
  const source = readFileSync(
    new URL('../apps/orchestrator-runtime/src/editorial-report.ts', import.meta.url),
    'utf8',
  );
  assert.equal(source.includes('buildControlRuntime'), false);
  assert.equal(source.includes('ReceiptLLMClient'), false);
  assert.equal(source.includes('LLM_PROVIDER'), false);
  assert.equal(source.includes('LLM_GATEWAY_'), false);
  assert.equal(source.includes('LLM_MODEL_'), false);
  assert.match(source, /modelPort:\s*NO_EDITORIAL_MODEL_PORT/u);
  assert.match(source, /root:\s*join\(workspaceRoot, 'current-control'\)/u);
  assert.match(source, /root:\s*join\(workspaceRoot, 'editorial-reports'\)/u);
  for (const forbidden of [
    'createStagingArtifact:',
    'sealArtifact:',
    'failArtifact:',
    'invalidateArtifactPublication:',
    'quarantineStagingArtifact:',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('official Phase 1 composition performs no main write when source lookup fails', async () => {
  const queries: string[] = [];
  let releases = 0;
  const pipeline = createPhase1EditorialReportPipeline({
    database: {
      connect: async () => ({
        query: async (sql: string) => {
          queries.push(sql);
          return { rows: [] };
        },
        release: () => { releases += 1; },
      }),
    },
    workspaceRoot: '/tmp/editorial-cli-read-only-test',
  });
  const captured = capture({ pipeline });

  assert.equal(await runEditorialReportCli(['--task-id', TASK_ID], captured.dependencies), 1);
  assert.deepEqual(captured.stdout, []);
  assert.deepEqual(captured.stderr, ['EDITORIAL_TASK_NOT_FOUND']);
  assert.equal(releases, 1);
  assert.equal(queries.length, 1);
  assert.equal(queries.every((sql) => sql.trimStart().startsWith('SELECT ')), true);
});

test('successful official Phase 1 CLI generation leaves every main byte unchanged', async () => {
  const schema = `editorial_cli_${randomUUID().replaceAll('-', '')}`;
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'editorial-cli-sidecar-'));
  const database = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/user_research_ai',
  });
  const scopedDatabase = new ScopedEditorialCliDatabase(database, schema);

  try {
    await database.query(`CREATE SCHEMA "${schema}"`);
    await runMigrations({
      database: scopedDatabase,
      migrationsDir: join(process.cwd(), 'database', 'migrations'),
      lockKey: 761_831_204,
    });
    await seedCompletedReportPackage(scopedDatabase, workspaceRoot);

    const currentTaskRoot = join(workspaceRoot, 'current-control', 'tasks', TASK_ID);
    const databaseBefore = await snapshotMainDatabase(scopedDatabase, TASK_ID);
    const currentControlBefore = fileHashes(currentTaskRoot);
    const workspaceBefore = snapshotTree(workspaceRoot);
    const modelCallsBefore = JSON.parse(databaseBefore.modelCalls) as Array<{ attempt_id?: unknown }>;
    assert.equal(modelCallsBefore.length, 2, 'fixture must cover the complete model-call table');
    assert.equal(
      modelCallsBefore.some((call) => call.attempt_id === null),
      true,
      'fixture must include a model call whose attempt_id is NULL',
    );
    assert.equal(JSON.parse(databaseBefore.task).length, 1);
    assert.equal(JSON.parse(databaseBefore.attempts).length, 1);
    assert.equal(JSON.parse(databaseBefore.artifacts).length, 5);
    assert.equal(currentControlBefore.length, 5);

    const pipeline = createPhase1EditorialReportPipeline({
      database: scopedDatabase,
      workspaceRoot,
    });
    const captured = capture({ pipeline });
    const exitCode = await runEditorialReportCli(['--task-id', TASK_ID], captured.dependencies);

    assert.equal(exitCode, 0);
    assert.deepEqual(captured.stderr, []);
    assert.equal(captured.stdout.length, 1);
    const result = JSON.parse(captured.stdout[0]!) as typeof RESULT;
    assert.equal(result.status, 'degraded');
    assert.equal(result.taskId, TASK_ID);
    assert.equal(result.planVersionId, PLAN_ID);
    assert.equal(result.attemptId, ATTEMPT_ID);
    const editorialRoot = join(workspaceRoot, 'editorial-reports');
    for (const outputPath of [result.reportPath, result.manifestPath]) {
      const relativeOutput = relative(realpathSync(editorialRoot), realpathSync(outputPath));
      assert.equal(
        relativeOutput !== '' && !relativeOutput.startsWith('..') && !relativeOutput.includes(`..${sep}`),
        true,
        `${outputPath} must stay below the sidecar root`,
      );
      assert.equal(existsSync(outputPath), true);
    }

    const databaseAfter = await snapshotMainDatabase(scopedDatabase, TASK_ID);
    const currentControlAfter = fileHashes(currentTaskRoot);
    const workspaceAfter = snapshotTree(workspaceRoot);
    assert.deepEqual(databaseAfter, databaseBefore, 'task, attempt, Artifact, and all model-call bytes changed');
    assert.deepEqual(
      currentControlAfter,
      currentControlBefore,
      'current-control task file bytes changed',
    );

    const beforeByPath = new Map(workspaceBefore.map((entry) => [entry.path, entry]));
    const afterByPath = new Map(workspaceAfter.map((entry) => [entry.path, entry]));
    const deletedOrChanged = workspaceBefore.filter((entry) => {
      const after = afterByPath.get(entry.path);
      return after === undefined || JSON.stringify(after) !== JSON.stringify(entry);
    });
    const added = workspaceAfter.filter((entry) => !beforeByPath.has(entry.path));
    assert.deepEqual(deletedOrChanged, [], 'Phase 1 changed or deleted a pre-existing workspace entry');
    assert.ok(added.length > 0, 'successful generation must publish sidecar content');
    assert.equal(
      added.every((entry) => (
        entry.path === 'editorial-reports' || entry.path.startsWith('editorial-reports/')
      )),
      true,
      `unexpected additions: ${added.map((entry) => entry.path).join(', ')}`,
    );
  } finally {
    await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await database.end();
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('editorial report executable maps a hard failure to process exit 1 and code-only stderr', () => {
  const result = spawnSync(process.execPath, [
    '--import',
    'tsx',
    'apps/orchestrator-runtime/src/editorial-report.ts',
    '--',
    '--task-id',
    'invalid',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'EDITORIAL_CLI_ARGUMENT_INVALID\n');
});
