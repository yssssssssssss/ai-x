-- This is an intentional breaking cutover. Back up the database before applying
-- it in a non-development environment. Old Skill-native rows use a different
-- plan, execution, and report contract and must not be interpreted by the new
-- runtime.
TRUNCATE TABLE
  skill_native_tool_calls,
  skill_native_model_calls,
  skill_native_artifacts,
  skill_native_attempts,
  skill_native_tasks
RESTART IDENTITY CASCADE;

DROP TABLE skill_native_materials;

ALTER TABLE skill_native_tasks
  DROP CONSTRAINT IF EXISTS skill_native_tasks_state_check;

ALTER TABLE skill_native_tasks
  ADD CONSTRAINT skill_native_tasks_state_check CHECK (state IN (
    'awaiting_selection', 'awaiting_confirmation', 'ready', 'executing',
    'waiting_for_user', 'paused', 'completed', 'completed_with_gaps', 'failed', 'cancelled'
  ));

ALTER TABLE skill_native_tasks
  RENAME COLUMN selected_solution_id TO selected_candidate_id;

ALTER TABLE skill_native_tasks
  ADD COLUMN materials_json JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE skill_native_tasks
  ADD COLUMN requirement_json JSONB NOT NULL;

ALTER TABLE skill_native_tasks
  RENAME COLUMN report_json TO result_json;

ALTER TABLE skill_native_tasks
  ALTER COLUMN execution_json SET DEFAULT '{"steps":[],"checkpoint":null,"externalKnowledge":[]}'::jsonb,
  DROP COLUMN report_html,
  DROP COLUMN report_markdown;

ALTER TABLE skill_native_attempts
  DROP CONSTRAINT IF EXISTS skill_native_attempts_status_check;

ALTER TABLE skill_native_attempts
  ADD CONSTRAINT skill_native_attempts_status_check CHECK (status IN (
    'running', 'waiting_for_user', 'completed', 'failed', 'cancelled', 'interrupted'
  ));

ALTER TABLE skill_native_artifacts
  DROP CONSTRAINT IF EXISTS skill_native_artifacts_media_type_check;

ALTER TABLE skill_native_artifacts
  DROP COLUMN input_id;

ALTER TABLE skill_native_artifacts
  ADD COLUMN invocation_id TEXT,
  ADD COLUMN relative_path TEXT,
  ADD COLUMN artifact_role TEXT NOT NULL DEFAULT 'working' CHECK (
    artifact_role IN ('working', 'output', 'report')
  ),
  ADD COLUMN source_artifact_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE skill_native_artifacts
SET relative_path = 'legacy/' || file_name
WHERE relative_path IS NULL;

ALTER TABLE skill_native_artifacts
  ALTER COLUMN relative_path SET NOT NULL;

CREATE INDEX IF NOT EXISTS skill_native_artifacts_task_invocation_idx
  ON skill_native_artifacts(task_id, invocation_id, created_at, id);

CREATE TABLE IF NOT EXISTS skill_native_script_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES skill_native_attempts(id),
  invocation_id TEXT NOT NULL,
  runtime TEXT NOT NULL CHECK (runtime IN ('node', 'python', 'bash')),
  script_path TEXT NOT NULL,
  arguments_json JSONB NOT NULL,
  input_artifact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  output_artifact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  failure TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS skill_native_script_calls_attempt_idx
  ON skill_native_script_calls(attempt_id, started_at);

DELETE FROM task_history_preferences WHERE task_kind <> 'native';

ALTER TABLE task_history_preferences
  DROP CONSTRAINT IF EXISTS task_history_preferences_task_kind_check;

ALTER TABLE task_history_preferences
  ADD CONSTRAINT task_history_preferences_task_kind_check
  CHECK (task_kind = 'native');
