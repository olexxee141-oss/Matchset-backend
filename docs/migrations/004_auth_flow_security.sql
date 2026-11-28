-- Add per-flow browser binding and durable recovery-code attempt throttling.
-- Apply after migration 003 on a disposable Neon branch first.
ALTER TABLE auth_challenges ADD COLUMN flow_token_hash text;
CREATE UNIQUE INDEX auth_challenges_flow_token_active_idx
  ON auth_challenges(flow_token_hash)
  WHERE flow_token_hash IS NOT NULL AND consumed_at IS NULL;

CREATE TABLE auth_recovery_attempt_limits (
  subject_hash text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_until timestamptz
);
CREATE INDEX auth_recovery_attempt_limits_lock_idx
  ON auth_recovery_attempt_limits(locked_until)
  WHERE locked_until IS NOT NULL;
