CREATE TABLE control_zero_publications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES control_tasks(id),
  owner_user_id UUID NOT NULL REFERENCES users(id),
  plan_version_id UUID NOT NULL REFERENCES control_plan_versions(id),
  attempt_id UUID NOT NULL REFERENCES control_execution_attempts(id),
  report_package_artifact_id UUID NOT NULL REFERENCES control_artifacts(id),
  report_package_hash TEXT NOT NULL CHECK (report_package_hash LIKE 'sha256:%'),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash LIKE 'sha256:%'),
  template_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  stage TEXT NOT NULL CHECK (stage IN (
    'checking_zero', 'reading_report', 'rendering_html', 'creating_draft',
    'transcoding_images', 'writing_images', 'verifying_metadata',
    'verifying_fills', 'capturing_screenshots', 'finalizing_receipt'
  )),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  zero_file_key TEXT,
  zero_page_id TEXT NOT NULL CHECK (zero_page_id ~ '^[0-9]+:[0-9]+$'),
  zero_page_name TEXT NOT NULL,
  draft_root_node_id TEXT CHECK (draft_root_node_id IS NULL OR draft_root_node_id ~ '^[0-9]+:[0-9]+$'),
  final_root_node_id TEXT CHECK (final_root_node_id IS NULL OR final_root_node_id ~ '^[0-9]+:[0-9]+$'),
  update_publication_id UUID REFERENCES control_zero_publications(id),
  update_root_node_id TEXT CHECK (update_root_node_id IS NULL OR update_root_node_id ~ '^[0-9]+:[0-9]+$'),
  zero_node_map JSONB,
  image_manifest JSONB,
  screenshot_manifest JSONB,
  receipt_artifact_id UUID REFERENCES control_artifacts(id),
  failure_json JSONB,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (task_id, idempotency_key),
  CHECK (update_publication_id IS NULL OR update_publication_id <> id),
  CHECK (
    (status = 'queued'
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND failure_json IS NULL
      AND completed_at IS NULL)
    OR
    (status = 'running'
      AND lease_owner IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND failure_json IS NULL
      AND completed_at IS NULL)
    OR
    (status = 'completed'
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND final_root_node_id IS NOT NULL
      AND receipt_artifact_id IS NOT NULL
      AND failure_json IS NULL
      AND completed_at IS NOT NULL
      AND progress = 100)
    OR
    (status = 'failed'
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND failure_json IS NOT NULL
      AND completed_at IS NOT NULL)
  )
);

CREATE INDEX control_zero_publications_task_idx
  ON control_zero_publications(task_id, created_at DESC);

CREATE INDEX control_zero_publications_recovery_idx
  ON control_zero_publications(status, lease_expires_at)
  WHERE status = 'running';
