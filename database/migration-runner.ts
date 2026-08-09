import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface MigrationQueryResult {
  rows: Array<Record<string, unknown>>;
}

export interface MigrationConnection {
  query(sql: string, values?: readonly unknown[]): Promise<MigrationQueryResult>;
  release(): void;
}

export interface MigrationDatabase {
  connect(): Promise<MigrationConnection>;
}

export interface MigrationRunOptions {
  database: MigrationDatabase;
  migrationsDir: string;
  lockKey?: number;
  clock?: () => number;
  log?: (line: string) => void;
}

export interface SeedRunOptions {
  database: MigrationDatabase;
  seedDir: string;
  lockKey?: number;
  log?: (line: string) => void;
}

export interface MigrationRunResult {
  applied: string[];
  skipped: string[];
}


export interface MigrationPlan {
  migrations: Array<{ fileName: string; version: string; name: string; checksum: string }>;
}
interface SqlFile {
  fileName: string;
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

const MIGRATION_LOCK_KEY = 761_830_921;
const SEED_LOCK_KEY = 761_830_922;

const CREATE_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('applied', 'failed')),
  applied_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT
)`;

const LOOKUP_MIGRATION_SQL = `
SELECT version, name, checksum, status
FROM schema_migrations
WHERE version = $1`;

const RECORD_APPLIED_SQL = `
INSERT INTO schema_migrations (version, name, checksum, status, applied_at, failed_at, duration_ms, error)
VALUES ($1, $2, $3, 'applied', now(), NULL, $4, NULL)
ON CONFLICT (version) DO UPDATE
SET name = EXCLUDED.name,
    checksum = EXCLUDED.checksum,
    status = EXCLUDED.status,
    applied_at = EXCLUDED.applied_at,
    failed_at = NULL,
    duration_ms = EXCLUDED.duration_ms,
    error = NULL`;

const RECORD_FAILED_SQL = `
INSERT INTO schema_migrations (version, name, checksum, status, applied_at, failed_at, duration_ms, error)
VALUES ($1, $2, $3, 'failed', NULL, now(), $4, $5)
ON CONFLICT (version) DO UPDATE
SET name = EXCLUDED.name,
    checksum = EXCLUDED.checksum,
    status = EXCLUDED.status,
    failed_at = EXCLUDED.failed_at,
    duration_ms = EXCLUDED.duration_ms,
    error = EXCLUDED.error`;

export class MigrationLockUnavailableError extends Error {
  constructor() {
    super('migration advisory lock is unavailable');
    this.name = 'MigrationLockUnavailableError';
  }
}

export class MigrationChecksumMismatchError extends Error {
  constructor(version: string) {
    super(`migration checksum drift detected for version ${version}`);
    this.name = 'MigrationChecksumMismatchError';
  }
}

export class MigrationFileNameError extends Error {
  constructor(fileName: string) {
    super(`invalid migration file name: ${fileName}`);
    this.name = 'MigrationFileNameError';
  }
}

function sqlFiles(directory: string, requireVersionPrefix: boolean): SqlFile[] {
  let fileNames: string[];
  try {
    fileNames = readdirSync(directory).filter((fileName) => fileName.endsWith('.sql'));
  } catch {
    return [];
  }

  const seenVersions = new Set<string>();
  const files = fileNames.map((fileName) => {
    const match = /^(\d+)_([A-Za-z0-9][A-Za-z0-9_-]*)\.sql$/.exec(fileName);
    if (requireVersionPrefix && !match) throw new MigrationFileNameError(fileName);
    const version = match?.[1] ?? fileName;
    if (seenVersions.has(version)) throw new MigrationFileNameError(fileName);
    seenVersions.add(version);
    const sql = readFileSync(join(directory, fileName), 'utf8');
    return {
      fileName,
      version,
      name: match?.[2] ?? fileName.replace(/\.sql$/, ''),
      sql,
      checksum: `sha256:${createHash('sha256').update(sql).digest('hex')}`,
    };
  });

  return files.sort((left, right) => {
    if (!requireVersionPrefix) return left.fileName.localeCompare(right.fileName);
    return Number(left.version) - Number(right.version) || left.fileName.localeCompare(right.fileName);
  });
}

export function planMigrations(migrationsDir: string): MigrationPlan {
  return {
    migrations: sqlFiles(migrationsDir, true).map(({ fileName, version, name, checksum }) => ({
      fileName,
      version,
      name,
      checksum,
    })),
  };
}

async function acquireLock(connection: MigrationConnection, lockKey: number): Promise<void> {
  const result = await connection.query('SELECT pg_try_advisory_lock($1) AS acquired', [lockKey]);
  if (result.rows[0]?.acquired !== true) throw new MigrationLockUnavailableError();
}

async function runSqlFiles(options: {
  database: MigrationDatabase;
  directory: string;
  lockKey: number;
  requireVersionPrefix: boolean;
  log: (line: string) => void;
  recordLedger: boolean;
  clock: () => number;
}): Promise<MigrationRunResult> {
  const connection = await options.database.connect();
  let lockHeld = false;
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await acquireLock(connection, options.lockKey);
    lockHeld = true;
    if (options.recordLedger) await connection.query(CREATE_LEDGER_SQL);

    for (const file of sqlFiles(options.directory, options.requireVersionPrefix)) {
      if (options.recordLedger) {
        const result = await connection.query(LOOKUP_MIGRATION_SQL, [file.version]);
        const record = result.rows[0];
        if (record) {
          if (record.checksum !== file.checksum) throw new MigrationChecksumMismatchError(file.version);
          if (record.status === 'applied') {
            skipped.push(file.fileName);
            options.log(`  [migrate] skipped ${file.fileName}`);
            continue;
          }
        }
      }

      const startedAt = options.clock();
      let transactionOpen = false;
      try {
        await connection.query('BEGIN');
        transactionOpen = true;
        await connection.query(file.sql);
        if (options.recordLedger) {
          await connection.query(RECORD_APPLIED_SQL, [file.version, file.name, file.checksum, options.clock() - startedAt]);
        }
        await connection.query('COMMIT');
        transactionOpen = false;
        applied.push(file.fileName);
        options.log(`  [${options.recordLedger ? 'migrate' : 'seed'}] applied ${file.fileName}`);
      } catch (error) {
        if (transactionOpen) await connection.query('ROLLBACK');
        if (options.recordLedger) {
          const message = error instanceof Error ? error.message : String(error);
          await connection.query(RECORD_FAILED_SQL, [file.version, file.name, file.checksum, options.clock() - startedAt, message]);
        }
        throw error;
      }
    }

    return { applied, skipped };
  } finally {
    if (lockHeld) await connection.query('SELECT pg_advisory_unlock($1)', [options.lockKey]);
    connection.release();
  }
}

export function runMigrations(options: MigrationRunOptions): Promise<MigrationRunResult> {
  return runSqlFiles({
    database: options.database,
    directory: options.migrationsDir,
    lockKey: options.lockKey ?? MIGRATION_LOCK_KEY,
    requireVersionPrefix: true,
    log: options.log ?? (() => undefined),
    recordLedger: true,
    clock: options.clock ?? Date.now,
  });
}

export function runSeeds(options: SeedRunOptions): Promise<MigrationRunResult> {
  return runSqlFiles({
    database: options.database,
    directory: options.seedDir,
    lockKey: options.lockKey ?? SEED_LOCK_KEY,
    requireVersionPrefix: true,
    log: options.log ?? (() => undefined),
    recordLedger: false,
    clock: Date.now,
  });
}
