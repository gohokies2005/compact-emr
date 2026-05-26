-- Phase 7B architect-QA follow-up (REVIEW.md commit b99de30):
--   1. Add `page_count` to documents so the Doctor Pack manifest can cap per-file page ranges
--      meaningfully (the assembler currently sees null page_count for every file and emits
--      empty page_ranges — "silently inert" per the architect).
--   2. Partial-unique index on doctor_packs(case_id, case_version) WHERE state IN
--      ('queued', 'generating') — prevents double-click-Generate from creating duplicate
--      queued rows + duplicate worker invocations. Preserves the audit history of
--      'ready' and 'failed' rows.

ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "page_count" INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS "doctor_packs_active_uq"
  ON "doctor_packs" ("case_id", "case_version")
  WHERE "state" IN ('queued', 'generating');
