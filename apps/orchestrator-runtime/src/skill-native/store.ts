import { createHash } from 'node:crypto';
import type { MigrationConnection, MigrationDatabase } from '../../../../database/migration-runner.ts';
import type { ModelCallRecordInput } from '../runtime/llm-client.ts';
import type { ToolInvocationReceipt } from '../runtime/tool-adapter.ts';
import type {
  OrchestrationMode,
  ReportResult,
  SkillDefinition,
  SkillNativeExecutionStepView,
  SkillNativeTaskState,
  SkillNativeTaskSummary,
  SkillNativeZeroPublication,
  SkillNativeZeroPublicationDraft,
  SolutionDefinition,
  SolutionPlan,
} from '../../../../packages/api-contract/skill-native.ts';
import type { InputMaterial, InputResolutionResult } from './input-resolution.ts';

const MAX_REUSABLE_MATERIAL_BYTES = 10 * 1024 * 1024;

export interface StoredSkillNativeCandidate {
  solution: SolutionDefinition;
  skills: SkillDefinition[];
  replacementSkills?: SkillDefinition[];
  initialMaterials: InputMaterial[];
  resolution: InputResolutionResult;
}

export interface SkillNativeArtifactInput {
  id: string;
  taskId: string;
  ownerUserId: string;
  projectId: string;
  inputId?: string;
  fileName: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: Uint8Array;
  contentSha256: string;
}

export interface SkillNativeArtifactRecord extends Omit<SkillNativeArtifactInput, 'bytes'> {
  bytes: Buffer;
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
  selectedSolutionId: string | null;
  candidates: StoredSkillNativeCandidate[];
  plan: SolutionPlan | null;
  executionSteps: SkillNativeExecutionStepView[];
  report: ReportResult | null;
  reportHtml: string | null;
  reportMarkdown: string | null;
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
  const actual = `sha256:${createHash('sha256').update(input.bytes).digest('hex')}`;
  if (input.contentSha256 !== actual) throw new Error('Artifact content hash does not match its bytes');
}

export interface SkillNativeTaskStore {
  create(input: {
    id: string;
    ownerUserId: string;
    projectId: string;
    originalInput: string;
    orchestrationMode: OrchestrationMode;
    candidates: StoredSkillNativeCandidate[];
    materials?: InputMaterial[];
    artifacts?: SkillNativeArtifactInput[];
  }): Promise<SkillNativeTaskRecord>;
  getOwned(taskId: string, ownerUserId: string): Promise<SkillNativeTaskRecord | null>;
  listOwned(ownerUserId: string): Promise<SkillNativeTaskSummary[]>;
  reserveSelection(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    solutionId: string;
  }): Promise<SkillNativeTaskRecord>;
  completeSelection(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    solutionId: string;
    candidates: StoredSkillNativeCandidate[];
  }): Promise<SkillNativeTaskRecord>;
  confirm(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    plan: SolutionPlan;
    materials: InputMaterial[];
    artifacts?: SkillNativeArtifactInput[];
  }): Promise<SkillNativeTaskRecord>;
  replan(input: { taskId: string; ownerUserId: string; expectedVersion: number; candidates: StoredSkillNativeCandidate[] }): Promise<SkillNativeTaskRecord>;
  beginExecution(input: { taskId: string; ownerUserId: string; expectedVersion: number; attemptId: string }): Promise<SkillNativeTaskRecord>;
  saveExecutionSteps(input: { taskId: string; ownerUserId: string; attemptId: string; steps: SkillNativeExecutionStepView[] }): Promise<boolean>;
  finishExecution(input: {
    taskId: string;
    ownerUserId: string;
    attemptId: string;
    state: 'completed' | 'completed_with_gaps' | 'failed';
    steps: SkillNativeExecutionStepView[];
    report: ReportResult | null;
    html: string | null;
    markdown: string | null;
    warnings: string[];
    failure: string | null;
  }): Promise<SkillNativeTaskRecord | null>;
  cancel(input: { taskId: string; ownerUserId: string; expectedVersion: number }): Promise<SkillNativeTaskRecord>;
  resume(input: { taskId: string; ownerUserId: string; expectedVersion: number }): Promise<SkillNativeTaskRecord>;
  listReusableMaterials(input: {
    ownerUserId: string;
    projectId: string;
    inputIds: readonly string[];
  }): Promise<InputMaterial[]>;
  getArtifactOwned(input: { artifactId: string; taskId: string; ownerUserId: string; projectId: string }): Promise<SkillNativeArtifactRecord | null>;
  writeArtifact(input: SkillNativeArtifactInput, attemptId?: string): Promise<void>;
  recordModelCall?(input: ModelCallRecordInput): Promise<string>;
  recordToolCall?(input: SkillNativeToolCallRecordInput): Promise<void>;
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

