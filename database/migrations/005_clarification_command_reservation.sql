-- Durable clarification command reservations may exist before the external LLM call completes.
ALTER TABLE control_commands
  ALTER COLUMN response_json DROP NOT NULL,
  ADD COLUMN command_status TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN reservation_token UUID,
  ADD COLUMN reservation_expires_at TIMESTAMPTZ,
  ADD CONSTRAINT control_commands_status_check
    CHECK (command_status IN ('pending', 'completed')),
  ADD CONSTRAINT control_commands_reservation_shape_check
    CHECK (
      (command_status = 'completed'
        AND response_json IS NOT NULL
        AND reservation_token IS NULL
        AND reservation_expires_at IS NULL)
      OR
      (command_status = 'pending'
        AND response_json IS NULL
        AND reservation_token IS NOT NULL
        AND reservation_expires_at IS NOT NULL)
    );

CREATE INDEX control_commands_pending_expiry_idx
  ON control_commands(reservation_expires_at)
  WHERE command_status = 'pending';
