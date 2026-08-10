import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class CutoverGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CutoverGateError';
  }
}

export interface CutoverEvidence {
  release: {
    releaseId: string;
    commit: string;
    contractVersions: string[];
    blockersClosed: number[];
  };
  maintenance: { oldWritesStopped: boolean; windowId: string };
  backup: {
    database: CutoverInventoryItem;
    workspace: CutoverInventoryItem;
    audit: CutoverInventoryItem;
  };
  migrations: {
    emptyRehearsal: boolean;
    legacySnapshotRehearsal: boolean;
    productionApplied: boolean;
    ledgerFrozen: boolean;
    schemaVersion: string;
    contractVersionVerified: boolean;
  };
  readOnlySmoke: {
    schema: boolean;
    artifactStorage: boolean;
    legacyReads: boolean;
    legacyMutation410: boolean;
    oldRoutesAbsent: boolean;
    stagingReconcile: boolean;
  };
  workflowSmoke: {
    nonGold: boolean;
    select: boolean;
    confirm: boolean;
    claim: boolean;
    execute: boolean;
    evidence: boolean;
    report: boolean;
    auditSeal: boolean;
    notGoldSlot: boolean;
  };
  rejectionProbes: {
    doubleExecuteRejected: boolean;
    oldVersionRejected: boolean;
    missingGateRejected: boolean;
    fakeMismatchRejected: boolean;
    modelDriftRejected: boolean;
    fabricatedEvidenceRejected: boolean;
    singleExecutionClaim: boolean;
  };
  operator: { goNoGo: 'GO' | 'NO_GO'; operatorId: string; recordedAt: string };
  firstWrite: { occurred: false } | { occurred: true; contractVersion: string; at: string };
}

export interface CutoverInventoryItem {
  uri: string;
  sha256: string;
  restoreChecked: boolean;
  bytes?: number;
}

interface CutoverManifest {
  version: 'cutover-checklist-v1';
  evidence: CutoverEvidence;
  decision: 'GO';
  rollback: { mode: 'FULL_ROLLBACK_ALLOWED' | 'ROLL_FORWARD_ONLY' };
  legacyWriterAllowed: boolean;
  rollForwardLock: null | { reason: string; contractVersion: string; at: string };
  manifestHash: string;
}

export interface CutoverGoLiveResult {
  decision: 'GO';
  directory: string;
  manifest: CutoverManifest;
  rollback: CutoverManifest['rollback'];
  legacyWriterAllowed: boolean;
  rollForwardLock: CutoverManifest['rollForwardLock'];
}

const REQUIRED_BLOCKERS = [29, 30, 31, 32, 33, 34, 35] as const;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function hashJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')}`;
}

function requireString(value: string, path: string): void {
  if (!value.trim()) throw new CutoverGateError(`${path} is required`);
}

function requireTrue(value: boolean, path: string): void {
  if (!value) throw new CutoverGateError(`${path} is required`);
}

function requireSha256(value: string, path: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new CutoverGateError(`${path} must be a SHA-256 digest`);
}

function requireInventory(item: CutoverInventoryItem, path: string): void {
  requireString(item.uri, `${path}.uri`);
  requireSha256(item.sha256, `${path}.sha256`);
  requireTrue(item.restoreChecked, `${path}.restoreChecked`);
}

export function backupInventoryFromFiles(input: Record<'database' | 'workspace' | 'audit', { path: string; uri: string; restoreChecked: boolean }>): CutoverEvidence['backup'] {
  return {
    database: inventoryItem(input.database),
    workspace: inventoryItem(input.workspace),
    audit: inventoryItem(input.audit),
  };
}

function inventoryItem(input: { path: string; uri: string; restoreChecked: boolean }): CutoverInventoryItem {
  const bytes = readFileSync(input.path);
  return { uri: input.uri, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytes: statSync(input.path).size, restoreChecked: input.restoreChecked };
}

export function assertMigrationPlanFrozen(input: {
  expectedSchemaVersion: string;
  appliedVersions: string[];
  ledgerFrozen: boolean;
  contractVersionVerified: boolean;
}): void {
  if (!input.appliedVersions.includes(input.expectedSchemaVersion)) throw new CutoverGateError(`migrations.schemaVersion ${input.expectedSchemaVersion} was not applied`);
  requireTrue(input.ledgerFrozen, 'migrations.ledgerFrozen');
  requireTrue(input.contractVersionVerified, 'migrations.contractVersionVerified');
}

