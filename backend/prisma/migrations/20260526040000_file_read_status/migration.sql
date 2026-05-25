-- Phase 5.2: OCR HARD-STOP enforcement. Every record file uploaded against a case must be
-- read by at least one method (native PDF extract / Tesseract OCR / Claude vision). If all
-- three fail, the row terminates at 'manual_summary_required' and the chart-readiness gate
-- HALTS every downstream consumer until an RN provides a manual_summary >= 40 chars.
--
-- Per Ryan's HARD RULE: no skip flag, no admin override. The only paths forward are 'read'
-- (a machine read the file) or 'manual_summary_provided' (an RN read it and wrote a summary).

CREATE TABLE IF NOT EXISTS "file_read_status" (
  "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
  "case_id"             VARCHAR NOT NULL,
  "file_path"           VARCHAR(500) NOT NULL,
  "file_sha256"         VARCHAR(64) NOT NULL,
  "terminal_status"     VARCHAR(40) NOT NULL,
  "attempts_json"       JSONB NOT NULL,
  "manual_summary"      TEXT,
  "manual_summary_at"   TIMESTAMPTZ(6),
  "manual_summary_by"   VARCHAR,
  "last_checked_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "version"             INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "file_read_status_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "file_read_status_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE,
  CONSTRAINT "file_read_status_terminal_check" CHECK ("terminal_status" IN ('read', 'manual_summary_required', 'manual_summary_provided'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "file_read_status_case_file_uq" ON "file_read_status"("case_id", "file_path");
CREATE INDEX IF NOT EXISTS "file_read_status_case_id_idx" ON "file_read_status"("case_id");
CREATE INDEX IF NOT EXISTS "file_read_status_terminal_idx" ON "file_read_status"("terminal_status");
