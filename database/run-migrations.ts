import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { closePool, pool } from './db.ts';
import { runDatabaseMigrations } from './migration-entry.ts';
import { planMigrations } from './migration-runner.ts';
import { createPostgresMigrationDatabase } from './postgres-migration-database.ts';

const here = dirname(fileURLToPath(import.meta.url));

export async function main(): Promise<void> {
  const migrationsDir = `${here}/migrations`;
  if (process.argv.includes('--dry-run')) {
    const plan = planMigrations(migrationsDir);
    console.log(`migration dry-run: ${plan.migrations.length} files`);
    for (const migration of plan.migrations) {
      console.log(`  [plan] ${migration.version} ${migration.fileName} ${migration.checksum}`);
    }
    return;
  }

  console.log('running migrations...');
  const result = await runDatabaseMigrations(
    createPostgresMigrationDatabase(pool),
    migrationsDir,
    console.log,
  );
  console.log(`done. applied=${result.applied.length} skipped=${result.skipped.length}`);
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  main()
    .catch((err) => {
      console.error('migration failed:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(closePool);
}
