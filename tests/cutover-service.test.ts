import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CutoverGateError,
  CutoverService,
  type CutoverEvidence,
} from '../apps/orchestrator-runtime/src/cutover/cutover-service.ts';

function evidence(overrides: Partial<CutoverEvidence> = {}): CutoverEvidence {
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

test('rejects go-live when any backup restore check is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'cutover-red-'));
  try {
    const service = new CutoverService({ auditRoot: root });
    assert.throws(
      () => service.prepareGoLive(evidence({ backup: { ...evidence().backup, audit: { uri: 's3://backup/audit.tar', sha256: `sha256:${'3'.repeat(64)}`, restoreChecked: false } } })),
      (error: unknown) => error instanceof CutoverGateError && error.message.includes('backup.audit.restoreChecked'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects backup inventory without a SHA-256 digest', () => {
  const root = mkdtempSync(join(tmpdir(), 'cutover-hash-'));
  try {
    const service = new CutoverService({ auditRoot: root });
    assert.throws(
      () => service.prepareGoLive(evidence({ backup: { ...evidence().backup, database: { uri: 's3://backup/db.dump', sha256: 'sha256:not-a-digest', restoreChecked: true } } })),
      (error: unknown) => error instanceof CutoverGateError && error.message.includes('backup.database.sha256'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('seals a go-live checklist only after all cutover gates pass', () => {
  const root = mkdtempSync(join(tmpdir(), 'cutover-green-'));
  try {
    const service = new CutoverService({ auditRoot: root });
    const result = service.prepareGoLive(evidence());
    assert.equal(result.decision, 'GO');
    assert.equal(result.rollback.mode, 'FULL_ROLLBACK_ALLOWED');
    assert.equal(result.legacyWriterAllowed, true);
    service.verifyGoLivePackage(result.directory);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('locks out legacy writer after first new contract write and switches to roll-forward', () => {
  const root = mkdtempSync(join(tmpdir(), 'cutover-lock-'));
  try {
    const service = new CutoverService({ auditRoot: root });
    const result = service.prepareGoLive(evidence({ firstWrite: { occurred: true, contractVersion: 'api-contract:0.0.1', at: '2026-08-09T00:05:00.000Z' } }));
    assert.equal(result.rollback.mode, 'ROLL_FORWARD_ONLY');
    assert.equal(result.legacyWriterAllowed, false);
    assert.deepEqual(result.rollForwardLock, {
      reason: 'first new contract write observed',
      contractVersion: 'api-contract:0.0.1',
      at: '2026-08-09T00:05:00.000Z',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses go-live when workflow smoke would count as a Gold slot', () => {
  const root = mkdtempSync(join(tmpdir(), 'cutover-gold-'));
  try {
    const service = new CutoverService({ auditRoot: root });
    assert.throws(
      () => service.prepareGoLive(evidence({ workflowSmoke: { ...evidence().workflowSmoke, notGoldSlot: false } })),
      (error: unknown) => error instanceof CutoverGateError && error.message.includes('workflowSmoke.notGoldSlot'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses operator NO_GO before sealing any go-live package', () => {
  const root = mkdtempSync(join(tmpdir(), 'cutover-nogo-'));
  try {
    const service = new CutoverService({ auditRoot: root });
    assert.throws(
      () => service.prepareGoLive(evidence({ operator: { goNoGo: 'NO_GO', operatorId: 'ops-1', recordedAt: '2026-08-09T00:00:00.000Z' } })),
      (error: unknown) => error instanceof CutoverGateError && error.message.includes('operator.goNoGo'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('detects tampering in sealed cutover checklist', () => {
  const root = mkdtempSync(join(tmpdir(), 'cutover-tamper-'));
  try {
    const service = new CutoverService({ auditRoot: root });
    const result = service.prepareGoLive(evidence());
    const checklist = join(result.directory, 'cutover-checklist.json');
    const tampered = readFileSync(checklist, 'utf8').replace('FULL_ROLLBACK_ALLOWED', 'ROLL_FORWARD_ONLY');
    writeFileSync(checklist, tampered);
    assert.throws(
      () => service.verifyGoLivePackage(result.directory),
      (error: unknown) => error instanceof CutoverGateError && error.message.includes('cutover checklist hash'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
