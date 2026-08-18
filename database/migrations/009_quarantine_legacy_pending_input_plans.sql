-- Plans written before PendingInput.kind, or with any other malformed
-- PendingInput field, cannot safely be confirmed or executed. Preserve every
-- task, plan, gate, and attempt row, but move live states to a recovery state
-- that has a Current API action:
--   awaiting_selection -> awaiting_clarification -> /clarify (full re-plan)
--   awaiting_approval / ready / active execution states
--     -> awaiting_confirmation -> /revise (full re-plan)

-- This migration rewrites related rows across the control plane. Take every
-- table it can modify in one retryable subtransaction before inspecting any
-- data. ACCESS EXCLUSIVE is deliberate: ALTER TABLE needs it for plans, and a
-- weaker mixed table/row lock scheme can deadlock with in-flight task,
-- attempt, Artifact, or command transactions. NOWAIT rolls back the whole
-- partial lock set before retrying, so the migration either owns the complete
-- write boundary or owns none of it.
DO $migration_lock$
DECLARE
  writer_fences_acquired BOOLEAN := false;
BEGIN
  FOR lock_attempt IN 1..300 LOOP
    BEGIN
      LOCK TABLE
        control_tasks,
        control_plan_versions,
        control_requirement_versions,
        control_execution_attempts,
        control_execution_steps,
        control_artifacts,
        control_commands
      IN ACCESS EXCLUSIVE MODE NOWAIT;
      writer_fences_acquired := true;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_sleep(0.1);
    END;
  END LOOP;
  IF NOT writer_fences_acquired THEN
    RAISE EXCEPTION 'timed out waiting for control-plane migration writer fences'
      USING ERRCODE = '55P03';
  END IF;
END
$migration_lock$;

-- A plan revision is identified by (task_id, version). Content may repeat
-- across immutable revisions, including an exact retry or a corrected
-- PendingInput contract, so it is not a database identity constraint.
ALTER TABLE control_plan_versions
  DROP CONSTRAINT IF EXISTS control_plan_versions_task_id_plan_hash_key;
DROP INDEX IF EXISTS control_plan_versions_task_plan_pending_key;

ALTER TABLE control_plan_versions
  ADD COLUMN IF NOT EXISTS pending_input_quarantined BOOLEAN NOT NULL DEFAULT false;

