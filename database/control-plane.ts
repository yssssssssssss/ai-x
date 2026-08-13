import { createHash, randomUUID } from 'node:crypto';
import type { MigrationConnection, MigrationDatabase } from './migration-runner.ts';
import type { ControlRequirementVersion } from '../packages/api-contract/control-workflow.ts';
import type {
  CurrentExecutionPlan,
  PendingInput,
} from '../packages/api-contract/research-deliverable.ts';
export type { ControlRequirementVersion };

export type ControlTaskState =
  | 'awaiting_clarification'
  | 'awaiting_selection'
  | 'awaiting_confirmation'
  | 'awaiting_approval'
  | 'ready'
  | 'executing'
  | 'paused'
  | 'reviewing'
  | 'composing_report'
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

export interface ControlExecutionLease {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  leaseOwner: string;
  leaseToken: string;
}

export interface ActiveExecutionLease {
  taskId: string;
  planVersionId: string;
  attemptId: string;
  leaseOwner: string;
  leaseExpiresAt: Date;
  stateVersion: number;
}

export interface ControlExecutionStep {
  stepNo: number;
  stepName: string;
  actorType: string;
  actorId: string;
  state: string;
  toolProvenance: Record<string, unknown> | null;
  failure: Record<string, unknown> | null;
  latencyMs: number | null;
}

