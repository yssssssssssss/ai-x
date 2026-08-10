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
  const evidence = { ...input, backup } as CutoverEvidence;
  validateCutoverEvidence(evidence);
  return evidence;
}
