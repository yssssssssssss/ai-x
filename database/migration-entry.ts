import { runMigrations, runSeeds } from './migration-runner.ts';
import type { MigrationDatabase, MigrationRunResult } from './migration-runner.ts';

export function runDatabaseMigrations(
  database: MigrationDatabase,
  migrationsDir: string,
  log: (line: string) => void = () => undefined,
): Promise<MigrationRunResult> {
  return runMigrations({ database, migrationsDir, log });
}

export function runDatabaseSeeds(
  database: MigrationDatabase,
  seedDir: string,
  log: (line: string) => void = () => undefined,
): Promise<MigrationRunResult> {
  return runSeeds({ database, seedDir, log });
}