export function validateCutoverEvidence(evidence: CutoverEvidence): void {
  requireString(evidence.release.releaseId, 'release.releaseId');
  requireString(evidence.release.commit, 'release.commit');
  for (const issue of REQUIRED_BLOCKERS) {
    if (!evidence.release.blockersClosed.includes(issue)) throw new CutoverGateError(`release.blockersClosed missing #${issue}`);
  }
  if (evidence.operator.goNoGo !== 'GO') throw new CutoverGateError('operator.goNoGo must be GO');
  requireString(evidence.operator.operatorId, 'operator.operatorId');
  requireString(evidence.operator.recordedAt, 'operator.recordedAt');
  requireTrue(evidence.maintenance.oldWritesStopped, 'maintenance.oldWritesStopped');
  requireString(evidence.maintenance.windowId, 'maintenance.windowId');
  requireInventory(evidence.backup.database, 'backup.database');
  requireInventory(evidence.backup.workspace, 'backup.workspace');
  requireInventory(evidence.backup.audit, 'backup.audit');

  requireTrue(evidence.migrations.emptyRehearsal, 'migrations.emptyRehearsal');
  requireTrue(evidence.migrations.legacySnapshotRehearsal, 'migrations.legacySnapshotRehearsal');
  requireTrue(evidence.migrations.productionApplied, 'migrations.productionApplied');
  requireTrue(evidence.migrations.ledgerFrozen, 'migrations.ledgerFrozen');
  requireString(evidence.migrations.schemaVersion, 'migrations.schemaVersion');
  requireTrue(evidence.migrations.contractVersionVerified, 'migrations.contractVersionVerified');

  requireTrue(evidence.readOnlySmoke.schema, 'readOnlySmoke.schema');
  requireTrue(evidence.readOnlySmoke.artifactStorage, 'readOnlySmoke.artifactStorage');
  requireTrue(evidence.readOnlySmoke.legacyReads, 'readOnlySmoke.legacyReads');
  requireTrue(evidence.readOnlySmoke.legacyMutation410, 'readOnlySmoke.legacyMutation410');
  requireTrue(evidence.readOnlySmoke.oldRoutesAbsent, 'readOnlySmoke.oldRoutesAbsent');
  requireTrue(evidence.readOnlySmoke.stagingReconcile, 'readOnlySmoke.stagingReconcile');

  requireTrue(evidence.workflowSmoke.nonGold, 'workflowSmoke.nonGold');
  requireTrue(evidence.workflowSmoke.select, 'workflowSmoke.select');
  requireTrue(evidence.workflowSmoke.confirm, 'workflowSmoke.confirm');
  requireTrue(evidence.workflowSmoke.claim, 'workflowSmoke.claim');
  requireTrue(evidence.workflowSmoke.execute, 'workflowSmoke.execute');
  requireTrue(evidence.workflowSmoke.evidence, 'workflowSmoke.evidence');
  requireTrue(evidence.workflowSmoke.report, 'workflowSmoke.report');
  requireTrue(evidence.workflowSmoke.auditSeal, 'workflowSmoke.auditSeal');
  requireTrue(evidence.workflowSmoke.notGoldSlot, 'workflowSmoke.notGoldSlot');

  requireTrue(evidence.rejectionProbes.doubleExecuteRejected, 'rejectionProbes.doubleExecuteRejected');
  requireTrue(evidence.rejectionProbes.oldVersionRejected, 'rejectionProbes.oldVersionRejected');
  requireTrue(evidence.rejectionProbes.missingGateRejected, 'rejectionProbes.missingGateRejected');
  requireTrue(evidence.rejectionProbes.fakeMismatchRejected, 'rejectionProbes.fakeMismatchRejected');
  requireTrue(evidence.rejectionProbes.modelDriftRejected, 'rejectionProbes.modelDriftRejected');
  requireTrue(evidence.rejectionProbes.fabricatedEvidenceRejected, 'rejectionProbes.fabricatedEvidenceRejected');
  requireTrue(evidence.rejectionProbes.singleExecutionClaim, 'rejectionProbes.singleExecutionClaim');
}

export class CutoverService {
  constructor(private readonly options: { auditRoot: string }) {}

  prepareGoLive(evidence: CutoverEvidence): CutoverGoLiveResult {
    validateCutoverEvidence(evidence);
    const rollForwardLock = evidence.firstWrite.occurred
      ? { reason: 'first new contract write observed', contractVersion: evidence.firstWrite.contractVersion, at: evidence.firstWrite.at }
      : null;
    const rollback = { mode: rollForwardLock ? 'ROLL_FORWARD_ONLY' as const : 'FULL_ROLLBACK_ALLOWED' as const };
    const draft = {
      version: 'cutover-checklist-v1' as const,
      evidence,
      decision: 'GO' as const,
      rollback,
      legacyWriterAllowed: !rollForwardLock,
      rollForwardLock,
    };
    const manifest: CutoverManifest = { ...draft, manifestHash: hashJson(draft) };
    const directory = join(this.options.auditRoot, 'cutovers', evidence.release.releaseId);
    if (existsSync(directory)) throw new CutoverGateError(`cutover package already exists: ${evidence.release.releaseId}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'cutover-checklist.json'), `${JSON.stringify(stable(manifest), null, 2)}\n`);
    return { decision: 'GO', directory, manifest, rollback, legacyWriterAllowed: !rollForwardLock, rollForwardLock };
  }

  verifyGoLivePackage(directory: string): CutoverManifest {
    const path = join(directory, 'cutover-checklist.json');
    if (!existsSync(path)) throw new CutoverGateError('cutover checklist is missing');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as CutoverManifest;
    const draft = {
      version: manifest.version,
      evidence: manifest.evidence,
      decision: manifest.decision,
      rollback: manifest.rollback,
      legacyWriterAllowed: manifest.legacyWriterAllowed,
      rollForwardLock: manifest.rollForwardLock,
    };
    if (manifest.manifestHash !== hashJson(draft)) throw new CutoverGateError('cutover checklist hash is invalid');
    validateCutoverEvidence(manifest.evidence);
    return manifest;
  }
}
