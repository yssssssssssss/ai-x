import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { MigrationConnection, MigrationDatabase } from './migration-runner.ts';
import type {
  ControlPlanCandidatesResponse,
  CurrentPlanCandidate,
  ControlRequirementVersion,
} from '../packages/api-contract/control-workflow.ts';
import type {
  CurrentExecutionPlan,
  PendingInput,
} from '../packages/api-contract/research-deliverable.ts';
import type { ResearchTaskV2 } from '../packages/api-contract/plan.ts';
import { validateCurrentPlanRevision } from '../apps/orchestrator-runtime/src/planners/plan-compiler.ts';
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
  skillProvenance: Record<string, unknown> | null;
  failure: Record<string, unknown> | null;
  latencyMs: number | null;
}

export interface ControlModelCall {
  id: string;
  stage: string;
  stepNo: number | null;
  provider: string;
  endpointHost: string;
  requestedModel: string;
  actualModel: string;
  modelVersion: string;
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
  mediaType?: string | null;
  metadata?: Record<string, unknown> | null;
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


async function validateProblemGraphReceipt(
  connection: MigrationConnection,
  plan: unknown,
): Promise<void> {
  const record = asRecord(plan);
  const provenance = record ? asRecord(record.problem_graph_provenance) : null;
  const receiptId = provenance?.receiptId;
  if (!provenance || typeof receiptId !== 'string') {
    throw new ControlPlaneConflictError('problem graph provenance receiptId is missing');
  }
  const result = await connection.query(
    `SELECT stage, attempt_id, status, actual_model, model_version, prompt_hash, trace_id
     FROM control_model_calls
     WHERE id = $1
     FOR SHARE`,
    [receiptId],
  );
  const receipt = result.rows[0];
  if (
    !receipt
    || receipt.attempt_id !== null
    || receipt.stage !== 'problem_graph'
    || receipt.status !== 'succeeded'
    || receipt.actual_model !== provenance.modelName
    || receipt.model_version !== provenance.modelVersion
    || receipt.prompt_hash !== provenance.promptHash
    || receipt.trace_id !== provenance.traceId
  ) {
    throw new ControlPlaneConflictError(`problem graph provenance receipt ${receiptId} is not bound to the persisted model call`);
  }
}
function planForTask(plan: unknown, taskId: string): { json: string; hash: string } {
  const record = asRecord(plan);
  if (!record) throw new ControlPlaneConflictError('candidate plan must be an object');
  return canonicalPlan({ ...record, task_id: taskId });
}

function candidateMetadata(plan: Record<string, unknown>): {
  title: string;
  rationale: string;
  tradeoffs: string;
} {
  const metadata = asRecord(plan.candidate_metadata);
  const title = metadata && typeof metadata.title === 'string' ? metadata.title.trim() : '';
  const rationale = metadata && typeof metadata.rationale === 'string' ? metadata.rationale.trim() : '';
  const tradeoffs = metadata && typeof metadata.tradeoffs === 'string' ? metadata.tradeoffs.trim() : '';
  if (!title || !rationale || !tradeoffs) {
    throw new ControlPlaneConflictError('candidate plan metadata is missing or malformed');
  }
  return { title, rationale, tradeoffs };
}

function candidateActivatedNodes(plan: Record<string, unknown>): string[] {
  const activatedNodes = plan.activated_nodes;
  if (!Array.isArray(activatedNodes) || activatedNodes.some((node) => typeof node !== 'string')) {
    throw new ControlPlaneConflictError('candidate plan activated_nodes is malformed');
  }
  return activatedNodes;
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
    mediaType: typeof row.media_type === 'string' ? row.media_type : null,
    metadata: asRecord(row.metadata_json),
  };
}

export interface ControlTaskDetail extends ControlTask { conversationId: string; originalInput: string; ownerUserId: string; conversationOwnerUserId: string; structuredTask: unknown; activeRequirementVersionId: string | null; }

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
    originalInput: asString(row.original_input, 'original_input'),
    ownerUserId: asString(row.owner_user_id, 'owner_user_id'),
    conversationOwnerUserId: asString(row.conversation_owner_user_id, 'conversation_owner_user_id'),
    structuredTask: row.structured_task,
    state: asString(row.state, 'state') as ControlTaskState,
    stateVersion: asNumber(row.state_version, 'state_version'),
    activePlanVersionId: typeof row.active_plan_version_id === 'string' ? row.active_plan_version_id : null,
    currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
    activeRequirementVersionId: typeof row.active_requirement_version_id === 'string' ? row.active_requirement_version_id : null,
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
  value: unknown;
  actorUserId: string | null;
  actorRole: string | null;
  idempotencyKey: string;
}

export interface ControlCommandRecord {
  requestHash: string;
  response: unknown;
}

export type ControlCommandReservation =
  | { status: 'reserved'; reservationToken: string }
  | { status: 'pending' }
  | { status: 'replay'; response: unknown }
  | { status: 'conflict' };

export type ControlCommandWaitResult =
  | { status: 'replay'; response: unknown }
  | { status: 'released' | 'timeout' | 'conflict' };