function taskFromRow(row: Record<string, unknown>): SkillNativeTaskRecord {
  return {
    id: stringValue(row.id, 'id'),
    ownerUserId: stringValue(row.owner_user_id, 'owner_user_id'),
    projectId: stringValue(row.project_id, 'project_id'),
    originalInput: stringValue(row.original_input, 'original_input'),
    orchestrationMode: stringValue(row.orchestration_mode, 'orchestration_mode') as OrchestrationMode,
    state: stringValue(row.state, 'state') as SkillNativeTaskState,
    stateVersion: numberValue(row.state_version, 'state_version'),
    selectedSolutionId: typeof row.selected_solution_id === 'string' ? row.selected_solution_id : null,
    candidates: jsonValue(row.candidates_json, []),
    plan: jsonValue(row.plan_json, null),
    executionSteps: jsonValue(row.execution_json, []),
    report: jsonValue(row.report_json, null),
    reportHtml: typeof row.report_html === 'string' ? row.report_html : null,
    reportMarkdown: typeof row.report_markdown === 'string' ? row.report_markdown : null,
    warnings: jsonValue(row.warnings_json, []),
    failure: typeof row.failure === 'string' ? row.failure : null,
    currentAttemptId: typeof row.current_attempt_id === 'string' ? row.current_attempt_id : null,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(stringValue(row.created_at, 'created_at')),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(stringValue(row.updated_at, 'updated_at')),
  };
}

function retainedCandidates(candidates: readonly StoredSkillNativeCandidate[]): StoredSkillNativeCandidate[] {
  return candidates.map((candidate) => ({
    ...structuredClone(candidate),
    initialMaterials: candidate.initialMaterials.map((material) => ({
      ...structuredClone(material),
      value: null,
    })),
    resolution: {
      ...structuredClone(candidate.resolution),
      inputs: candidate.resolution.inputs.map((input) => ({
        ...structuredClone(input),
        value: null,
      })),
    },
  }));
}

function retainedPlan(plan: SolutionPlan | null): SolutionPlan | null {
  if (!plan) return null;
  return {
    ...structuredClone(plan),
    requirement: {
      ...structuredClone(plan.requirement),
      inputs: plan.requirement.inputs.map((input) => ({
        ...structuredClone(input),
        value: input.source === 'tool' ? structuredClone(input.value) : null,
      })),
    },
  };
}

function reportArtifactIds(report: ReportResult | null): string[] {
  if (!report) return [];
  return [...new Set([
    ...report.sources.flatMap(({ artifactId }) => artifactId ? [artifactId] : []),
    ...report.sections.flatMap(({ blocks }) => blocks.flatMap((block) => (
      block.type === 'image' ? [block.artifactId] : []
    ))),
  ])];
}

function executionArtifactIds(steps: readonly SkillNativeExecutionStepView[]): string[] {
  return [...new Set(steps.flatMap(({ report }) => reportArtifactIds(report ?? null)))];
}

