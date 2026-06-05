-- Soft-archive for claims: a nullable timestamp instead of a permanent cascade delete. Archived
-- cases are hidden from default views + restorable (set archived_at = NULL). A true hard purge stays
-- available to admins for spam. (Replaces the old DELETE-cascades-the-row behavior.)
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMPTZ(6);
CREATE INDEX IF NOT EXISTS "cases_archived_at_idx" ON "cases"("archived_at");
