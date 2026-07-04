-- claimedConditionSource provenance (2026-07-04): who set Case.claimed_condition — 'intake' (Jotform/create),
-- 'ai' (the AI-narrow step resolved a generic "Other Joint (…)" dropdown catch-all to a specific documented
-- dx), or 'manual' (an RN/physician set it — IMMUTABLE: the AI-narrow writer and any automated path must never
-- overwrite a 'manual' value). Additive + nullable → metadata-only ALTER (no table rewrite), safe on a live
-- table. Legacy rows stay NULL → treated as overwritable (source unknown = intake-equivalent).
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "claimed_condition_source" VARCHAR(16);
