-- Trusted P0 control-plane foundation. This migration is additive and does not switch
-- existing production composition roots; final legacy table isolation happens at cutover.

CREATE TABLE IF NOT EXISTS control_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  owner_user_id UUID NOT NULL REFERENCES users(id),
  original_input TEXT NOT NULL,
  task_type TEXT,
  structured_task JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'awaiting_selection', 'awaiting_confirmation', 'awaiting_approval',
    'ready', 'executing', 'paused', 'completed', 'completed_with_gaps',
    'failed', 'cancelled', 'rejected'
  )),
  state_version BIGINT NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  active_plan_version_id UUID,
  current_attempt_id UUID,
  sensitivity TEXT NOT NULL DEFAULT 'internal',
  pii_detected BOOLEAN NOT NULL DEFAULT false,
  contract_version TEXT NOT NULL DEFAULT 'trusted-p0-v1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS control_plan_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES control_tasks(id),
  version INTEGER NOT NULL CHECK (version > 0),
  candidate_id TEXT,
  plan_json JSONB NOT NULL,
  plan_hash TEXT NOT NULL,
  pending_inputs JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, version),
  UNIQUE (task_id, plan_hash)
);

ALTER TABLE control_tasks
  ADD CONSTRAINT control_tasks_active_plan_version_fk
  FOREIGN KEY (active_plan_version_id) REFERENCES control_plan_versions(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS control_gate_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES control_tasks(id),
  plan_version_id UUID NOT NULL REFERENCES control_plan_versions(id),
  plan_hash TEXT NOT NULL,
  gate_type TEXT NOT NULL,
  gate_key TEXT NOT NULL,
  required_authority TEXT NOT NULL,
  decision TEXT NOT NULL,
  value_json JSONB,
  evidence_ref TEXT,
  actor_user_id UUID REFERENCES users(id),
  actor_service TEXT,
  actor_role TEXT,
  policy_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (actor_user_id IS NOT NULL OR actor_service IS NOT NULL),
  UNIQUE (task_id, plan_version_id, gate_type, gate_key, idempotency_key)
);

CREATE TABLE IF NOT EXISTS control_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES control_tasks(id),
  command_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  expected_version BIGINT NOT NULL,
  state_before TEXT NOT NULL,
  state_after TEXT NOT NULL,
  response_json JSONB NOT NULL,
  actor_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, command_type, idempotency_key)
);

CREATE TABLE IF NOT EXISTS control_execution_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES control_tasks(id),
  plan_version_id UUID NOT NULL REFERENCES control_plan_versions(id),
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'completed', 'failed', 'cancelled')),
  retry_of UUID REFERENCES control_execution_attempts(id),
  failure_kind TEXT,
  lease_owner TEXT,
  lease_token_hash TEXT,
  lease_expires_at TIMESTAMPTZ,
  lease_heartbeat_at TIMESTAMPTZ,
  batch_id UUID,
  slot_no INTEGER,
  pinned_config_hash TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE (task_id, attempt_no),
  CHECK (
    (state = 'active' AND lease_owner IS NOT NULL AND lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR state <> 'active'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS control_execution_attempts_one_active_per_task
  ON control_execution_attempts(task_id)
  WHERE state = 'active';

ALTER TABLE control_tasks
  ADD CONSTRAINT control_tasks_current_attempt_fk
  FOREIGN KEY (current_attempt_id) REFERENCES control_execution_attempts(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS control_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES control_tasks(id),
  plan_version_id UUID REFERENCES control_plan_versions(id),
  attempt_id UUID REFERENCES control_execution_attempts(id),
  kind TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('STAGING', 'SEALED', 'FAILED')),
  storage_uri TEXT NOT NULL,
  content_sha256 TEXT,
  byte_size BIGINT,
  sensitivity TEXT NOT NULL,
  redaction_policy_version TEXT NOT NULL,
  redaction_status TEXT NOT NULL DEFAULT 'pending',
  parent_artifact_id UUID REFERENCES control_artifacts(id),
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sealed_at TIMESTAMPTZ,
  CHECK (
    (state = 'SEALED' AND content_sha256 IS NOT NULL AND byte_size IS NOT NULL AND sealed_at IS NOT NULL)
    OR state <> 'SEALED'
  )
);

CREATE TABLE IF NOT EXISTS control_execution_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES control_execution_attempts(id),
  step_no INTEGER NOT NULL CHECK (step_no > 0),
  step_name TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  input_artifact_id UUID REFERENCES control_artifacts(id),
  output_artifact_id UUID REFERENCES control_artifacts(id),
  tool_provenance JSONB,
  failure_json JSONB,
  latency_ms INTEGER,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE (attempt_id, step_no)
);

CREATE TABLE IF NOT EXISTS control_model_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID REFERENCES control_execution_attempts(id),
  stage TEXT NOT NULL,
  step_no INTEGER,
  provider TEXT NOT NULL,
  endpoint_host TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  actual_model TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  context_manifest_hash TEXT,
  trace_id TEXT,
  tokens_json JSONB,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS gold_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_key TEXT NOT NULL UNIQUE,
  pins_json JSONB NOT NULL,
  pins_hash TEXT NOT NULL,
  machine_state TEXT NOT NULL,
  p0_decision TEXT,
  scenario_id TEXT NOT NULL,
  scenario_input_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE control_execution_attempts
  ADD CONSTRAINT control_execution_attempts_batch_fk
  FOREIGN KEY (batch_id) REFERENCES gold_batches(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS gold_batch_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES gold_batches(id),
  slot_no INTEGER NOT NULL CHECK (slot_no BETWEEN 1 AND 3),
  capability_attempt_id UUID REFERENCES control_execution_attempts(id),
  state TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_id, slot_no)
);

CREATE UNIQUE INDEX IF NOT EXISTS gold_batch_slots_one_attempt_per_slot
  ON gold_batch_slots(capability_attempt_id)
  WHERE capability_attempt_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS gold_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES gold_batches(id),
  attempt_id UUID REFERENCES control_execution_attempts(id),
  reviewer_user_id UUID NOT NULL REFERENCES users(id),
  independence_json JSONB NOT NULL,
  verdict TEXT,
  artifact_id UUID REFERENCES control_artifacts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gold_batch_supersessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  old_batch_id UUID NOT NULL REFERENCES gold_batches(id),
  new_batch_id UUID NOT NULL REFERENCES gold_batches(id),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (old_batch_id, new_batch_id),
  CHECK (old_batch_id <> new_batch_id)
);

CREATE INDEX IF NOT EXISTS control_plan_versions_task_idx
  ON control_plan_versions(task_id, version DESC);
CREATE INDEX IF NOT EXISTS control_gate_records_task_idx
  ON control_gate_records(task_id, plan_version_id, created_at);
CREATE INDEX IF NOT EXISTS control_commands_task_idx
  ON control_commands(task_id, created_at);
CREATE INDEX IF NOT EXISTS control_execution_steps_attempt_idx
  ON control_execution_steps(attempt_id, step_no);
CREATE INDEX IF NOT EXISTS control_artifacts_task_idx
  ON control_artifacts(task_id, state, created_at);
CREATE INDEX IF NOT EXISTS control_model_calls_attempt_idx
  ON control_model_calls(attempt_id, started_at);
CREATE INDEX IF NOT EXISTS gold_reviews_batch_idx
  ON gold_reviews(batch_id, attempt_id, created_at);