export interface ControlModelCall {
  stage: string;
  stepNo: number | null;
  provider: string;
  endpointHost: string;
  requestedModel: string;
  actualModel: string;
  promptHash: string;
  contextManifestHash: string | null;
  traceId: string | null;
  tokens: Record<string, unknown> | null;
  status: string;
  failure: Record<string, unknown> | null;
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

export class ControlPlaneAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskWorkflowAuthorizationError';
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

function asDate(value: unknown, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(asString(value, field));
  if (Number.isNaN(parsed.getTime())) throw new Error(`control-plane query missing ${field}`);
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hashLeaseToken(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}


function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function canonicalPlan(plan: unknown): { json: string; hash: string } {
  const json = JSON.stringify(stableValue(plan));
  if (json === undefined) throw new ControlPlaneConflictError('plan is not JSON serializable');
  return {
    json,
    hash: `sha256:${createHash('sha256').update(json).digest('hex')}`,
  };
}

export function canonicalPlanHash(plan: unknown): string {
  return canonicalPlan(plan).hash;
}

function planForTask(plan: unknown, taskId: string): { json: string; hash: string } {
  const record = asRecord(plan);
  if (!record) throw new ControlPlaneConflictError('candidate plan must be an object');
  return canonicalPlan({ ...record, task_id: taskId });
}

export interface SelectionResponse {
  planVersionId: string;
  state: ControlTaskState;
  stateVersion: number;
}

function selectionResponse(value: unknown): SelectionResponse {
  const response = asRecord(value);
  if (!response) throw new Error('control-plane selection response is invalid');
  return {
    planVersionId: asString(response.planVersionId, 'planVersionId'),
    state: asString(response.state, 'state') as ControlTaskState,
    stateVersion: asNumber(response.stateVersion, 'stateVersion'),
  };
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
  activeRequirementVersionId: string | null;
}

function requirementVersionFromRow(row: Record<string, unknown>): ControlRequirementVersion {
  return {
    id: asString(row.id, 'id'),
    taskId: asString(row.task_id, 'task_id'),
    version: asNumber(row.version, 'version'),
    rawInputHash: asString(row.raw_input_hash, 'raw_input_hash'),
    clarification: row.clarification_json,
    structuredTask: row.structured_task_json as ControlRequirementVersion['structuredTask'],
    modelCallId: typeof row.model_call_id === 'string' ? row.model_call_id : null,
    createdAt: asDate(row.created_at, 'created_at'),
  };
}

function controlTaskDetailFromRow(row: Record<string, unknown>): ControlTaskDetail {
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
    activeRequirementVersionId: typeof row.active_requirement_version_id === 'string'
      ? row.active_requirement_version_id
      : null,
  };
}

export interface ControlPlanVersionDetail extends ControlPlanVersion {
  candidateId: string | null;
  plan: unknown;
  pendingInputs: unknown;
}

export type ControlCandidateId = 'depth' | 'speed';

export interface ControlCandidatePlanVersionDetail
  extends Omit<ControlPlanVersionDetail, 'candidateId' | 'plan' | 'pendingInputs'> {
  candidateId: ControlCandidateId;
  plan: CurrentExecutionPlan;
  pendingInputs: PendingInput[];
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

  async createRequirementVersion(input: {
    taskId: string;
    version: number;
    rawInputHash: string;
    clarification: unknown;
    structuredTask: unknown;
    modelCallId?: string | null;
  }): Promise<ControlRequirementVersion> {
    return this.transaction(async (connection) => {
      const task = await connection.query(
        `SELECT id FROM control_tasks WHERE id = $1 FOR KEY SHARE`,
        [input.taskId],
      );
      if (!task.rows[0]) throw new ControlPlaneConflictError(`task ${input.taskId} does not exist`);
      const result = await connection.query(
        `INSERT INTO control_requirement_versions
           (task_id, version, raw_input_hash, clarification_json, structured_task_json, model_call_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, task_id, version, raw_input_hash, clarification_json,
                   structured_task_json, model_call_id, created_at`,
        [
          input.taskId,
          input.version,
          input.rawInputHash,
          JSON.stringify(input.clarification),
          JSON.stringify(input.structuredTask),
          input.modelCallId ?? null,
        ],
      );
      return requirementVersionFromRow(result.rows[0] ?? {});
    });
  }

  async getActiveRequirementVersion(taskId: string): Promise<ControlRequirementVersion | null> {
    return this.transaction(async (connection) => {
      const result = await connection.query(
        `SELECT requirement.id, requirement.task_id, requirement.version,
                requirement.raw_input_hash, requirement.clarification_json,
                requirement.structured_task_json, requirement.model_call_id,
                requirement.created_at
         FROM control_requirement_versions AS requirement
         JOIN control_tasks AS task
           ON task.active_requirement_version_id = requirement.id
          AND task.id = requirement.task_id
         WHERE task.id = $1`,
        [taskId],
      );
      const row = result.rows[0];
      return row ? requirementVersionFromRow(row) : null;
    });
  }

  async activateRequirementVersion(input: {
    taskId: string;
    requirementVersionId: string;
    expectedVersion: number;
    ownerUserId: string;
  }): Promise<ControlTaskDetail> {
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT task.id, task.conversation_id, task.owner_user_id,
                conversation.owner_user_id AS conversation_owner_user_id,
                task.structured_task, task.state, task.state_version,
                task.active_plan_version_id, task.current_attempt_id,
                task.active_requirement_version_id
         FROM control_tasks AS task
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE task.id = $1
         FOR UPDATE OF task`,
        [input.taskId],
      );
      const task = taskResult.rows[0];
      if (!task) throw new ControlPlaneConflictError(`task ${input.taskId} does not exist`);
      if (
        task.owner_user_id !== input.ownerUserId
        || task.conversation_owner_user_id !== input.ownerUserId
      ) {
        throw new ControlPlaneAuthorizationError(`actor cannot control task ${input.taskId}`);
      }
      if (asNumber(task.state_version, 'state_version') !== input.expectedVersion) {
        throw new ControlPlaneConflictError(`task ${input.taskId} is not at version ${input.expectedVersion}`);
      }

      const requirementResult = await connection.query(
        `SELECT id, task_id, version, raw_input_hash, clarification_json,
                structured_task_json, model_call_id, created_at
         FROM control_requirement_versions
         WHERE id = $1
         FOR KEY SHARE`,
        [input.requirementVersionId],
      );
      const requirement = requirementResult.rows[0];
      if (!requirement || requirement.task_id !== input.taskId) {
        throw new ControlPlaneConflictError(
          `requirement version ${input.requirementVersionId} does not belong to task ${input.taskId}`,
        );
      }

      const updated = await connection.query(
        `UPDATE control_tasks
         SET active_requirement_version_id = $2,
             state_version = state_version + 1,
             updated_at = now()
         WHERE id = $1 AND state_version = $3
         RETURNING id, conversation_id, owner_user_id,
                   (SELECT owner_user_id FROM conversations WHERE id = control_tasks.conversation_id)
                     AS conversation_owner_user_id,
                   structured_task, state, state_version,
                   active_plan_version_id, current_attempt_id,
                   active_requirement_version_id`,
        [input.taskId, input.requirementVersionId, input.expectedVersion],
      );
      const row = updated.rows[0];
      if (!row) throw new ControlPlaneConflictError(`task ${input.taskId} lost requirement activation CAS`);
      return controlTaskDetailFromRow(row);
    });
  }

  async createTaskWithCandidates(input: {
    conversationId: string;
    ownerUserId: string;
    originalInput: string;
    taskType: string | null;
    structuredTask: unknown;
    candidates: Array<{
      candidateId: ControlCandidateId;
      plan: Omit<CurrentExecutionPlan, 'task_id'> & { task_id?: string };
      pendingInputs: PendingInput[];
    }>;
  }): Promise<{ task: ControlTask; candidates: ControlCandidatePlanVersionDetail[] }> {
    return this.transaction(async (connection) => {
      const conversationResult = await connection.query(
        `SELECT owner_user_id FROM conversations WHERE id = $1 FOR UPDATE`,
        [input.conversationId],
      );
      const conversation = conversationResult.rows[0];
      if (!conversation || conversation.owner_user_id !== input.ownerUserId) {
        throw new ControlPlaneConflictError(`conversation ${input.conversationId} does not belong to owner ${input.ownerUserId}`);
      }
      const candidateIds = new Set<ControlCandidateId>();
      for (const candidate of input.candidates) {
        if (candidateIds.has(candidate.candidateId)) {
          throw new ControlPlaneConflictError(`candidate id ${candidate.candidateId} is duplicated`);
        }
        candidateIds.add(candidate.candidateId);
      }

      const taskId = randomUUID();
      const taskResult = await connection.query(
        `INSERT INTO control_tasks
           (id, conversation_id, owner_user_id, original_input, task_type, structured_task, state)
         VALUES ($1, $2, $3, $4, $5, $6, 'awaiting_selection')
         RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
        [
          taskId,
          input.conversationId,
          input.ownerUserId,
          input.originalInput,
          input.taskType,
          JSON.stringify(input.structuredTask),
        ],
      );
      const taskRow = taskResult.rows[0] ?? {};
      const task: ControlTask = {
        id: asString(taskRow.id, 'id'),
        state: asString(taskRow.state, 'state') as ControlTaskState,
        stateVersion: asNumber(taskRow.state_version, 'state_version'),
        activePlanVersionId: typeof taskRow.active_plan_version_id === 'string' ? taskRow.active_plan_version_id : null,
        currentAttemptId: typeof taskRow.current_attempt_id === 'string' ? taskRow.current_attempt_id : null,
      };

      const preparedCandidates = input.candidates.map((candidate) => ({
        candidate,
        persistedPlan: planForTask(candidate.plan, taskId),
      }));
      const planHashes = new Set<string>();
      for (const { persistedPlan } of preparedCandidates) {
        if (planHashes.has(persistedPlan.hash)) {
          throw new ControlPlaneConflictError(`candidate plan hash ${persistedPlan.hash} is duplicated`);
        }
        planHashes.add(persistedPlan.hash);
      }

      const candidates: ControlCandidatePlanVersionDetail[] = [];
      for (const [index, { candidate, persistedPlan }] of preparedCandidates.entries()) {
        const planResult = await connection.query(
          `INSERT INTO control_plan_versions
             (task_id, version, candidate_id, plan_json, plan_hash, pending_inputs)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, task_id, version, candidate_id, plan_json, plan_hash, pending_inputs`,
          [
            taskId,
            index + 1,
            candidate.candidateId,
            persistedPlan.json,
            persistedPlan.hash,
            JSON.stringify(candidate.pendingInputs),
          ],
        );
        const planRow = planResult.rows[0] ?? {};
        candidates.push({
          id: asString(planRow.id, 'id'),
          taskId: asString(planRow.task_id, 'task_id'),
          version: asNumber(planRow.version, 'version'),
          candidateId: asString(planRow.candidate_id, 'candidate_id') as ControlCandidateId,
          plan: planRow.plan_json as CurrentExecutionPlan,
          planHash: asString(planRow.plan_hash, 'plan_hash'),
          pendingInputs: planRow.pending_inputs as PendingInput[],
        });
      }
      return { task, candidates };
    });
  }

  async selectCandidate(input: {
    taskId: string;
    planVersionId: string;
    expectedVersion: number;
    idempotencyKey: string;
    requestHash: string;
    actor: { userId: string; role: string };
  }): Promise<SelectionResponse> {
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT task.owner_user_id, conversation.owner_user_id AS conversation_owner_user_id,
                task.state, task.state_version, task.active_plan_version_id
         FROM control_tasks AS task
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE task.id = $1
         FOR UPDATE OF task`,
        [input.taskId],
      );
      const task = taskResult.rows[0];
      if (!task) throw new ControlPlaneConflictError(`task ${input.taskId} does not exist`);

      const commandResult = await connection.query(
        `SELECT request_hash, response_json
         FROM control_commands
         WHERE task_id = $1 AND command_type = 'selection' AND idempotency_key = $2`,
        [input.taskId, input.idempotencyKey],
      );
      const existingCommand = commandResult.rows[0];
      if (existingCommand) {
        if (existingCommand.request_hash !== input.requestHash) {
          throw new ControlPlaneConflictError(`idempotency key ${input.idempotencyKey} was reused with a different request`);
        }
        return selectionResponse(existingCommand.response_json);
      }

      if (
        task.owner_user_id !== input.actor.userId
        || task.conversation_owner_user_id !== input.actor.userId
        || input.actor.role !== 'owner'
      ) {
        throw new ControlPlaneAuthorizationError(`actor cannot control task ${input.taskId}`);
      }
      if (
        task.state !== 'awaiting_selection'
        || asNumber(task.state_version, 'state_version') !== input.expectedVersion
        || task.active_plan_version_id !== null
      ) {
        throw new ControlPlaneConflictError(`task ${input.taskId} is not awaiting selection at version ${input.expectedVersion}`);
      }

      const planResult = await connection.query(
        `SELECT task_id, candidate_id, plan_json, plan_hash
         FROM control_plan_versions
         WHERE id = $1
         FOR UPDATE`,
        [input.planVersionId],
      );
      const plan = planResult.rows[0];
      if (!plan || plan.task_id !== input.taskId || typeof plan.candidate_id !== 'string') {
        throw new ControlPlaneConflictError(`plan version ${input.planVersionId} is not a candidate for task ${input.taskId}`);
      }
      const persistedPlan = asRecord(plan.plan_json);
      if (!persistedPlan || persistedPlan.task_id !== input.taskId) {
        throw new ControlPlaneConflictError(`plan version ${input.planVersionId} is not bound to task ${input.taskId}`);
      }
      if (canonicalPlanHash(persistedPlan) !== plan.plan_hash) {
        throw new ControlPlaneConflictError(`plan version ${input.planVersionId} hash does not match persisted plan`);
      }

      const updatedResult = await connection.query(
        `UPDATE control_tasks
         SET state = 'awaiting_confirmation',
             state_version = state_version + 1,
             active_plan_version_id = $2,
             updated_at = now()
         WHERE id = $1
           AND state = 'awaiting_selection'
           AND state_version = $3
           AND active_plan_version_id IS NULL
         RETURNING state, state_version`,
        [input.taskId, input.planVersionId, input.expectedVersion],
      );
      const updated = updatedResult.rows[0];
      if (!updated) throw new ControlPlaneConflictError(`task ${input.taskId} lost selection CAS`);
      const response: SelectionResponse = {
        planVersionId: input.planVersionId,
        state: asString(updated.state, 'state') as ControlTaskState,
        stateVersion: asNumber(updated.state_version, 'state_version'),
      };
      await connection.query(
        `INSERT INTO control_commands
           (task_id, command_type, idempotency_key, request_hash, expected_version,
            state_before, state_after, response_json, actor_user_id)
         VALUES ($1, $2, $3, $4, $5, 'awaiting_selection', 'awaiting_confirmation', $6, $7)`,
        [
          input.taskId,
          'selection',
          input.idempotencyKey,
          input.requestHash,
          input.expectedVersion,
          JSON.stringify(response),
          input.actor.userId,
        ],
      );
      return response;
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

  async createPlanRevision(input: {
    taskId: string;
    expectedVersion: number;
    from: ControlTaskState | ControlTaskState[];
    to: ControlTaskState;
    plan: unknown;
    candidateId?: string;
    pendingInputs?: unknown;
  }): Promise<{ plan: ControlPlanVersion; task: ControlTask }> {
    const persistedPlan = canonicalPlan(input.plan);
    return this.transaction(async (connection) => {
      const fromStates = Array.isArray(input.from) ? input.from : [input.from];
      const locked = await connection.query(
        `SELECT state, state_version FROM control_tasks WHERE id = $1 FOR UPDATE`,
        [input.taskId],
      );
      const taskRow = locked.rows[0];
      if (
        !taskRow
        || !fromStates.includes(asString(taskRow.state, 'state') as ControlTaskState)
        || asNumber(taskRow.state_version, 'state_version') !== input.expectedVersion
      ) {
        throw new ControlPlaneConflictError(`task ${input.taskId} cannot revise at version ${input.expectedVersion}`);
      }
      const versionResult = await connection.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM control_plan_versions WHERE task_id = $1`,
        [input.taskId],
      );
      const version = asNumber(versionResult.rows[0]?.version, 'version');
      const inserted = await connection.query(
        `INSERT INTO control_plan_versions
           (task_id, version, candidate_id, plan_json, plan_hash, pending_inputs)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, task_id, version, plan_hash`,
        [
          input.taskId, version, input.candidateId ?? null, persistedPlan.json,
          persistedPlan.hash, JSON.stringify(input.pendingInputs ?? []),
        ],
      );
      const planRow = inserted.rows[0] ?? {};
      const plan: ControlPlanVersion = {
        id: asString(planRow.id, 'id'),
        taskId: asString(planRow.task_id, 'task_id'),
        version: asNumber(planRow.version, 'version'),
        planHash: asString(planRow.plan_hash, 'plan_hash'),
      };
      const updated = await connection.query(
        `UPDATE control_tasks
         SET state = $3, state_version = state_version + 1,
             active_plan_version_id = $4, updated_at = now()
         WHERE id = $1 AND state_version = $2 AND state = ANY($5::text[])
         RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
        [input.taskId, input.expectedVersion, input.to, plan.id, fromStates],
      );
      const row = updated.rows[0];
      if (!row) throw new ControlPlaneConflictError(`task ${input.taskId} lost revision CAS`);
      return {
        plan,
        task: {
          id: asString(row.id, 'id'),
          state: asString(row.state, 'state') as ControlTaskState,
          stateVersion: asNumber(row.state_version, 'state_version'),
          activePlanVersionId: typeof row.active_plan_version_id === 'string' ? row.active_plan_version_id : null,
          currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
        },
      };
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
  } & Partial<ControlExecutionLease>): Promise<ControlArtifact> {
    const leaseFieldCount = [
      input.taskId,
      input.planVersionId,
      input.attemptId,
      input.leaseOwner,
      input.leaseToken,
    ].filter((value) => value !== undefined).length;
    const leaseBound = leaseFieldCount === 5;
    const outcome = await this.transaction(async (connection) => {
      const result = leaseBound
        ? await connection.query(
            `UPDATE control_artifacts AS artifact
             SET state = 'SEALED',
                 content_sha256 = $2,
                 byte_size = $3,
                 sealed_at = now(),
                 redaction_status = 'sealed'
             FROM control_execution_attempts AS attempt, control_tasks AS task
             WHERE artifact.id = $1
               AND artifact.state = 'STAGING'
               AND artifact.task_id = $4
               AND artifact.plan_version_id = $5
               AND artifact.attempt_id = $6
               AND attempt.id = $6
               AND attempt.task_id = $4
               AND attempt.plan_version_id = $5
               AND attempt.lease_owner = $7
               AND attempt.lease_token_hash = $8
               AND attempt.state = 'active'
               AND attempt.lease_expires_at > now()
               AND task.id = $4
               AND task.state = 'executing'
               AND task.current_attempt_id = attempt.id
               AND task.active_plan_version_id = attempt.plan_version_id
             RETURNING artifact.*`,
            [
              input.artifactId,
              input.contentSha256,
              input.byteSize,
              input.taskId,
              input.planVersionId,
              input.attemptId,
              input.leaseOwner,
              hashLeaseToken(input.leaseToken!),
            ],
          )
        : leaseFieldCount === 0
          ? await connection.query(
              `UPDATE control_artifacts
               SET state = 'SEALED',
                   content_sha256 = $2,
                   byte_size = $3,
                   sealed_at = now(),
                   redaction_status = 'sealed'
               WHERE id = $1 AND state = 'STAGING'
               RETURNING *`,
              [input.artifactId, input.contentSha256, input.byteSize],
            )
          : { rows: [] };
      if (result.rows[0]) return artifactFromRow(result.rows[0]);

      if (leaseFieldCount > 0) {
        await connection.query(
          `UPDATE control_artifacts
           SET state = 'FAILED',
               failure_reason = 'active execution lease is invalid or expired',
               redaction_status = 'failed'
           WHERE id = $1 AND state = 'STAGING'`,
          [input.artifactId],
        );
        if (leaseBound) {
          await connection.query(
            `UPDATE control_execution_attempts
             SET state = 'paused', failure_kind = 'worker_loss', finished_at = now()
             WHERE id = $1
               AND task_id = $2
               AND plan_version_id = $3
               AND state = 'active'
               AND lease_expires_at <= now()`,
            [input.attemptId, input.taskId, input.planVersionId],
          );
          await connection.query(
            `UPDATE control_tasks AS task
             SET state = 'paused', state_version = state_version + 1, updated_at = now()
             WHERE task.id = $1
               AND task.state = 'executing'
               AND task.current_attempt_id = $2
               AND task.active_plan_version_id = $3
               AND EXISTS (
                 SELECT 1 FROM control_execution_attempts AS attempt
                 WHERE attempt.id = $2
                   AND attempt.task_id = task.id
                   AND attempt.plan_version_id = $3
                   AND attempt.state = 'paused'
               )`,
            [input.taskId, input.attemptId, input.planVersionId],
          );
        }
      }
      return null;
    });
    if (!outcome) throw new ControlPlaneConflictError(`artifact ${input.artifactId} cannot be sealed`);
    return outcome;
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

  async invalidateTerminalArtifacts(input: {
    taskId: string;
    planVersionId: string;
    attemptId: string;
    reason: string;
  }): Promise<void> {
    await this.transaction(async (connection) => {
      await connection.query(
        `UPDATE control_artifacts
         SET state = 'FAILED', failure_reason = $4, redaction_status = 'failed'
         WHERE task_id = $1
           AND plan_version_id = $2
           AND attempt_id = $3
           AND kind IN ('evidence_manifest', 'deliverable')
           AND state IN ('STAGING', 'SEALED')`,
        [input.taskId, input.planVersionId, input.attemptId, input.reason],
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

  async findSealedArtifact(input: {
    taskId: string;
    attemptId: string;
    kind: string;
  }): Promise<ControlArtifact | null> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT *
         FROM control_artifacts
         WHERE task_id = $1 AND attempt_id = $2 AND kind = $3 AND state = 'SEALED'
         ORDER BY created_at DESC
         LIMIT 1`,
        [input.taskId, input.attemptId, input.kind],
      );
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
                task.structured_task, task.state, task.state_version, task.active_plan_version_id,
                task.current_attempt_id, task.active_requirement_version_id
         FROM control_tasks AS task
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE task.id = $1`,
        [taskId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return controlTaskDetailFromRow(row);
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

  async requireActiveLease(input: ControlExecutionLease): Promise<ActiveExecutionLease> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT attempt.id AS attempt_id, attempt.task_id, attempt.plan_version_id,
                attempt.lease_owner, attempt.lease_expires_at, task.state_version
         FROM control_execution_attempts AS attempt
         JOIN control_tasks AS task ON task.id = attempt.task_id
         WHERE attempt.id = $1
           AND attempt.task_id = $2
           AND attempt.plan_version_id = $3
           AND attempt.lease_owner = $4
           AND attempt.lease_token_hash = $5
           AND attempt.state = 'active'
           AND attempt.lease_expires_at > now()
           AND task.state = 'executing'
           AND task.current_attempt_id = attempt.id
           AND task.active_plan_version_id = attempt.plan_version_id`,
        [input.attemptId, input.taskId, input.planVersionId, input.leaseOwner, hashLeaseToken(input.leaseToken)],
      );
      const row = result.rows[0];
      if (!row) throw new ControlPlaneConflictError(`execution lease ${input.attemptId} is invalid or expired`);
      return {
        attemptId: asString(row.attempt_id, 'attempt_id'),
        taskId: asString(row.task_id, 'task_id'),
        planVersionId: asString(row.plan_version_id, 'plan_version_id'),
        leaseOwner: asString(row.lease_owner, 'lease_owner'),
        leaseExpiresAt: asDate(row.lease_expires_at, 'lease_expires_at'),
        stateVersion: asNumber(row.state_version, 'state_version'),
      };
    } finally {
      connection.release();
    }
  }

  async heartbeatExecutionLease(input: ControlExecutionLease & { extendUntil: Date }): Promise<ActiveExecutionLease> {
    return this.transaction(async (connection) => {
      const result = await connection.query(
        `UPDATE control_execution_attempts AS attempt
         SET lease_heartbeat_at = now(),
             lease_expires_at = GREATEST(attempt.lease_expires_at, $6)
         FROM control_tasks AS task
         WHERE attempt.id = $1
           AND attempt.task_id = $2
           AND attempt.plan_version_id = $3
           AND attempt.lease_owner = $4
           AND attempt.lease_token_hash = $5
           AND attempt.state = 'active'
           AND attempt.lease_expires_at > now()
           AND task.id = attempt.task_id
           AND task.state = 'executing'
           AND task.current_attempt_id = attempt.id
           AND task.active_plan_version_id = attempt.plan_version_id
         RETURNING attempt.id AS attempt_id, attempt.task_id, attempt.plan_version_id,
                   attempt.lease_owner, attempt.lease_expires_at, task.state_version`,
        [input.attemptId, input.taskId, input.planVersionId, input.leaseOwner, hashLeaseToken(input.leaseToken), input.extendUntil],
      );
      const row = result.rows[0];
      if (!row) throw new ControlPlaneConflictError(`execution lease ${input.attemptId} cannot heartbeat`);
      return {
        attemptId: asString(row.attempt_id, 'attempt_id'),
        taskId: asString(row.task_id, 'task_id'),
        planVersionId: asString(row.plan_version_id, 'plan_version_id'),
        leaseOwner: asString(row.lease_owner, 'lease_owner'),
        leaseExpiresAt: asDate(row.lease_expires_at, 'lease_expires_at'),
        stateVersion: asNumber(row.state_version, 'state_version'),
      };
    });
  }

  async recordExecutionStep(input: {
    attemptId: string;
    stepNo: number;
    stepName: string;
    actorType: string;
    actorId: string;
    state: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
    toolProvenance?: Record<string, unknown>;
    failure?: Record<string, unknown>;
    latencyMs?: number;
    startedAt?: Date;
    finishedAt?: Date;
  }): Promise<void> {
    await this.transaction(async (connection) => {
      await connection.query(
        `INSERT INTO control_execution_steps
           (attempt_id, step_no, step_name, actor_type, actor_id, state,
            tool_provenance, failure_json, latency_ms, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (attempt_id, step_no) DO UPDATE
         SET step_name = EXCLUDED.step_name,
             actor_type = EXCLUDED.actor_type,
             actor_id = EXCLUDED.actor_id,
             state = EXCLUDED.state,
             tool_provenance = COALESCE(EXCLUDED.tool_provenance, control_execution_steps.tool_provenance),
             failure_json = COALESCE(EXCLUDED.failure_json, control_execution_steps.failure_json),
             latency_ms = COALESCE(EXCLUDED.latency_ms, control_execution_steps.latency_ms),
             started_at = COALESCE(control_execution_steps.started_at, EXCLUDED.started_at),
             finished_at = EXCLUDED.finished_at`,
        [
          input.attemptId, input.stepNo, input.stepName, input.actorType, input.actorId, input.state,
          input.toolProvenance == null ? null : JSON.stringify(input.toolProvenance),
          input.failure == null ? null : JSON.stringify(input.failure),
          input.latencyMs ?? null, input.startedAt ?? null, input.finishedAt ?? null,
        ],
      );
    });
  }

  async listExecutionSteps(attemptId: string): Promise<ControlExecutionStep[]> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT step_no, step_name, actor_type, actor_id, state, tool_provenance, failure_json, latency_ms
         FROM control_execution_steps WHERE attempt_id = $1 ORDER BY step_no`,
        [attemptId],
      );
      return result.rows.map((row) => ({
        stepNo: asNumber(row.step_no, 'step_no'),
        stepName: asString(row.step_name, 'step_name'),
        actorType: asString(row.actor_type, 'actor_type'),
        actorId: asString(row.actor_id, 'actor_id'),
        state: asString(row.state, 'state'),
        toolProvenance: asRecord(row.tool_provenance),
        failure: asRecord(row.failure_json),
        latencyMs: row.latency_ms == null ? null : asNumber(row.latency_ms, 'latency_ms'),
      }));
    } finally {
      connection.release();
    }
  }

  async recordModelCall(input: {
    attemptId?: string;
    stage: string;
    stepNo?: number;
    provider: string;
    endpointHost: string;
    requestedModel: string;
    actualModel: string;
    promptHash: string;
    contextManifestHash?: string;
    traceId?: string;
    tokens?: { prompt: number; completion: number; total: number };
    status: 'succeeded' | 'failed';
    failure: Record<string, unknown> | null;
    startedAt: Date;
    finishedAt: Date;
  }): Promise<void> {
    await this.transaction(async (connection) => {
      await connection.query(
        `INSERT INTO control_model_calls
           (attempt_id, stage, step_no, provider, endpoint_host, requested_model, actual_model,
            prompt_hash, context_manifest_hash, trace_id, tokens_json, status, failure_json, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          input.attemptId ?? null, input.stage, input.stepNo ?? null, input.provider, input.endpointHost,
          input.requestedModel, input.actualModel, input.promptHash, input.contextManifestHash ?? null,
          input.traceId ?? null, input.tokens == null ? null : JSON.stringify(input.tokens), input.status,
          input.failure == null ? null : JSON.stringify(input.failure), input.startedAt, input.finishedAt,
        ],
      );
    });
  }

  async listModelCalls(attemptId: string): Promise<ControlModelCall[]> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT stage, step_no, provider, endpoint_host, requested_model, actual_model,
                prompt_hash, context_manifest_hash, trace_id, tokens_json, status, failure_json
         FROM control_model_calls WHERE attempt_id = $1 ORDER BY started_at`,
        [attemptId],
      );
      return result.rows.map((row) => ({
        stage: asString(row.stage, 'stage'),
        stepNo: row.step_no == null ? null : asNumber(row.step_no, 'step_no'),
        provider: asString(row.provider, 'provider'),
        endpointHost: asString(row.endpoint_host, 'endpoint_host'),
        requestedModel: asString(row.requested_model, 'requested_model'),
        actualModel: asString(row.actual_model, 'actual_model'),
        promptHash: asString(row.prompt_hash, 'prompt_hash'),
        contextManifestHash: typeof row.context_manifest_hash === 'string' ? row.context_manifest_hash : null,
        traceId: typeof row.trace_id === 'string' ? row.trace_id : null,
        tokens: asRecord(row.tokens_json),
        status: asString(row.status, 'status'),
        failure: asRecord(row.failure_json),
      }));
    } finally {
      connection.release();
    }
  }

  async completeExecution(
    input: ControlExecutionLease,
    options: { status: 'completed' | 'completed_with_gaps' } = { status: 'completed' },
  ): Promise<ControlTask> {
    return this.transaction(async (connection) => {
      const attempt = await connection.query(
        `UPDATE control_execution_attempts
         SET state = 'completed', finished_at = now()
         WHERE id = $1
           AND task_id = $2
           AND plan_version_id = $3
           AND lease_owner = $4
           AND lease_token_hash = $5
           AND state = 'active'
           AND lease_expires_at > now()
         RETURNING id`,
        [input.attemptId, input.taskId, input.planVersionId, input.leaseOwner, hashLeaseToken(input.leaseToken)],
      );
      if (!attempt.rows[0]) throw new ControlPlaneConflictError(`execution lease ${input.attemptId} cannot complete`);
      const task = await connection.query(
        `UPDATE control_tasks
         SET state = $4, state_version = state_version + 1, updated_at = now()
         WHERE id = $1
           AND state = 'executing'
           AND current_attempt_id = $2
           AND active_plan_version_id = $3
         RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
        [input.taskId, input.attemptId, input.planVersionId, options.status],
      );
      const row = task.rows[0];
      if (!row) throw new ControlPlaneConflictError(`task ${input.taskId} is not executing attempt ${input.attemptId}`);
      return {
        id: asString(row.id, 'id'),
        state: asString(row.state, 'state') as ControlTaskState,
        stateVersion: asNumber(row.state_version, 'state_version'),
        activePlanVersionId: typeof row.active_plan_version_id === 'string' ? row.active_plan_version_id : null,
        currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
      };
    });
  }

  async expireExecutionLease(input: { taskId: string; attemptId: string }): Promise<ControlTask> {
    return this.transaction(async (connection) => {
      const attempt = await connection.query(
        `UPDATE control_execution_attempts
         SET state = 'paused', failure_kind = 'worker_loss', finished_at = now()
         WHERE id = $1
           AND task_id = $2
           AND state = 'active'
           AND lease_expires_at <= now()
         RETURNING id, plan_version_id`,
        [input.attemptId, input.taskId],
      );
      const attemptRow = attempt.rows[0];
      if (!attemptRow) throw new ControlPlaneConflictError(`execution lease ${input.attemptId} is not expired and active`);
      const stepNo = await connection.query(
        `SELECT COALESCE(MAX(step_no), 0) + 1 AS step_no FROM control_execution_steps WHERE attempt_id = $1`,
        [input.attemptId],
      );
      await connection.query(
        `INSERT INTO control_execution_steps
           (attempt_id, step_no, step_name, actor_type, actor_id, state, failure_json, started_at, finished_at)
         VALUES ($1, $2, 'worker lease expired', 'system', 'worker-loss', 'failed', $3, now(), now())`,
        [input.attemptId, asNumber(stepNo.rows[0]?.step_no, 'step_no'), JSON.stringify({ kind: 'worker_loss', retryable: true, allowedActions: ['retry', 'abort'] })],
      );
      const task = await connection.query(
        `UPDATE control_tasks
         SET state = 'paused', state_version = state_version + 1, updated_at = now()
         WHERE id = $1
           AND state = 'executing'
           AND current_attempt_id = $2
           AND active_plan_version_id = $3
         RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
        [input.taskId, input.attemptId, attemptRow.plan_version_id],
      );
      const row = task.rows[0];
      if (!row) throw new ControlPlaneConflictError(`task ${input.taskId} is not executing expired attempt ${input.attemptId}`);
      return {
        id: asString(row.id, 'id'),
        state: asString(row.state, 'state') as ControlTaskState,
        stateVersion: asNumber(row.state_version, 'state_version'),
        activePlanVersionId: typeof row.active_plan_version_id === 'string' ? row.active_plan_version_id : null,
        currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
      };
    });
  }

  async cancelPausedExecution(input: {
    taskId: string;
    attemptId: string;
    expectedVersion: number;
  }): Promise<ControlTask> {
    return this.transaction(async (connection) => {
      const attempt = await connection.query(
        `UPDATE control_execution_attempts
         SET state = 'cancelled', finished_at = COALESCE(finished_at, now())
         WHERE id = $1 AND task_id = $2 AND state = 'paused'
         RETURNING id`,
        [input.attemptId, input.taskId],
      );
      if (!attempt.rows[0]) throw new ControlPlaneConflictError(`attempt ${input.attemptId} is not paused`);
      const task = await connection.query(
        `UPDATE control_tasks
         SET state = 'cancelled', state_version = state_version + 1, updated_at = now()
         WHERE id = $1 AND state = 'paused' AND state_version = $2 AND current_attempt_id = $3
         RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
        [input.taskId, input.expectedVersion, input.attemptId],
      );
      const row = task.rows[0];
      if (!row) throw new ControlPlaneConflictError(`task ${input.taskId} cannot cancel attempt ${input.attemptId}`);
      return {
        id: asString(row.id, 'id'),
        state: asString(row.state, 'state') as ControlTaskState,
        stateVersion: asNumber(row.state_version, 'state_version'),
        activePlanVersionId: typeof row.active_plan_version_id === 'string' ? row.active_plan_version_id : null,
        currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
      };
    });
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
