import { createHash } from 'node:crypto';
import type { MigrationConnection, MigrationDatabase } from '../../../../database/migration-runner.ts';
import type { ModelCallRecordInput } from '../runtime/llm-client.ts';
import type { ToolInvocationReceipt } from '../runtime/tool-adapter.ts';
import type {
  ArtifactRole,
  ExecutionPlan,
  OrchestrationMode,
  RequirementBrief,
  SkillNativeCandidate,
  SkillNativeExecutionState,
  SkillNativeTaskState,
  SkillNativeTaskSummary,
  SkillNativeZeroPublication,
  SkillNativeZeroPublicationDraft,
  SkillOutcome,
  SkillTaskMaterial,
  TaskArtifact,
} from '../../../../packages/api-contract/skill-native.ts';

export type StoredSkillNativeCandidate = SkillNativeCandidate;

export interface SkillNativeArtifactInput {
  id: string;
  taskId: string;
  ownerUserId: string;
  projectId: string;
  invocationId?: string;
  relativePath: string;
  fileName: string;
  mediaType: string;
  role: ArtifactRole;
  bytes: Uint8Array;
  contentSha256: string;
  sourceArtifactIds: string[];
}

export interface SkillNativeArtifactRecord extends SkillNativeArtifactInput {
  bytes: Buffer;
  createdAt?: Date;
}

export interface SkillNativeToolCallRecordInput {
  attemptId: string;
  invocationId: string;
  toolId: string;
  inputHash: string;
  output?: object;
  sources?: unknown[];
  receipt?: ToolInvocationReceipt;
  status: 'succeeded' | 'failed';
  failure?: Record<string, unknown>;
  startedAt: Date;
  finishedAt: Date;
}

export interface SkillNativeScriptCallRecordInput {
  attemptId: string;
  invocationId: string;
  runtime: 'node' | 'python' | 'bash';
  scriptPath: string;
  arguments: unknown[];
  inputArtifactIds: string[];
  outputArtifactIds: string[];
  status: 'succeeded' | 'failed';
  failure?: string;
  startedAt: Date;
  finishedAt: Date;
}

export type SkillNativeZeroPublicationReservation =
  | { status: 'reserved' }
  | { status: 'prepared'; draft: SkillNativeZeroPublicationDraft }
  | { status: 'completed'; publication: SkillNativeZeroPublication };

