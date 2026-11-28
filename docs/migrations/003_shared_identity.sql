-- MatchSet shared identity foundation.
-- Additive identity tables; existing community/member/match identifiers remain intact.
-- Do not apply to production until reviewed and backed up.

CREATE TABLE users (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('PENDING', 'ACTIVE', 'RECOVERY_PENDING', 'DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_passkey_credentials (
  credential_id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key bytea NOT NULL,
  signature_counter bigint NOT NULL DEFAULT 0 CHECK (signature_counter >= 0),
  transports text[] NOT NULL DEFAULT '{}',
  device_type text,
  backed_up boolean NOT NULL DEFAULT false,
  aaguid text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX user_passkey_credentials_user_idx
  ON user_passkey_credentials(user_id) WHERE revoked_at IS NULL;

CREATE TABLE user_recovery_codes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_salt text NOT NULL,
  code_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX user_recovery_codes_one_active_per_user_idx
  ON user_recovery_codes(user_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE auth_challenges (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  challenge_hash text NOT NULL UNIQUE,
  purpose text NOT NULL CHECK (purpose IN (
    'PASSKEY_REGISTRATION',
    'PASSKEY_AUTHENTICATION',
    'RECOVERY_EMAIL_VERIFICATION',
    'RECOVERY_PASSKEY_REGISTRATION'
  )),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_challenges_expiry_idx ON auth_challenges(expires_at);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  csrf_token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_active_idx
  ON auth_sessions(user_id, expires_at) WHERE revoked_at IS NULL;

-- Existing community_members rows become unclaimed identities; their IDs and
-- historical references are preserved. Display names are intentionally non-unique.
ALTER TABLE community_members
  ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'LEFT', 'REMOVED'));

ALTER TABLE community_members
  DROP CONSTRAINT IF EXISTS community_members_community_id_normalized_name_key;

CREATE UNIQUE INDEX community_members_one_active_account_per_community_idx
  ON community_members(community_id, user_id)
  WHERE user_id IS NOT NULL AND status = 'ACTIVE';

CREATE TABLE membership_claim_invitations (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES community_members(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  issued_by_membership_id uuid NOT NULL REFERENCES community_members(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  claimed_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX membership_claim_invitations_membership_idx
  ON membership_claim_invitations(membership_id, created_at DESC);

CREATE TABLE community_audit_events (
  id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id),
  actor_membership_id uuid REFERENCES community_members(id),
  action text NOT NULL,
  target_type text,
  target_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX community_audit_events_history_idx
  ON community_audit_events(community_id, created_at DESC);
