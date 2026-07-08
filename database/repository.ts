import { pool } from './db.ts';

// 最小 DAO:V0 只覆盖主链路与验收所需的读写。
// 复杂查询/分页/软删留 P1+。所有写入返回落库后的行。

// ---- 类型(与 DDL 对齐,仅列常用字段)----
export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  status: string;
}

export interface ConversationRow {
  id: string;
  owner_user_id: string;
  title: string;
  status: string;
  summary: string | null;
  last_message_at: string | null;
  updated_at: string;
}

export interface ResearchTaskRow {
  id: string;
  conversation_id: string;
  owner_user_id: string;
  original_input: string;
  task_type: string | null;
  structured_task: unknown;
  assumptions: unknown;
  confirmations: unknown;
  blocking_issues: unknown;
  approval_state: string;
  status: string;
  run_workspace_uri: string;
  sensitivity: string;
  pii_detected: boolean;
}

export interface ExecutionLogRow {
  id: string;
  task_id: string;
  step_no: number;
  step_name: string;
  actor_type: string;
  actor_id: string;
  status: string;
}

// ---- 用户 ----
export async function createUser(input: {
  email: string;
  displayName: string;
  passwordHash: string;
  role?: string;
}): Promise<UserRow> {
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO users (email, display_name, password_hash, role)
     VALUES ($1, $2, $3, COALESCE($4, 'member'))
     RETURNING id, email, display_name, role, status`,
    [input.email, input.displayName, input.passwordHash, input.role ?? null],
  );
  return rows[0];
}

// 登录校验专用:返回含 password_hash 的行(其它读取路径不暴露 hash)。
export async function getUserByEmail(
  email: string,
): Promise<(UserRow & { password_hash: string }) | null> {
  const { rows } = await pool.query<UserRow & { password_hash: string }>(
    `SELECT id, email, display_name, role, status, password_hash
     FROM users WHERE email = $1`,
    [email],
  );
  return rows[0] ?? null;
}

export async function getUserById(id: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(
    `SELECT id, email, display_name, role, status FROM users WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

// ---- 会话 ----
export async function createConversation(input: {
  ownerUserId: string;
  title: string;
}): Promise<ConversationRow> {
  const { rows } = await pool.query<ConversationRow>(
    `INSERT INTO conversations (owner_user_id, title)
     VALUES ($1, $2)
     RETURNING id, owner_user_id, title, status, summary, last_message_at, updated_at`,
    [input.ownerUserId, input.title],
  );
  return rows[0];
}

// owner 最近会话(验收:按 owner_user_id 查最近会话)
export async function listRecentConversations(
  ownerUserId: string,
  limit = 20,
): Promise<ConversationRow[]> {
  const { rows } = await pool.query<ConversationRow>(
    `SELECT id, owner_user_id, title, status, summary, last_message_at, updated_at
     FROM conversations
     WHERE owner_user_id = $1
     ORDER BY updated_at DESC
     LIMIT $2`,
    [ownerUserId, limit],
  );
  return rows;
}

// ---- 消息 ----
export async function writeMessage(input: {
  conversationId: string;
  senderType: 'user' | 'assistant' | 'system' | 'tool';
  messageType: 'text' | 'plan' | 'execution_update' | 'report' | 'error';
  content: unknown;
  artifactId?: string;
}): Promise<{ id: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO messages (conversation_id, sender_type, message_type, content, artifact_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      input.conversationId,
      input.senderType,
      input.messageType,
      JSON.stringify(input.content),
      input.artifactId ?? null,
    ],
  );
  // 更新会话最后消息时间(会话记忆/断点恢复用)
  await pool.query(
    `UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`,
    [input.conversationId],
  );
  return rows[0];
}

// 会话消息回放(验收:按 conversation_id 时间序回放)
export async function listMessages(conversationId: string): Promise<
  Array<{ id: string; sender_type: string; message_type: string; content: unknown }>
> {
  const { rows } = await pool.query(
    `SELECT id, sender_type, message_type, content
     FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC`,
    [conversationId],
  );
  return rows;
}

