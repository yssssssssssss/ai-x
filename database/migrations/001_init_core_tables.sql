-- 用研 AI 专项 · 核心运行时表(V0/P0)
-- 严格誊抄《底座搭建方案_优化版_codex.md》§3.2 / §3.3 的 DDL。
-- 原则:DB 只存用户/会话/运行时数据;skill/tool/decision 配置归 git+YAML,不入库。
-- 幂等:全部 IF NOT EXISTS,可重复在空库或已建库执行。

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()

-- 1. 用户:独立注册体系,不接 ERP。users.id 是业务主键,邮箱只是登录标识。
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. 会话:一次对话,支持历史任务/会话记忆/断点恢复。
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. 消息:会话回放真相源。artifact_id 有意不加外键(messages 先于 artifacts 存在)。
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  sender_type TEXT NOT NULL,          -- user | assistant | system | tool
  message_type TEXT NOT NULL,         -- text | plan | execution_update | report | error
  content JSONB NOT NULL,
  artifact_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. 研究任务:任务真相源。structured_task 存 LLM 结构化结果;配置不入此表。
CREATE TABLE IF NOT EXISTS research_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  owner_user_id UUID NOT NULL REFERENCES users(id),
  original_input TEXT NOT NULL,
  task_type TEXT,
  structured_task JSONB NOT NULL,
  assumptions JSONB NOT NULL DEFAULT '[]'::jsonb,
  confirmations JSONB NOT NULL DEFAULT '[]'::jsonb,
  blocking_issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  approval_state TEXT NOT NULL DEFAULT 'draft',
  status TEXT NOT NULL DEFAULT 'created',
  run_workspace_uri TEXT NOT NULL,
  feishu_record_id TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'internal',
  pii_detected BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. 决策节点状态:调度复盘核心。记录本次激活了哪些节点、判成什么、为什么。
CREATE TABLE IF NOT EXISTS task_decision_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES research_tasks(id),
  node_key TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT NOT NULL,
  confidence NUMERIC(4,3),
  user_override JSONB,
  final_state TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(task_id, node_key)
);

-- 6. 执行日志:任务执行真相源 + 版本追溯底线(manifest/prompt/model hash 全在此)。
CREATE TABLE IF NOT EXISTS execution_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES research_tasks(id),
  step_no INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  actor_type TEXT NOT NULL,           -- skill | tool | llm | reviewer
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL,               -- pending | running | succeeded | failed | skipped
  input_ref TEXT,
  output_ref TEXT,
  error_json JSONB,
  tokens_json JSONB,
  latency_ms INTEGER,
  context_manifest_ref TEXT,
  config_git_commit TEXT,
  decision_graph_hash TEXT,
  skill_manifest_hashes JSONB NOT NULL DEFAULT '[]'::jsonb,
  tool_manifest_hashes JSONB NOT NULL DEFAULT '[]'::jsonb,
  prompt_hash TEXT,
  model_name TEXT,
  model_version TEXT,
  trace_id TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(task_id, step_no)
);

-- 7. 产物:报告是 artifact 的一种,不单开 research_reports。大文件只存 storage_uri。
CREATE TABLE IF NOT EXISTS artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES research_tasks(id),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  artifact_type TEXT NOT NULL,        -- plan | report | file | tool_output | context_manifest
  title TEXT NOT NULL,
  storage_uri TEXT NOT NULL,
  content_summary TEXT,
  source_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  sensitivity TEXT NOT NULL DEFAULT 'internal',
  created_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8. 用户反馈:优化下次调度。MVP 仅存储,不自动优化。
CREATE TABLE IF NOT EXISTS user_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES research_tasks(id),
  user_id UUID NOT NULL REFERENCES users(id),
  rating INTEGER,
  adopted BOOLEAN,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 索引(§3.3)
CREATE INDEX IF NOT EXISTS idx_conversations_owner_recent
  ON conversations(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_time
  ON messages(conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_research_tasks_owner_recent
  ON research_tasks(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_tasks_conversation
  ON research_tasks(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_tasks_status
  ON research_tasks(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_states_task
  ON task_decision_states(task_id);
CREATE INDEX IF NOT EXISTS idx_execution_log_task_status
  ON execution_log(task_id, status);
CREATE INDEX IF NOT EXISTS idx_artifacts_task_type
  ON artifacts(task_id, artifact_type);
