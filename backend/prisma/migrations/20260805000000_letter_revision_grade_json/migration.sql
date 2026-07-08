-- Regrade-on-save (Ryan 2026-07-08): earmark a fast probative grade to each saved edit version.
-- Additive + nullable → backward-compatible; existing rows read null (display falls back to the
-- DraftJob grade). Mirrors draft_jobs.grade_sidecar_json (JSONB).
ALTER TABLE "letter_revisions" ADD COLUMN "grade_json" JSONB;
