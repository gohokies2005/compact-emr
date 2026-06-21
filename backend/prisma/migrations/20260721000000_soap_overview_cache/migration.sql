-- SOAP-overview cache (cost-safety 2026-06-21). The AI-synthesized Subjective/Objective/Assessment/Plan
-- note (buildSoapNote, Sonnet) re-spent on every chart/page OPEN because it was only cached in an
-- in-process Map — a cold Lambda instance (very common: concurrent instances + idle reaping) had an empty
-- Map → cache miss → a fresh billed Sonnet call on every "in and out of charts". Mirrors the
-- sanity_impressions cache: ONE row per case keyed by an input FINGERPRINT (hash of the chart inputs that
-- feed the note). An exact-fingerprint hit serves the stored note for $0/instant; the model runs ONLY when
-- the fingerprint changes (new info came in) or the RN explicitly clicks "Regenerate with new info".
--   schema_version — bumped when SoapNote SHAPE changes so an old-shape blob is cleanly ignored, not mis-rendered.
CREATE TABLE "soap_overviews" (
  "id"             TEXT NOT NULL,
  "case_id"        TEXT NOT NULL,
  "input_hash"     VARCHAR(64) NOT NULL,
  "schema_version" INTEGER NOT NULL DEFAULT 1,
  "result_json"    JSONB,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "soap_overviews_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "soap_overview_case_uq" ON "soap_overviews" ("case_id");
CREATE INDEX "soap_overviews_case_id_idx" ON "soap_overviews" ("case_id");
