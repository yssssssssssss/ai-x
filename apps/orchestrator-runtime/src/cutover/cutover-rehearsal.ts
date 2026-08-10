import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { runCutoverHttpSmoke } from './cutover-smoke.ts';

export class LocalRehearsalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalRehearsalError';
  }
}

export interface LocalBackupEvidence {
  uri: string;
  sha256: string;
  bytes: number;
  restoreChecked: true;
}

export interface LocalRehearsalManifest {
  version: 'cutover-rehearsal-v1';
  releaseId: string;
  commit: string;
  environment: 'local';
  goLiveEligible: false;
  notProductionEvidence: true;
  notGoldSlot: true;
  backups: Record<'database' | 'workspace' | 'audit', LocalBackupEvidence>;
  httpSmoke: { healthz: true; legacyMutation410: true; oldRoute404: true };
  manifestHash: string;
}

export interface CommandResult {
  status: number;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
) => CommandResult;

const nodeCommandRunner: CommandRunner = (command, args, options) => {
  const result = spawnSync(command, args, { encoding: 'utf8', env: options?.env ?? process.env });
  return { status: result.status ?? 1, stderr: result.stderr || result.error?.message || '' };
};

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

function hashFile(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function backupEvidence(path: string): LocalBackupEvidence {
  return { uri: pathToFileURL(path).href, sha256: hashFile(path), bytes: statSync(path).size, restoreChecked: true };
}

function runOrThrow(runner: CommandRunner, command: string, args: string[], env?: NodeJS.ProcessEnv): void {
  const result = runner(command, args, { env });
  if (result.status !== 0) throw new LocalRehearsalError(`${command} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
}

function fileManifest(root: string, relative = ''): Array<{ path: string; sha256: string; bytes: number }> {
  const directory = join(root, relative);
  const entries: Array<{ path: string; sha256: string; bytes: number }> = [];
  for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const itemRelative = relative ? join(relative, item.name) : item.name;
    if (item.isSymbolicLink()) throw new LocalRehearsalError(`symbolic links are not allowed in rehearsal backups: ${itemRelative}`);
    if (item.isDirectory()) entries.push(...fileManifest(root, itemRelative));
    else if (item.isFile()) {
      const path = join(root, itemRelative);
      entries.push({ path: itemRelative, sha256: hashFile(path), bytes: statSync(path).size });
    }
  }
  return entries;
}

export function archiveAndRestoreDirectory(input: {
  name: 'workspace' | 'audit';
  source: string;
  backupDirectory: string;
  runner?: CommandRunner;
}): LocalBackupEvidence {
  if (!existsSync(input.source) || !statSync(input.source).isDirectory()) throw new LocalRehearsalError(`${input.name} source directory is missing`);
  const runner = input.runner ?? nodeCommandRunner;
  mkdirSync(input.backupDirectory, { recursive: true });
  const archive = join(input.backupDirectory, `${input.name}.tar.gz`);
  runOrThrow(runner, 'tar', ['-czf', archive, '-C', dirname(input.source), basename(input.source)]);
  const restoreRoot = mkdtempSync(join(tmpdir(), `cutover-${input.name}-restore-`));
  try {
    runOrThrow(runner, 'tar', ['-xzf', archive, '-C', restoreRoot]);
    const restored = join(restoreRoot, basename(input.source));
    if (JSON.stringify(fileManifest(input.source)) !== JSON.stringify(fileManifest(restored))) {
      throw new LocalRehearsalError(`${input.name} restore manifest does not match source`);
    }
    return backupEvidence(archive);
  } finally {
    rmSync(restoreRoot, { recursive: true, force: true });
  }
}

export function backupAndRestoreLocalDatabase(input: {
  databaseUrl: string;
  backupDirectory: string;
  runner?: CommandRunner;
  temporaryDatabaseName?: string;
}): LocalBackupEvidence {
  const sourceUrl = assertLoopbackUrl(input.databaseUrl, 'database');
  const password = decodeURIComponent(sourceUrl.password);
  sourceUrl.password = '';
  const runner = input.runner ?? nodeCommandRunner;
  const temporaryDatabaseName = input.temporaryDatabaseName ?? `cutover_rehearsal_${randomUUID().replaceAll('-', '')}`;
  const temporaryUrl = new URL(sourceUrl);
  temporaryUrl.pathname = `/${temporaryDatabaseName}`;
  const env = { ...process.env, ...(password ? { PGPASSWORD: password } : {}) };
  mkdirSync(input.backupDirectory, { recursive: true });
  const dump = join(input.backupDirectory, 'database.dump');
  runOrThrow(runner, 'pg_dump', ['--format=custom', `--file=${dump}`, `--dbname=${sourceUrl.toString()}`], env);
  let databaseCreated = false;
  let primaryError: unknown;
  try {
    runOrThrow(runner, 'createdb', [`--maintenance-db=${sourceUrl.toString()}`, temporaryDatabaseName], env);
    databaseCreated = true;
    runOrThrow(runner, 'pg_restore', ['--exit-on-error', `--dbname=${temporaryUrl.toString()}`, dump], env);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (databaseCreated) {
      const dropped = runner('dropdb', ['--if-exists', `--maintenance-db=${sourceUrl.toString()}`, temporaryDatabaseName], { env });
      if (dropped.status !== 0 && !primaryError) throw new LocalRehearsalError(`dropdb failed: ${dropped.stderr.trim() || `exit ${dropped.status}`}`);
    }
  }
  if (!existsSync(dump)) throw new LocalRehearsalError('pg_dump did not create a backup file');
  return backupEvidence(dump);
}

function validateManifest(manifest: LocalRehearsalManifest): void {
  if (manifest.version !== 'cutover-rehearsal-v1') throw new LocalRehearsalError('rehearsal version is invalid');
  if (manifest.environment !== 'local') throw new LocalRehearsalError('rehearsal environment must be local');
  if (manifest.goLiveEligible !== false) throw new LocalRehearsalError('local rehearsal cannot be go-live eligible');
  if (manifest.notProductionEvidence !== true) throw new LocalRehearsalError('local rehearsal must be marked non-production');
  if (manifest.notGoldSlot !== true) throw new LocalRehearsalError('local rehearsal must not be a Gold slot');
  if (!manifest.releaseId.trim() || !manifest.commit.trim()) throw new LocalRehearsalError('releaseId and commit are required');
  for (const [name, backup] of Object.entries(manifest.backups)) {
    if (!/^sha256:[0-9a-f]{64}$/.test(backup.sha256)) throw new LocalRehearsalError(`${name} backup SHA-256 is invalid`);
    if (!backup.uri || backup.bytes < 0 || backup.restoreChecked !== true) throw new LocalRehearsalError(`${name} backup is not restored`);
  }
}

export function assertLoopbackUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LocalRehearsalError(`${label} URL is invalid`);
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new LocalRehearsalError(`${label} must use a loopback host`);
  }
  return url;
}

function assertOutputRootOutsideSources(outputRoot: string, sources: string[]): void {
  const output = resolve(outputRoot);
  for (const source of sources) {
    const resolvedSource = resolve(source);
    if (output === resolvedSource || output.startsWith(`${resolvedSource}${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new LocalRehearsalError('outputRoot must be outside workspaceRoot and auditRoot');
    }
  }
}

export function sealLocalRehearsal(input: {
  outputRoot: string;
  releaseId: string;
  commit: string;
  backups: LocalRehearsalManifest['backups'];
  httpSmoke: LocalRehearsalManifest['httpSmoke'];
}): { directory: string; manifest: LocalRehearsalManifest } {
  const directory = join(input.outputRoot, input.releaseId);
  if (existsSync(join(directory, 'rehearsal-checklist.json'))) throw new LocalRehearsalError(`rehearsal package already exists: ${input.releaseId}`);
  const draft = {
    version: 'cutover-rehearsal-v1' as const,
    releaseId: input.releaseId,
    commit: input.commit,
    environment: 'local' as const,
    goLiveEligible: false as const,
    notProductionEvidence: true as const,
    notGoldSlot: true as const,
    backups: input.backups,
    httpSmoke: input.httpSmoke,
  };
  const manifest: LocalRehearsalManifest = { ...draft, manifestHash: hashJson(draft) };
  validateManifest(manifest);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'rehearsal-checklist.json'), `${JSON.stringify(stable(manifest), null, 2)}\n`);
  return { directory, manifest };
}

