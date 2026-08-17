ALTER TABLE control_model_calls
  ADD COLUMN IF NOT EXISTS model_version TEXT NOT NULL DEFAULT 'unknown';
