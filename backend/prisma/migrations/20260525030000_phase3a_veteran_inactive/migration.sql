-- Phase 3A-1: support admin-only soft delete for veterans.
-- No PHI is removed; active list endpoints filter inactive rows by default.
ALTER TABLE "veterans" ADD COLUMN IF NOT EXISTS "inactive" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "veterans_inactive_idx" ON "veterans"("inactive");
