import { runDatabaseMigrations } from '../database/migration-entry.ts';

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MigrationChecksumMismatchError,
  MigrationLockUnavailableError,
  planMigrations,
  runMigrations,
  runSeeds,
  type MigrationConnection,
  type MigrationDatabase,
  type MigrationQueryResult,
} from '../database/migration-runner.ts';
interface LedgerRecord {
  version: string;
  name: string;
  checksum: string;
  status: 'applied' | 'failed';
  durationMs: number;
  error: string | null;
}

class FakeMigrationConnection implements MigrationConnection {
  readonly statements: string[] = [];
  readonly ledger = new Map<string, LedgerRecord>();
  lockAvailable = true;
  released = false;
  transactionOpen = false;
  failWhenSqlIncludes: string | null = null;

  async query(sql: string, values: readonly unknown[] = []): Promise<MigrationQueryResult> {
    this.statements.push(sql);
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (normalized.startsWith('SELECT pg_try_advisory_lock')) {
      return { rows: [{ acquired: this.lockAvailable }] };
    }
    if (normalized.startsWith('SELECT pg_advisory_unlock')) return { rows: [{ released: true }] };
    if (normalized.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) return { rows: [] };
    if (normalized.startsWith('SELECT version, name, checksum, status FROM schema_migrations')) {
      const record = this.ledger.get(String(values[0]));
      return { rows: record ? [{ version: record.version, name: record.name, checksum: record.checksum, status: record.status }] : [] };
    }
    if (normalized === 'BEGIN') {
      assert.equal(this.transactionOpen, false, 'migration transactions must not overlap');
      this.transactionOpen = true;
      return { rows: [] };
    }
    if (normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      assert.equal(this.transactionOpen, true, `${normalized} requires an open transaction`);
      this.transactionOpen = false;
      return { rows: [] };
    }
    if (normalized.startsWith('INSERT INTO schema_migrations')) {
      const [version, name, checksum, durationMs, error] = values;
      this.ledger.set(String(version), {
        version: String(version),
        name: String(name),
        checksum: String(checksum),
        status: normalized.includes("'failed'") ? 'failed' : 'applied',
        durationMs: Number(durationMs),
        error: error == null ? null : String(error),
      });
      return { rows: [] };
    }
    if (this.failWhenSqlIncludes && sql.includes(this.failWhenSqlIncludes)) {
      throw new Error(`forced failure for ${this.failWhenSqlIncludes}`);
    }
    return { rows: [] };
  }

  release(): void {
    this.released = true;
  }
}

class FakeMigrationDatabase implements MigrationDatabase {
  readonly client = new FakeMigrationConnection();

