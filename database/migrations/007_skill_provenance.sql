ALTER TABLE control_execution_steps
  ADD COLUMN IF NOT EXISTS skill_provenance JSONB;
