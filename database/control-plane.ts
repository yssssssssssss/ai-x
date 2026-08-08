import type { MigrationConnection, MigrationDatabase } from './migration-runner.ts';

export type ControlTaskState =
  | 'awaiting_selection'
  | 'awaiting_confirmation'
  | 'awaiting_approval'
  | 'ready'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'completed_with_gaps'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export type ControlArtifactState = 'STAGING' | 'SEALED' | 'FAILED';

export interface ControlTask {
  id: string;
  state: ControlTaskState;
  stateVersion: number;
  activePlanVersionId: string | null;
  currentAttemptId: string | null;
}

export interface ControlPlanVersion {
  id: string;
  taskId: string;
  version: number;
  planHash: string;
}

export interface ControlExecutionClaim {
  attemptId: string;
  stateVersion: number;
  replayed: boolean;
}

export interface ControlArtifact {
  id: string;
  taskId: string;
  planVersionId: string | null;
  attemptId: string | null;
  kind: string;
  state: ControlArtifactState;
  storageUri: string;
  contentSha256: string | null;
  byteSize: number | null;
  schemaVersion: string;
  sensitivity: string;
  redactionPolicyVersion: string;
  failureReason: string | null;
}

export class ControlPlaneConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlPlaneConflictError';
  }
}

export class ArtifactNotSealedError extends Error {
  constructor(artifactId: string) {
    super(`artifact ${artifactId} is not sealed`);
    this.name = 'ArtifactNotSealedError';
  }
}

interface CommandResponse {
  attemptId: string;
  stateVersion: number;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`control-plane query missing ${field}`);
  return value;
}

function asNumber(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`control-plane query missing ${field}`);
  return parsed;
}

function commandResponse(value: unknown): CommandResponse {
  if (!value || typeof value !== 'object') throw new Error('control-plane command response is invalid');
  const response = value as Record<string, unknown>;
  return {
    attemptId: asString(response.attemptId, 'attemptId'),
    stateVersion: asNumber(response.stateVersion, 'stateVersion'),
  };
}

function artifactFromRow(row: Record<string, unknown>): ControlArtifact {
  return {
    id: asString(row.id, 'id'),
    taskId: asString(row.task_id, 'task_id'),
    planVersionId: typeof row.plan_version_id === 'string' ? row.plan_version_id : null,
    attemptId: typeof row.attempt_id === 'string' ? row.attempt_id : null,
    kind: asString(row.kind, 'kind'),
    state: asString(row.state, 'state') as ControlArtifactState,
    storageUri: asString(row.storage_uri, 'storage_uri'),
    contentSha256: typeof row.content_sha256 === 'string' ? row.content_sha256 : null,
    byteSize: row.byte_size == null ? null : asNumber(row.byte_size, 'byte_size'),
    schemaVersion: asString(row.schema_version, 'schema_version'),
    sensitivity: asString(row.sensitivity, 'sensitivity'),
    redactionPolicyVersion: asString(row.redaction_policy_version, 'redaction_policy_version'),
    failureReason: typeof row.failure_reason === 'string' ? row.failure_reason : null,
  };
}

export interface ControlTaskDetail extends ControlTask {
  conversationId: string;
  ownerUserId: string;
  conversationOwnerUserId: string;
  structuredTask: unknown;
}

export interface ControlPlanVersionDetail extends ControlPlanVersion {
  candidateId: string | null;
  plan: unknown;
  pendingInputs: unknown;
}

export interface ControlGateRecord {
  gateType: string;
  gateKey: string;
  requiredAuthority: string;
  decision: string;
}

export interface ControlCommandRecord {
  requestHash: string;
  response: unknown;
}

export class ControlPlaneRepository {
  constructor(private readonly database: MigrationDatabase) {}