// ---- 研究任务 ----
export async function createResearchTask(input: {
  conversationId: string;
  ownerUserId: string;
  originalInput: string;
  taskType: string | null;
  structuredTask: unknown;
  assumptions?: unknown;
  confirmations?: unknown;
  blockingIssues?: unknown;
  runWorkspaceUri: string;
  sensitivity?: string;
  piiDetected?: boolean;
}): Promise<ResearchTaskRow> {
  const { rows } = await pool.query<ResearchTaskRow>(
    `INSERT INTO research_tasks
       (conversation_id, owner_user_id, original_input, task_type, structured_task,
        assumptions, confirmations, blocking_issues, run_workspace_uri, sensitivity, pii_detected)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,'internal'),COALESCE($11,false))
     RETURNING *`,
    [
      input.conversationId,
      input.ownerUserId,
      input.originalInput,
      input.taskType,
      JSON.stringify(input.structuredTask),
      JSON.stringify(input.assumptions ?? []),
      JSON.stringify(input.confirmations ?? []),
      JSON.stringify(input.blockingIssues ?? []),
      input.runWorkspaceUri,
      input.sensitivity ?? null,
      input.piiDetected ?? null,
    ],
  );
  return rows[0];
}

export async function getResearchTask(taskId: string): Promise<ResearchTaskRow | null> {
  const { rows } = await pool.query<ResearchTaskRow>(
    `SELECT * FROM research_tasks WHERE id = $1`,
    [taskId],
  );
  return rows[0] ?? null;
}

export async function updateTaskStatus(
  taskId: string,
  status: string,
  approvalState?: string,
): Promise<void> {
  await pool.query(
    `UPDATE research_tasks
     SET status = $2,
         approval_state = COALESCE($3, approval_state),
         updated_at = now()
     WHERE id = $1`,
    [taskId, status, approvalState ?? null],
  );
}

// owner 最近任务(验收:按 owner_user_id 查最近任务,历史复盘入口)
export async function listRecentTasks(
  ownerUserId: string,
  limit = 20,
): Promise<ResearchTaskRow[]> {
  const { rows } = await pool.query<ResearchTaskRow>(
    `SELECT * FROM research_tasks
     WHERE owner_user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [ownerUserId, limit],
  );
  return rows;
}

// ---- 决策节点状态 ----
export async function writeDecisionState(input: {
  taskId: string;
  nodeKey: string;
  state: string;
  reason: string;
  confidence?: number;
  userOverride?: unknown;
  finalState: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO task_decision_states
       (task_id, node_key, state, reason, confidence, user_override, final_state)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (task_id, node_key) DO UPDATE
       SET state = EXCLUDED.state,
           reason = EXCLUDED.reason,
           confidence = EXCLUDED.confidence,
           user_override = EXCLUDED.user_override,
           final_state = EXCLUDED.final_state`,
    [
      input.taskId,
      input.nodeKey,
      input.state,
      input.reason,
      input.confidence ?? null,
      input.userOverride ? JSON.stringify(input.userOverride) : null,
      input.finalState,
    ],
  );
}

// 按 task_id 查决策状态(验收:复盘"为什么激活/没激活某节点")
export async function listDecisionStates(taskId: string): Promise<
  Array<{ node_key: string; state: string; reason: string; final_state: string; confidence: number | null }>
> {
  const { rows } = await pool.query(
    `SELECT node_key, state, reason, final_state, confidence
     FROM task_decision_states
     WHERE task_id = $1
     ORDER BY node_key ASC`,
    [taskId],
  );
  return rows;
}