export interface SkillNativeTaskRecord {
  id: string;
  ownerUserId: string;
  projectId: string;
  originalInput: string;
  orchestrationMode: OrchestrationMode;
  state: SkillNativeTaskState;
  stateVersion: number;
  selectedCandidateId: string | null;
  requirement: RequirementBrief;
  candidates: StoredSkillNativeCandidate[];
  materials: SkillTaskMaterial[];
  plan: ExecutionPlan | null;
  execution: SkillNativeExecutionState;
  artifacts: TaskArtifact[];
  result: SkillOutcome | null;
  warnings: string[];
  failure: string | null;
  currentAttemptId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class SkillNativeStoreError extends Error {
  constructor(readonly code: 'not_found' | 'conflict', message: string) {
    super(message);
    this.name = 'SkillNativeStoreError';
  }
}

function assertArtifactInput(input: SkillNativeArtifactInput): void {
  if (input.bytes.byteLength === 0) throw new Error('Artifact bytes must not be empty');
  if (input.bytes.byteLength > 10 * 1024 * 1024) throw new Error('Artifact exceeds 10 MiB');
  const actual = `sha256:${createHash('sha256').update(input.bytes).digest('hex')}`;
  if (input.contentSha256 !== actual) throw new Error('Artifact content hash does not match its bytes');
  if (
    !input.relativePath
    || input.relativePath.startsWith('/')
    || input.relativePath.includes('\\')
    || input.relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Artifact relativePath is invalid');
  }
}

export interface SkillNativeTaskStore {
  create(input: {
    id: string;
    ownerUserId: string;
    projectId: string;
    originalInput: string;
    orchestrationMode: OrchestrationMode;
    requirement: RequirementBrief;
    candidates: StoredSkillNativeCandidate[];
    materials?: SkillTaskMaterial[];
    artifacts?: SkillNativeArtifactInput[];
  }): Promise<SkillNativeTaskRecord>;
  getOwned(taskId: string, ownerUserId: string): Promise<SkillNativeTaskRecord | null>;
  listOwned(ownerUserId: string): Promise<SkillNativeTaskSummary[]>;
  select(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    candidateId: string;
  }): Promise<SkillNativeTaskRecord>;
  confirm(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    plan: ExecutionPlan;
    materials: SkillTaskMaterial[];
    artifacts?: SkillNativeArtifactInput[];
  }): Promise<SkillNativeTaskRecord>;
  replan(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    requirement: RequirementBrief;
    candidates: StoredSkillNativeCandidate[];
  }): Promise<SkillNativeTaskRecord>;
  beginExecution(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    attemptId: string;
    from: 'ready' | 'waiting_for_user' | 'paused';
    materials?: SkillTaskMaterial[];
    artifacts?: SkillNativeArtifactInput[];
  }): Promise<SkillNativeTaskRecord>;
  saveExecution(input: {
    taskId: string;
    ownerUserId: string;
    attemptId: string;
    execution: SkillNativeExecutionState;
  }): Promise<boolean>;
  waitForUser(input: {
    taskId: string;
    ownerUserId: string;
    attemptId: string;
    execution: SkillNativeExecutionState;
    warnings: string[];
  }): Promise<SkillNativeTaskRecord | null>;
  pauseExecution(input: {
    taskId: string;
    ownerUserId: string;
    attemptId: string;
    execution: SkillNativeExecutionState;
    failure: string;
  }): Promise<SkillNativeTaskRecord | null>;
  finishExecution(input: {
    taskId: string;
    ownerUserId: string;
    attemptId: string;
    state: 'completed' | 'completed_with_gaps' | 'failed';
    execution: SkillNativeExecutionState;
    result: SkillOutcome | null;
    warnings: string[];
    failure: string | null;
  }): Promise<SkillNativeTaskRecord | null>;
  cancel(input: { taskId: string; ownerUserId: string; expectedVersion: number }): Promise<SkillNativeTaskRecord>;
  listArtifacts(input: { taskId: string; ownerUserId: string; projectId: string }): Promise<TaskArtifact[]>;
  getArtifactOwned(input: {
    artifactId: string;
    taskId: string;
    ownerUserId: string;
    projectId: string;
  }): Promise<SkillNativeArtifactRecord | null>;
  writeArtifact(input: SkillNativeArtifactInput, attemptId?: string): Promise<void>;
  recordModelCall(input: ModelCallRecordInput): Promise<string>;
  recordToolCall?(input: SkillNativeToolCallRecordInput): Promise<void>;
  recordScriptCall?(input: SkillNativeScriptCallRecordInput): Promise<void>;
  reserveZeroPublication(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
  }): Promise<SkillNativeZeroPublicationReservation>;
  prepareZeroPublication(input: {
    taskId: string;
    ownerUserId: string;
    draft: SkillNativeZeroPublicationDraft;
  }): Promise<void>;
  completeZeroPublication(input: {
    taskId: string;
    ownerUserId: string;
    publication: SkillNativeZeroPublication;
  }): Promise<void>;
  failZeroPublication(input: {
    taskId: string;
    ownerUserId: string;
    failure: string;
  }): Promise<void>;
  recoverInterrupted(): Promise<number>;
}

function numberValue(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`skill-native row has invalid ${field}`);
  return parsed;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`skill-native row has invalid ${field}`);
  return value;
}

