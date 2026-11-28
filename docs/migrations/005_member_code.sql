-- MatchSet: add stable public member codes without changing existing member IDs.
-- Safe to run after shared identity migrations; existing rows are backfilled deterministically.
ALTER TABLE community_members
  ADD COLUMN IF NOT EXISTS member_code text;

UPDATE community_members
   SET member_code = upper(substr(replace(id::text, '-', ''), 1, 8))
 WHERE member_code IS NULL;

ALTER TABLE community_members
  ALTER COLUMN member_code SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS community_members_community_member_code_uidx
  ON community_members (community_id, member_code);
