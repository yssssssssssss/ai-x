import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  evidenceFromOperatorInput,
  loadCutoverOperatorInput,
  type CutoverOperatorInput,
} from '../apps/orchestrator-runtime/src/cutover/cutover-input.ts';
import { CutoverGateError, type CutoverEvidence } from '../apps/orchestrator-runtime/src/cutover/cutover-service.ts';

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
