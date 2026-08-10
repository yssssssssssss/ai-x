import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import {
  LocalRehearsalError,
  archiveAndRestoreDirectory,
  assertLoopbackUrl,
  backupAndRestoreLocalDatabase,
  runLocalRehearsal,
  sealLocalRehearsal,
  verifyLocalRehearsal,
  type CommandRunner,
} from '../apps/orchestrator-runtime/src/cutover/cutover-rehearsal.ts';

function inventory(digit: string, uri: string) {
  return { uri, sha256: `sha256:${digit.repeat(64)}`, bytes: 12, restoreChecked: true as const };
}

test('local rehearsal seals fixed non-production invariants', () => {
  const root = mkdtempSync(join(tmpdir(), 'local-rehearsal-manifest-'));
  try {
    const result = sealLocalRehearsal({
      outputRoot: root,
      releaseId: 'local-rehearsal-1',
      commit: '43a54bf',
      backups: {
        database: inventory('1', 'file://database.dump'),
        workspace: inventory('2', 'file://workspace.tar.gz'),
        audit: inventory('3', 'file://audit.tar.gz'),
      },
      httpSmoke: { healthz: true, legacyMutation410: true, oldRoute404: true },
    });

    assert.equal(result.manifest.version, 'cutover-rehearsal-v1');
    assert.equal(result.manifest.environment, 'local');
    assert.equal(result.manifest.goLiveEligible, false);
    assert.equal(result.manifest.notProductionEvidence, true);
    assert.equal(result.manifest.notGoldSlot, true);
    assert.deepEqual(verifyLocalRehearsal(result.directory), result.manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local rehearsal rejects non-loopback URLs before side effects', () => {
  assert.equal(assertLoopbackUrl('http://127.0.0.1:3001', 'API').hostname, '127.0.0.1');
  assert.equal(assertLoopbackUrl('postgres://localhost:5432/rehearsal', 'database').hostname, 'localhost');
  assert.throws(
    () => assertLoopbackUrl('https://staging.example.com', 'API'),
    (error: unknown) => error instanceof LocalRehearsalError && error.message.includes('API must use a loopback host'),
  );
});

test('local rehearsal verification detects checklist tampering', () => {
  const root = mkdtempSync(join(tmpdir(), 'local-rehearsal-tamper-'));
  try {
    const result = sealLocalRehearsal({
      outputRoot: root,
      releaseId: 'local-rehearsal-tamper',
      commit: '43a54bf',
      backups: {
        database: inventory('1', 'file://database.dump'),
        workspace: inventory('2', 'file://workspace.tar.gz'),
        audit: inventory('3', 'file://audit.tar.gz'),
      },
      httpSmoke: { healthz: true, legacyMutation410: true, oldRoute404: true },
    });
    const checklist = join(result.directory, 'rehearsal-checklist.json');
    writeFileSync(checklist, readFileSync(checklist, 'utf8').replace('"notGoldSlot": true', '"notGoldSlot": false'));

    assert.throws(
      () => verifyLocalRehearsal(result.directory),
      (error: unknown) => error instanceof LocalRehearsalError && error.message.includes('manifest hash'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local rehearsal archives and restores workspace content with matching hashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'local-rehearsal-archive-'));
  try {
    const source = join(root, 'workspace');
    mkdirSync(join(source, 'nested'), { recursive: true });
    writeFileSync(join(source, 'root.txt'), 'root');
    writeFileSync(join(source, 'nested', 'child.txt'), 'child');

    const evidence = archiveAndRestoreDirectory({ name: 'workspace', source, backupDirectory: join(root, 'backups') });

    assert.match(evidence.sha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(evidence.restoreChecked, true);
    assert.ok(evidence.bytes > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function databaseRunner(options: { restoreFails?: boolean } = {}) {
  const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const runner: CommandRunner = (command, args, runOptions) => {
    calls.push({ command, args, env: runOptions?.env });
    if (command === 'pg_dump') {
      const file = args.find((arg) => arg.startsWith('--file='))?.slice('--file='.length);
      assert.ok(file);
      writeFileSync(file, 'database-dump');
    }
    if (command === 'pg_restore' && options.restoreFails) return { status: 1, stderr: 'restore failed' };
    return { status: 0, stderr: '' };
  };
  return { calls, runner };
}

test('local rehearsal backs up and restores a loopback PostgreSQL database in order', () => {
  const root = mkdtempSync(join(tmpdir(), 'local-rehearsal-db-'));
  try {
    const { calls, runner } = databaseRunner();
    const evidence = backupAndRestoreLocalDatabase({
      databaseUrl: 'postgres://local_user:secret@127.0.0.1:5432/local_db',
      backupDirectory: join(root, 'backups'),
      temporaryDatabaseName: 'local_rehearsal_restore',
      runner,
    });

    assert.deepEqual(calls.map((call) => call.command), ['pg_dump', 'createdb', 'pg_restore', 'dropdb']);
    assert.equal(calls.some((call) => call.args.some((arg) => arg.includes('secret'))), false);
    assert.equal(calls.every((call) => call.env?.PGPASSWORD === 'secret'), true);
    assert.match(evidence.sha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(evidence.restoreChecked, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local rehearsal drops the temporary database after restore failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'local-rehearsal-db-failure-'));
  try {
    const { calls, runner } = databaseRunner({ restoreFails: true });
    assert.throws(
      () => backupAndRestoreLocalDatabase({
        databaseUrl: 'postgres://127.0.0.1:5432/local_db',
        backupDirectory: join(root, 'backups'),
        temporaryDatabaseName: 'local_rehearsal_restore_failure',
        runner,
      }),
      /pg_restore failed/,
    );
    assert.deepEqual(calls.map((call) => call.command), ['pg_dump', 'createdb', 'pg_restore', 'dropdb']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local rehearsal rejects remote PostgreSQL before invoking commands', () => {
  const { calls, runner } = databaseRunner();
  assert.throws(
    () => backupAndRestoreLocalDatabase({
      databaseUrl: 'postgres://db.example.com:5432/local_db',
      backupDirectory: '/tmp/unused-local-rehearsal',
      runner,
    }),
    /database must use a loopback host/,
  );
  assert.equal(calls.length, 0);
});

test('local rehearsal rejects output root nested inside source audit or workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-rehearsal-output-nesting-'));
  try {
    const { runner } = databaseRunner();
    await assert.rejects(
      () => runLocalRehearsal({
        releaseId: 'nested-output',
        commit: '43a54bf',
        baseUrl: 'http://127.0.0.1:3001',
        bearerToken: 'local-token',
        smokeTaskId: 'local-task',
        databaseUrl: 'postgres://127.0.0.1:5432/local_db',
        workspaceRoot: join(root, 'workspace'),
        auditRoot: join(root, 'audit'),
        outputRoot: join(root, 'audit', 'local-rehearsals'),
        databaseRunner: runner,
      }),
      /outputRoot must be outside workspaceRoot and auditRoot/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local rehearsal orchestrates backups, loopback HTTP smoke, and a sealed local-only checklist', async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-rehearsal-run-'));
  const app = express();
  app.use(express.json());
  app.get('/api/healthz', (_req, res) => res.sendStatus(200));
  app.post('/api/tasks/:id/execute', (_req, res) => res.sendStatus(410));
  app.post('/api/legacy/tasks/:id/execute', (_req, res) => res.sendStatus(404));
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const workspace = join(root, 'workspace');
    const audit = join(root, 'audit');
    mkdirSync(workspace);
    mkdirSync(audit);
    writeFileSync(join(workspace, 'artifact.json'), '{"ok":true}');
    writeFileSync(join(audit, 'manifest.json'), '{"sealed":true}');
    const { runner } = databaseRunner();

    const result = await runLocalRehearsal({
      releaseId: 'local-rehearsal-run',
      commit: '43a54bf',
      baseUrl: `http://127.0.0.1:${address.port}`,
      bearerToken: 'local-token',
      smokeTaskId: 'local-smoke-task',
      databaseUrl: 'postgres://127.0.0.1:5432/local_db',
      workspaceRoot: workspace,
      auditRoot: audit,
      outputRoot: join(root, 'output'),
      databaseRunner: runner,
    });

    assert.equal(result.manifest.environment, 'local');
    assert.equal(result.manifest.goLiveEligible, false);
    assert.equal(result.manifest.notProductionEvidence, true);
    assert.equal(result.manifest.notGoldSlot, true);
    assert.deepEqual(verifyLocalRehearsal(result.directory), result.manifest);

    const verify = spawnSync(process.execPath, [
      '--import', 'tsx',
      'apps/orchestrator-runtime/src/cutover/cutover-cli.ts',
      'verify-rehearsal',
      '--directory', result.directory,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(verify.status, 0, verify.stderr || verify.stdout);
    assert.match(verify.stdout, /verified=true/);
    assert.match(verify.stdout, /environment=local/);
    assert.match(verify.stdout, /goLiveEligible=false/);
    assert.match(verify.stdout, /notGoldSlot=true/);
  } finally {
    server.close();
    await once(server, 'close');
    rmSync(root, { recursive: true, force: true });
  }
});

test('local rehearsal CLI rejects missing secret environment variables', () => {
  const env = { ...process.env };
  delete env.LOCAL_REHEARSAL_DATABASE_URL;
  delete env.LOCAL_REHEARSAL_SMOKE_TOKEN;
  const result = spawnSync(process.execPath, [
    '--import', 'tsx',
    'apps/orchestrator-runtime/src/cutover/cutover-cli.ts',
    'rehearse',
    '--release-id', 'local-rehearsal-missing-env',
    '--commit', '43a54bf',
    '--base-url', 'http://127.0.0.1:3001',
    '--smoke-task-id', 'local-task',
    '--database-url-env', 'LOCAL_REHEARSAL_DATABASE_URL',
    '--smoke-token-env', 'LOCAL_REHEARSAL_SMOKE_TOKEN',
    '--workspace-root', './run-workspaces',
    '--audit-root', './audit',
    '--output-root', './audit/local-rehearsals',
  ], { cwd: process.cwd(), encoding: 'utf8', env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /environment variable LOCAL_REHEARSAL_DATABASE_URL is required/);
});
