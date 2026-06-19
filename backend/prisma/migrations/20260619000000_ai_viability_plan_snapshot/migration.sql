-- AI route-picker plan snapshot (Ryan 2026-06-19). The Overview viability card runs the AI route-picker
-- (deriveAiViability) — the SAME brain the drafter uses. We persist its argument plan on the case so
-- Ask Aegis can NARRATE that one-brain pick (hard excludes included) for a viability question WITHOUT a
-- second synchronous LLM call on the 29s-capped /ask path. ai_viability_plan_hash guards refresh (re-write
-- only when the picker inputs change). Both nullable + additive → existing rows unaffected, no backfill.
ALTER TABLE "cases" ADD COLUMN "ai_viability_plan_json" JSONB;
ALTER TABLE "cases" ADD COLUMN "ai_viability_plan_hash" TEXT;
