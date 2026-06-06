-- Parse-at-intake OCR cache (#8 v2). Intake files are OCR'd in place (the EventBridge OCR rule now
-- also fires on the intake/ prefix) so the text is ready by assign time and isn't re-OCR'd. Keyed by
-- the intake S3 key (intake/<intakeId>/<file>); NO FK to intakes (staging table — the key already
-- namespaces by intakeId, and intake rows are pruned independently). page_number 0 is a placeholder
-- written at OCR start carrying the Textract job_tag, so the async completion can resolve which
-- intake key a finished Textract job belongs to (JobTag can't hold the slash-bearing s3 key).
CREATE TABLE IF NOT EXISTS "intake_pages" (
  "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "intake_s3_key" TEXT NOT NULL,
  "page_number"   INTEGER NOT NULL,
  "text"          TEXT NOT NULL DEFAULT '',
  "confidence"    REAL,
  "page_count"    INTEGER,
  "read_status"   VARCHAR(40),
  "job_tag"       VARCHAR(64),
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "intake_pages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "intake_pages_page_check" CHECK ("page_number" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "intake_pages_key_page_uq" ON "intake_pages"("intake_s3_key", "page_number");
CREATE INDEX IF NOT EXISTS "intake_pages_intake_s3_key_idx" ON "intake_pages"("intake_s3_key");
CREATE INDEX IF NOT EXISTS "intake_pages_job_tag_idx" ON "intake_pages"("job_tag");