const TASK_COLUMNS = `id, owner_user_id, project_id, original_input, orchestration_mode,
  state, state_version, selected_solution_id, candidates_json, plan_json,
  execution_json, report_json, report_html, report_markdown, warnings_json, failure,
  current_attempt_id, created_at, updated_at`;

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
    candidates: StoredSkillNativeCandidate[];
    materials?: InputMaterial[];
    artifacts?: SkillNativeArtifactInput[];
  }): Promise<SkillNativeTaskRecord> {
    return this.transaction(async (connection) => {
      const result = await connection.query(
        `INSERT INTO skill_native_tasks
           (id, owner_user_id, project_id, original_input, orchestration_mode, state, candidates_json)
         VALUES ($1, $2, $3, $4, $5, 'awaiting_selection', $6)
         RETURNING ${TASK_COLUMNS}`,
        [input.id, input.ownerUserId, input.projectId, input.originalInput, input.orchestrationMode, JSON.stringify(input.candidates)],
      );
      await this.persistInputs(connection, {
        taskId: input.id,
        ownerUserId: input.ownerUserId,
        projectId: input.projectId,
        materials: input.materials ?? [],
        artifacts: input.artifacts ?? [],
      });
      return taskFromRow(result.rows[0] ?? {});
    });
  }

  async getOwned(taskId: string, ownerUserId: string): Promise<SkillNativeTaskRecord | null> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `SELECT ${TASK_COLUMNS} FROM skill_native_tasks WHERE id = $1 AND owner_user_id = $2`,
        [taskId, ownerUserId],
      );
      return result.rows[0] ? taskFromRow(result.rows[0]) : null;
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

  async reserveSelection(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    solutionId: string;
  }): Promise<SkillNativeTaskRecord> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `UPDATE skill_native_tasks
         SET selected_solution_id = $4, state_version = state_version + 1, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND state_version = $3
           AND state = 'awaiting_selection' AND selected_solution_id IS NULL
         RETURNING ${TASK_COLUMNS}`,
        [input.taskId, input.ownerUserId, input.expectedVersion, input.solutionId],
      );
      if (result.rows[0]) return taskFromRow(result.rows[0]);
      await this.throwStateError(connection, input.taskId, input.ownerUserId);
      throw new Error('unreachable');
    } finally {
      connection.release();
    }
  }

  async completeSelection(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    solutionId: string;
    candidates: StoredSkillNativeCandidate[];
  }): Promise<SkillNativeTaskRecord> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `UPDATE skill_native_tasks
         SET state = 'awaiting_confirmation', candidates_json = $5,
             state_version = state_version + 1, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND state_version = $3
           AND state = 'awaiting_selection' AND selected_solution_id = $4
         RETURNING ${TASK_COLUMNS}`,
        [input.taskId, input.ownerUserId, input.expectedVersion, input.solutionId, JSON.stringify(input.candidates)],
      );
      if (result.rows[0]) return taskFromRow(result.rows[0]);
      await this.throwStateError(connection, input.taskId, input.ownerUserId);
      throw new Error('unreachable');
    } finally {
      connection.release();
    }
  }

  async confirm(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
    plan: SolutionPlan;
    materials: InputMaterial[];
    artifacts?: SkillNativeArtifactInput[];
  }): Promise<SkillNativeTaskRecord> {
    return this.transaction(async (connection) => {
      const updated = await connection.query(
        `UPDATE skill_native_tasks
         SET state = 'ready', plan_json = $4, failure = NULL,
             state_version = state_version + 1, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND state_version = $3
           AND state = 'awaiting_confirmation'
         RETURNING ${TASK_COLUMNS}`,
        [input.taskId, input.ownerUserId, input.expectedVersion, JSON.stringify(input.plan)],
      );
      if (!updated.rows[0]) {
        const existing = await connection.query(
          'SELECT state, state_version FROM skill_native_tasks WHERE id = $1 AND owner_user_id = $2',
          [input.taskId, input.ownerUserId],
        );
        if (!existing.rows[0]) throw new SkillNativeStoreError('not_found', '任务不存在');
        throw new SkillNativeStoreError(
          'conflict',
          `任务状态已变化：${existing.rows[0].state}@${existing.rows[0].state_version}`,
        );
      }
      await this.persistInputs(connection, {
        taskId: input.taskId,
        ownerUserId: input.ownerUserId,
        projectId: stringValue(updated.rows[0].project_id, 'project_id'),
        materials: input.materials,
        artifacts: input.artifacts ?? [],
      });
      return taskFromRow(updated.rows[0]);
    });
  }

  async replan(input: { taskId: string; ownerUserId: string; expectedVersion: number; candidates: StoredSkillNativeCandidate[] }): Promise<SkillNativeTaskRecord> {
    return this.updateState(input.taskId, input.ownerUserId, input.expectedVersion, [
      'awaiting_selection', 'awaiting_confirmation', 'ready', 'paused', 'failed',
      'completed', 'completed_with_gaps',
    ], `
      state = 'awaiting_selection', selected_solution_id = NULL, candidates_json = $4,
      plan_json = NULL, execution_json = '[]'::jsonb, report_json = NULL,
      report_html = NULL, report_markdown = NULL, warnings_json = '[]'::jsonb,
      failure = NULL, current_attempt_id = NULL, zero_publication_status = NULL,
      zero_publication_json = NULL, zero_publication_failure = NULL
    `, [JSON.stringify(input.candidates)],
    `AND (state <> 'awaiting_selection' OR selected_solution_id IS NULL)
       AND (zero_publication_status IS NULL OR zero_publication_status NOT IN ('publishing', 'prepared'))`);
  }

  async beginExecution(input: { taskId: string; ownerUserId: string; expectedVersion: number; attemptId: string }): Promise<SkillNativeTaskRecord> {
    return this.transaction(async (connection) => {
      const result = await connection.query(
        `UPDATE skill_native_tasks
         SET state = 'executing', current_attempt_id = $4, failure = NULL,
             state_version = state_version + 1, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND state_version = $3 AND state = 'ready'
         RETURNING ${TASK_COLUMNS}`,
        [input.taskId, input.ownerUserId, input.expectedVersion, input.attemptId],
      );
      if (!result.rows[0]) {
        await this.throwStateError(connection, input.taskId, input.ownerUserId);
      }
      await connection.query(
        `INSERT INTO skill_native_attempts (id, task_id, owner_user_id, status)
         VALUES ($1, $2, $3, 'running')`,
        [input.attemptId, input.taskId, input.ownerUserId],
      );
      return taskFromRow(result.rows[0]!);
    });
  }

  async saveExecutionSteps(input: { taskId: string; ownerUserId: string; attemptId: string; steps: SkillNativeExecutionStepView[] }): Promise<boolean> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `UPDATE skill_native_tasks SET execution_json = $4, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND state = 'executing' AND current_attempt_id = $3
         RETURNING id`,
        [input.taskId, input.ownerUserId, input.attemptId, JSON.stringify(input.steps)],
      );
      return Boolean(result.rows[0]);
    } finally {
      connection.release();
    }
  }

  async finishExecution(input: {
    taskId: string;
    ownerUserId: string;
    attemptId: string;
    state: 'completed' | 'completed_with_gaps' | 'failed';
    steps: SkillNativeExecutionStepView[];
    report: ReportResult | null;
    html: string | null;
    markdown: string | null;
    warnings: string[];
    failure: string | null;
  }): Promise<SkillNativeTaskRecord | null> {
    return this.transaction(async (connection) => {
      const result = await connection.query(
        `UPDATE skill_native_tasks
         SET state = $4, execution_json = $5, report_json = $6, report_html = $7,
             report_markdown = $8, warnings_json = $9, failure = $10,
             state_version = state_version + 1, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND state = 'executing' AND current_attempt_id = $3
         RETURNING ${TASK_COLUMNS}`,
        [
          input.taskId, input.ownerUserId, input.attemptId, input.state,
          JSON.stringify(input.steps), input.report ? JSON.stringify(input.report) : null,
          input.html, input.markdown, JSON.stringify(input.warnings), input.failure,
        ],
      );
      if (result.rows[0]) {
        await connection.query(
          `UPDATE skill_native_attempts
           SET status = $2, finished_at = now()
           WHERE id = $1 AND status = 'running'`,
          [input.attemptId, input.state === 'failed' ? 'failed' : 'completed'],
        );
      }
      if (!result.rows[0]) return null;
      let task = taskFromRow(result.rows[0]);
      if (input.state === 'completed' || input.state === 'completed_with_gaps') {
        task = await this.clearRawInputs(connection, task, [
          ...new Set([...reportArtifactIds(input.report), ...executionArtifactIds(input.steps)]),
        ]);
      }
      return task;
    });
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
          'awaiting_selection', 'awaiting_confirmation', 'ready', 'executing', 'paused', 'failed',
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
      return this.clearRawInputs(connection, taskFromRow(result.rows[0]!), []);
    });
  }

  async resume(input: { taskId: string; ownerUserId: string; expectedVersion: number }): Promise<SkillNativeTaskRecord> {
    return this.updateState(input.taskId, input.ownerUserId, input.expectedVersion, ['paused', 'failed'], `
      state = 'ready', failure = NULL
    `, []);
  }

  async listReusableMaterials(input: {
    ownerUserId: string;
    projectId: string;
    inputIds: readonly string[];
  }): Promise<InputMaterial[]> {
    if (input.inputIds.length === 0) return [];
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `WITH latest AS (
           SELECT DISTINCT ON (input_id)
             id, input_id, value_json, valid_until, created_at
           FROM skill_native_materials
           WHERE owner_user_id = $1 AND project_id = $2
             AND input_id = ANY($3::text[])
             AND (valid_until IS NULL OR valid_until > now())
           ORDER BY input_id, created_at DESC, id DESC
         ), budgeted AS (
           SELECT *, sum(octet_length(value_json::text)) OVER (
             ORDER BY created_at DESC, id DESC
           ) AS cumulative_bytes
           FROM latest
         )
         SELECT id, input_id, value_json, valid_until
         FROM budgeted
         WHERE cumulative_bytes <= $4
         ORDER BY created_at DESC, id DESC`,
        [input.ownerUserId, input.projectId, [...new Set(input.inputIds)], MAX_REUSABLE_MATERIAL_BYTES],
      );
      return result.rows.map((row) => ({
        id: `database:${stringValue(row.id, 'id')}`,
        inputId: stringValue(row.input_id, 'input_id'),
        source: 'database' as const,
        value: row.value_json,
        ownerUserId: input.ownerUserId,
        projectId: input.projectId,
        ...(row.valid_until ? { validUntil: row.valid_until instanceof Date ? row.valid_until : new Date(stringValue(row.valid_until, 'valid_until')) } : {}),
      })).filter(({ value }) => !containsArtifactReference(value));
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
        `SELECT id, task_id, owner_user_id, project_id, input_id, file_name, media_type,
                content_bytes, content_sha256
         FROM skill_native_artifacts
         WHERE id = $1 AND task_id = $2 AND owner_user_id = $3 AND project_id = $4`,
        [input.artifactId, input.taskId, input.ownerUserId, input.projectId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const bytes = Buffer.isBuffer(row.content_bytes)
        ? row.content_bytes
        : Buffer.from(row.content_bytes as Uint8Array);
      return {
        id: stringValue(row.id, 'id'),
        taskId: stringValue(row.task_id, 'task_id'),
        ownerUserId: stringValue(row.owner_user_id, 'owner_user_id'),
        projectId: stringValue(row.project_id, 'project_id'),
        ...(typeof row.input_id === 'string' ? { inputId: row.input_id } : {}),
        fileName: stringValue(row.file_name, 'file_name'),
        mediaType: stringValue(row.media_type, 'media_type') as SkillNativeArtifactRecord['mediaType'],
        bytes,
        contentSha256: stringValue(row.content_sha256, 'content_sha256'),
      };
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
           (id, task_id, owner_user_id, project_id, input_id, file_name, media_type,
            content_bytes, content_sha256, byte_size)
         SELECT $1, task.id, task.owner_user_id, task.project_id, $5, $6, $7, $8, $9, $10
         FROM skill_native_tasks task
         WHERE task.id = $2 AND task.owner_user_id = $3 AND task.project_id = $4
           AND ($11::uuid IS NULL OR (task.state = 'executing' AND task.current_attempt_id = $11))
         FOR UPDATE
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [
          input.id, input.taskId, input.ownerUserId, input.projectId, input.inputId ?? null,
          input.fileName, input.mediaType, Buffer.from(input.bytes), input.contentSha256,
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

  async reserveZeroPublication(input: {
    taskId: string;
    ownerUserId: string;
    expectedVersion: number;
  }): Promise<SkillNativeZeroPublicationReservation> {
    return this.transaction(async (connection) => {
      const selected = await connection.query(
        `SELECT state, state_version, report_json, zero_publication_status,
                zero_publication_json, zero_publication_failure
         FROM skill_native_tasks
         WHERE id = $1 AND owner_user_id = $2
         FOR UPDATE`,
        [input.taskId, input.ownerUserId],
      );
      const row = selected.rows[0];
      if (!row) throw new SkillNativeStoreError('not_found', '任务不存在');
      if (numberValue(row.state_version, 'state_version') !== input.expectedVersion) {
        throw new SkillNativeStoreError(
          'conflict',
          `任务状态已变化：${stringValue(row.state, 'state')}@${row.state_version}`,
        );
      }
      if (
        (row.state !== 'completed' && row.state !== 'completed_with_gaps')
        || row.report_json === null
      ) {
        throw new SkillNativeStoreError('conflict', '报告尚未完成');
      }
      if (row.zero_publication_status === 'completed') {
        const publication = jsonValue<SkillNativeZeroPublication | null>(row.zero_publication_json, null);
        if (!publication) throw new Error('Zero publication receipt is missing');
        return {
          status: 'completed',
          publication,
        };
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
             zero_publication_failure = NULL,
             updated_at = now()
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
        `UPDATE skill_native_tasks
         SET zero_publication_status = 'prepared', zero_publication_json = $3,
             zero_publication_failure = NULL, updated_at = now()
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
        `UPDATE skill_native_tasks
         SET zero_publication_status = 'completed', zero_publication_json = $3,
             zero_publication_failure = NULL, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND zero_publication_status = 'prepared'
         RETURNING id`,
        [input.taskId, input.ownerUserId, JSON.stringify(input.publication)],
      );
      if (!result.rows[0]) await this.throwStateError(connection, input.taskId, input.ownerUserId);
    } finally {
      connection.release();
    }
  }

  async failZeroPublication(input: {
    taskId: string;
    ownerUserId: string;
    failure: string;
  }): Promise<void> {
    const connection = await this.database.connect();
    try {
      await connection.query(
        `UPDATE skill_native_tasks
         SET zero_publication_status = 'failed', zero_publication_failure = $3,
             updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND zero_publication_status = 'publishing'`,
        [input.taskId, input.ownerUserId, input.failure],
      );
    } finally {
      connection.release();
    }
  }

  async recoverInterrupted(): Promise<number> {
    return this.transaction(async (connection) => {
      const result = await connection.query(
        `UPDATE skill_native_tasks
         SET state = 'paused', failure = 'execution interrupted; retry uses the frozen plan',
             state_version = state_version + 1, updated_at = now()
         WHERE state = 'executing' RETURNING id`,
      );
      await connection.query(
        `UPDATE skill_native_attempts SET status = 'interrupted', finished_at = now()
         WHERE status = 'running'`,
      );
      const selections = await connection.query(
        `UPDATE skill_native_tasks
         SET selected_solution_id = NULL, state_version = state_version + 1, updated_at = now()
         WHERE state = 'awaiting_selection' AND selected_solution_id IS NOT NULL
         RETURNING id`,
      );
      const publications = await connection.query(
        `UPDATE skill_native_tasks
         SET zero_publication_status = 'failed',
             zero_publication_failure = 'publication interrupted', updated_at = now()
         WHERE zero_publication_status = 'publishing'
         RETURNING id`,
      );
      return result.rows.length + selections.rows.length + publications.rows.length;
    });
  }

  private async persistInputs(connection: MigrationConnection, input: {
    taskId: string;
    ownerUserId: string;
    projectId: string;
    materials: InputMaterial[];
    artifacts: SkillNativeArtifactInput[];
  }): Promise<void> {
    for (const artifact of input.artifacts) {
      assertArtifactInput(artifact);
      if (
        artifact.taskId !== input.taskId
        || artifact.ownerUserId !== input.ownerUserId
        || artifact.projectId !== input.projectId
      ) throw new Error('Artifact scope does not match its task');
      await connection.query(
        `INSERT INTO skill_native_artifacts
           (id, task_id, owner_user_id, project_id, input_id, file_name, media_type,
            content_bytes, content_sha256, byte_size)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          artifact.id, artifact.taskId, artifact.ownerUserId, artifact.projectId,
          artifact.inputId ?? null, artifact.fileName, artifact.mediaType,
          Buffer.from(artifact.bytes), artifact.contentSha256, artifact.bytes.byteLength,
        ],
      );
    }
    for (const material of input.materials.filter(({ source }) => source === 'upload')) {
      await connection.query(
        `INSERT INTO skill_native_materials
           (task_id, owner_user_id, project_id, input_id, source_kind, value_json, valid_until)
         VALUES ($1, $2, $3, $4, 'upload', $5, $6)`,
        [
          input.taskId, input.ownerUserId, input.projectId, material.inputId,
          JSON.stringify(material.value), material.validUntil ?? new Date(Date.now() + 24 * 60 * 60 * 1_000),
        ],
      );
    }
  }

  private async clearRawInputs(
    connection: MigrationConnection,
    task: SkillNativeTaskRecord,
    retainedArtifactIds: string[],
  ): Promise<SkillNativeTaskRecord> {
    const sanitized = await connection.query(
      `UPDATE skill_native_tasks
       SET candidates_json = $3, plan_json = $4, updated_at = now()
       WHERE id = $1 AND owner_user_id = $2
       RETURNING ${TASK_COLUMNS}`,
      [
        task.id,
        task.ownerUserId,
        JSON.stringify(retainedCandidates(task.candidates)),
        task.plan ? JSON.stringify(retainedPlan(task.plan)) : null,
      ],
    );
    await connection.query(
      `DELETE FROM skill_native_materials WHERE task_id = $1 AND owner_user_id = $2`,
      [task.id, task.ownerUserId],
    );
    await connection.query(
      `DELETE FROM skill_native_artifacts
       WHERE task_id = $1 AND owner_user_id = $2 AND NOT (id = ANY($3::uuid[]))`,
      [task.id, task.ownerUserId, retainedArtifactIds],
    );
    return taskFromRow(sanitized.rows[0]!);
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

  private async updateState(
    taskId: string,
    ownerUserId: string,
    expectedVersion: number,
    states: SkillNativeTaskState[],
    assignments: string,
    extra: unknown[],
    condition = '',
  ): Promise<SkillNativeTaskRecord> {
    const connection = await this.database.connect();
    try {
      const result = await connection.query(
        `UPDATE skill_native_tasks SET ${assignments}, state_version = state_version + 1, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND state_version = $3 AND state = ANY($${4 + extra.length}::text[])
           ${condition}
         RETURNING ${TASK_COLUMNS}`,
        [taskId, ownerUserId, expectedVersion, ...extra, states],
      );
      if (result.rows[0]) return taskFromRow(result.rows[0]);
      const existing = await connection.query(
        'SELECT state, state_version FROM skill_native_tasks WHERE id = $1 AND owner_user_id = $2',
        [taskId, ownerUserId],
      );
      if (!existing.rows[0]) throw new SkillNativeStoreError('not_found', '任务不存在');
      throw new SkillNativeStoreError(
        'conflict',
        `任务状态已变化：${existing.rows[0].state}@${existing.rows[0].state_version}`,
      );
    } finally {
      connection.release();
    }
  }
}

function containsArtifactReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsArtifactReference);
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (typeof item.artifactId === 'string' && item.artifactId.trim()) return true;
  return Object.values(item).some(containsArtifactReference);
}
