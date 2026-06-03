-- Chart auto-extract: provenance columns on the three chart tables + the extraction-run ledger.
-- Every column is additive with a default/nullable, so existing rows and the manual POST path are
-- unaffected: source defaults to 'manual', which makes existing + manually-entered rows IMMUTABLE
-- to the extractor's non-destructive merge. Idempotent: safe to re-run.

-- ----- sc_conditions -----
ALTER TABLE "sc_conditions" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "sc_conditions" ADD COLUMN IF NOT EXISTS "source_document_id" TEXT;
ALTER TABLE "sc_conditions" ADD COLUMN IF NOT EXISTS "source_page" INTEGER;
ALTER TABLE "sc_conditions" ADD COLUMN IF NOT EXISTS "source_quote" TEXT;
ALTER TABLE "sc_conditions" ADD COLUMN IF NOT EXISTS "confidence" DOUBLE PRECISION;
ALTER TABLE "sc_conditions" ADD COLUMN IF NOT EXISTS "needs_review" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "sc_conditions" ADD COLUMN IF NOT EXISTS "extracted_at" TIMESTAMPTZ(6);
ALTER TABLE "sc_conditions" ADD COLUMN IF NOT EXISTS "extraction_run_id" TEXT;

-- ----- active_problems -----
ALTER TABLE "active_problems" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "active_problems" ADD COLUMN IF NOT EXISTS "source_document_id" TEXT;
ALTER TABLE "active_problems" ADD COLUMN IF NOT EXISTS "source_page" INTEGER;
ALTER TABLE "active_problems" ADD COLUMN IF NOT EXISTS "source_quote" TEXT;
ALTER TABLE "active_problems" ADD COLUMN IF NOT EXISTS "confidence" DOUBLE PRECISION;
ALTER TABLE "active_problems" ADD COLUMN IF NOT EXISTS "needs_review" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "active_problems" ADD COLUMN IF NOT EXISTS "extracted_at" TIMESTAMPTZ(6);
ALTER TABLE "active_problems" ADD COLUMN IF NOT EXISTS "extraction_run_id" TEXT;

-- ----- active_medications -----
ALTER TABLE "active_medications" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "active_medications" ADD COLUMN IF NOT EXISTS "source_document_id" TEXT;
ALTER TABLE "active_medications" ADD COLUMN IF NOT EXISTS "source_page" INTEGER;
ALTER TABLE "active_medications" ADD COLUMN IF NOT EXISTS "source_quote" TEXT;
ALTER TABLE "active_medications" ADD COLUMN IF NOT EXISTS "confidence" DOUBLE PRECISION;
ALTER TABLE "active_medications" ADD COLUMN IF NOT EXISTS "needs_review" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "active_medications" ADD COLUMN IF NOT EXISTS "extracted_at" TIMESTAMPTZ(6);
ALTER TABLE "active_medications" ADD COLUMN IF NOT EXISTS "extraction_run_id" TEXT;

-- ----- chart_extraction_runs (idempotency latch + Phase A audit sink) -----
CREATE TABLE IF NOT EXISTS "chart_extraction_runs" (
  "id"            TEXT NOT NULL,
  "case_id"       TEXT NOT NULL,
  "veteran_id"    TEXT NOT NULL,
  "trigger_hash"  VARCHAR(64) NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'queued',
  "items_written" INTEGER NOT NULL DEFAULT 0,
  "items_skipped" INTEGER NOT NULL DEFAULT 0,
  "result_json"   JSONB,
  "error_message" TEXT,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at"  TIMESTAMPTZ(6),
  CONSTRAINT "chart_extraction_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "chart_extraction_run_case_hash_uq" ON "chart_extraction_runs"("case_id", "trigger_hash");
CREATE INDEX IF NOT EXISTS "chart_extraction_runs_case_id_idx" ON "chart_extraction_runs"("case_id");