CREATE TEMP TABLE legacy_pending_input_plan_versions ON COMMIT DROP AS
SELECT plan.id
FROM control_plan_versions AS plan
WHERE
  jsonb_typeof(plan.pending_inputs) IS DISTINCT FROM 'array'
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(plan.pending_inputs) = 'array' THEN plan.pending_inputs
        ELSE '[]'::jsonb
      END
    ) AS pending(value)
    WHERE CASE
      WHEN jsonb_typeof(pending.value) IS DISTINCT FROM 'object' THEN true
      ELSE
        NOT (pending.value ?& ARRAY['kind', 'role', 'label', 'multiple', 'targets'])
        OR pending.value - ARRAY['kind', 'role', 'label', 'multiple', 'targets'] <> '{}'::jsonb
        OR jsonb_typeof(pending.value -> 'kind') IS DISTINCT FROM 'string'
        OR pending.value ->> 'kind' NOT IN ('value', 'visual')
        OR jsonb_typeof(pending.value -> 'role') IS DISTINCT FROM 'string'
        OR btrim(pending.value ->> 'role') = ''
        OR jsonb_typeof(pending.value -> 'label') IS DISTINCT FROM 'string'
        OR btrim(pending.value ->> 'label') = ''
        OR jsonb_typeof(pending.value -> 'multiple') IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(pending.value -> 'targets') IS DISTINCT FROM 'array'
        OR jsonb_array_length(
          CASE
            WHEN jsonb_typeof(pending.value -> 'targets') = 'array'
              THEN pending.value -> 'targets'
            ELSE '[]'::jsonb
          END
        ) = 0
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(pending.value -> 'targets') = 'array'
                THEN pending.value -> 'targets'
              ELSE '[]'::jsonb
            END
          ) AS target(value)
          WHERE CASE
            WHEN jsonb_typeof(target.value) IS DISTINCT FROM 'object' THEN true
            ELSE
              NOT (target.value ?& ARRAY['step_no', 'tool_id', 'field', 'multiple'])
              OR target.value - ARRAY['step_no', 'tool_id', 'field', 'multiple'] <> '{}'::jsonb
              OR CASE
                WHEN jsonb_typeof(target.value -> 'step_no') = 'number' THEN
                  (target.value ->> 'step_no')::numeric < 1
                  OR trunc((target.value ->> 'step_no')::numeric) <> (target.value ->> 'step_no')::numeric
                ELSE true
              END
              OR jsonb_typeof(target.value -> 'tool_id') IS DISTINCT FROM 'string'
              OR btrim(target.value ->> 'tool_id') = ''
              OR jsonb_typeof(target.value -> 'field') IS DISTINCT FROM 'string'
              OR btrim(target.value ->> 'field') = ''
              OR jsonb_typeof(target.value -> 'multiple') IS DISTINCT FROM 'boolean'
          END
        )
    END
  )
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(plan.pending_inputs) = 'array' THEN plan.pending_inputs
        ELSE '[]'::jsonb
      END
    ) AS pending(value)
    WHERE jsonb_typeof(pending.value) = 'object'
      AND jsonb_typeof(pending.value -> 'role') = 'string'
    GROUP BY pending.value ->> 'role'
    HAVING COUNT(*) > 1
  )
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(plan.pending_inputs) = 'array' THEN plan.pending_inputs
        ELSE '[]'::jsonb
      END
    ) AS pending(value)
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(pending.value) = 'object'
          AND jsonb_typeof(pending.value -> 'targets') = 'array'
          THEN pending.value -> 'targets'
        ELSE '[]'::jsonb
      END
    ) AS target(value)
    WHERE jsonb_typeof(target.value) = 'object'
      AND jsonb_typeof(target.value -> 'step_no') = 'number'
      AND jsonb_typeof(target.value -> 'field') = 'string'
    GROUP BY (target.value ->> 'step_no')::numeric, target.value ->> 'field'
    HAVING COUNT(*) > 1
  )
  OR EXISTS (
    SELECT 1
    FROM (
      SELECT eligible.value
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(plan.plan_json #> '{capability_decisions,eligible}') = 'array'
            THEN plan.plan_json #> '{capability_decisions,eligible}'
          ELSE '[]'::jsonb
        END
      ) AS eligible(value)
      UNION ALL
      SELECT rejected.value
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(plan.plan_json #> '{capability_decisions,rejected}') = 'array'
            THEN plan.plan_json #> '{capability_decisions,rejected}'
          ELSE '[]'::jsonb
        END
      ) AS rejected(value)
    ) AS decision
    WHERE CASE
      WHEN jsonb_typeof(decision.value) IS DISTINCT FROM 'object' THEN true
      WHEN jsonb_typeof(decision.value -> 'pending_inputs') IS DISTINCT FROM 'array' THEN true
      ELSE EXISTS (
         SELECT 1
         FROM jsonb_array_elements(
           CASE
             WHEN jsonb_typeof(decision.value -> 'pending_inputs') = 'array'
               THEN decision.value -> 'pending_inputs'
             ELSE '[]'::jsonb
           END
         ) AS nested_pending(value)
         WHERE CASE
           WHEN jsonb_typeof(nested_pending.value) IS DISTINCT FROM 'object' THEN true
           ELSE
             NOT (nested_pending.value ?& ARRAY['kind', 'role', 'label', 'multiple', 'capability_id'])
             OR nested_pending.value - ARRAY['kind', 'role', 'label', 'multiple', 'capability_id'] <> '{}'::jsonb
             OR jsonb_typeof(nested_pending.value -> 'kind') IS DISTINCT FROM 'string'
             OR nested_pending.value ->> 'kind' NOT IN ('value', 'visual')
             OR jsonb_typeof(nested_pending.value -> 'role') IS DISTINCT FROM 'string'
             OR btrim(nested_pending.value ->> 'role') = ''
             OR jsonb_typeof(nested_pending.value -> 'label') IS DISTINCT FROM 'string'
             OR btrim(nested_pending.value ->> 'label') = ''
             OR jsonb_typeof(nested_pending.value -> 'multiple') IS DISTINCT FROM 'boolean'
             OR jsonb_typeof(nested_pending.value -> 'capability_id') IS DISTINCT FROM 'string'
             OR btrim(nested_pending.value ->> 'capability_id') = ''
         END
       )
    END
  );

