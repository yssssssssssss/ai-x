import type { MigrationDatabase } from './migration-runner.ts';
import type {
  GoldBatchStore,
  GoldPins,
  GoldReviewerAuthority,
} from '../apps/orchestrator-runtime/src/gold/gold-batch-service.ts';

interface QueryConnection {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(): void;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`gold batch query missing ${field}`);
  return value;
}

function asNumber(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`gold batch query missing ${field}`);
  return parsed;
}

export class PostgresGoldBatchStore implements GoldBatchStore {
  constructor(private readonly database: MigrationDatabase) {}

  private async transaction<T>(work: (connection: QueryConnection) => Promise<T>): Promise<T> {
    const connection = await this.database.connect();
    try {
      await connection.query('BEGIN');
      const result = await work(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  async createBatch(input: { batchId: string; pinsHash: string; pins: GoldPins }): Promise<void> {
    await this.transaction(async (connection) => {
      const batch = await connection.query(
        `INSERT INTO gold_batches
           (batch_key, pins_json, pins_hash, machine_state, scenario_id, scenario_input_hash)
         VALUES ($1, $2, $3, 'COLLECTING', $4, $5)
         RETURNING id`,
        [input.batchId, JSON.stringify(input.pins), input.pinsHash, input.pins.scenarioId, input.pins.scenarioInputHash],
      );
      const batchId = asString(batch.rows[0]?.id, 'id');
      for (const slotNo of [1, 2, 3]) {
        await connection.query(
          `INSERT INTO gold_batch_slots (batch_id, slot_no, state) VALUES ($1, $2, 'OPEN')`,
          [batchId, slotNo],
        );
      }
    });
  }

  async getBatch(batchKey: string): Promise<{ pinsHash: string; state: string; decision: string | null } | null> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT pins_hash, machine_state, p0_decision FROM gold_batches WHERE batch_key = $1`,
        [batchKey],
      );
      const row = result.rows[0];
      return row
        ? { pinsHash: asString(row.pins_hash, 'pins_hash'), state: asString(row.machine_state, 'machine_state'), decision: typeof row.p0_decision === 'string' ? row.p0_decision : null }
        : null;
    } finally {
      connection.release();
    }
  }

  async getSlots(batchKey: string): Promise<Array<{
    slotNo: number;
    attemptId: string | null;
    reportPackageId: string | null;
    state: string;
    infraRetries: number;
  }>> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT slot.slot_no, slot.capability_attempt_id, slot.report_package_artifact_id,
                slot.state, slot.infra_retries
         FROM gold_batch_slots AS slot
         JOIN gold_batches AS batch ON batch.id = slot.batch_id
         WHERE batch.batch_key = $1 ORDER BY slot.slot_no`,
        [batchKey],
      );
      return result.rows.map((row) => ({
        slotNo: asNumber(row.slot_no, 'slot_no'),
        attemptId: typeof row.capability_attempt_id === 'string' ? row.capability_attempt_id : null,
        reportPackageId: typeof row.report_package_artifact_id === 'string'
          ? row.report_package_artifact_id
          : null,
        state: asString(row.state, 'state'),
        infraRetries: asNumber(row.infra_retries, 'infra_retries'),
      }));
    } finally {
      connection.release();
    }
  }

  async updateSlot(batchKey: string, slotNo: number, patch: Partial<{
    attemptId: string | null;
    reportPackageId: string | null;
    state: string;
    infraRetries: number;
  }>): Promise<void> {
    const connection = await this.database.connect();
    try {
      await connection.query(
        `UPDATE gold_batch_slots AS slot
         SET capability_attempt_id = COALESCE($3, slot.capability_attempt_id),
             report_package_artifact_id = COALESCE($4, slot.report_package_artifact_id),
             state = COALESCE($5, slot.state),
             infra_retries = COALESCE($6, slot.infra_retries)
         FROM gold_batches AS batch
         WHERE slot.batch_id = batch.id AND batch.batch_key = $1 AND slot.slot_no = $2`,
        [
          batchKey,
          slotNo,
          patch.attemptId ?? null,
          patch.reportPackageId ?? null,
          patch.state ?? null,
          patch.infraRetries ?? null,
        ],
      );
    } finally {
      connection.release();
    }
  }

