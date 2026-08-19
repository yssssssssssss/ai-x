-- Initial planning used to persist an empty task before requirement understanding.
-- If that step failed, the task remained recoverable even though no requirement
-- version existed. Preserve the row for history, but remove the invalid live state.
UPDATE control_tasks
SET state = 'failed',
    state_version = state_version + 1,
    updated_at = now()
WHERE state = 'awaiting_clarification'
  AND structured_task = '{}'::jsonb
  AND active_requirement_version_id IS NULL;
