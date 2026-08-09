import type { Pool } from 'pg';
import type { MigrationConnection, MigrationDatabase } from './migration-runner.ts';

export function createPostgresMigrationDatabase(pool: Pool): MigrationDatabase {
  return {
    async connect(): Promise<MigrationConnection> {
      const client = await pool.connect();
      return {
        async query(sql, values = []) {
          const result = await client.query(sql, [...values]);
          return { rows: result.rows };
        },
        release() {
          client.release();
        },
      };
    },
  };
}
