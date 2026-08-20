-- Per-user presentation state for Legacy and Current task history.
-- task_id intentionally has no foreign key: it refers to one of two task tables.
CREATE TABLE IF NOT EXISTS task_history_preferences (
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_kind TEXT NOT NULL CHECK (task_kind IN ('legacy', 'current')),
  task_id UUID NOT NULL,
  display_name TEXT CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 200),
  pinned_at TIMESTAMPTZ,
  hidden_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, task_kind, task_id)
);

CREATE INDEX IF NOT EXISTS task_history_preferences_owner_order_idx
  ON task_history_preferences(owner_user_id, hidden_at, pinned_at DESC, updated_at DESC);
