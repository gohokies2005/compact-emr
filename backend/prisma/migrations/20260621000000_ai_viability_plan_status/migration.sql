-- AI route-picker plan COMPUTE STATUS (Ryan 2026-06-21, Zimmelman). The 20260619 snapshot persisted ONLY a
-- successful plan, so a route-picker LLM error/timeout on a large chart left the plan columns null forever:
-- the GET re-fired the async recompute on every open (same failure each time → never warms) and the card
-- fell back to a MISLEADING "Not supportable as filed" deterministic verdict instead of an honest error.
-- These columns make the failure VISIBLE + STABLE so the read path can distinguish never-computed /
-- computing / failed / ready, surface an honest "analysis failed — retry", and bound retries. All nullable
-- + additive → existing rows unaffected, no backfill.
ALTER TABLE "cases" ADD COLUMN "ai_viability_plan_status" TEXT;
ALTER TABLE "cases" ADD COLUMN "ai_viability_plan_error" TEXT;
ALTER TABLE "cases" ADD COLUMN "ai_viability_plan_computed_at" TIMESTAMP(3);