export interface PersistClarificationCandidatesInput {
  taskId: string;
  conversationId: string;
  ownerUserId: string;
  expectedStateVersion: number;
  taskType: string;
  structuredTask: ResearchTaskV2;
  activatedNodes: string[];
  candidates: Array<{
    candidateId: ControlCandidateId;
    title: string;
    rationale: string;
    tradeoffs: string;
    plan: Omit<CurrentExecutionPlan, 'task_id'> & { task_id?: string };
    pendingInputs: PendingInput[];
  }>;
  command: {
    commandType: 'clarification';
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    reservationToken: string;
    actorUserId: string;
  };
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
  private async pauseExpiredExecutionLease(
    connection: MigrationConnection,
    input: {
      taskId: string;
      attemptId: string;
      planVersionId?: string;
      leaseOwner?: string;
      leaseToken?: string;
    },
  ): Promise<ControlTask | null> {
    const leaseTokenHash = input.leaseToken === undefined ? null : hashLeaseToken(input.leaseToken);
    const locked = await connection.query(
      `SELECT attempt.plan_version_id
       FROM control_execution_attempts AS attempt
       JOIN control_tasks AS task ON task.id = attempt.task_id
       WHERE attempt.id = $1
         AND attempt.task_id = $2
         AND ($3::uuid IS NULL OR attempt.plan_version_id = $3::uuid)
         AND ($4::text IS NULL OR attempt.lease_owner = $4)
         AND ($5::text IS NULL OR attempt.lease_token_hash = $5)
         AND attempt.state = 'active'
         AND attempt.lease_expires_at <= now()
         AND task.state IN ('executing', 'reviewing', 'composing_report')
         AND task.current_attempt_id = attempt.id
         AND task.active_plan_version_id = attempt.plan_version_id
       FOR UPDATE OF attempt, task`,
      [input.attemptId, input.taskId, input.planVersionId ?? null, input.leaseOwner ?? null, leaseTokenHash],
    );
    const lockedRow = locked.rows[0];
    if (!lockedRow) return null;
    const planVersionId = asString(lockedRow.plan_version_id, 'plan_version_id');

    const attempt = await connection.query(
      `UPDATE control_execution_attempts
       SET state = 'paused', failure_kind = 'worker_loss', finished_at = now()
       WHERE id = $1
         AND task_id = $2
         AND plan_version_id = $3
         AND ($4::text IS NULL OR lease_owner = $4)
         AND ($5::text IS NULL OR lease_token_hash = $5)
         AND state = 'active'
         AND lease_expires_at <= now()
       RETURNING id`,
      [input.attemptId, input.taskId, planVersionId, input.leaseOwner ?? null, leaseTokenHash],
    );
    if (!attempt.rows[0]) {
      throw new ControlPlaneConflictError(`execution lease ${input.attemptId} changed during expiry recovery`);
    }

    const task = await connection.query(
      `UPDATE control_tasks
       SET state = 'paused', state_version = state_version + 1, updated_at = now()
       WHERE id = $1
         AND state IN ('executing', 'reviewing', 'composing_report')
         AND current_attempt_id = $2
         AND active_plan_version_id = $3
       RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
      [input.taskId, input.attemptId, planVersionId],
    );
    const row = task.rows[0];
    if (!row) throw new ControlPlaneConflictError(`task ${input.taskId} changed during expiry recovery`);
    return {
      id: asString(row.id, 'id'),
      state: asString(row.state, 'state') as ControlTaskState,
      stateVersion: asNumber(row.state_version, 'state_version'),
      activePlanVersionId: typeof row.active_plan_version_id === 'string' ? row.active_plan_version_id : null,
      currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
    };
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
        `SELECT id, state FROM control_tasks WHERE id = $1 FOR KEY SHARE`,
        [input.taskId],
      );
      if (!task.rows[0]) throw new ControlPlaneConflictError(`task ${input.taskId} does not exist`);
      if (task.rows[0].state !== 'awaiting_clarification') throw new ControlPlaneConflictError(`task ${input.taskId} is not awaiting_clarification`);
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

  async createAndActivateRequirementVersion(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    rawInputHash: string;
    clarification: unknown;
    structuredTask: unknown;
    modelCallId?: string | null;
  }): Promise<{ version: ControlRequirementVersion; task: ControlTaskDetail }> {
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT task.id, task.conversation_id, task.original_input, task.owner_user_id,
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
      if (task.state !== 'awaiting_clarification') throw new ControlPlaneConflictError(`task ${input.taskId} is not awaiting_clarification`);
      if (asNumber(task.state_version, 'state_version') !== input.expectedVersion) {
        throw new ControlPlaneConflictError(`task ${input.taskId} is not at version ${input.expectedVersion}`);
      }

      const versionResult = await connection.query(
        `INSERT INTO control_requirement_versions
           (task_id, version, raw_input_hash, clarification_json, structured_task_json, model_call_id)
         SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3, $4, $5
         FROM control_requirement_versions
         WHERE task_id = $1
         RETURNING id, task_id, version, raw_input_hash, clarification_json,
                   structured_task_json, model_call_id, created_at`,
        [
          input.taskId,
          input.rawInputHash,
          JSON.stringify(input.clarification),
          JSON.stringify(input.structuredTask),
          input.modelCallId ?? null,
        ],
      );
      const versionRow = versionResult.rows[0] ?? {};
      const updated = await connection.query(
        `UPDATE control_tasks
         SET active_requirement_version_id = $2,
             structured_task = $3,
             state_version = state_version + 1,
             updated_at = now()
         WHERE id = $1
           AND state = 'awaiting_clarification'
           AND state_version = $4
         RETURNING id, conversation_id, original_input, owner_user_id,
                   (SELECT owner_user_id FROM conversations WHERE id = control_tasks.conversation_id)
                     AS conversation_owner_user_id,
                   structured_task, state, state_version, active_plan_version_id,
                   current_attempt_id, active_requirement_version_id`,
        [input.taskId, versionRow.id, JSON.stringify(input.structuredTask), input.expectedVersion],
      );
      const row = updated.rows[0];
      if (!row) throw new ControlPlaneConflictError(`task ${input.taskId} lost requirement activation CAS`);
      return {
        version: requirementVersionFromRow(versionRow),
        task: controlTaskDetailFromRow(row),
      };
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
        `SELECT task.id, task.conversation_id, task.original_input, task.owner_user_id,
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
      if (task.state !== 'awaiting_clarification') throw new ControlPlaneConflictError(`task ${input.taskId} is not awaiting_clarification`);
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
             structured_task = (SELECT structured_task_json FROM control_requirement_versions WHERE id = $2),
             state_version = state_version + 1,
             updated_at = now()
         WHERE id = $1 AND state = 'awaiting_clarification' AND state_version = $3
         RETURNING id, conversation_id, original_input, owner_user_id,
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
      for (const { persistedPlan } of preparedCandidates) {
        await validateProblemGraphReceipt(connection, JSON.parse(persistedPlan.json));
      }
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

  async persistExistingTaskWithCandidates(input: {
    taskId: string;
    conversationId: string;
    ownerUserId: string;
    expectedStateVersion: number;
    taskType: string | null;
    structuredTask: unknown;
    candidates: Array<{
      candidateId: ControlCandidateId;
      plan: Omit<CurrentExecutionPlan, 'task_id'> & { task_id?: string };
      pendingInputs: PendingInput[];
    }>;
  }): Promise<{ task: ControlTask; candidates: ControlCandidatePlanVersionDetail[] }> {
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT task.id, task.conversation_id, task.owner_user_id,
                conversation.owner_user_id AS conversation_owner_user_id,
                task.task_type, task.structured_task, task.state, task.state_version,
                task.active_plan_version_id, task.current_attempt_id
         FROM control_tasks AS task
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE task.id = $1
         FOR UPDATE OF task`,
        [input.taskId],
      );
      const taskRow = taskResult.rows[0];
      if (!taskRow) throw new ControlPlaneConflictError(`task ${input.taskId} does not exist`);
      if (taskRow.conversation_id !== input.conversationId) {
        throw new ControlPlaneConflictError(`task ${input.taskId} does not belong to conversation ${input.conversationId}`);
      }
      if (
        taskRow.owner_user_id !== input.ownerUserId
        || taskRow.conversation_owner_user_id !== input.ownerUserId
      ) {
        throw new ControlPlaneAuthorizationError(`actor cannot control task ${input.taskId}`);
      }
      if (taskRow.state !== 'awaiting_clarification') {
        throw new ControlPlaneConflictError(`task ${input.taskId} is not awaiting clarification`);
      }
      if (asNumber(taskRow.state_version, 'state_version') !== input.expectedStateVersion) {
        throw new ControlPlaneConflictError(`task ${input.taskId} is not at version ${input.expectedStateVersion}`);
      }
      const structuredTask = asRecord(input.structuredTask);
      if (!input.taskType || !structuredTask || structuredTask.task_type !== input.taskType) {
        throw new ControlPlaneConflictError(`task ${input.taskId} has invalid finalized structured task`);
      }
      const candidateIds = input.candidates.map((candidate) => candidate.candidateId);
      if (
        input.candidates.length !== 2
        || new Set(candidateIds).size !== 2
        || !candidateIds.includes('depth')
        || !candidateIds.includes('speed')
      ) {
        throw new ControlPlaneConflictError('existing task planning requires exactly depth and speed candidates');
      }

      const preparedCandidates = input.candidates.map((candidate) => ({
        candidate,
        persistedPlan: planForTask(candidate.plan, input.taskId),
      }));
      for (const { persistedPlan } of preparedCandidates) {
        await validateProblemGraphReceipt(connection, JSON.parse(persistedPlan.json));
      }
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
            input.taskId,
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

      const updated = await connection.query(
        `UPDATE control_tasks
         SET task_type = $2,
             structured_task = $3,
             state = 'awaiting_selection',
             state_version = state_version + 1,
             updated_at = now()
         WHERE id = $1
           AND state = 'awaiting_clarification'
           AND state_version = $4
         RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
        [input.taskId, input.taskType, JSON.stringify(input.structuredTask), input.expectedStateVersion],
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new ControlPlaneConflictError(`task ${input.taskId} lost planning CAS`);
      return {
        task: {
          id: asString(updatedRow.id, 'id'),
          state: asString(updatedRow.state, 'state') as ControlTaskState,
          stateVersion: asNumber(updatedRow.state_version, 'state_version'),
          activePlanVersionId: typeof updatedRow.active_plan_version_id === 'string' ? updatedRow.active_plan_version_id : null,
          currentAttemptId: typeof updatedRow.current_attempt_id === 'string' ? updatedRow.current_attempt_id : null,
        },
        candidates,
      };
    });
  }

