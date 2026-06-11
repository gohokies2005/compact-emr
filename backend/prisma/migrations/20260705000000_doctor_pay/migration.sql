-- Doctor-pay tracking (docs/DOCTOR_PAY_BUILD_PLAN_2026-06-11.md §5.5). Three ADDITIVE columns on
-- letter_revisions + one index. ACCURACY-CRITICAL: Ryan cuts real physician checks from this data.
--
-- letter_type          billing type of the completion: nexus_letter | nexus_memo. NOT NULL DEFAULT
--                      'nexus_letter' → every historical approved_final row back-fills to the
--                      correct type (every completion to date has been a nexus letter) and the
--                      live approve flow is unaffected.
-- signing_physician_id immutable pay attribution: the ASSIGNED signing physician at approve time
--                      (never the ActivityLog actor — an admin may click approve). NULLABLE; the
--                      pay query falls back to the live cases.assigned_physician_id join for
--                      pre-feature rows. No backfill (deliberate, plan §5.5).
-- pay_cents            rate-at-completion snapshot in integer cents ($100 letter / $50 memo),
--                      frozen at approve so future rate changes never rewrite closed months.
--                      NULLABLE; null rows resolve via the rate config at query time.
--
-- All additive + defaulted/nullable; IF NOT EXISTS for idempotent re-runs (codebuild-prisma-migrate
-- psql flow, same convention as 20260701000000_case_viability_columns).
ALTER TABLE "letter_revisions" ADD COLUMN IF NOT EXISTS "letter_type" VARCHAR(16) NOT NULL DEFAULT 'nexus_letter';
ALTER TABLE "letter_revisions" ADD COLUMN IF NOT EXISTS "signing_physician_id" TEXT;
ALTER TABLE "letter_revisions" ADD COLUMN IF NOT EXISTS "pay_cents" INTEGER;

-- Pay scan: approved_final rows by completion instant (the existing case_id/version indexes do
-- not serve a source+created_at scan).
CREATE INDEX IF NOT EXISTS "letter_revisions_pay_idx" ON "letter_revisions" ("source", "created_at");
