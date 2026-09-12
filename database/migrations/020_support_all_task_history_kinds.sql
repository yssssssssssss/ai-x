ALTER TABLE task_history_preferences
  DROP CONSTRAINT IF EXISTS task_history_preferences_task_kind_check;

ALTER TABLE task_history_preferences
  ADD CONSTRAINT task_history_preferences_task_kind_check
  CHECK (task_kind IN ('legacy', 'current', 'native'));
