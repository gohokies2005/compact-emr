-- Medication temporality (full-read chunker, Ryan 2026-06-13). Three ADDITIVE columns + one index
-- on active_medications so the chart can split the CURRENT active list from the treatment HISTORY
-- (Prozac 2015 vs Lexapro 2022) instead of a flat 37-row "active" dump.
--
-- med_status      active | discontinued | historical | unknown. NOT NULL DEFAULT 'active' → every
--                 existing row and every manual-add row reads as active with NO backfill, and the
--                 manual-vs-auto merge stays intact (a manual 'active' row keeps its key).
-- start_date      explicitly-labeled Start/Issue date, verbatim. TEXT not date: VA OCR dates are
--                 often partial ("2015", "03/2015") — a date column would force a fabricating parse.
-- last_seen_date  last-fill date (active list) OR the progress-note date a past mention came from.
--
-- All defaulted/nullable; IF NOT EXISTS for idempotent re-runs (codebuild-prisma-migrate psql flow,
-- same convention as 20260705000000_doctor_pay).
ALTER TABLE "active_medications" ADD COLUMN IF NOT EXISTS "med_status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "active_medications" ADD COLUMN IF NOT EXISTS "start_date" TEXT;
ALTER TABLE "active_medications" ADD COLUMN IF NOT EXISTS "last_seen_date" TEXT;

-- The MedicationsPanel active-list query filters by (veteran_id, med_status).
CREATE INDEX IF NOT EXISTS "active_medications_veteran_id_med_status_idx" ON "active_medications" ("veteran_id", "med_status");
