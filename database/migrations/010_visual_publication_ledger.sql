-- Confirmation-scoped visual publications make Artifact compensation durable.
CREATE TABLE control_visual_publications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES control_tasks(id),
  plan_version_id UUID NOT NULL REFERENCES control_plan_versions(id),
  -- Commands are intentionally deletable when a reservation is released; retain its durable ID.
  command_id UUID NOT NULL,
  request_hash TEXT NOT NULL,
  expected_version BIGINT NOT NULL,
  reservation_token_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PUBLISHING', 'COMMITTED', 'ABANDONED')),
  evidence_refs JSONB,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at TIMESTAMPTZ,
  abandoned_at TIMESTAMPTZ,
  UNIQUE (command_id, reservation_token_hash),
  CHECK (
    (state = 'PUBLISHING'
      AND evidence_refs IS NULL
      AND failure_reason IS NULL
      AND committed_at IS NULL
      AND abandoned_at IS NULL)
    OR
    (state = 'COMMITTED'
      AND jsonb_typeof(evidence_refs) = 'array'
      AND failure_reason IS NULL
      AND committed_at IS NOT NULL
      AND abandoned_at IS NULL)
    OR
    (state = 'ABANDONED'
      AND evidence_refs IS NULL
      AND failure_reason IS NOT NULL
      AND committed_at IS NULL
      AND abandoned_at IS NOT NULL)
  )
);

ALTER TABLE control_artifacts
  ADD COLUMN publication_id UUID REFERENCES control_visual_publications(id);

CREATE INDEX control_visual_publications_recovery_idx
  ON control_visual_publications(state, task_id)
  WHERE state = 'PUBLISHING';

CREATE INDEX control_artifacts_publication_idx
  ON control_artifacts(publication_id, state)
  WHERE publication_id IS NOT NULL;
