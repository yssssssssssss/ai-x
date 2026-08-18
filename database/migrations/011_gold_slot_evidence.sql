ALTER TABLE gold_batch_slots
  ADD COLUMN IF NOT EXISTS report_package_artifact_id UUID REFERENCES control_artifacts(id),
  ADD COLUMN IF NOT EXISTS infra_retries INTEGER NOT NULL DEFAULT 0 CHECK (infra_retries >= 0);

CREATE INDEX IF NOT EXISTS gold_batch_slots_report_package_idx
  ON gold_batch_slots(report_package_artifact_id)
  WHERE report_package_artifact_id IS NOT NULL;
