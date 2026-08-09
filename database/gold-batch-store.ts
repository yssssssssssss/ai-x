import type { MigrationDatabase } from './migration-runner.ts';
import type { GoldBatchStore, GoldPins } from '../apps/orchestrator-runtime/src/gold/gold-batch-service.ts';

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

  async getSlots(batchKey: string): Promise<Array<{ slotNo: number; attemptId: string | null; state: string; infraRetries: number }>> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT slot.slot_no, slot.capability_attempt_id, slot.state,
                COALESCE((SELECT COUNT(*) FROM control_execution_attempts attempt
                  WHERE attempt.batch_id = batch.id AND attempt.slot_no = slot.slot_no AND attempt.state = 'paused'), 0) AS infra_retries
         FROM gold_batch_slots AS slot
         JOIN gold_batches AS batch ON batch.id = slot.batch_id
         WHERE batch.batch_key = $1 ORDER BY slot.slot_no`,
        [batchKey],
      );
      return result.rows.map((row) => ({
        slotNo: asNumber(row.slot_no, 'slot_no'),
        attemptId: typeof row.capability_attempt_id === 'string' ? row.capability_attempt_id : null,
        state: asString(row.state, 'state'),
        infraRetries: asNumber(row.infra_retries, 'infra_retries'),
      }));
    } finally {
      connection.release();
    }
  }

  async updateSlot(batchKey: string, slotNo: number, patch: Partial<{ attemptId: string | null; state: string; infraRetries: number }>): Promise<void> {
    void patch.infraRetries;
    const connection = await this.database.connect();
    try {
      await connection.query(
        `UPDATE gold_batch_slots AS slot
         SET capability_attempt_id = COALESCE($3, slot.capability_attempt_id),
             state = COALESCE($4, slot.state)
         FROM gold_batches AS batch
         WHERE slot.batch_id = batch.id AND batch.batch_key = $1 AND slot.slot_no = $2`,
        [batchKey, slotNo, patch.attemptId ?? null, patch.state ?? null],
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

  async appendReview(batchKey: string, review: { attemptId: string; reviewerId: string; verdict: string }): Promise<void> {
    const connection = await this.database.connect();
    try {
      await connection.query(
        `INSERT INTO gold_reviews (batch_id, attempt_id, reviewer_user_id, independence_json, verdict)
         SELECT id, $2, $3, $4, $5 FROM gold_batches WHERE batch_key = $1`,
        [batchKey, review.attemptId, review.reviewerId, JSON.stringify({ validated: true }), review.verdict],
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