  async persistClarificationCandidatesAndCompleteCommand(
    input: PersistClarificationCandidatesInput,
  ): Promise<ControlPlanCandidatesResponse> {
    if (input.expectedStateVersion !== input.command.expectedVersion + 1) {
      throw new ControlPlaneConflictError('clarification planning state version is not activation successor');
    }
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT task.id, task.conversation_id, task.owner_user_id,
                conversation.owner_user_id AS conversation_owner_user_id,
                task.state, task.state_version, task.active_plan_version_id,
                task.current_attempt_id
         FROM control_tasks AS task
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE task.id = $1
         FOR UPDATE OF task`,
        [input.taskId],
      );
      const taskRow = taskResult.rows[0];
      if (!taskRow) throw new ControlPlaneConflictError(`task ${input.taskId} does not exist`);
      if (taskRow.conversation_id !== input.conversationId) {
        throw new ControlPlaneConflictError(
          `task ${input.taskId} does not belong to conversation ${input.conversationId}`,
        );
      }
      if (
        taskRow.owner_user_id !== input.ownerUserId
        || taskRow.conversation_owner_user_id !== input.ownerUserId
      ) {
        throw new ControlPlaneAuthorizationError(`actor cannot control task ${input.taskId}`);
      }
      if (
        taskRow.state !== 'awaiting_clarification'
        || asNumber(taskRow.state_version, 'state_version') !== input.expectedStateVersion
      ) {
        throw new ControlPlaneConflictError(
          `task ${input.taskId} is not awaiting clarification at version ${input.expectedStateVersion}`,
        );
      }

      const commandResult = await connection.query(
        `SELECT request_hash, expected_version, actor_user_id, command_status, reservation_token
         FROM control_commands
         WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3
         FOR UPDATE`,
        [input.taskId, input.command.commandType, input.command.idempotencyKey],
      );
      const commandRow = commandResult.rows[0];
      if (
        !commandRow
        || commandRow.request_hash !== input.command.requestHash
        || asNumber(commandRow.expected_version, 'expected_version') !== input.command.expectedVersion
        || commandRow.actor_user_id !== input.command.actorUserId
        || input.command.actorUserId !== input.ownerUserId
        || commandRow.command_status !== 'pending'
        || commandRow.reservation_token !== input.command.reservationToken
      ) {
        throw new ControlPlaneConflictError('clarification command reservation fence was lost');
      }

      const structuredTask = asRecord(input.structuredTask);
      if (!structuredTask || structuredTask.task_type !== input.taskType) {
        throw new ControlPlaneConflictError(`task ${input.taskId} has invalid finalized structured task`);
      }
      const candidateById = new Map(input.candidates.map((candidate) => [candidate.candidateId, candidate]));
      if (
        input.candidates.length !== 2
        || candidateById.size !== 2
        || !candidateById.has('depth')
        || !candidateById.has('speed')
      ) {
        throw new ControlPlaneConflictError('clarification planning requires exactly depth and speed candidates');
      }
      const preparedCandidates = (['depth', 'speed'] as const).map((candidateId) => {
        const candidate = candidateById.get(candidateId)!;
        return { candidate, persistedPlan: planForTask(candidate.plan, input.taskId) };
      });
      for (const { persistedPlan } of preparedCandidates) {
        await validateProblemGraphReceipt(connection, JSON.parse(persistedPlan.json));
      }
      if (preparedCandidates[0]!.persistedPlan.hash === preparedCandidates[1]!.persistedPlan.hash) {
        throw new ControlPlaneConflictError('clarification candidate plan hashes are duplicated');
      }

      const persistedCandidates: Array<{
        candidate: PersistClarificationCandidatesInput['candidates'][number];
        stored: ControlCandidatePlanVersionDetail;
      }> = [];
      for (const [index, prepared] of preparedCandidates.entries()) {
        const planResult = await connection.query(
          `INSERT INTO control_plan_versions
             (task_id, version, candidate_id, plan_json, plan_hash, pending_inputs)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, task_id, version, candidate_id, plan_json, plan_hash, pending_inputs`,
          [
            input.taskId,
            index + 1,
            prepared.candidate.candidateId,
            prepared.persistedPlan.json,
            prepared.persistedPlan.hash,
            JSON.stringify(prepared.candidate.pendingInputs),
          ],
        );
        const row = planResult.rows[0] ?? {};
        persistedCandidates.push({
          candidate: prepared.candidate,
          stored: {
            id: asString(row.id, 'id'),
            taskId: asString(row.task_id, 'task_id'),
            version: asNumber(row.version, 'version'),
            candidateId: asString(row.candidate_id, 'candidate_id') as ControlCandidateId,
            plan: row.plan_json as CurrentExecutionPlan,
            planHash: asString(row.plan_hash, 'plan_hash'),
            pendingInputs: row.pending_inputs as PendingInput[],
          },
        });
      }

      const updated = await connection.query(
        `UPDATE control_tasks
         SET task_type = $2,
             structured_task = $3,
             state = 'awaiting_selection',
             state_version = state_version + 1,
             updated_at = now()
         WHERE id = $1 AND state = 'awaiting_clarification' AND state_version = $4
         RETURNING id, state, state_version, active_plan_version_id, current_attempt_id`,
        [input.taskId, input.taskType, JSON.stringify(input.structuredTask), input.expectedStateVersion],
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new ControlPlaneConflictError(`task ${input.taskId} lost planning CAS`);
      const response: ControlPlanCandidatesResponse = {
        kind: 'current',
        conversationId: input.conversationId,
        task: {
          id: asString(updatedRow.id, 'id'),
          state: asString(updatedRow.state, 'state') as ControlTaskState,
          stateVersion: asNumber(updatedRow.state_version, 'state_version'),
          activePlanVersionId: typeof updatedRow.active_plan_version_id === 'string'
            ? updatedRow.active_plan_version_id
            : null,
          currentAttemptId: typeof updatedRow.current_attempt_id === 'string'
            ? updatedRow.current_attempt_id
            : null,
        },
        structuredTask: input.structuredTask,
        activatedNodes: input.activatedNodes,
        candidates: persistedCandidates.map(({ candidate, stored }) => ({
          planVersionId: stored.id,
          candidateId: stored.candidateId,
          title: candidate.title,
          rationale: candidate.rationale,
          tradeoffs: candidate.tradeoffs,
          planHash: stored.planHash,
          plan: stored.plan,
          pendingInputs: stored.pendingInputs,
        })),
      };
      const completed = await connection.query(
        `UPDATE control_commands
         SET state_after = 'awaiting_selection',
             response_json = $8,
             command_status = 'completed',
             reservation_token = NULL,
             reservation_expires_at = NULL
         WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3
           AND request_hash = $4 AND expected_version = $5
           AND command_status = 'pending' AND reservation_token = $6
           AND actor_user_id = $7
         RETURNING id`,
        [
          input.taskId,
          input.command.commandType,
          input.command.idempotencyKey,
          input.command.requestHash,
          input.command.expectedVersion,
          input.command.reservationToken,
          input.command.actorUserId,
          JSON.stringify(response),
        ],
      );
      if (!completed.rows[0]) {
        throw new ControlPlaneConflictError('clarification command reservation fence was lost');
      }
      return response;
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
    const candidateId = input.candidateId;
    if (candidateId !== 'depth' && candidateId !== 'speed') {
      throw new ControlPlaneConflictError('Current plan revision requires a depth or speed candidate id');
    }
    const plan = asRecord(input.plan);
    if (!plan) throw new ControlPlaneConflictError('candidate revision plan must be an object');
    candidateMetadata(plan);
    candidateActivatedNodes(plan);
    return this.transaction(async (connection) => {
      const fromStates = Array.isArray(input.from) ? input.from : [input.from];
      const locked = await connection.query(
        `SELECT state, state_version, structured_task FROM control_tasks WHERE id = $1 FOR UPDATE`,
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
      await validateProblemGraphReceipt(connection, input.plan);
      const validatedPlan = validateCurrentPlanRevision({
        plan: input.plan,
        task: taskRow.structured_task,
        pending_inputs: input.pendingInputs ?? [],
        task_id: input.taskId,
        candidate_id: candidateId,
      });
      const persistedPlan = canonicalPlan(validatedPlan);
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
    mediaType?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ControlArtifact> {
    return this.transaction(async (connection) => {
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.storageUri]);
      const livePath = await connection.query(
        `SELECT id FROM control_artifacts
         WHERE storage_uri = $1 AND state IN ('STAGING', 'SEALED')
         LIMIT 1`,
        [input.storageUri],
      );
      if (livePath.rows[0]) {
        throw new ControlPlaneConflictError(`artifact path ${input.storageUri} already has a live owner`);
      }
      if (input.planVersionId) {
        const plan = await connection.query(
          'SELECT 1 FROM control_plan_versions WHERE id = $1 AND task_id = $2',
          [input.planVersionId, input.taskId],
        );
        if (!plan.rows[0]) {
          throw new ControlPlaneConflictError(`plan version ${input.planVersionId} does not belong to task ${input.taskId}`);
        }
      }
      if (input.attemptId) {
        if (!input.planVersionId) throw new ControlPlaneConflictError('attempt-bound artifact requires a plan version');
        const attempt = await connection.query(
          `SELECT 1 FROM control_execution_attempts
           WHERE id = $1 AND task_id = $2 AND plan_version_id = $3`,
          [input.attemptId, input.taskId, input.planVersionId],
        );
        if (!attempt.rows[0]) {
          throw new ControlPlaneConflictError(`attempt ${input.attemptId} does not belong to artifact task and plan`);
        }
      }
      const result = await connection.query(
        `INSERT INTO control_artifacts
           (task_id, plan_version_id, attempt_id, kind, contract_version, schema_version, state,
            storage_uri, sensitivity, redaction_policy_version, media_type, metadata_json)
         VALUES ($1, $2, $3, $4, 'trusted-p0-v1', $5, 'STAGING', $6, $7, $8, $9, $10)
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
          input.mediaType ?? null,
          input.metadata ? JSON.stringify(input.metadata) : null,
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
      const bindingResult = await connection.query(
        `SELECT artifact.task_id, artifact.plan_version_id, artifact.attempt_id, artifact.storage_uri,
                plan.task_id AS plan_task_id,
                attempt.task_id AS attempt_task_id,
                attempt.plan_version_id AS attempt_plan_version_id
         FROM control_artifacts AS artifact
         LEFT JOIN control_plan_versions AS plan ON plan.id = artifact.plan_version_id
         LEFT JOIN control_execution_attempts AS attempt ON attempt.id = artifact.attempt_id
         WHERE artifact.id = $1 AND artifact.state = 'STAGING'`,
        [input.artifactId],
      );
      const binding = bindingResult.rows[0];
      if (!binding) return null;
      const storageUri = asString(binding.storage_uri, 'storage_uri');
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [storageUri]);
      const competingPath = await connection.query(
        `SELECT id FROM control_artifacts
         WHERE storage_uri = $1
           AND id <> $2
           AND state IN ('STAGING', 'SEALED')
         LIMIT 1`,
        [storageUri, input.artifactId],
      );
      if (competingPath.rows[0]) return null;
      const taskId = asString(binding.task_id, 'task_id');
      const planVersionId = typeof binding.plan_version_id === 'string' ? binding.plan_version_id : null;
      const attemptId = typeof binding.attempt_id === 'string' ? binding.attempt_id : null;
      const validPlan = planVersionId === null || binding.plan_task_id === taskId;
      const validAttempt = attemptId === null || (
        planVersionId !== null
        && binding.attempt_task_id === taskId
        && binding.attempt_plan_version_id === planVersionId
      );
      if (!validPlan || !validAttempt) return null;
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
               AND task.state IN ('executing', 'reviewing', 'composing_report')
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
          await this.pauseExpiredExecutionLease(connection, {
            taskId: input.taskId!,
            planVersionId: input.planVersionId!,
            attemptId: input.attemptId!,
            leaseOwner: input.leaseOwner!,
            leaseToken: input.leaseToken!,
          });
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
           AND kind IN ('evidence_manifest', 'deliverable', 'report_review')
           AND state IN ('STAGING', 'SEALED')`,
        [input.taskId, input.planVersionId, input.attemptId, input.reason],
      );
    });
  }
  async invalidateArtifactPublication(artifactId: string, reason: string): Promise<void> {
    await this.transaction(async (connection) => {
      await connection.query(
        `UPDATE control_artifacts
         SET state = 'FAILED', failure_reason = $2, redaction_status = 'failed'
         WHERE id = $1 AND state IN ('STAGING', 'SEALED')`,
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

  async requireSealedArtifactBinding(artifactId: string): Promise<ControlArtifact> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT artifact.*,
                plan.task_id AS binding_plan_task_id,
                attempt.task_id AS binding_attempt_task_id,
                attempt.plan_version_id AS binding_attempt_plan_version_id
         FROM control_artifacts AS artifact
         LEFT JOIN control_plan_versions AS plan ON plan.id = artifact.plan_version_id
         LEFT JOIN control_execution_attempts AS attempt ON attempt.id = artifact.attempt_id
         WHERE artifact.id = $1 AND artifact.state = 'SEALED'`,
        [artifactId],
      );
      const row = result.rows[0];
      if (!row) throw new ArtifactNotSealedError(artifactId);
      const taskId = asString(row.task_id, 'task_id');
      const planVersionId = typeof row.plan_version_id === 'string' ? row.plan_version_id : null;
      const attemptId = typeof row.attempt_id === 'string' ? row.attempt_id : null;
      if (
        !planVersionId
        || row.binding_plan_task_id !== taskId
        || (attemptId !== null && (
          row.binding_attempt_task_id !== taskId
          || row.binding_attempt_plan_version_id !== planVersionId
        ))
      ) {
        throw new ControlPlaneConflictError(`artifact ${artifactId} identity binding is invalid`);
      }
      return artifactFromRow(row);
    } finally {
      connection.release();
    }
  }

  async listArtifactsByStorageUri(storageUri: string): Promise<ControlArtifact[]> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        'SELECT * FROM control_artifacts WHERE storage_uri = $1 ORDER BY created_at, id',
        [storageUri],
      );
      return result.rows.map(artifactFromRow);
    } finally {
      connection.release();
    }
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
        `SELECT task.id, task.conversation_id, task.original_input, task.owner_user_id, conversation.owner_user_id AS conversation_owner_user_id,
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

  async listCandidatePlanVersionsForOwner(input: {
    taskId: string;
    ownerUserId: string;
  }): Promise<{ candidates: CurrentPlanCandidate[]; activatedNodes: string[] } | null> {
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT task.state, task.owner_user_id,
                conversation.owner_user_id AS conversation_owner_user_id
         FROM control_tasks AS task
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE task.id = $1
         FOR KEY SHARE OF task`,
        [input.taskId],
      );
      const task = taskResult.rows[0];
      if (
        !task
        || task.owner_user_id !== input.ownerUserId
        || task.conversation_owner_user_id !== input.ownerUserId
      ) {
        return null;
      }
      if (task.state !== 'awaiting_selection') {
        throw new ControlPlaneConflictError(`task ${input.taskId} is not awaiting_selection`);
      }

      const result = await connection.query(
        `SELECT id, task_id, version, candidate_id, plan_json, plan_hash, pending_inputs
         FROM control_plan_versions
         WHERE task_id = $1
         ORDER BY version`,
        [input.taskId],
      );
      if (
        result.rows.length !== 2
        || result.rows[0]?.candidate_id !== 'depth'
        || result.rows[1]?.candidate_id !== 'speed'
      ) {
        throw new ControlPlaneConflictError('awaiting_selection task requires exactly depth and speed candidates');
      }

      let activatedNodes: string[] | null = null;
      const candidates = result.rows.map((row): CurrentPlanCandidate => {
        const plan = asRecord(row.plan_json);
        if (!plan || plan.task_id !== input.taskId) {
          throw new ControlPlaneConflictError('candidate plan task binding is malformed');
        }
        const planHash = asString(row.plan_hash, 'plan_hash');
        if (canonicalPlanHash(plan) !== planHash) {
          throw new ControlPlaneConflictError('candidate plan canonical hash does not match stored hash');
        }
        const metadata = candidateMetadata(plan);
        const candidateNodes = candidateActivatedNodes(plan);
        if (activatedNodes === null) {
          activatedNodes = candidateNodes;
        } else if (JSON.stringify(activatedNodes) !== JSON.stringify(candidateNodes)) {
          throw new ControlPlaneConflictError('candidate activated_nodes do not match');
        }
        if (!Array.isArray(row.pending_inputs)) {
          throw new ControlPlaneConflictError('candidate pending inputs are malformed');
        }
        return {
          planVersionId: asString(row.id, 'id'),
          candidateId: asString(row.candidate_id, 'candidate_id') as 'depth' | 'speed',
          ...metadata,
          planHash,
          plan: plan as unknown as CurrentExecutionPlan,
          pendingInputs: row.pending_inputs as PendingInput[],
        };
      });
      return { candidates, activatedNodes: activatedNodes ?? [] };
    });
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

  async reserveCommand(input: {
    taskId: string;
    commandType: string;
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    actorUserId?: string;
  }): Promise<ControlCommandReservation> {
    return this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT task.state, task.state_version, task.owner_user_id,
                conversation.owner_user_id AS conversation_owner_user_id
         FROM control_tasks AS task
         JOIN conversations AS conversation ON conversation.id = task.conversation_id
         WHERE task.id = $1
         FOR UPDATE OF task`,
        [input.taskId],
      );
      const task = taskResult.rows[0];
      if (!task) throw new ControlPlaneConflictError(`task ${input.taskId} does not exist`);
      if (
        input.actorUserId
        && (task.owner_user_id !== input.actorUserId
          || task.conversation_owner_user_id !== input.actorUserId)
      ) {
        throw new ControlPlaneAuthorizationError(`actor cannot control task ${input.taskId}`);
      }

      const existingResult = await connection.query(
        `SELECT request_hash, command_status, response_json, reservation_expires_at
         FROM control_commands
         WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3
         FOR UPDATE`,
        [input.taskId, input.commandType, input.idempotencyKey],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (existing.request_hash !== input.requestHash) return { status: 'conflict' };
        if (existing.command_status === 'completed') {
          return { status: 'replay', response: existing.response_json };
        }
        const expiresAt = asDate(existing.reservation_expires_at, 'reservation_expires_at');
        if (expiresAt.getTime() > Date.now()) return { status: 'pending' };
      }

      const taskStateVersion = asNumber(task.state_version, 'state_version');
      const resumesActivatedRequirement = Boolean(existing)
        && taskStateVersion === input.expectedVersion + 1;
      if (task.state !== 'awaiting_clarification') {
        throw new ControlPlaneConflictError(`task ${input.taskId} is not awaiting_clarification`);
      }
      if (taskStateVersion !== input.expectedVersion && !resumesActivatedRequirement) {
        throw new ControlPlaneConflictError(`task ${input.taskId} is not at version ${input.expectedVersion}`);
      }

      const reservationToken = randomUUID();
      const reservationExpiresAt = new Date(Date.now() + 5 * 60_000);
      if (existing) {
        await connection.query(
          `UPDATE control_commands
           SET expected_version = $4,
               state_before = 'awaiting_clarification',
               state_after = 'awaiting_clarification',
               actor_user_id = $5,
               reservation_token = $6,
               reservation_expires_at = $7
           WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3
             AND command_status = 'pending'`,
          [
            input.taskId,
            input.commandType,
            input.idempotencyKey,
            input.expectedVersion,
            input.actorUserId ?? null,
            reservationToken,
            reservationExpiresAt,
          ],
        );
      } else {
        await connection.query(
          `INSERT INTO control_commands
             (task_id, command_type, idempotency_key, request_hash, expected_version,
              state_before, state_after, response_json, actor_user_id, command_status,
              reservation_token, reservation_expires_at)
           VALUES ($1, $2, $3, $4, $5, 'awaiting_clarification',
                   'awaiting_clarification', NULL, $6, 'pending', $7, $8)`,
          [
            input.taskId,
            input.commandType,
            input.idempotencyKey,
            input.requestHash,
            input.expectedVersion,
            input.actorUserId ?? null,
            reservationToken,
            reservationExpiresAt,
          ],
        );
      }
      return { status: 'reserved', reservationToken };
    });
  }

  async completeCommand(input: {
    taskId: string;
    commandType: string;
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    reservationToken: string;
    stateAfter: ControlTaskState;
    response: unknown;
  }): Promise<void> {
    await this.transaction(async (connection) => {
      const result = await connection.query(
        `UPDATE control_commands
         SET state_after = $7,
             response_json = $8,
             command_status = 'completed',
             reservation_token = NULL,
             reservation_expires_at = NULL
         WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3
           AND request_hash = $4 AND expected_version = $5
           AND command_status = 'pending' AND reservation_token = $6
         RETURNING id`,
        [
          input.taskId,
          input.commandType,
          input.idempotencyKey,
          input.requestHash,
          input.expectedVersion,
          input.reservationToken,
          input.stateAfter,
          JSON.stringify(input.response),
        ],
      );
      if (!result.rows[0]) {
        throw new ControlPlaneConflictError('clarification command reservation fence was lost');
      }
    });
  }

  async releaseCommand(input: {
    taskId: string;
    commandType: string;
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    reservationToken: string;
  }): Promise<void> {
    await this.transaction(async (connection) => {
      await connection.query(
        `DELETE FROM control_commands
         WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3
           AND request_hash = $4 AND expected_version = $5
           AND command_status = 'pending' AND reservation_token = $6`,
        [
          input.taskId,
          input.commandType,
          input.idempotencyKey,
          input.requestHash,
          input.expectedVersion,
          input.reservationToken,
        ],
      );
    });
  }

  async recoverCommandAfterFailure(input: {
    taskId: string;
    commandType: string;
    idempotencyKey: string;
    requestHash: string;
    expectedVersion: number;
    reservationToken: string;
  }): Promise<void> {
    await this.transaction(async (connection) => {
      const taskResult = await connection.query(
        `SELECT state, state_version
         FROM control_tasks
         WHERE id = $1
         FOR UPDATE`,
        [input.taskId],
      );
      const task = taskResult.rows[0];
      if (!task) return;
      const taskStateVersion = asNumber(task.state_version, 'state_version');
      const commandValues = [
        input.taskId,
        input.commandType,
        input.idempotencyKey,
        input.requestHash,
        input.expectedVersion,
        input.reservationToken,
      ];
      if (taskStateVersion === input.expectedVersion) {
        await connection.query(
          `DELETE FROM control_commands
           WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3
             AND request_hash = $4 AND expected_version = $5
             AND command_status = 'pending' AND reservation_token = $6`,
          commandValues,
        );
        return;
      }
      if (task.state === 'awaiting_clarification' && taskStateVersion === input.expectedVersion + 1) {
        await connection.query(
          `UPDATE control_commands
           SET reservation_expires_at = now()
           WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3
             AND request_hash = $4 AND expected_version = $5
             AND command_status = 'pending' AND reservation_token = $6`,
          commandValues,
        );
      }
    });
  }

  async waitForCommand(input: {
    taskId: string;
    commandType: string;
    idempotencyKey: string;
    requestHash: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }): Promise<ControlCommandWaitResult> {
    const deadline = Date.now() + (input.timeoutMs ?? 1_000);
    while (true) {
      const connection = await this.database.connect();
      try {
        const result = await connection.query(
          `SELECT request_hash, command_status, response_json
           FROM control_commands
           WHERE task_id = $1 AND command_type = $2 AND idempotency_key = $3`,
          [input.taskId, input.commandType, input.idempotencyKey],
        );
        const command = result.rows[0];
        if (!command) return { status: 'released' };
        if (command.request_hash !== input.requestHash) return { status: 'conflict' };
        if (command.command_status === 'completed') {
          return { status: 'replay', response: command.response_json };
        }
      } finally {
        connection.release();
      }
      if (Date.now() >= deadline) return { status: 'timeout' };
      await delay(input.pollIntervalMs ?? 25);
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
          input.requiredAuthority, input.decision, input.value === undefined ? null : JSON.stringify(input.value),
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
        `SELECT gate_type, gate_key, required_authority, decision, value_json,
                actor_user_id, actor_role, idempotency_key
         FROM control_gate_records
         WHERE task_id = $1 AND plan_version_id = $2 ORDER BY created_at`,
        [taskId, planVersionId],
      );
      return result.rows.map((row) => ({
        gateType: asString(row.gate_type, 'gate_type'),
        gateKey: asString(row.gate_key, 'gate_key'),
        requiredAuthority: asString(row.required_authority, 'required_authority'),
        decision: asString(row.decision, 'decision'),
        value: row.value_json,
        actorUserId: row.actor_user_id == null ? null : asString(row.actor_user_id, 'actor_user_id'),
        actorRole: row.actor_role == null ? null : asString(row.actor_role, 'actor_role'),
        idempotencyKey: asString(row.idempotency_key, 'idempotency_key'),
      }));
    } finally {
      connection.release();
    }
  }

  async requireActiveLease(input: ControlExecutionLease): Promise<ActiveExecutionLease> {
    const outcome = await this.transaction(async (connection): Promise<ActiveExecutionLease | null> => {
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
           AND task.state IN ('executing', 'reviewing', 'composing_report')
           AND task.current_attempt_id = attempt.id
           AND task.active_plan_version_id = attempt.plan_version_id`,
        [input.attemptId, input.taskId, input.planVersionId, input.leaseOwner, hashLeaseToken(input.leaseToken)],
      );
      const row = result.rows[0];
      if (!row) {
        await this.pauseExpiredExecutionLease(connection, input);
        return null;
      }
      return {
        attemptId: asString(row.attempt_id, 'attempt_id'),
        taskId: asString(row.task_id, 'task_id'),
        planVersionId: asString(row.plan_version_id, 'plan_version_id'),
        leaseOwner: asString(row.lease_owner, 'lease_owner'),
        leaseExpiresAt: asDate(row.lease_expires_at, 'lease_expires_at'),
        stateVersion: asNumber(row.state_version, 'state_version'),
      };
    });
    if (!outcome) throw new ControlPlaneConflictError(`execution lease ${input.attemptId} is invalid or expired`);
    return outcome;
  }

  async heartbeatExecutionLease(input: ControlExecutionLease & { extendUntil: Date }): Promise<ActiveExecutionLease> {
    const outcome = await this.transaction(async (connection): Promise<ActiveExecutionLease | null> => {
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
           AND task.state IN ('executing', 'reviewing', 'composing_report')
           AND task.current_attempt_id = attempt.id
           AND task.active_plan_version_id = attempt.plan_version_id
         RETURNING attempt.id AS attempt_id, attempt.task_id, attempt.plan_version_id,
                   attempt.lease_owner, attempt.lease_expires_at, task.state_version`,
        [input.attemptId, input.taskId, input.planVersionId, input.leaseOwner, hashLeaseToken(input.leaseToken), input.extendUntil],
      );
      const row = result.rows[0];
      if (!row) {
        await this.pauseExpiredExecutionLease(connection, input);
        return null;
      }
      return {
        attemptId: asString(row.attempt_id, 'attempt_id'),
        taskId: asString(row.task_id, 'task_id'),
        planVersionId: asString(row.plan_version_id, 'plan_version_id'),
        leaseOwner: asString(row.lease_owner, 'lease_owner'),
        leaseExpiresAt: asDate(row.lease_expires_at, 'lease_expires_at'),
        stateVersion: asNumber(row.state_version, 'state_version'),
      };
    });
    if (!outcome) throw new ControlPlaneConflictError(`execution lease ${input.attemptId} cannot heartbeat`);
    return outcome;
  }

  async recordExecutionStep(input: {
    attemptId: string;
    stepNo: number;
    stepName: string;
    actorType: string;
    actorId: string;
    state: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
    toolProvenance?: Record<string, unknown>;
    skillProvenance?: Record<string, unknown>;
    failure?: Record<string, unknown>;
    latencyMs?: number;
    startedAt?: Date;
    finishedAt?: Date;
  }): Promise<void> {
    await this.transaction(async (connection) => {
      await connection.query(
        `INSERT INTO control_execution_steps
           (attempt_id, step_no, step_name, actor_type, actor_id, state,
            tool_provenance, skill_provenance, failure_json, latency_ms, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (attempt_id, step_no) DO UPDATE
         SET step_name = EXCLUDED.step_name,
             actor_type = EXCLUDED.actor_type,
             actor_id = EXCLUDED.actor_id,
             state = EXCLUDED.state,
             tool_provenance = COALESCE(EXCLUDED.tool_provenance, control_execution_steps.tool_provenance),
             skill_provenance = COALESCE(EXCLUDED.skill_provenance, control_execution_steps.skill_provenance),
             failure_json = COALESCE(EXCLUDED.failure_json, control_execution_steps.failure_json),
             latency_ms = COALESCE(EXCLUDED.latency_ms, control_execution_steps.latency_ms),
             started_at = COALESCE(control_execution_steps.started_at, EXCLUDED.started_at),
             finished_at = EXCLUDED.finished_at`,
        [
          input.attemptId, input.stepNo, input.stepName, input.actorType, input.actorId, input.state,
          input.toolProvenance == null ? null : JSON.stringify(input.toolProvenance),
          input.skillProvenance == null ? null : JSON.stringify(input.skillProvenance),
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
        `SELECT step_no, step_name, actor_type, actor_id, state, tool_provenance, skill_provenance, failure_json, latency_ms
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
        skillProvenance: asRecord(row.skill_provenance),
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
    modelVersion?: string;
    promptHash: string;
    contextManifestHash?: string;
    traceId?: string;
    tokens?: { prompt: number; completion: number; total: number };
    status: 'succeeded' | 'failed';
    failure: Record<string, unknown> | null;
    startedAt: Date;
    finishedAt: Date;
  }): Promise<string> {
    return this.transaction(async (connection) => {
      const result = await connection.query(
        `INSERT INTO control_model_calls
           (attempt_id, stage, step_no, provider, endpoint_host, requested_model, actual_model, model_version,
            prompt_hash, context_manifest_hash, trace_id, tokens_json, status, failure_json, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING id`,
        [
          input.attemptId ?? null, input.stage, input.stepNo ?? null, input.provider, input.endpointHost,
          input.requestedModel, input.actualModel, input.modelVersion ?? 'unknown', input.promptHash,
          input.contextManifestHash ?? null, input.traceId ?? null,
          input.tokens == null ? null : JSON.stringify(input.tokens), input.status,
          input.failure == null ? null : JSON.stringify(input.failure), input.startedAt, input.finishedAt,
        ],
      );
      return asString(result.rows[0]?.id, 'model_call_id');
    });
  }

  async listModelCalls(attemptId: string): Promise<ControlModelCall[]> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT id, stage, step_no, provider, endpoint_host, requested_model, actual_model, model_version,
                prompt_hash, context_manifest_hash, trace_id, tokens_json, status, failure_json
         FROM control_model_calls WHERE attempt_id = $1 ORDER BY started_at`,
        [attemptId],
      );
      return result.rows.map((row) => ({
        id: asString(row.id, 'id'),
        stage: asString(row.stage, 'stage'),
        stepNo: row.step_no == null ? null : asNumber(row.step_no, 'step_no'),
        provider: asString(row.provider, 'provider'),
        endpointHost: asString(row.endpoint_host, 'endpoint_host'),
        requestedModel: asString(row.requested_model, 'requested_model'),
        actualModel: asString(row.actual_model, 'actual_model'),
        modelVersion: asString(row.model_version, 'model_version'),
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
    const outcome = await this.transaction(async (connection): Promise<ControlTask | null> => {
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
      if (!attempt.rows[0]) {
        await this.pauseExpiredExecutionLease(connection, input);
        return null;
      }
      const task = await connection.query(
        `UPDATE control_tasks
         SET state = $4, state_version = state_version + 1, updated_at = now()
         WHERE id = $1
           AND state IN ('executing', 'reviewing', 'composing_report')
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
    if (!outcome) throw new ControlPlaneConflictError(`execution lease ${input.attemptId} cannot complete`);
    return outcome;
  }

  async expireExecutionLease(input: { taskId: string; attemptId: string }): Promise<ControlTask> {
    return this.transaction(async (connection) => {
      const task = await this.pauseExpiredExecutionLease(connection, input);
      if (!task) {
        throw new ControlPlaneConflictError(`execution lease ${input.attemptId} is not expired and active`);
      }
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
      return task;
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
         WHERE id = $1 AND state_version = $2
           AND state IN ('executing', 'reviewing', 'composing_report')
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
