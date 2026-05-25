-- Phase 4B-5: per-veteran chart notes. Idempotent so deploys can be retried safely.
CREATE TABLE IF NOT EXISTS chart_notes (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  veteran_id text NOT NULL REFERENCES veterans(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS chart_notes_veteran_id_idx ON chart_notes(veteran_id);
CREATE INDEX IF NOT EXISTS chart_notes_created_at_idx ON chart_notes(created_at);

-- Match the version-touch trigger applied to every other versioned table in Phase 1.
DROP TRIGGER IF EXISTS chart_notes_touch_version ON chart_notes;
CREATE TRIGGER chart_notes_touch_version BEFORE UPDATE ON chart_notes FOR EACH ROW EXECUTE FUNCTION compact_emr_touch_version();
