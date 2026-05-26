-- Phase 7B: Key documents classifier + Doctor Pack assembly state.
-- Each uploaded record file gets classified (high_signal / bulk / normal) + an
-- optional doc_type label (dd_214, denial_letter, dbq, c_and_p, ...). The
-- doctor_pack table tracks one assembly job per (caseId, version) — the
-- consolidated PDF the physician reviews.

CREATE TABLE IF NOT EXISTS "key_docs" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "case_id"         VARCHAR NOT NULL,
  "file_path"       VARCHAR(500) NOT NULL,
  "file_sha256"     VARCHAR(64) NOT NULL,
  "classification"  VARCHAR(20) NOT NULL,
  "doc_type"        VARCHAR(40) NOT NULL,
  "importance"      INTEGER NOT NULL DEFAULT 0,
  "page_ranges"     JSONB NOT NULL DEFAULT '[]'::jsonb,
  "notes"           TEXT,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "version"         INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "key_docs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "key_docs_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE,
  CONSTRAINT "key_docs_classification_check" CHECK ("classification" IN ('high_signal', 'bulk', 'normal'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "key_docs_case_file_uq" ON "key_docs"("case_id", "file_path");
CREATE INDEX IF NOT EXISTS "key_docs_case_id_idx" ON "key_docs"("case_id");
CREATE INDEX IF NOT EXISTS "key_docs_classification_idx" ON "key_docs"("classification");
CREATE INDEX IF NOT EXISTS "key_docs_doc_type_idx" ON "key_docs"("doc_type");
CREATE INDEX IF NOT EXISTS "key_docs_importance_idx" ON "key_docs"("importance");

CREATE TABLE IF NOT EXISTS "doctor_packs" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "case_id"          VARCHAR NOT NULL,
  "case_version"     INTEGER NOT NULL,
  "state"            VARCHAR(20) NOT NULL DEFAULT 'queued',
  "pdf_s3_key"       VARCHAR(500),
  "page_count"       INTEGER,
  "key_doc_count"    INTEGER,
  "manifest_json"    JSONB,
  "error_message"    TEXT,
  "generated_at"     TIMESTAMPTZ(6),
  "generated_by"     VARCHAR,
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "version"          INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "doctor_packs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "doctor_packs_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE,
  CONSTRAINT "doctor_packs_state_check" CHECK ("state" IN ('queued', 'generating', 'ready', 'failed'))
);

CREATE INDEX IF NOT EXISTS "doctor_packs_case_id_idx" ON "doctor_packs"("case_id");
CREATE INDEX IF NOT EXISTS "doctor_packs_state_idx" ON "doctor_packs"("state");
CREATE INDEX IF NOT EXISTS "doctor_packs_case_version_idx" ON "doctor_packs"("case_id", "case_version");
