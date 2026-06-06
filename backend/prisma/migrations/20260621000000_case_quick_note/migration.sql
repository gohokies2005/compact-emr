-- Feature A: quick-note scratchpad on the claim row (Ryan 2026-06-06). At-a-glance status note
-- ("rejected, refund offered" / "waiting on records") shown in the claims list, distinct from the
-- substantive chart Notes. Overwrite scratchpad + last-editor stamp. Additive + nullable → existing
-- rows unaffected; set only by PUT /cases/:id/quick-note (never bumps the case version).
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "quick_note"    TEXT;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "quick_note_by" TEXT;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "quick_note_at" TIMESTAMPTZ(6);
