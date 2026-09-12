ALTER TABLE control_tasks
  ADD COLUMN IF NOT EXISTS orchestration_mode TEXT;
