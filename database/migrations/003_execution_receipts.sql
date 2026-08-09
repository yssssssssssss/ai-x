ALTER TABLE control_model_calls
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'succeeded'
    CHECK (status IN ('succeeded', 'failed')),
  ADD COLUMN IF NOT EXISTS failure_json JSONB;
