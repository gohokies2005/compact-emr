-- Sanity-impression cache (cost-safety 2026-06-18). The auto-fired Opus "overall impression" gut-check
-- re-spent on every Overview mount because there was no server-side dedup. This table caches the result
-- per (case, stage) keyed by an input hash so an identical re-fire returns the cached row for $0.
CREATE TABLE "sanity_impressions" (
  "id"          TEXT NOT NULL,
  "case_id"     TEXT NOT NULL,
  "stage"       TEXT NOT NULL,
  "input_hash"  VARCHAR(64) NOT NULL,
  "result_json" JSONB,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "sanity_impressions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sanity_impression_case_stage_uq" ON "sanity_impressions" ("case_id", "stage");
CREATE INDEX "sanity_impressions_case_id_idx" ON "sanity_impressions" ("case_id");
