-- Assistant refinement messages are retried by activated requirement version.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS messages_conversation_idempotency_key_unique
  ON messages(conversation_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