CREATE UNIQUE INDEX legacy_pending_input_plan_versions_id_idx
  ON legacy_pending_input_plan_versions(id);

UPDATE control_plan_versions AS plan
SET pending_input_quarantined = true
FROM legacy_pending_input_plan_versions AS legacy
WHERE plan.id = legacy.id
  AND plan.pending_input_quarantined = false;

CREATE TEMP TABLE legacy_pending_input_task_ids ON COMMIT DROP AS
SELECT task.id
FROM control_tasks AS task
WHERE
  (
    task.state = 'awaiting_selection'
    AND EXISTS (
      SELECT 1
      FROM (
        SELECT current_plan.id
        FROM control_plan_versions AS current_plan
        WHERE current_plan.task_id = task.id
        ORDER BY current_plan.version DESC
        LIMIT 2
      ) AS plan
      JOIN legacy_pending_input_plan_versions AS legacy ON legacy.id = plan.id
    )
  )
  OR (
    task.state IN (
      'awaiting_confirmation', 'awaiting_approval', 'ready',
      'paused', 'executing', 'reviewing', 'composing_report'
    )
    AND task.active_plan_version_id IN (
      SELECT id FROM legacy_pending_input_plan_versions
    )
  );

CREATE UNIQUE INDEX legacy_pending_input_task_ids_id_idx
  ON legacy_pending_input_task_ids(id);

-- Lock affected tasks before taking the state snapshot. An old process may
-- still finish an in-flight state transition while this migration waits; the
-- second predicate below then classifies that committed state.
SELECT task.id
FROM control_tasks AS task
JOIN legacy_pending_input_task_ids AS candidate ON candidate.id = task.id
FOR UPDATE OF task;

CREATE TEMP TABLE legacy_pending_input_tasks ON COMMIT DROP AS
SELECT task.id, task.state, task.active_plan_version_id, task.current_attempt_id
FROM control_tasks AS task
JOIN legacy_pending_input_task_ids AS candidate ON candidate.id = task.id
WHERE
  (
    task.state = 'awaiting_selection'
    AND EXISTS (
      SELECT 1
      FROM (
        SELECT current_plan.id
        FROM control_plan_versions AS current_plan
        WHERE current_plan.task_id = task.id
        ORDER BY current_plan.version DESC
        LIMIT 2
      ) AS plan
      JOIN legacy_pending_input_plan_versions AS legacy ON legacy.id = plan.id
    )
  )
  OR (
    task.state IN (
      'awaiting_confirmation', 'awaiting_approval', 'ready',
      'paused', 'executing', 'reviewing', 'composing_report'
    )
    AND task.active_plan_version_id IN (
      SELECT id FROM legacy_pending_input_plan_versions
    )
  );

CREATE UNIQUE INDEX legacy_pending_input_tasks_id_idx
  ON legacy_pending_input_tasks(id);

