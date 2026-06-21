-- Quick notes (Ryan 2026-06-21). Quick notes are NOT a new table or section — they are FLAGGED entries
-- INSIDE the existing chart-notes (staff-notes) stream. A quick note is a SHORT note added via the
-- "sticky" fast-add; it lists chronologically with the other staff notes, just marked with a badge, and
-- the dashboard/case Overview surfaces the MOST-RECENT quick note. All quick notes persist historically
-- in the same list (never overwritten).
--
-- ADDITIVE ONLY: a single new boolean column (default false) + a covering index for the
-- latest-quick-note-by-veteran read. No destructive change. Existing rows become is_quick_note = false
-- (i.e. ordinary staff notes), which is the correct back-fill. Apply on deploy with `prisma migrate deploy`.
ALTER TABLE "chart_notes" ADD COLUMN IF NOT EXISTS "is_quick_note" BOOLEAN NOT NULL DEFAULT false;

-- Latest-quick-note-by-veteran: WHERE veteran_id = ? AND is_quick_note ORDER BY created_at DESC LIMIT 1.
CREATE INDEX IF NOT EXISTS "chart_notes_veteran_id_is_quick_note_created_at_idx"
  ON "chart_notes" ("veteran_id", "is_quick_note", "created_at");