  async updateBatch(batchKey: string, patch: Partial<{ state: string; decision: string | null }>): Promise<void> {
    const connection = await this.database.connect();
    try {
      await connection.query(
        `UPDATE gold_batches
         SET machine_state = COALESCE($2, machine_state), p0_decision = COALESCE($3, p0_decision), updated_at = now()
         WHERE batch_key = $1`,
        [batchKey, patch.state ?? null, patch.decision ?? null],
      );
    } finally {
      connection.release();
    }
  }

  async appendReview(batchKey: string, review: {
    attemptId: string;
    reviewerId: string;
    authenticated: boolean;
    independence: { capabilityOwner: boolean; operator: boolean; artifactEditor: boolean };
    verdict: string;
  }): Promise<void> {
    const connection = await this.database.connect();
    try {
      await connection.query(
        `INSERT INTO gold_reviews (batch_id, attempt_id, reviewer_user_id, independence_json, verdict)
         SELECT id, $2, $3, $4, $5 FROM gold_batches WHERE batch_key = $1`,
        [batchKey, review.attemptId, review.reviewerId, JSON.stringify({ authenticated: review.authenticated, ...review.independence }), review.verdict],
      );
    } finally {
      connection.release();
    }
  }

  async getReviews(batchKey: string): Promise<Array<{ attemptId: string; reviewerId: string; verdict: string }>> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT review.attempt_id, review.reviewer_user_id, review.verdict
         FROM gold_reviews AS review JOIN gold_batches AS batch ON batch.id = review.batch_id
         WHERE batch.batch_key = $1 ORDER BY review.created_at`,
        [batchKey],
      );
      return result.rows.map((row) => ({
        attemptId: asString(row.attempt_id, 'attempt_id'),
        reviewerId: asString(row.reviewer_user_id, 'reviewer_user_id'),
        verdict: asString(row.verdict, 'verdict'),
      }));
    } finally {
      connection.release();
    }
  }
}

export class PostgresGoldReviewerAuthority implements GoldReviewerAuthority {
  constructor(private readonly database: MigrationDatabase) {}

  async verifyReviewer(input: { reviewerId: string; attemptId: string }): Promise<{
    authenticated: boolean;
    independence: { capabilityOwner: boolean; operator: boolean; artifactEditor: boolean };
  }> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT reviewer.status AS reviewer_status,
                task.owner_user_id = reviewer.id AS capability_owner,
                (
                  EXISTS (
                    SELECT 1 FROM control_commands AS command
                    WHERE command.task_id = task.id AND command.actor_user_id = reviewer.id
                  )
                  OR EXISTS (
                    SELECT 1 FROM control_gate_records AS gate
                    WHERE gate.task_id = task.id AND gate.actor_user_id = reviewer.id
                  )
                ) AS operated_attempt
         FROM users AS reviewer
         JOIN control_execution_attempts AS attempt ON attempt.id = $2
         JOIN control_tasks AS task ON task.id = attempt.task_id
         WHERE reviewer.id = $1`,
        [input.reviewerId, input.attemptId],
      );
      const row = result.rows[0];
      if (!row) {
        return {
          authenticated: false,
          independence: { capabilityOwner: true, operator: true, artifactEditor: true },
        };
      }
      const operated = row.operated_attempt === true;
      return {
        authenticated: row.reviewer_status === 'active',
        independence: {
          capabilityOwner: row.capability_owner === true,
          operator: operated,
          artifactEditor: operated,
        },
      };
    } finally {
      connection.release();
    }
  }
}
