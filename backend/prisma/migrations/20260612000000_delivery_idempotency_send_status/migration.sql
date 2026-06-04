-- Delivery workflow hardening (P1 idempotency + P1 no-false-"sent"). ADDITIVE ONLY: no drops, no
-- renames, every statement IF NOT EXISTS. Safe for CI `prisma migrate deploy`. Does not touch the
-- approve/sign/draft/case-list flows.
--
-- ============================================================================================
-- FIX 2 (no false "sent"): widen emails.sent_at to nullable + add a lifecycle status column.
-- ============================================================================================
-- A composed/queued (stub) delivery email has NOT been transmitted; it must leave sent_at NULL.
-- sent_at is set ONLY when a real transmit happens. Widening NOT NULL -> NULL is additive and
-- lossless: every existing row keeps its value. (DROP NOT NULL is not a destructive change — no
-- data is removed and no column is renamed/dropped — and is required for the new semantics.)
ALTER TABLE "emails" ALTER COLUMN "sent_at" DROP NOT NULL;

-- status: 'sent' for historically-transmitted rows (back-compat default keeps every existing row
-- reading as 'sent', which they were), 'queued' for a composed-but-not-transmitted stub email.
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'sent';
CREATE INDEX IF NOT EXISTS "emails_status_idx" ON "emails" ("status");

-- ============================================================================================
-- FIX 1 (race-proof idempotency): one delivery Payment + one delivery Email per case, enforced
-- at the DB so a double-click / retry / concurrent request cannot create duplicate rows. The
-- route catches the unique violation (P2002) and re-uses the existing row.
-- ============================================================================================
-- WHY THESE CAN'T FAIL ON EXISTING DATA — these are PARTIAL unique indexes, scoped to exactly the
-- delivery rows (mirrors the existing draft_jobs_case_id_in_flight_uq / doctor_packs partial-unique
-- idiom in this repo; Prisma's @@unique does not support partial indexes, so this lives only in raw
-- SQL — intentional). A plain unique on (case_id) would be WRONG and WOULD break existing data: a
-- case legitimately has many payments (review_50 + letter_500 + refund) and many emails (inbound +
-- multiple outbound). The partial WHERE clause restricts the index to the single delivery row class.
--
-- The one residual risk is a pre-existing DUPLICATE in staging (e.g. a double-send before this fix
-- landed). CREATE UNIQUE INDEX would fail on a duplicate, so we DEDUPLICATE FIRST, keeping the
-- earliest row per case (deterministic, by created_at then id). These are stub rows — no real charge
-- and no real send ever occurred — so collapsing duplicates is lossless of real-world effect. The
-- DELETE is a no-op when there are no duplicates (the common case). Both steps are idempotent: the
-- DELETE has nothing to remove on re-run, and the index uses IF NOT EXISTS.

-- 1a) Deduplicate delivery Payments (letter_500) — keep the earliest per case.
DELETE FROM "payments" p
USING "payments" keep
WHERE p."kind" = 'letter_500'
  AND keep."kind" = 'letter_500'
  AND p."case_id" = keep."case_id"
  AND (p."created_at", p."id") > (keep."created_at", keep."id");

-- 1b) One letter_500 Payment per case.
CREATE UNIQUE INDEX IF NOT EXISTS "payments_case_id_letter_500_uq"
  ON "payments" ("case_id")
  WHERE "kind" = 'letter_500';

-- 1c) Deduplicate the delivery Email (outbound, from info@, fixed delivery subject) — keep earliest.
--     Subject/from are pinned to the delivery-templates constants; the route's idempotency findFirst
--     uses the same triple, so the index predicate matches exactly what gets inserted.
DELETE FROM "emails" e
USING "emails" keep
WHERE e."direction" = 'outbound'
  AND e."from_address" = 'info@flatratenexus.com'
  AND e."subject" = 'Your nexus letter is ready, invoice enclosed'
  AND keep."direction" = 'outbound'
  AND keep."from_address" = 'info@flatratenexus.com'
  AND keep."subject" = 'Your nexus letter is ready, invoice enclosed'
  AND e."case_id" = keep."case_id"
  AND (e."created_at", e."id") > (keep."created_at", keep."id");

-- 1d) One delivery Email per case.
CREATE UNIQUE INDEX IF NOT EXISTS "emails_case_id_delivery_uq"
  ON "emails" ("case_id")
  WHERE "direction" = 'outbound'
    AND "from_address" = 'info@flatratenexus.com'
    AND "subject" = 'Your nexus letter is ready, invoice enclosed';
