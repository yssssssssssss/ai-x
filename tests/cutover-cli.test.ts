import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import {
  evidenceFromOperatorInput,
  loadCutoverOperatorInput,
  type CutoverOperatorInput,
} from '../apps/orchestrator-runtime/src/cutover/cutover-input.ts';
import { CutoverGateError, type CutoverEvidence } from '../apps/orchestrator-runtime/src/cutover/cutover-service.ts';
import { runCutoverHttpSmoke } from '../apps/orchestrator-runtime/src/cutover/cutover-smoke.ts';

function validInput(overrides: Partial<CutoverOperatorInput> = {}): CutoverOperatorInput {
  return {
    release: {
      releaseId: 'release-2026-08-09-clean-cutover',
      commit: 'ee92db7',
      contractVersions: ['api-contract:0.0.1', 'audit-machine-v1', 'audit-batch-v1'],
      blockersClosed: [29, 30, 31, 32, 33, 34, 35],
    },
    maintenance: { oldWritesStopped: true, windowId: 'mw-2026-08-09' },
    backup: {
      database: { uri: 's3://backup/db.dump', sha256: `sha256:${'1'.repeat(64)}`, restoreChecked: true },
      workspace: { uri: 's3://backup/workspace.tar', sha256: `sha256:${'2'.repeat(64)}`, restoreChecked: true },
      audit: { uri: 's3://backup/audit.tar', sha256: `sha256:${'3'.repeat(64)}`, restoreChecked: true },
    },
    migrations: {
      emptyRehearsal: true,
      legacySnapshotRehearsal: true,
      productionApplied: true,
      ledgerFrozen: true,
      schemaVersion: '003',
      contractVersionVerified: true,
    },
    readOnlySmoke: {
      schema: true,
      artifactStorage: true,
      legacyReads: true,
      legacyMutation410: true,
      oldRoutesAbsent: true,
      stagingReconcile: true,
    },
    workflowSmoke: {
      nonGold: true,
      select: true,
      confirm: true,
      claim: true,
      execute: true,
      evidence: true,
      report: true,
      auditSeal: true,
      notGoldSlot: true,
    },
    rejectionProbes: {
      doubleExecuteRejected: true,
      oldVersionRejected: true,
      missingGateRejected: true,
      fakeMismatchRejected: true,
      modelDriftRejected: true,
      fabricatedEvidenceRejected: true,
      singleExecutionClaim: true,
    },
    operator: { goNoGo: 'GO', operatorId: 'ops-1', recordedAt: '2026-08-09T00:00:00.000Z' },
    firstWrite: { occurred: false },
    ...overrides,
  };
}