-- Old awaiting_selection rows may predate requirement-version persistence. A
-- frozen copy of their existing structured task makes /clarify recovery
-- reachable without inventing or mutating plan data.
WITH inserted AS (
  INSERT INTO control_requirement_versions
    (task_id, version, raw_input_hash, clarification_json, structured_task_json)
  SELECT
    task.id,
    (
      SELECT COALESCE(MAX(requirement.version), 0) + 1
      FROM control_requirement_versions AS requirement
      WHERE requirement.task_id = task.id
    ),
    'sha256:' || encode(digest(task.original_input, 'sha256'), 'hex'),
    '{}'::jsonb,
    task.structured_task
  FROM control_tasks AS task
  JOIN legacy_pending_input_tasks AS legacy ON legacy.id = task.id
  WHERE legacy.state = 'awaiting_selection'
    AND task.active_requirement_version_id IS NULL
  RETURNING id, task_id
)
UPDATE control_tasks AS task
SET active_requirement_version_id = inserted.id
FROM inserted
WHERE task.id = inserted.task_id;

-- current_attempt_id may legitimately reference a paused attempt from the
-- prior plan after skip recovery. Since the task pointer is cleared below,
-- terminalize that exact live attempt regardless of task state or plan match.
CREATE TEMP TABLE legacy_pending_input_attempts ON COMMIT DROP AS
SELECT attempt.id, attempt.task_id
FROM legacy_pending_input_tasks AS legacy
JOIN control_execution_attempts AS attempt
  ON attempt.id = legacy.current_attempt_id
 AND attempt.task_id = legacy.id
WHERE attempt.state IN ('active', 'paused');

CREATE UNIQUE INDEX legacy_pending_input_attempts_id_idx
  ON legacy_pending_input_attempts(id);

SELECT attempt.id
FROM control_execution_attempts AS attempt
JOIN legacy_pending_input_attempts AS legacy ON legacy.id = attempt.id
FOR UPDATE OF attempt;

UPDATE control_execution_steps AS step
SET state = CASE WHEN step.state = 'running' THEN 'failed' ELSE 'skipped' END,
    failure_json = CASE
      WHEN step.state = 'running' THEN COALESCE(
        step.failure_json,
        '{"kind":"legacy_plan_quarantine","retryable":false}'::jsonb
      )
      ELSE step.failure_json
    END,
    finished_at = COALESCE(step.finished_at, now())
FROM legacy_pending_input_attempts AS legacy
WHERE step.attempt_id = legacy.id
  AND step.state IN ('pending', 'running');

UPDATE control_artifacts AS artifact
SET state = 'FAILED',
    failure_reason = 'legacy plan quarantined before recovery',
    redaction_status = 'failed'
FROM legacy_pending_input_attempts AS legacy
WHERE artifact.attempt_id = legacy.id
  AND artifact.state = 'STAGING';

UPDATE control_execution_attempts AS attempt
SET state = 'cancelled',
    failure_kind = COALESCE(attempt.failure_kind, 'legacy_plan_quarantine'),
    lease_owner = NULL,
    lease_token_hash = NULL,
    lease_expires_at = NULL,
    lease_heartbeat_at = NULL,
    finished_at = COALESCE(attempt.finished_at, now())
FROM legacy_pending_input_attempts AS legacy
WHERE attempt.id = legacy.id;

-- Keep reservation rows for audit, but make every stale owner immediately
-- reclaimable under the normal token fence.
UPDATE control_commands AS command
SET reservation_expires_at = LEAST(command.reservation_expires_at, now())
FROM legacy_pending_input_tasks AS legacy
WHERE command.task_id = legacy.id
  AND command.command_status = 'pending';

UPDATE control_tasks AS task
SET state = CASE
      WHEN legacy.state = 'awaiting_selection' THEN 'awaiting_clarification'
      ELSE 'awaiting_confirmation'
    END,
    state_version = task.state_version + 1,
    active_plan_version_id = CASE
      WHEN legacy.state = 'awaiting_selection' THEN NULL
      ELSE task.active_plan_version_id
    END,
    current_attempt_id = NULL,
    updated_at = now()
FROM legacy_pending_input_tasks AS legacy
WHERE task.id = legacy.id
  AND task.state = legacy.state
  AND (
    legacy.state <> 'awaiting_confirmation'
    OR task.current_attempt_id IS NOT NULL
  );
