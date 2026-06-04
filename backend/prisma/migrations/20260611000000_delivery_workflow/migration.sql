-- Post-approval delivery workflow: additive schema only. No drops, no renames; safe for the CI
-- migrate step and idempotent (every statement is IF NOT EXISTS).
--
-- 1) PaymentKind gains 'letter_500' — the $500 flat letter fee invoiced at delivery. The local
--    FRN pricing moved to $500 flat (project_pricing_model_500); the cloud Payment ledger needs the
--    matching kind so a delivery can record the invoice. Existing kinds are untouched.
--    NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction in older Postgres. Prisma runs
--    each migration file in its own transaction; ADD VALUE IF NOT EXISTS is transaction-safe on
--    PG 12+ (RDS Aurora/PG here), so this is fine.
ALTER TYPE "payment_kind" ADD VALUE IF NOT EXISTS 'letter_500';

-- 2) Prior-denial signals on cases — so the delivery cover-memo predicate knows when an appeal
--    cover memo applies (feedback_supplemental_appeals_need_cover_letter HARD RULE). Additive,
--    defaulted/nullable: existing rows keep previouslyDenied=false / NULL dates.
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "previously_denied" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "prior_denial_reason" TEXT;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "prior_decision_date" DATE;