// ---- 执行日志 ----
export async function writeExecutionLog(input: {
  taskId: string;
  stepNo: number;
  stepName: string;
  actorType: 'skill' | 'tool' | 'llm' | 'reviewer';
  actorId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  inputRef?: string;
  outputRef?: string;
  errorJson?: unknown;
  tokensJson?: unknown;
  latencyMs?: number;
  contextManifestRef?: string;
  configGitCommit?: string;
  decisionGraphHash?: string;
  skillManifestHashes?: unknown[];
  toolManifestHashes?: unknown[];
  promptHash?: string;
  modelName?: string;
  modelVersion?: string;
  traceId?: string;
  startedAt?: Date;
  finishedAt?: Date;
}): Promise<{ id: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO execution_log
       (task_id, step_no, step_name, actor_type, actor_id, status,
        input_ref, output_ref, error_json, tokens_json, latency_ms,
        context_manifest_ref, config_git_commit, decision_graph_hash,
        skill_manifest_hashes, tool_manifest_hashes,
        prompt_hash, model_name, model_version, trace_id, started_at, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     ON CONFLICT (task_id, step_no) DO UPDATE
       SET status = EXCLUDED.status,
           output_ref = EXCLUDED.output_ref,
           error_json = EXCLUDED.error_json,
           tokens_json = EXCLUDED.tokens_json,
           latency_ms = EXCLUDED.latency_ms,
           context_manifest_ref = COALESCE(EXCLUDED.context_manifest_ref, execution_log.context_manifest_ref),
           skill_manifest_hashes = CASE WHEN EXCLUDED.skill_manifest_hashes = '[]'::jsonb
                                        THEN execution_log.skill_manifest_hashes ELSE EXCLUDED.skill_manifest_hashes END,
           tool_manifest_hashes = CASE WHEN EXCLUDED.tool_manifest_hashes = '[]'::jsonb
                                       THEN execution_log.tool_manifest_hashes ELSE EXCLUDED.tool_manifest_hashes END,
           prompt_hash = COALESCE(EXCLUDED.prompt_hash, execution_log.prompt_hash),
           model_name = COALESCE(EXCLUDED.model_name, execution_log.model_name),
           model_version = COALESCE(EXCLUDED.model_version, execution_log.model_version),
           trace_id = COALESCE(EXCLUDED.trace_id, execution_log.trace_id),
           finished_at = EXCLUDED.finished_at
     RETURNING id`,
    [
      input.taskId,
      input.stepNo,
      input.stepName,
      input.actorType,
      input.actorId,
      input.status,
      input.inputRef ?? null,
      input.outputRef ?? null,
      input.errorJson ? JSON.stringify(input.errorJson) : null,
      input.tokensJson ? JSON.stringify(input.tokensJson) : null,
      input.latencyMs ?? null,
      input.contextManifestRef ?? null,
      input.configGitCommit ?? null,
      input.decisionGraphHash ?? null,
      JSON.stringify(input.skillManifestHashes ?? []),
      JSON.stringify(input.toolManifestHashes ?? []),
      input.promptHash ?? null,
      input.modelName ?? null,
      input.modelVersion ?? null,
      input.traceId ?? null,
      input.startedAt ?? null,
      input.finishedAt ?? null,
    ],
  );
  return rows[0];
}

// 按 task_id 查执行日志(验收:执行审计/失败恢复)
export async function listExecutionLog(taskId: string): Promise<ExecutionLogRow[]> {
  const { rows } = await pool.query<ExecutionLogRow>(
    `SELECT id, task_id, step_no, step_name, actor_type, actor_id, status
     FROM execution_log
     WHERE task_id = $1
     ORDER BY step_no ASC`,
    [taskId],
  );
  return rows;
}

// ---- 产物 ----
export async function writeArtifact(input: {
  taskId: string;
  conversationId: string;
  artifactType: 'plan' | 'report' | 'file' | 'tool_output' | 'context_manifest';
  title: string;
  storageUri: string;
  contentSummary?: string;
  sourceRefs?: unknown[];
  sensitivity?: string;
  createdByUserId?: string;
}): Promise<{ id: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO artifacts
       (task_id, conversation_id, artifact_type, title, storage_uri,
        content_summary, source_refs_json, sensitivity, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'internal'),$9)
     RETURNING id`,
    [
      input.taskId,
      input.conversationId,
      input.artifactType,
      input.title,
      input.storageUri,
      input.contentSummary ?? null,
      JSON.stringify(input.sourceRefs ?? []),
      input.sensitivity ?? null,
      input.createdByUserId ?? null,
    ],
  );
  return rows[0];
}

export async function listArtifacts(taskId: string): Promise<
  Array<{ id: string; artifact_type: string; title: string; storage_uri: string }>
> {
  const { rows } = await pool.query(
    `SELECT id, artifact_type, title, storage_uri
     FROM artifacts
     WHERE task_id = $1
     ORDER BY created_at ASC`,
    [taskId],
  );
  return rows;
}

// ---- 反馈 ----
export async function writeFeedback(input: {
  taskId: string;
  userId: string;
  rating?: number;
  adopted?: boolean;
  comment?: string;
}): Promise<{ id: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO user_feedback (task_id, user_id, rating, adopted, comment)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id`,
    [input.taskId, input.userId, input.rating ?? null, input.adopted ?? null, input.comment ?? null],
  );
  return rows[0];
}
