import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PostgresGoldBatchStore,
  PostgresGoldReviewerAuthority,
} from '../database/gold-batch-store.ts';
import type {
  MigrationConnection,
  MigrationDatabase,
} from '../database/migration-runner.ts';

class RecordingDatabase implements MigrationDatabase {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  reviewerRow: Record<string, unknown> | undefined = {
    reviewer_status: 'active',
    capability_owner: false,
    operated_attempt: false,
  };

  async connect(): Promise<MigrationConnection> {
    return {
      query: async (sql, values = []) => {
        this.calls.push({ sql, values });
        if (sql.includes('SELECT slot.slot_no')) {
          return {
            rows: [{
              slot_no: 2,
              capability_attempt_id: 'attempt-2',
              report_package_artifact_id: 'package-2',
              state: 'OPEN',
              infra_retries: 2,
            }],
          };
        }
        if (sql.includes('reviewer.status AS reviewer_status')) {
          return { rows: this.reviewerRow ? [this.reviewerRow] : [] };
        }
        return { rows: [] };
      },
      release() {},
    };
  }
}

test('Postgres Gold slots persist Report Package identity and infra retry count', async () => {
  const database = new RecordingDatabase();
  const store = new PostgresGoldBatchStore(database);

  assert.deepEqual(await store.getSlots('batch-1'), [{
    slotNo: 2,
    attemptId: 'attempt-2',
    reportPackageId: 'package-2',
    state: 'OPEN',
    infraRetries: 2,
  }]);
  await store.updateSlot('batch-1', 2, {
    attemptId: 'attempt-2',
    reportPackageId: 'package-2',
    state: 'SEALED',
    infraRetries: 3,
  });

  const update = database.calls.find(({ sql }) => sql.includes('UPDATE gold_batch_slots'));
  assert.ok(update);
  assert.match(update.sql, /report_package_artifact_id = COALESCE\(\$4/u);
  assert.match(update.sql, /infra_retries = COALESCE\(\$6/u);
  assert.deepEqual(update.values, ['batch-1', 2, 'attempt-2', 'package-2', 'SEALED', 3]);
});

test('Postgres Gold reviewer authority derives active identity and independence from the attempt audit trail', async () => {
  const database = new RecordingDatabase();
  const authority = new PostgresGoldReviewerAuthority(database);

  assert.deepEqual(await authority.verifyReviewer({ reviewerId: 'reviewer-1', attemptId: 'attempt-1' }), {
    authenticated: true,
    independence: { capabilityOwner: false, operator: false, artifactEditor: false },
  });
  const query = database.calls.find(({ sql }) => sql.includes('reviewer.status AS reviewer_status'));
  assert.deepEqual(query?.values, ['reviewer-1', 'attempt-1']);

  database.reviewerRow = {
    reviewer_status: 'active',
    capability_owner: true,
    operated_attempt: true,
  };
  assert.deepEqual(await authority.verifyReviewer({ reviewerId: 'reviewer-1', attemptId: 'attempt-1' }), {
    authenticated: true,
    independence: { capabilityOwner: true, operator: true, artifactEditor: true },
  });
});
