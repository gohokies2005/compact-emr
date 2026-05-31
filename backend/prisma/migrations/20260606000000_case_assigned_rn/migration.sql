-- Case assignment: RN liaison (2026-05-30). Every case gets an RN liaison alongside the
-- assigned physician. assignedRnId -> app_users(id). ON DELETE SET NULL (an RN leaving must
-- never cascade-delete cases — the opposite of the veteran/physician cascade).
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "assigned_rn_id" TEXT;
CREATE INDEX IF NOT EXISTS "cases_assigned_rn_id_idx" ON "cases" ("assigned_rn_id");
DO $$ BEGIN
  ALTER TABLE "cases" ADD CONSTRAINT "cases_assigned_rn_id_fkey"
    FOREIGN KEY ("assigned_rn_id") REFERENCES "app_users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