function jsonValue<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function requiredJson<T>(value: unknown, field: string): T {
  if (value === null || value === undefined) throw new Error(`skill-native row has invalid ${field}`);
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function taskFromRow(row: Record<string, unknown>, artifacts: TaskArtifact[] = []): SkillNativeTaskRecord {
  return {
    id: stringValue(row.id, 'id'),
    ownerUserId: stringValue(row.owner_user_id, 'owner_user_id'),
    projectId: stringValue(row.project_id, 'project_id'),
    originalInput: stringValue(row.original_input, 'original_input'),
    orchestrationMode: stringValue(row.orchestration_mode, 'orchestration_mode') as OrchestrationMode,
    state: stringValue(row.state, 'state') as SkillNativeTaskState,
    stateVersion: numberValue(row.state_version, 'state_version'),
    selectedCandidateId: typeof row.selected_candidate_id === 'string' ? row.selected_candidate_id : null,
    requirement: requiredJson<RequirementBrief>(row.requirement_json, 'requirement_json'),
    candidates: jsonValue(row.candidates_json, []),
    materials: jsonValue(row.materials_json, []),
    plan: jsonValue(row.plan_json, null),
    execution: jsonValue(row.execution_json, { steps: [], checkpoint: null, externalKnowledge: [] }),
    artifacts,
    result: jsonValue(row.result_json, null),
    warnings: jsonValue(row.warnings_json, []),
    failure: typeof row.failure === 'string' ? row.failure : null,
    currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(stringValue(row.created_at, 'created_at')),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(stringValue(row.updated_at, 'updated_at')),
  };
}

function retainedMaterials(materials: readonly SkillTaskMaterial[]): SkillTaskMaterial[] {
  return materials.map((material) => ({ ...structuredClone(material), value: null }));
}

function retainedPlan(plan: ExecutionPlan | null): ExecutionPlan | null {
  if (!plan) return null;
  return {
    ...structuredClone(plan),
    requirement: {
      ...structuredClone(plan.requirement),
      materials: retainedMaterials(plan.requirement.materials),
    },
  };
}

const TASK_COLUMNS = `id, owner_user_id, project_id, original_input, orchestration_mode,
  state, state_version, selected_candidate_id, requirement_json, candidates_json, materials_json, plan_json,
  execution_json, result_json, warnings_json, failure, current_attempt_id, created_at, updated_at`;

export class PostgresSkillNativeTaskStore implements SkillNativeTaskStore {
  constructor(private readonly database: MigrationDatabase) {}

  private async transaction<T>(work: (connection: MigrationConnection) => Promise<T>): Promise<T> {
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

  async create(input: {
    id: string;
    ownerUserId: string;
    projectId: string;
    originalInput: string;
    orchestrationMode: OrchestrationMode;
    requirement: RequirementBrief;
    candidates: StoredSkillNativeCandidate[];
    materials?: SkillTaskMaterial[];
    artifacts?: SkillNativeArtifactInput[];
  }): Promise<SkillNativeTaskRecord> {
    return this.transaction(async (connection) => {
      const result = await connection.query(
         `INSERT INTO skill_native_tasks
           (id, owner_user_id, project_id, original_input, orchestration_mode, state,
            requirement_json, candidates_json, materials_json)
         VALUES ($1, $2, $3, $4, $5, 'awaiting_selection', $6, $7, $8)
         RETURNING ${TASK_COLUMNS}`,
        [
          input.id,
          input.ownerUserId,
          input.projectId,
          input.originalInput,
          input.orchestrationMode,
          JSON.stringify(input.requirement),
          JSON.stringify(input.candidates),
          JSON.stringify(input.materials ?? []),
        ],
      );
      await this.persistArtifacts(connection, input.artifacts ?? [], {
        taskId: input.id,
        ownerUserId: input.ownerUserId,
        projectId: input.projectId,
      });
      return this.taskWithArtifacts(connection, result.rows[0] ?? {});
    });
  }

  async getOwned(taskId: string, ownerUserId: string): Promise<SkillNativeTaskRecord | null> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT ${TASK_COLUMNS} FROM skill_native_tasks WHERE id = $1 AND owner_user_id = $2`,
        [taskId, ownerUserId],
      );
      return result.rows[0] ? this.taskWithArtifacts(connection, result.rows[0]) : null;
    } finally {
      connection.release();
    }
  }

  async listOwned(ownerUserId: string): Promise<SkillNativeTaskSummary[]> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT id, original_input, orchestration_mode, state, created_at, updated_at
         FROM skill_native_tasks WHERE owner_user_id = $1
         ORDER BY updated_at DESC, id DESC LIMIT 100`,
        [ownerUserId],
      );
      return result.rows.map((row) => ({
        id: stringValue(row.id, 'id'),
        originalInput: stringValue(row.original_input, 'original_input'),
        orchestrationMode: stringValue(row.orchestration_mode, 'orchestration_mode') as OrchestrationMode,
        state: stringValue(row.state, 'state') as SkillNativeTaskState,
        createdAt: (row.created_at instanceof Date ? row.created_at : new Date(stringValue(row.created_at, 'created_at'))).toISOString(),
        updatedAt: (row.updated_at instanceof Date ? row.updated_at : new Date(stringValue(row.updated_at, 'updated_at'))).toISOString(),
      }));
    } finally {
      connection.release();
    }
  }

  async select(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    candidateId: string;
  }): Promise<SkillNativeTaskRecord> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `UPDATE skill_native_tasks
         SET selected_candidate_id = $4, state = 'awaiting_confirmation',
             state_version = state_version + 1, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND state_version = $3
           AND state = 'awaiting_selection' AND selected_candidate_id IS NULL
         RETURNING ${TASK_COLUMNS}`,
        [input.taskId, input.ownerUserId, input.expectedVersion, input.candidateId],
      );
      if (!result.rows[0]) await this.throwStateError(connection, input.taskId, input.ownerUserId);
      return this.taskWithArtifacts(connection, result.rows[0]!);
    } finally {
      connection.release();
    }
  }

  async confirm(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    plan: ExecutionPlan;
    materials: SkillTaskMaterial[];
    artifacts?: SkillNativeArtifactInput[];
  }): Promise<SkillNativeTaskRecord> {
    return this.transaction(async (connection) => {
      const result = await connection.query(
        `UPDATE skill_native_tasks
         SET state = 'ready', plan_json = $4, materials_json = $5, failure = NULL,
             state_version = state_version + 1, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND state_version = $3
           AND state = 'awaiting_confirmation'
         RETURNING ${TASK_COLUMNS}`,
        [input.taskId, input.ownerUserId, input.expectedVersion, JSON.stringify(input.plan), JSON.stringify(input.materials)],
      );
      if (!result.rows[0]) await this.throwStateError(connection, input.taskId, input.ownerUserId);
      await this.persistArtifacts(connection, input.artifacts ?? [], {
        taskId: input.taskId,
        ownerUserId: input.ownerUserId,
        projectId: stringValue(result.rows[0]!.project_id, 'project_id'),
      });
      return this.taskWithArtifacts(connection, result.rows[0]!);
    });
  }

  async replan(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    requirement: RequirementBrief;
    candidates: StoredSkillNativeCandidate[];
  }): Promise<SkillNativeTaskRecord> {
    return this.transaction(async (connection) => {
      const states: SkillNativeTaskState[] = [
        'awaiting_selection', 'awaiting_confirmation', 'ready', 'waiting_for_user', 'paused',
        'failed', 'completed', 'completed_with_gaps',
      ];
      const result = await connection.query(
        `UPDATE skill_native_tasks
         SET state = 'awaiting_selection', selected_candidate_id = NULL, requirement_json = $4,
             candidates_json = $5, plan_json = NULL,
             execution_json = '{"steps":[],"checkpoint":null,"externalKnowledge":[]}'::jsonb,
             result_json = NULL, warnings_json = '[]'::jsonb, failure = NULL,
             current_attempt_id = NULL, zero_publication_status = NULL,
             zero_publication_json = NULL, zero_publication_failure = NULL,
             state_version = state_version + 1, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND state_version = $3
           AND state = ANY($6::text[])
           AND (zero_publication_status IS NULL OR zero_publication_status NOT IN ('publishing', 'prepared'))
         RETURNING ${TASK_COLUMNS}`,
        [
          input.taskId,
          input.ownerUserId,
          input.expectedVersion,
          JSON.stringify(input.requirement),
          JSON.stringify(input.candidates),
          states,
        ],
      );
      if (!result.rows[0]) await this.throwStateError(connection, input.taskId, input.ownerUserId);
      await connection.query(
        `DELETE FROM skill_native_artifacts
         WHERE task_id = $1 AND owner_user_id = $2 AND invocation_id IS NOT NULL`,
        [input.taskId, input.ownerUserId],
      );
      return this.taskWithArtifacts(connection, result.rows[0]!);
    });
  }

  async beginExecution(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    attemptId: string;
    from: 'ready' | 'waiting_for_user' | 'paused';
    materials?: SkillTaskMaterial[];
    artifacts?: SkillNativeArtifactInput[];
  }): Promise<SkillNativeTaskRecord> {
    return this.transaction(async (connection) => {
      const result = await connection.query(
        `UPDATE skill_native_tasks
         SET state = 'executing', current_attempt_id = $4, failure = NULL, materials_json = $6,
             state_version = state_version + 1, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND state_version = $3 AND state = $5
         RETURNING ${TASK_COLUMNS}`,
        [
          input.taskId, input.ownerUserId, input.expectedVersion, input.attemptId, input.from,
          JSON.stringify(input.materials ?? []),
        ],
      );
      if (!result.rows[0]) await this.throwStateError(connection, input.taskId, input.ownerUserId);
      await connection.query(
        `INSERT INTO skill_native_attempts (id, task_id, owner_user_id, status)
         VALUES ($1, $2, $3, 'running')`,
        [input.attemptId, input.taskId, input.ownerUserId],
      );
      await this.persistArtifacts(connection, input.artifacts ?? [], {
        taskId: input.taskId,
        ownerUserId: input.ownerUserId,
        projectId: stringValue(result.rows[0]!.project_id, 'project_id'),
      });
      return this.taskWithArtifacts(connection, result.rows[0]!);
    });
  }

  async saveExecution(input: {
    taskId: string;
    ownerUserId: string;
    attemptId: string;
    execution: SkillNativeExecutionState;
  }): Promise<boolean> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `UPDATE skill_native_tasks SET execution_json = $4, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND state = 'executing' AND current_attempt_id = $3
         RETURNING id`,
        [input.taskId, input.ownerUserId, input.attemptId, JSON.stringify(input.execution)],
      );
      return Boolean(result.rows[0]);
    } finally {
      connection.release();
    }
  }

  async waitForUser(input: {
    taskId: string;
    ownerUserId: string;
    attemptId: string;
    execution: SkillNativeExecutionState;
    warnings: string[];
  }): Promise<SkillNativeTaskRecord | null> {
    return this.endAttempt({ ...input, state: 'waiting_for_user', result: null, failure: null, attemptStatus: 'waiting_for_user' });
  }

  async pauseExecution(input: {
    taskId: string;
    ownerUserId: string;
    attemptId: string;
    execution: SkillNativeExecutionState;
    failure: string;
  }): Promise<SkillNativeTaskRecord | null> {
    return this.endAttempt({ ...input, state: 'paused', result: null, warnings: [], attemptStatus: 'interrupted' });
  }

  async finishExecution(input: {
    taskId: string;
    ownerUserId: string;
    attemptId: string;
    state: 'completed' | 'completed_with_gaps' | 'failed';
    execution: SkillNativeExecutionState;
    result: SkillOutcome | null;
    warnings: string[];
    failure: string | null;
  }): Promise<SkillNativeTaskRecord | null> {
    const task = await this.endAttempt({
      ...input,
      attemptStatus: input.state === 'failed' ? 'failed' : 'completed',
    });
    if (!task || input.state === 'failed') return task;
    return this.clearRawMaterials(task);
  }

  async cancel(input: { taskId: string; ownerUserId: string; expectedVersion: number }): Promise<SkillNativeTaskRecord> {
    return this.transaction(async (connection) => {
      const result = await connection.query(
        `UPDATE skill_native_tasks
         SET state = 'cancelled', state_version = state_version + 1, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND state_version = $3
           AND state = ANY($4::text[])
         RETURNING ${TASK_COLUMNS}`,
        [input.taskId, input.ownerUserId, input.expectedVersion, [
          'awaiting_selection', 'awaiting_confirmation', 'ready', 'executing',
          'waiting_for_user', 'paused', 'failed',
        ]],
      );
      if (!result.rows[0]) await this.throwStateError(connection, input.taskId, input.ownerUserId);
      const attemptId = result.rows[0]?.current_attempt_id;
      if (typeof attemptId === 'string') {
        await connection.query(
          `UPDATE skill_native_attempts SET status = 'cancelled', finished_at = now()
           WHERE id = $1 AND status = 'running'`,
          [attemptId],
        );
      }
      return this.taskWithArtifacts(connection, result.rows[0]!);
    });
  }

  async listArtifacts(input: { taskId: string; ownerUserId: string; projectId: string }): Promise<TaskArtifact[]> {
    const connection = await this.database.connect();
    try {
      return this.loadArtifacts(connection, input);
    } finally {
      connection.release();
    }
  }

  async getArtifactOwned(input: {
    artifactId: string;
    taskId: string;
    ownerUserId: string;
    projectId: string;
  }): Promise<SkillNativeArtifactRecord | null> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT id, task_id, owner_user_id, project_id, invocation_id, relative_path,
                file_name, media_type, artifact_role, source_artifact_ids, content_bytes,
                content_sha256, created_at
         FROM skill_native_artifacts
         WHERE id = $1 AND task_id = $2 AND owner_user_id = $3 AND project_id = $4`,
        [input.artifactId, input.taskId, input.ownerUserId, input.projectId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return this.artifactFromRow(row);
    } finally {
      connection.release();
    }
  }

  async writeArtifact(input: SkillNativeArtifactInput, attemptId?: string): Promise<void> {
    assertArtifactInput(input);
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `INSERT INTO skill_native_artifacts
           (id, task_id, owner_user_id, project_id, invocation_id, relative_path, file_name,
            media_type, artifact_role, source_artifact_ids, content_bytes, content_sha256, byte_size)
         SELECT $1, task.id, task.owner_user_id, task.project_id, $5, $6, $7, $8, $9,
                $10::jsonb, $11, $12, $13
         FROM skill_native_tasks task
         WHERE task.id = $2 AND task.owner_user_id = $3 AND task.project_id = $4
           AND ($14::uuid IS NULL OR (task.state = 'executing' AND task.current_attempt_id = $14))
         FOR UPDATE
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [
          input.id, input.taskId, input.ownerUserId, input.projectId, input.invocationId ?? null,
          input.relativePath, input.fileName, input.mediaType, input.role,
          JSON.stringify(input.sourceArtifactIds), Buffer.from(input.bytes), input.contentSha256,
          input.bytes.byteLength, attemptId ?? null,
        ],
      );
      if (!result.rows[0]) {
        const existing = await connection.query(
          `SELECT content_sha256 FROM skill_native_artifacts
           WHERE id = $1 AND task_id = $2 AND owner_user_id = $3 AND project_id = $4`,
          [input.id, input.taskId, input.ownerUserId, input.projectId],
        );
        if (existing.rows[0]?.content_sha256 !== input.contentSha256) {
          throw new SkillNativeStoreError('not_found', '任务或 Artifact 不存在');
        }
      }
    } finally {
      connection.release();
    }
  }

  async recordModelCall(input: ModelCallRecordInput): Promise<string> {
    if (!input.attemptId) throw new Error('native model receipt requires attemptId');
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `INSERT INTO skill_native_model_calls
           (attempt_id, stage, step_no, provider, endpoint_host, requested_model, actual_model,
            model_version, prompt_hash, context_manifest_hash, trace_id, tokens_json, status,
            failure_json, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING id`,
        [
          input.attemptId, input.stage, input.stepNo ?? null, input.provider, input.endpointHost,
          input.requestedModel, input.actualModel, input.modelVersion ?? 'unknown', input.promptHash,
          input.contextManifestHash ?? null, input.traceId ?? null,
          input.tokens == null ? null : JSON.stringify(input.tokens), input.status,
          input.failure == null ? null : JSON.stringify(input.failure), input.startedAt, input.finishedAt,
        ],
      );
      return stringValue(result.rows[0]?.id, 'model_call_id');
    } finally {
      connection.release();
    }
  }

  async recordToolCall(input: SkillNativeToolCallRecordInput): Promise<void> {
    const connection = await this.database.connect();
    try {
      await connection.query(
        `INSERT INTO skill_native_tool_calls
           (attempt_id, invocation_id, tool_id, input_hash, output_json, sources_json,
            receipt_json, status, failure_json, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          input.attemptId, input.invocationId, input.toolId, input.inputHash,
          input.output == null ? null : JSON.stringify(input.output), JSON.stringify(input.sources ?? []),
          input.receipt == null ? null : JSON.stringify(input.receipt), input.status,
          input.failure == null ? null : JSON.stringify(input.failure), input.startedAt, input.finishedAt,
        ],
      );
    } finally {
      connection.release();
    }
  }

  async recordScriptCall(input: SkillNativeScriptCallRecordInput): Promise<void> {
    const connection = await this.database.connect();
    try {
      await connection.query(
        `INSERT INTO skill_native_script_calls
           (attempt_id, invocation_id, runtime, script_path, arguments_json,
            input_artifact_ids, output_artifact_ids, status, failure, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11)`,
        [
          input.attemptId, input.invocationId, input.runtime, input.scriptPath,
          JSON.stringify(input.arguments), JSON.stringify(input.inputArtifactIds),
          JSON.stringify(input.outputArtifactIds), input.status, input.failure ?? null,
          input.startedAt, input.finishedAt,
        ],
      );
    } finally {
      connection.release();
    }
  }

  async reserveZeroPublication(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
  }): Promise<SkillNativeZeroPublicationReservation> {
    return this.transaction(async (connection) => {
      const selected = await connection.query(
        `SELECT state, state_version, result_json, zero_publication_status,
                zero_publication_json, zero_publication_failure
         FROM skill_native_tasks WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
        [input.taskId, input.ownerUserId],
      );
      const row = selected.rows[0];
      if (!row) throw new SkillNativeStoreError('not_found', '任务不存在');
      if (numberValue(row.state_version, 'state_version') !== input.expectedVersion) {
        throw new SkillNativeStoreError('conflict', `任务状态已变化：${row.state}@${row.state_version}`);
      }
      if ((row.state !== 'completed' && row.state !== 'completed_with_gaps') || row.result_json === null) {
        throw new SkillNativeStoreError('conflict', '报告尚未完成');
      }
      if (row.zero_publication_status === 'completed') {
        const publication = jsonValue<SkillNativeZeroPublication | null>(row.zero_publication_json, null);
        if (!publication) throw new Error('Zero publication receipt is missing');
        return { status: 'completed', publication };
      }
      if (row.zero_publication_status === 'prepared') {
        const draft = jsonValue<SkillNativeZeroPublicationDraft | null>(row.zero_publication_json, null);
        if (!draft) throw new Error('Zero publication draft receipt is missing');
        return { status: 'prepared', draft };
      }
      if (row.zero_publication_status === 'publishing') {
        throw new SkillNativeStoreError('conflict', 'Zero 发布正在进行');
      }
      await connection.query(
        `UPDATE skill_native_tasks
         SET zero_publication_status = 'publishing', zero_publication_json = NULL,
             zero_publication_failure = NULL, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2`,
        [input.taskId, input.ownerUserId],
      );
      return { status: 'reserved' };
    });
  }

  async prepareZeroPublication(input: {
    taskId: string;
    ownerUserId: string;
    draft: SkillNativeZeroPublicationDraft;
  }): Promise<void> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `UPDATE skill_native_tasks SET zero_publication_status = 'prepared',
             zero_publication_json = $3, zero_publication_failure = NULL, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND zero_publication_status = 'publishing'
         RETURNING id`,
        [input.taskId, input.ownerUserId, JSON.stringify(input.draft)],
      );
      if (!result.rows[0]) await this.throwStateError(connection, input.taskId, input.ownerUserId);
    } finally {
      connection.release();
    }
  }

  async completeZeroPublication(input: {
    taskId: string;
    ownerUserId: string;
    publication: SkillNativeZeroPublication;
  }): Promise<void> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `UPDATE skill_native_tasks SET zero_publication_status = 'completed',
             zero_publication_json = $3, zero_publication_failure = NULL, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND zero_publication_status = 'prepared'
         RETURNING id`,
        [input.taskId, input.ownerUserId, JSON.stringify(input.publication)],
      );
      if (!result.rows[0]) await this.throwStateError(connection, input.taskId, input.ownerUserId);
    } finally {
      connection.release();
    }
  }

  async failZeroPublication(input: { taskId: string; ownerUserId: string; failure: string }): Promise<void> {
    const connection = await this.database.connect();
    try {
      await connection.query(
        `UPDATE skill_native_tasks SET zero_publication_status = 'failed',
             zero_publication_failure = $3, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND zero_publication_status = 'publishing'`,
        [input.taskId, input.ownerUserId, input.failure],
      );
    } finally {
      connection.release();
    }
  }

  async recoverInterrupted(): Promise<number> {
    return this.transaction(async (connection) => {
      const executions = await connection.query(
        `UPDATE skill_native_tasks
         SET state = 'paused', failure = 'execution interrupted; resume uses the frozen package snapshot',
             state_version = state_version + 1, updated_at = now()
         WHERE state = 'executing' RETURNING id`,
      );
      await connection.query(
        `UPDATE skill_native_attempts SET status = 'interrupted', finished_at = now()
         WHERE status = 'running'`,
      );
      const publications = await connection.query(
        `UPDATE skill_native_tasks SET zero_publication_status = 'failed',
             zero_publication_failure = 'publication interrupted', updated_at = now()
         WHERE zero_publication_status = 'publishing' RETURNING id`,
      );
      return executions.rows.length + publications.rows.length;
    });
  }

  private async endAttempt(input: {
    taskId: string;
    ownerUserId: string;
    attemptId: string;
    state: 'waiting_for_user' | 'paused' | 'completed' | 'completed_with_gaps' | 'failed';
    execution: SkillNativeExecutionState;
    result: SkillOutcome | null;
    warnings: string[];
    failure: string | null;
    attemptStatus: 'waiting_for_user' | 'interrupted' | 'completed' | 'failed';
  }): Promise<SkillNativeTaskRecord | null> {
    return this.transaction(async (connection) => {
      const result = await connection.query(
        `UPDATE skill_native_tasks
         SET state = $4, execution_json = $5, result_json = $6, warnings_json = $7,
             failure = $8, current_attempt_id = NULL,
             state_version = state_version + 1, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND state = 'executing' AND current_attempt_id = $3
         RETURNING ${TASK_COLUMNS}`,
        [
          input.taskId, input.ownerUserId, input.attemptId, input.state,
          JSON.stringify(input.execution), input.result ? JSON.stringify(input.result) : null,
          JSON.stringify(input.warnings), input.failure,
        ],
      );
      if (!result.rows[0]) return null;
      await connection.query(
        `UPDATE skill_native_attempts SET status = $2, finished_at = now()
         WHERE id = $1 AND status = 'running'`,
        [input.attemptId, input.attemptStatus],
      );
      return this.taskWithArtifacts(connection, result.rows[0]);
    });
  }

  private async clearRawMaterials(task: SkillNativeTaskRecord): Promise<SkillNativeTaskRecord> {
    const retained = {
      ...task,
      materials: retainedMaterials(task.materials),
      plan: retainedPlan(task.plan),
    };
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `UPDATE skill_native_tasks SET materials_json = $3, plan_json = $4, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND state = $5 AND state_version = $6
         RETURNING ${TASK_COLUMNS}`,
        [
          task.id,
          task.ownerUserId,
          JSON.stringify(retained.materials),
          retained.plan ? JSON.stringify(retained.plan) : null,
          task.state,
          task.stateVersion,
        ],
      );
      return result.rows[0] ? this.taskWithArtifacts(connection, result.rows[0]) : retained;
    } finally {
      connection.release();
    }
  }

  private async persistArtifacts(
    connection: MigrationConnection,
    artifacts: SkillNativeArtifactInput[],
    scope: { taskId: string; ownerUserId: string; projectId: string },
  ): Promise<void> {
    for (const artifact of artifacts) {
      assertArtifactInput(artifact);
      if (
        artifact.taskId !== scope.taskId
        || artifact.ownerUserId !== scope.ownerUserId
        || artifact.projectId !== scope.projectId
      ) throw new Error('Artifact scope does not match its task');
      await connection.query(
        `INSERT INTO skill_native_artifacts
           (id, task_id, owner_user_id, project_id, invocation_id, relative_path, file_name,
            media_type, artifact_role, source_artifact_ids, content_bytes, content_sha256, byte_size)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)`,
        [
          artifact.id, artifact.taskId, artifact.ownerUserId, artifact.projectId,
          artifact.invocationId ?? null, artifact.relativePath, artifact.fileName, artifact.mediaType,
          artifact.role, JSON.stringify(artifact.sourceArtifactIds), Buffer.from(artifact.bytes),
          artifact.contentSha256, artifact.bytes.byteLength,
        ],
      );
    }
  }

  private artifactFromRow(row: Record<string, unknown>): SkillNativeArtifactRecord {
    return {
      id: stringValue(row.id, 'id'),
      taskId: stringValue(row.task_id, 'task_id'),
      ownerUserId: stringValue(row.owner_user_id, 'owner_user_id'),
      projectId: stringValue(row.project_id, 'project_id'),
      ...(typeof row.invocation_id === 'string' ? { invocationId: row.invocation_id } : {}),
      relativePath: stringValue(row.relative_path, 'relative_path'),
      fileName: stringValue(row.file_name, 'file_name'),
      mediaType: stringValue(row.media_type, 'media_type'),
      role: stringValue(row.artifact_role, 'artifact_role') as ArtifactRole,
      sourceArtifactIds: jsonValue(row.source_artifact_ids, []),
      bytes: Buffer.isBuffer(row.content_bytes) ? row.content_bytes : Buffer.from(row.content_bytes as Uint8Array),
      contentSha256: stringValue(row.content_sha256, 'content_sha256'),
      ...(row.created_at ? {
        createdAt: row.created_at instanceof Date ? row.created_at : new Date(stringValue(row.created_at, 'created_at')),
      } : {}),
    };
  }

  private async loadArtifacts(
    connection: MigrationConnection,
    input: { taskId: string; ownerUserId: string; projectId: string },
  ): Promise<TaskArtifact[]> {
    const result = await connection.query(
      `SELECT id, invocation_id, relative_path, file_name, media_type, artifact_role,
              source_artifact_ids, byte_size, content_sha256, created_at
       FROM skill_native_artifacts
       WHERE task_id = $1 AND owner_user_id = $2 AND project_id = $3
       ORDER BY created_at, id`,
      [input.taskId, input.ownerUserId, input.projectId],
    );
    return result.rows.map((row) => ({
      id: stringValue(row.id, 'id'),
      ...(typeof row.invocation_id === 'string' ? { invocationId: row.invocation_id } : {}),
      relativePath: stringValue(row.relative_path, 'relative_path'),
      fileName: stringValue(row.file_name, 'file_name'),
      mediaType: stringValue(row.media_type, 'media_type'),
      role: stringValue(row.artifact_role, 'artifact_role') as ArtifactRole,
      sourceArtifactIds: jsonValue(row.source_artifact_ids, []),
      byteSize: numberValue(row.byte_size, 'byte_size'),
      contentSha256: stringValue(row.content_sha256, 'content_sha256'),
      createdAt: (row.created_at instanceof Date ? row.created_at : new Date(stringValue(row.created_at, 'created_at'))).toISOString(),
    }));
  }

  private async taskWithArtifacts(
    connection: MigrationConnection,
    row: Record<string, unknown>,
  ): Promise<SkillNativeTaskRecord> {
    const task = taskFromRow(row);
    task.artifacts = await this.loadArtifacts(connection, {
      taskId: task.id,
      ownerUserId: task.ownerUserId,
      projectId: task.projectId,
    });
    return task;
  }

  private async throwStateError(
    connection: MigrationConnection,
    taskId: string,
    ownerUserId: string,
  ): Promise<never> {
    const existing = await connection.query(
      'SELECT state, state_version FROM skill_native_tasks WHERE id = $1 AND owner_user_id = $2',
      [taskId, ownerUserId],
    );
    if (!existing.rows[0]) throw new SkillNativeStoreError('not_found', '任务不存在');
    throw new SkillNativeStoreError(
      'conflict',
      `任务状态已变化：${existing.rows[0].state}@${existing.rows[0].state_version}`,
    );
  }

}