function hashBytes(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

test('operator backupFiles derive SHA-256 digests and byte counts from local files', () => {
  const root = mkdtempSync(join(tmpdir(), 'cutover-input-backups-'));
  try {
    const database = join(root, 'db.dump');
    const workspace = join(root, 'workspace.tar');
    const audit = join(root, 'audit.tar');
    writeFileSync(database, 'database-backup');
    writeFileSync(workspace, 'workspace-backup');
    writeFileSync(audit, 'audit-backup');

    const evidence = evidenceFromOperatorInput(validInput({
      backup: undefined,
      backupFiles: {
        database: { path: database, uri: 'file://db.dump', restoreChecked: true },
        workspace: { path: workspace, uri: 'file://workspace.tar', restoreChecked: true },
        audit: { path: audit, uri: 'file://audit.tar', restoreChecked: true },
      },
    }));

    assert.deepEqual(evidence.backup.database, {
      uri: 'file://db.dump',
      sha256: hashBytes('database-backup'),
      bytes: 15,
      restoreChecked: true,
    });
    assert.deepEqual(evidence.backup.workspace, {
      uri: 'file://workspace.tar',
      sha256: hashBytes('workspace-backup'),
      bytes: 16,
      restoreChecked: true,
    });
    assert.deepEqual(evidence.backup.audit, {
      uri: 'file://audit.tar',
      sha256: hashBytes('audit-backup'),
      bytes: 12,
      restoreChecked: true,
    });
    assert.equal('backupFiles' in evidence, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('operator input fails closed when backup restore check is false', () => {
  assert.throws(
    () => evidenceFromOperatorInput(validInput({ backup: { ...validInput().backup as CutoverEvidence['backup'], audit: { uri: 's3://backup/audit.tar', sha256: `sha256:${'3'.repeat(64)}`, restoreChecked: false } } })),
    (error: unknown) => error instanceof CutoverGateError && error.message.includes('backup.audit.restoreChecked'),
  );
});

test('operator JSON input loads from disk and preserves release id', () => {
  const root = mkdtempSync(join(tmpdir(), 'cutover-input-json-'));
  try {
    const path = join(root, 'input.json');
    writeFileSync(path, `${JSON.stringify(validInput({ release: { ...validInput().release, releaseId: 'release-from-json' } }))}\n`);

    const input = loadCutoverOperatorInput(path);

    assert.equal(input.release.releaseId, 'release-from-json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function withSmokeServer(
  configure: (app: express.Express, seenHeaders: Array<Record<string, string | undefined>>) => void,
  run: (baseUrl: string, seenHeaders: Array<Record<string, string | undefined>>) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  const seenHeaders: Array<Record<string, string | undefined>> = [];
  configure(app, seenHeaders);
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`, seenHeaders);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('cutover HTTP smoke records local health, legacy mutation, and old route probes', async () => {
  await withSmokeServer(
    (app, seenHeaders) => {
      app.get('/api/healthz', (_req, res) => res.sendStatus(200));
      app.post('/api/tasks/:taskId/execute', (req, res) => {
        seenHeaders.push({ authorization: req.header('authorization'), contentType: req.header('content-type') });
        res.sendStatus(410);
      });
      app.post('/api/legacy/tasks/:taskId/execute', (req, res) => {
        seenHeaders.push({ authorization: req.header('authorization'), contentType: req.header('content-type') });
        res.sendStatus(404);
      });
    },
    async (baseUrl, seenHeaders) => {
      const result = await runCutoverHttpSmoke({ baseUrl, bearerToken: 'smoke-token', taskId: 'task-123' });

      assert.deepEqual(result, { healthz: true, legacyMutation410: true, oldRoute404: true });
      assert.deepEqual(seenHeaders, [
        { authorization: 'Bearer smoke-token', contentType: 'application/json' },
        { authorization: 'Bearer smoke-token', contentType: 'application/json' },
      ]);
    },
  );
});

test('cutover HTTP smoke fails closed when legacy mutation is not gone', async () => {
  await withSmokeServer(
    (app) => {
      app.get('/api/healthz', (_req, res) => res.sendStatus(200));
      app.post('/api/tasks/:taskId/execute', (_req, res) => res.sendStatus(200));
      app.post('/api/legacy/tasks/:taskId/execute', (_req, res) => res.sendStatus(404));
    },
    async (baseUrl) => {
      await assert.rejects(
        runCutoverHttpSmoke({ baseUrl, bearerToken: 'smoke-token', taskId: 'task-123' }),
        /legacy mutation expected 410/,
      );
    },
  );
});

test('cutover prepare CLI seals checklist from operator input', () => {
  const root = mkdtempSync(join(tmpdir(), 'cutover-cli-prepare-'));
  try {
    const inputPath = join(root, 'input.json');
    const auditRoot = join(root, 'audit');
    writeFileSync(inputPath, `${JSON.stringify(validInput(), null, 2)}\n`);

    const result = spawnSync(process.execPath, [
      '--import', 'tsx',
      'apps/orchestrator-runtime/src/cutover/cutover-cli.ts',
      'prepare',
      '--input', inputPath,
      '--audit-root', auditRoot,
    ], { cwd: process.cwd(), encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /decision=GO/);
    assert.equal(existsSync(join(auditRoot, 'cutovers', 'release-2026-08-09-clean-cutover', 'cutover-checklist.json')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cutover prepare CLI exits non-zero on NO_GO and does not seal checklist', () => {
  const root = mkdtempSync(join(tmpdir(), 'cutover-cli-nogo-'));
  try {
    const inputPath = join(root, 'input.json');
    const auditRoot = join(root, 'audit');
    writeFileSync(inputPath, `${JSON.stringify(validInput({ operator: { goNoGo: 'NO_GO', operatorId: 'ops-1', recordedAt: '2026-08-09T00:00:00.000Z' } }), null, 2)}\n`);

    const result = spawnSync(process.execPath, [
      '--import', 'tsx',
      'apps/orchestrator-runtime/src/cutover/cutover-cli.ts',
      'prepare',
      '--input', inputPath,
      '--audit-root', auditRoot,
    ], { cwd: process.cwd(), encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /operator.goNoGo/);
    assert.equal(existsSync(join(auditRoot, 'cutovers', 'release-2026-08-09-clean-cutover', 'cutover-checklist.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cutover verify CLI accepts sealed checklist and rejects tampering', () => {
  const root = mkdtempSync(join(tmpdir(), 'cutover-cli-verify-'));
  try {
    const inputPath = join(root, 'input.json');
    const auditRoot = join(root, 'audit');
    writeFileSync(inputPath, `${JSON.stringify(validInput(), null, 2)}\n`);
    const prepare = spawnSync(process.execPath, [
      '--import', 'tsx',
      'apps/orchestrator-runtime/src/cutover/cutover-cli.ts',
      'prepare',
      '--input', inputPath,
      '--audit-root', auditRoot,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(prepare.status, 0, prepare.stderr || prepare.stdout);

    const directory = join(auditRoot, 'cutovers', 'release-2026-08-09-clean-cutover');
    const verify = spawnSync(process.execPath, [
      '--import', 'tsx',
      'apps/orchestrator-runtime/src/cutover/cutover-cli.ts',
      'verify',
      '--directory', directory,
    ], { cwd: process.cwd(), encoding: 'utf8' });

    assert.equal(verify.status, 0, verify.stderr || verify.stdout);
    assert.match(verify.stdout, /verified=true/);

    const checklist = join(directory, 'cutover-checklist.json');
    writeFileSync(checklist, readFileSync(checklist, 'utf8').replace('FULL_ROLLBACK_ALLOWED', 'ROLL_FORWARD_ONLY'));
    const tampered = spawnSync(process.execPath, [
      '--import', 'tsx',
      'apps/orchestrator-runtime/src/cutover/cutover-cli.ts',
      'verify',
      '--directory', directory,
    ], { cwd: process.cwd(), encoding: 'utf8' });

    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /cutover checklist hash/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
