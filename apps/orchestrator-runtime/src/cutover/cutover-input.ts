import { readFileSync } from 'node:fs';
import {
  backupInventoryFromFiles,
  type CutoverEvidence,
  validateCutoverEvidence,
} from './cutover-service.ts';

type BackupFiles = Parameters<typeof backupInventoryFromFiles>[0];

export interface CutoverOperatorInput extends Omit<CutoverEvidence, 'backup'> {
  backup?: CutoverEvidence['backup'];
  backupFiles?: BackupFiles;
}

export function loadCutoverOperatorInput(path: string): CutoverOperatorInput {
  return JSON.parse(readFileSync(path, 'utf8')) as CutoverOperatorInput;
}

export function evidenceFromOperatorInput(input: CutoverOperatorInput): CutoverEvidence {
  const backup = input.backupFiles ? backupInventoryFromFiles(input.backupFiles) : input.backup;
  if (!backup) throw new Error('backup or backupFiles is required');
  const evidence: CutoverEvidence = {
    release: input.release,
    maintenance: input.maintenance,
    backup,
    migrations: input.migrations,
    readOnlySmoke: input.readOnlySmoke,
    workflowSmoke: input.workflowSmoke,
    rejectionProbes: input.rejectionProbes,
    operator: input.operator,
    firstWrite: input.firstWrite,
  };
  validateCutoverEvidence(evidence);
  return evidence;
}