export async function runLocalRehearsal(input: {
  releaseId: string;
  commit: string;
  baseUrl: string;
  bearerToken: string;
  smokeTaskId: string;
  databaseUrl: string;
  workspaceRoot: string;
  auditRoot: string;
  outputRoot: string;
  databaseRunner?: CommandRunner;
}): Promise<{ directory: string; manifest: LocalRehearsalManifest }> {
  assertOutputRootOutsideSources(input.outputRoot, [input.workspaceRoot, input.auditRoot]);
  assertLoopbackUrl(input.baseUrl, 'API');
  assertLoopbackUrl(input.databaseUrl, 'database');
  const directory = join(input.outputRoot, input.releaseId);
  const backupDirectory = join(directory, 'backups');
  if (existsSync(join(directory, 'rehearsal-checklist.json'))) {
    throw new LocalRehearsalError(`rehearsal package already exists: ${input.releaseId}`);
  }
  const database = backupAndRestoreLocalDatabase({
    databaseUrl: input.databaseUrl,
    backupDirectory,
    runner: input.databaseRunner,
  });
  const workspace = archiveAndRestoreDirectory({ name: 'workspace', source: input.workspaceRoot, backupDirectory });
  const audit = archiveAndRestoreDirectory({ name: 'audit', source: input.auditRoot, backupDirectory });
  const httpSmoke = await runCutoverHttpSmoke({
    baseUrl: input.baseUrl,
    bearerToken: input.bearerToken,
    taskId: input.smokeTaskId,
  });
  return sealLocalRehearsal({
    outputRoot: input.outputRoot,
    releaseId: input.releaseId,
    commit: input.commit,
    backups: { database, workspace, audit },
    httpSmoke,
  });
}

export function verifyLocalRehearsal(directory: string): LocalRehearsalManifest {
  const path = join(directory, 'rehearsal-checklist.json');
  if (!existsSync(path)) throw new LocalRehearsalError('rehearsal checklist is missing');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as LocalRehearsalManifest;
  const { manifestHash, ...draft } = manifest;
  if (manifestHash !== hashJson(draft)) throw new LocalRehearsalError('rehearsal manifest hash is invalid');
  validateManifest(manifest);
  return manifest;
}