  private async transaction<T>(work: (connection: MigrationConnection) => Promise<T>): Promise<T> {
    const connection = await this.database.connect();
    let transactionOpen = false;
    try {
      await connection.query('BEGIN');
      transactionOpen = true;
      const result = await work(connection);
      await connection.query('COMMIT');
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  async createTask(input: {
    conversationId: string;
    ownerUserId: string;
    originalInput: string;
    taskType: string | null;
    structuredTask: unknown;
    state: ControlTaskState;
    sensitivity?: string;
    piiDetected?: boolean;
  }): Promise<ControlTask> {
    return this.transaction(async (connection) => {
      const result = await connection.query(
        `INSERT INTO control_tasks
           (conversation_id, owner_user_id, original_input, task_type, structured_task, state, sensitivity, pii_detected)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'internal'), COALESCE($8, false))
         RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
        [
          input.conversationId,
          input.ownerUserId,
          input.originalInput,
          input.taskType,
          JSON.stringify(input.structuredTask),
          input.state,
          input.sensitivity ?? null,
          input.piiDetected ?? null,
        ],
      );
      const row = result.rows[0] ?? {};
      return {
        id: asString(row.id, 'id'),
        state: asString(row.state, 'state') as ControlTaskState,
        stateVersion: asNumber(row.state_version, 'state_version'),
        activePlanVersionId: typeof row.active_plan_version_id === 'string' ? row.active_plan_version_id : null,
        currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
      };
    });
  }

  async createPlanVersion(input: {
    taskId: string;
    version: number;
    plan: unknown;
    planHash: string;
    candidateId?: string;
    pendingInputs?: unknown;
  }): Promise<ControlPlanVersion> {
    return this.transaction(async (connection) => {
      const planResult = await connection.query(
        `INSERT INTO control_plan_versions
           (task_id, version, candidate_id, plan_json, plan_hash, pending_inputs)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, task_id, version, plan_hash`,
        [
          input.taskId,
          input.version,
          input.candidateId ?? null,
          JSON.stringify(input.plan),
          input.planHash,
          JSON.stringify(input.pendingInputs ?? []),
        ],
      );
      const row = planResult.rows[0] ?? {};
      const plan = {
        id: asString(row.id, 'id'),
        taskId: asString(row.task_id, 'task_id'),
        version: asNumber(row.version, 'version'),
        planHash: asString(row.plan_hash, 'plan_hash'),
      };
      await connection.query(
        `UPDATE control_tasks
         SET active_plan_version_id = $2, updated_at = now()
         WHERE id = $1`,
        [input.taskId, plan.id],
      );
      return plan;
    });
  }

  async claimExecution(input: {
    taskId: string;
    planVersionId: string;
    expectedVersion: number;
    idempotencyKey: string;
    requestHash: string;
    leaseOwner: string;
    leaseTokenHash: string;
    leaseExpiresAt?: Date;
  }): Promise<ControlExecutionClaim> {
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT state, state_version
         FROM control_tasks
         WHERE id = $1
         FOR UPDATE`,
        [input.taskId],
      );
      const task = taskResult.rows[0];
      if (!task) throw new ControlPlaneConflictError(`task ${input.taskId} does not exist`);

      const planResult = await connection.query(
        `SELECT task_id
         FROM control_plan_versions
         WHERE id = $1
         FOR KEY SHARE`,
        [input.planVersionId],
      );
      const plan = planResult.rows[0];
      if (!plan || plan.task_id !== input.taskId) {
        throw new ControlPlaneConflictError(`plan version ${input.planVersionId} does not belong to task ${input.taskId}`);
      }

      const commandResult = await connection.query(
        `SELECT request_hash, response_json
         FROM control_commands
         WHERE task_id = $1 AND command_type = 'execution_claim' AND idempotency_key = $2`,
        [input.taskId, input.idempotencyKey],
      );
      const existingCommand = commandResult.rows[0];
      if (existingCommand) {
        if (existingCommand.request_hash !== input.requestHash) {
          throw new ControlPlaneConflictError(`idempotency key ${input.idempotencyKey} was reused with a different request`);
        }
        const response = commandResponse(existingCommand.response_json);
        return { ...response, replayed: true };
      }

      if (task.state !== 'ready' || asNumber(task.state_version, 'state_version') !== input.expectedVersion) {
        throw new ControlPlaneConflictError(`task ${input.taskId} is no longer ready at version ${input.expectedVersion}`);
      }

      const nextAttemptResult = await connection.query(
        `SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt_no
         FROM control_execution_attempts
         WHERE task_id = $1`,
        [input.taskId],
      );
      const attemptNo = asNumber(nextAttemptResult.rows[0]?.attempt_no, 'attempt_no');
      const expiresAt = input.leaseExpiresAt ?? new Date(Date.now() + 5 * 60 * 1000);
      const attemptResult = await connection.query(
        `INSERT INTO control_execution_attempts
           (task_id, plan_version_id, attempt_no, state, lease_owner, lease_token_hash, lease_expires_at, lease_heartbeat_at)
         VALUES ($1, $2, $3, 'active', $4, $5, $6, now())
         RETURNING id`,
        [input.taskId, input.planVersionId, attemptNo, input.leaseOwner, input.leaseTokenHash, expiresAt],
      );
      const attemptId = asString(attemptResult.rows[0]?.id, 'attempt_id');
      const updatedTask = await connection.query(
        `UPDATE control_tasks
         SET state = 'executing',
             state_version = state_version + 1,
             current_attempt_id = $2,
             active_plan_version_id = $3,
             updated_at = now()
         WHERE id = $1 AND state = 'ready' AND state_version = $4
         RETURNING state_version`,
        [input.taskId, attemptId, input.planVersionId, input.expectedVersion],
      );
      const stateVersion = asNumber(updatedTask.rows[0]?.state_version, 'state_version');
      const response: CommandResponse = { attemptId, stateVersion };
      await connection.query(
        `INSERT INTO control_commands
           (task_id, command_type, idempotency_key, request_hash, expected_version, state_before, state_after, response_json)
         VALUES ($1, 'execution_claim', $2, $3, $4, 'ready', 'executing', $5)`,
        [input.taskId, input.idempotencyKey, input.requestHash, input.expectedVersion, JSON.stringify(response)],
      );
      return { ...response, replayed: false };
    });
  }

  async listAttempts(taskId: string): Promise<Array<{ id: string; state: string }>> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT id, state
         FROM control_execution_attempts
         WHERE task_id = $1
         ORDER BY attempt_no`,
        [taskId],
      );
      return result.rows.map((row) => ({ id: asString(row.id, 'id'), state: asString(row.state, 'state') }));
    } finally {
      connection.release();
    }
  }

  async createStagingArtifact(input: {
    taskId: string;
    planVersionId?: string;
    attemptId?: string;
    kind: string;
    storageUri: string;
    schemaVersion: string;
    sensitivity: string;
    redactionPolicyVersion: string;
  }): Promise<ControlArtifact> {
    return this.transaction(async (connection) => {
      const result = await connection.query(
        `INSERT INTO control_artifacts
           (task_id, plan_version_id, attempt_id, kind, contract_version, schema_version, state,
            storage_uri, sensitivity, redaction_policy_version)
         VALUES ($1, $2, $3, $4, 'trusted-p0-v1', $5, 'STAGING', $6, $7, $8)
         RETURNING *`,
        [
          input.taskId,
          input.planVersionId ?? null,
          input.attemptId ?? null,
          input.kind,
          input.schemaVersion,
          input.storageUri,
          input.sensitivity,
          input.redactionPolicyVersion,
        ],
      );
      return artifactFromRow(result.rows[0] ?? {});
    });
  }

  async sealArtifact(input: {
    artifactId: string;
    contentSha256: string;
    byteSize: number;
  }): Promise<ControlArtifact> {
    return this.transaction(async (connection) => {
      const result = await connection.query(
        `UPDATE control_artifacts
         SET state = 'SEALED',
             content_sha256 = $2,
             byte_size = $3,
             sealed_at = now(),
             redaction_status = 'sealed'
         WHERE id = $1 AND state = 'STAGING'
         RETURNING *`,
        [input.artifactId, input.contentSha256, input.byteSize],
      );
      if (!result.rows[0]) throw new ControlPlaneConflictError(`artifact ${input.artifactId} cannot be sealed`);
      return artifactFromRow(result.rows[0]);
    });
  }

  async failArtifact(artifactId: string, reason: string): Promise<void> {
    await this.transaction(async (connection) => {
      await connection.query(
        `UPDATE control_artifacts
         SET state = 'FAILED', failure_reason = $2
         WHERE id = $1 AND state = 'STAGING'`,
        [artifactId, reason],
      );
    });
  }

  async getArtifact(artifactId: string): Promise<ControlArtifact | null> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(`SELECT * FROM control_artifacts WHERE id = $1`, [artifactId]);
      return result.rows[0] ? artifactFromRow(result.rows[0]) : null;
    } finally {
      connection.release();
    }
  }

  async requireSealedArtifact(artifactId: string): Promise<ControlArtifact> {
    const artifact = await this.getArtifact(artifactId);
    if (!artifact || artifact.state !== 'SEALED') throw new ArtifactNotSealedError(artifactId);
    return artifact;
  }

  async listStagingArtifacts(): Promise<ControlArtifact[]> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(`SELECT * FROM control_artifacts WHERE state = 'STAGING' ORDER BY created_at`);
      return result.rows.map(artifactFromRow);
    } finally {
      connection.release();
    }
  }
  async getTaskDetail(taskId: string): Promise<ControlTaskDetail | null> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT task.id, task.conversation_id, task.owner_user_id, conversation.owner_user_id AS conversation_owner_user_id,
                task.structured_task, task.state, task.state_version, task.active_plan_version_id, task.current_attempt_id
         FROM control_tasks AS task
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE task.id = $1`,
        [taskId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: asString(row.id, 'id'),
        conversationId: asString(row.conversation_id, 'conversation_id'),
        ownerUserId: asString(row.owner_user_id, 'owner_user_id'),
        conversationOwnerUserId: asString(row.conversation_owner_user_id, 'conversation_owner_user_id'),
        structuredTask: row.structured_task,
        state: asString(row.state, 'state') as ControlTaskState,
        stateVersion: asNumber(row.state_version, 'state_version'),
        activePlanVersionId: typeof row.active_plan_version_id === 'string' ? row.active_plan_version_id : null,
        currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
      };
    } finally {
      connection.release();
    }
  }

