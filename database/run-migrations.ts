import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from './db.ts';

// SQL runner:按文件名顺序执行 migrations/*.sql,再执行 seed/*.sql。
// migration 全用 IF NOT EXISTS、seed 全用 ON CONFLICT DO NOTHING,故可重复执行。

const here = dirname(fileURLToPath(import.meta.url));

function runDir(label: string, dir: string): Promise<void>[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    return [];
  }
  return files.map(async (f) => {
    const sql = readFileSync(join(dir, f), 'utf8');
    await pool.query(sql);
    console.log(`  [${label}] applied ${f}`);
  });
}

async function main(): Promise<void> {
  console.log('running migrations...');
  for (const p of runDir('migrate', join(here, 'migrations'))) await p;
  console.log('running seed...');
  for (const p of runDir('seed', join(here, 'seed'))) await p;
  console.log('done.');
}

main()
  .catch((err) => {
    console.error('migration failed:', err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
