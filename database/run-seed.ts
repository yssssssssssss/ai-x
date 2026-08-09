import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { closePool, pool } from './db.ts';
import { runDatabaseSeeds } from './migration-entry.ts';
import { createPostgresMigrationDatabase } from './postgres-migration-database.ts';

const here = dirname(fileURLToPath(import.meta.url));

export async function main(): Promise<void> {
  console.log('running development/test seeds...');
  const result = await runDatabaseSeeds(
    createPostgresMigrationDatabase(pool),
    `${here}/seed`,
    console.log,
  );
  console.log(`done. applied=${result.applied.length}`);
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  main()
    .catch((err) => {
      console.error('seed failed:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(closePool);
}