  async getPlanVersionDetail(planVersionId: string): Promise<ControlPlanVersionDetail | null> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT id, task_id, version, candidate_id, plan_json, plan_hash, pending_inputs
         FROM control_plan_versions WHERE id = $1`,
        [planVersionId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: asString(row.id, 'id'),
        taskId: asString(row.task_id, 'task_id'),
        version: asNumber(row.version, 'version'),
        candidateId: typeof row.candidate_id === 'string' ? row.candidate_id : null,
        plan: row.plan_json,
        planHash: asString(row.plan_hash, 'plan_hash'),
        pendingInputs: row.pending_inputs,
      };
    } finally {
      connection.release();
    }
  }

  async nextPlanVersion(taskId: string): Promise<number> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM control_plan_versions WHERE task_id = $1`,
        [taskId],
      );
      return asNumber(result.rows[0]?.version, 'version');
    } finally {
      connection.release();
    }
  }

  async transitionTask(input: {
    taskId: string;
    expectedVersion: number;
    from: ControlTaskState | ControlTaskState[];
    to: ControlTaskState;
    activePlanVersionId?: string;
  }): Promise<ControlTask> {
    return this.transaction(async (connection) => {
      const fromStates = Array.isArray(input.from) ? input.from : [input.from];
      const result = await connection.query(
        `UPDATE control_tasks
         SET state = $3,
             state_version = state_version + 1,
             active_plan_version_id = COALESCE($4, active_plan_version_id),
             updated_at = now()
         WHERE id = $1 AND state_version = $2 AND state = ANY($5::text[])
         RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
        [input.taskId, input.expectedVersion, input.to, input.activePlanVersionId ?? null, fromStates],
      );
      const row = result.rows[0];
      if (!row) throw new ControlPlaneConflictError(`task ${input.taskId} is not ${fromStates.join(' or ')} at version ${input.expectedVersion}`);
      return {
        id: asString(row.id, 'id'),
        state: asString(row.state, 'state') as ControlTaskState,
        stateVersion: asNumber(row.state_version, 'state_version'),
        activePlanVersionId: typeof row.active_plan_version_id === 'string' ? row.active_plan_version_id : null,
        currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
      };
    });
  }

  async getCommand(taskId: string, commandType: string, idempotencyKey: string): Promise<ControlCommandRecord | null> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT request_hash, response_json FROM control_commands
         WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3`,
        [taskId, commandType, idempotencyKey],
      );
      const row = result.rows[0];
      return row ? { requestHash: asString(row.request_hash, 'request_hash'), response: row.response_json } : null;
    } finally {
      connection.release();
    }
  }

  async recordCommand(input: {
    taskId: string;
    commandType: string;
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    stateBefore: ControlTaskState;
    stateAfter: ControlTaskState;
    response: unknown;
    actorUserId?: string;
  }): Promise<void> {
    await this.transaction(async (connection) => {
      await connection.query(
        `INSERT INTO control_commands
         (task_id, command_type, idempotency_key, request_hash, expected_version,
          state_before, state_after, response_json, actor_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          input.taskId, input.commandType, input.idempotencyKey, input.requestHash,
          input.expectedVersion, input.stateBefore, input.stateAfter,
          JSON.stringify(input.response), input.actorUserId ?? null,
        ],
      );
    });
  }

  async recordGate(input: {
    taskId: string;
    planVersionId: string;
    planHash: string;
    gateType: string;
    gateKey: string;
    requiredAuthority: string;
    decision: string;
    value?: unknown;
    actorUserId?: string;
    actorService?: string;
    actorRole?: string;
    idempotencyKey: string;
  }): Promise<void> {
    await this.transaction(async (connection) => {
      await connection.query(
        `INSERT INTO control_gate_records
         (task_id, plan_version_id, plan_hash, gate_type, gate_key, required_authority,
          decision, value_json, actor_user_id, actor_service, actor_role, policy_version, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'trusted-p0-v1', $12)`,
        [
          input.taskId, input.planVersionId, input.planHash, input.gateType, input.gateKey,
          input.requiredAuthority, input.decision, input.value == null ? null : JSON.stringify(input.value),
          input.actorUserId ?? null, input.actorService ?? null, input.actorRole ?? null,
          input.idempotencyKey,
        ],
      );
    });
  }

  async listGateRecords(taskId: string, planVersionId: string): Promise<ControlGateRecord[]> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT gate_type, gate_key, required_authority, decision
         FROM control_gate_records
         WHERE task_id = $1 AND plan_version_id = $2 ORDER BY created_at`,
        [taskId, planVersionId],
      );
      return result.rows.map((row) => ({
        gateType: asString(row.gate_type, 'gate_type'),
        gateKey: asString(row.gate_key, 'gate_key'),
        requiredAuthority: asString(row.required_authority, 'required_authority'),
        decision: asString(row.decision, 'decision'),
      }));
    } finally {
      connection.release();
    }
  }

  async pauseExecution(input: { taskId: string; attemptId: string; expectedVersion: number; reason: string }): Promise<ControlTask> {
    return this.transaction(async (connection) => {
      const attempt = await connection.query(
        `UPDATE control_execution_attempts SET state = 'paused', failure_kind = $3, finished_at = now()
         WHERE id = $1 AND task_id = $2 AND state = 'active' RETURNING id`,
        [input.attemptId, input.taskId, input.reason],
      );
      if (!attempt.rows[0]) throw new ControlPlaneConflictError(`attempt ${input.attemptId} is not active`);
      const task = await connection.query(
        `UPDATE control_tasks SET state = 'paused', state_version = state_version + 1, updated_at = now()
         WHERE id = $1 AND state = 'executing' AND state_version = $2
         RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
        [input.taskId, input.expectedVersion],
      );
      const row = task.rows[0];
      if (!row) throw new ControlPlaneConflictError(`task ${input.taskId} is no longer executing at version ${input.expectedVersion}`);
      return {
        id: asString(row.id, 'id'),
        state: asString(row.state, 'state') as ControlTaskState,
        stateVersion: asNumber(row.state_version, 'state_version'),
        activePlanVersionId: typeof row.active_plan_version_id === 'string' ? row.active_plan_version_id : null,
        currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
      };
    });
  }
}
