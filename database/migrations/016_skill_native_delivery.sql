CREATE TABLE IF NOT EXISTS skill_native_tasks (
  id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES users(id),
  project_id TEXT NOT NULL,
  original_input TEXT NOT NULL,
  orchestration_mode TEXT NOT NULL CHECK (orchestration_mode IN ('single_skill', 'multi_skill')),
  state TEXT NOT NULL CHECK (state IN (
    'awaiting_selection', 'awaiting_confirmation', 'ready', 'executing',
    'paused', 'completed', 'completed_with_gaps', 'failed', 'cancelled'
  )),
  state_version BIGINT NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  selected_solution_id TEXT,
  candidates_json JSONB NOT NULL,
  plan_json JSONB,
  execution_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  report_json JSONB,
  report_html TEXT,
  report_markdown TEXT,
  warnings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  failure TEXT,
  current_attempt_id UUID,
  zero_publication_status TEXT CHECK (zero_publication_status IN ('publishing', 'prepared', 'completed', 'failed')),
  zero_publication_json JSONB,
  zero_publication_failure TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS skill_native_tasks_owner_updated_idx
  ON skill_native_tasks(owner_user_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS skill_native_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES skill_native_tasks(id),
  owner_user_id UUID NOT NULL REFERENCES users(id),
  project_id TEXT NOT NULL,
  input_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('conversation', 'upload')),
  value_json JSONB NOT NULL,
  valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS skill_native_materials_scope_idx
  ON skill_native_materials(owner_user_id, project_id, input_id, created_at DESC);

CREATE TABLE IF NOT EXISTS skill_native_artifacts (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES skill_native_tasks(id),
  owner_user_id UUID NOT NULL REFERENCES users(id),
  project_id TEXT NOT NULL,
  input_id TEXT,
  file_name TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg', 'image/webp')),
  content_bytes BYTEA NOT NULL,
  content_sha256 TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (octet_length(content_bytes) = byte_size)
);

CREATE INDEX IF NOT EXISTS skill_native_artifacts_scope_idx
  ON skill_native_artifacts(owner_user_id, project_id, id);

CREATE TABLE IF NOT EXISTS skill_native_attempts (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES skill_native_tasks(id),
  owner_user_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS skill_native_attempts_task_idx
  ON skill_native_attempts(task_id, started_at DESC);

CREATE TABLE IF NOT EXISTS skill_native_model_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES skill_native_attempts(id),
  stage TEXT NOT NULL,
  step_no INTEGER,
  provider TEXT NOT NULL,
  endpoint_host TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  actual_model TEXT NOT NULL,
  model_version TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  context_manifest_hash TEXT,
  trace_id TEXT,
  tokens_json JSONB,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  failure_json JSONB,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS skill_native_model_calls_attempt_idx
  ON skill_native_model_calls(attempt_id, started_at);

CREATE TABLE IF NOT EXISTS skill_native_tool_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES skill_native_attempts(id),
  invocation_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output_json JSONB,
  sources_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  receipt_json JSONB,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  failure_json JSONB,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS skill_native_tool_calls_attempt_idx
  ON skill_native_tool_calls(attempt_id, started_at);
