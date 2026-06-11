-- P4 anchor-viability snapshot columns (caseViability v1, docs/P4_ANCHOR_VIABILITY_BUILD_PLAN.md §3.2).
-- Written ONLY-WHEN-NULL by the POST /draft viability stamp (persistViabilityWhenNull — same
-- never-clobber contract as persistFramingWhenNull); dark behind EMR_CASE_VIABILITY_ENABLED.
-- band: strong|moderate|conditional|weak|abstain|redirect; anchor: best_anchor.upstream_canonical
-- (null for redirect/abstain — no anchor persisted). Both NULLABLE, default null → existing rows
-- unaffected. IF NOT EXISTS for idempotent re-runs (codebuild-prisma-migrate psql flow).
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "case_viability_band" VARCHAR(16);
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "case_viability_anchor" TEXT;
