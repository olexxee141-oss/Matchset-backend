-- MatchSet: admin roles and tournament groupings
-- Additive migration. Existing communities, members, matches and history are preserved.
ALTER TABLE community_members
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'MEMBER',
  ADD COLUMN IF NOT EXISTS admin_token_hash text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_members_role_check') THEN
    ALTER TABLE community_members
      ADD CONSTRAINT community_members_role_check CHECK (role IN ('MEMBER', 'ADMIN'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS community_role_audit (
  id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES community_members(id) ON DELETE CASCADE,
  previous_role text NOT NULL,
  new_role text NOT NULL,
  changed_by text NOT NULL CHECK (changed_by = 'OWNER'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS community_role_audit_history_idx
  ON community_role_audit (community_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tournaments (
  id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tournaments_community_history_idx
  ON tournaments (community_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tournament_groups (
  id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tournament_teams (
  id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES tournament_groups(id) ON DELETE CASCADE,
  name text NOT NULL,
  members jsonb NOT NULL,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS tournament_groups_order_idx
  ON tournament_groups (tournament_id, sort_order);
CREATE INDEX IF NOT EXISTS tournament_teams_group_order_idx
  ON tournament_teams (group_id, sort_order);
