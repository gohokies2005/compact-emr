-- Architect QA finding (REVIEW.md commit 0cd4df0, Build 1 follow-up):
-- needs_rn_review was being recomputed on every /generate, so an RN's "I reviewed, this is
-- correct as-is" decision didn't survive regeneration. Add a durable acknowledgement
-- timestamp + actor; when set, the upsert's update path leaves needs_rn_review alone.
ALTER TABLE "key_docs" ADD COLUMN IF NOT EXISTS "selector_acknowledged_at" TIMESTAMPTZ(6);
ALTER TABLE "key_docs" ADD COLUMN IF NOT EXISTS "selector_acknowledged_by" VARCHAR;
