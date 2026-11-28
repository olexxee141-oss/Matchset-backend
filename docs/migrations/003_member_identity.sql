-- MatchSet: stable member identity and duplicate display-name support.
-- Existing member UUIDs remain unchanged; all existing records receive a deterministic code.
ALTER TABLE community_members
  ADD COLUMN IF NOT EXISTS member_code text;

UPDATE community_members
   SET member_code = upper(substr(replace(id::text, '-', ''), 1, 8))
 WHERE member_code IS NULL;

ALTER TABLE community_members
  ALTER COLUMN member_code SET NOT NULL;

-- Display names are labels, not identity. Allow duplicates within a community.
ALTER TABLE community_members
  DROP CONSTRAINT IF EXISTS community_members_community_id_normalized_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS community_members_community_member_code_uidx
  ON community_members (community_id, member_code);

CREATE INDEX IF NOT EXISTS community_members_community_name_idx
  ON community_members (community_id, display_name);
