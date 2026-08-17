-- Trusted Current requirement history and media metadata.
-- Additive only: legacy tables and rows remain untouched; Current callers opt in explicitly.

ALTER TABLE control_tasks
  ADD COLUMN IF NOT EXISTS active_requirement_version_id UUID;

ALTER TABLE control_tasks
  DROP CONSTRAINT IF EXISTS control_tasks_state_check;

ALTER TABLE control_tasks
  ADD CONSTRAINT control_tasks_state_check CHECK (state IN (
    'awaiting_clarification', 'awaiting_selection', 'awaiting_confirmation',
    'awaiting_approval', 'ready', 'executing', 'paused', 'reviewing',
    'composing_report', 'completed', 'completed_with_gaps', 'failed',
    'cancelled', 'rejected'
  ));

CREATE TABLE IF NOT EXISTS control_requirement_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES control_tasks(id),
  version INTEGER NOT NULL CHECK (version > 0),
  raw_input_hash TEXT NOT NULL,
  clarification_json JSONB NOT NULL,
  structured_task_json JSONB NOT NULL,
  model_call_id UUID REFERENCES control_model_calls(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, version)
);

ALTER TABLE control_tasks
  ADD CONSTRAINT control_tasks_active_requirement_version_fk
  FOREIGN KEY (active_requirement_version_id)
  REFERENCES control_requirement_versions(id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE control_artifacts
  ADD COLUMN IF NOT EXISTS media_type TEXT,
  ADD COLUMN IF NOT EXISTS metadata_json JSONB;

CREATE INDEX IF NOT EXISTS control_requirement_versions_task_idx
  ON control_requirement_versions(task_id, version DESC);