  async connect(): Promise<MigrationConnection> {
    return this.client;
  }
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sqlDir(prefix: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

test('applies migrations in version order and records ledger rows', async () => {
  const migrationsDir = sqlDir('migration-order', {
    '002_second.sql': 'CREATE TABLE second_table ();',
    '001_first.sql': 'CREATE TABLE first_table ();',
  });
  const database = new FakeMigrationDatabase();

  const result = await runMigrations({ database, migrationsDir });

  assert.deepEqual(result.applied, ['001_first.sql', '002_second.sql']);
  assert.deepEqual(result.skipped, []);
  assert.equal(database.client.ledger.get('001')?.status, 'applied');
  assert.equal(database.client.ledger.get('002')?.status, 'applied');
  assert.ok(database.client.statements.indexOf('CREATE TABLE first_table ();') < database.client.statements.indexOf('CREATE TABLE second_table ();'));
  assert.equal(database.client.released, true);
});

test('orders non-padded migration versions numerically', async () => {
  const migrationsDir = sqlDir('migration-numeric-order', {
    '10_tenth.sql': 'CREATE TABLE tenth_table ();',
    '2_second.sql': 'CREATE TABLE second_table ();',
  });
  const database = new FakeMigrationDatabase();

  const result = await runMigrations({ database, migrationsDir });

  assert.deepEqual(result.applied, ['2_second.sql', '10_tenth.sql']);
});

test('rejects checksum drift for an applied migration', async () => {
  const migrationsDir = sqlDir('migration-drift', {
    '001_initial.sql': 'CREATE TABLE stable_table ();',
  });
  const database = new FakeMigrationDatabase();

  await runMigrations({ database, migrationsDir });
  writeFileSync(join(migrationsDir, '001_initial.sql'), 'CREATE TABLE changed_table ();');

  await assert.rejects(
    () => runMigrations({ database, migrationsDir }),
    MigrationChecksumMismatchError,
  );
  assert.ok(!database.client.statements.includes('CREATE TABLE changed_table ();'));
});

test('builds a dry-run migration plan without opening a database connection', () => {
  const migrationsDir = sqlDir('migration-plan', {
    '10_tenth.sql': 'CREATE TABLE tenth_table ();',
    '2_second.sql': 'CREATE TABLE second_table ();',
  });
  const plan = planMigrations(migrationsDir);

  assert.deepEqual(plan.migrations.map((migration) => migration.fileName), ['2_second.sql', '10_tenth.sql']);
  assert.ok(plan.migrations.every((migration) => migration.checksum.startsWith('sha256:')));
});

test('records a failed migration and stops before later files', async () => {
  const migrationsDir = sqlDir('migration-failure', {
    '001_before.sql': 'CREATE TABLE before_table ();',
    '002_break.sql': 'FAIL_MIGRATION;',
    '003_after.sql': 'CREATE TABLE after_table ();',
  });
  const database = new FakeMigrationDatabase();
  database.client.failWhenSqlIncludes = 'FAIL_MIGRATION';

  await assert.rejects(() => runMigrations({ database, migrationsDir }), /forced failure/);

  assert.equal(database.client.ledger.get('001')?.status, 'applied');
  assert.equal(database.client.ledger.get('002')?.status, 'failed');
  assert.equal(database.client.ledger.get('002')?.error, 'forced failure for FAIL_MIGRATION');
  assert.ok(!database.client.statements.includes('CREATE TABLE after_table ();'));
});

test('fails before running migrations when another migrator holds the advisory lock', async () => {
  const migrationsDir = sqlDir('migration-lock', {
    '001_initial.sql': 'CREATE TABLE locked_table ();',
  });
  const database = new FakeMigrationDatabase();
  database.client.lockAvailable = false;

  await assert.rejects(() => runMigrations({ database, migrationsDir }), MigrationLockUnavailableError);
  assert.ok(!database.client.statements.includes('CREATE TABLE locked_table ();'));
  assert.equal(database.client.released, true);
});

test('keeps seed execution explicit and rehearses an existing legacy schema idempotently', async () => {
  const migrationsDir = sqlDir('legacy-rehearsal', {
    '001_legacy_schema.sql': 'CREATE TABLE IF NOT EXISTS legacy_table ();',
  });
  const seedDir = sqlDir('seed-files', {
    '001_fixture.sql': 'INSERT INTO legacy_table VALUES (1);',
  });
  const database = new FakeMigrationDatabase();

  const first = await runMigrations({ database, migrationsDir });
  const second = await runMigrations({ database, migrationsDir });

  assert.deepEqual(first.applied, ['001_legacy_schema.sql']);
  assert.deepEqual(second.skipped, ['001_legacy_schema.sql']);
  assert.ok(!database.client.statements.includes('INSERT INTO legacy_table VALUES (1);'));

  await runSeeds({ database, seedDir });
  assert.ok(database.client.statements.includes('INSERT INTO legacy_table VALUES (1);'));
});

test('production migration entry applies only migrations and never auto-runs seed files', async () => {
  const migrationsDir = sqlDir('production-migrations', {
    '001_schema.sql': 'CREATE TABLE production_table ();',
  });
  const database = new FakeMigrationDatabase();

  await runDatabaseMigrations(database, migrationsDir);

  assert.ok(database.client.statements.includes('CREATE TABLE production_table ();'));
  assert.ok(!database.client.statements.some((statement) => statement.includes('seed@user-research.local')));
});
