-- MatchSet: winner-stays rotation state for community matches.
-- Additive migration; existing match history remains unchanged.
ALTER TABLE community_matches
  ADD COLUMN IF NOT EXISTS rotation_state jsonb;

CREATE INDEX IF NOT EXISTS community_matches_rotation_active_idx
  ON community_matches (community_id, created_at DESC)
  WHERE rotation_state IS NOT NULL;
