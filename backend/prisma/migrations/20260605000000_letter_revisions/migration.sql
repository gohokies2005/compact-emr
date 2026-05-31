-- LetterRevision unified-timeline table (2026-05-30).
-- CRITICAL: drafter.ts /complete calls tx.letterRevision.create() unconditionally inside its
-- transaction, and the in-EMR editor save/approve write here too. With no table, EVERY drafter
-- completion rolls back on staging/prod -> the case never reaches physician_review and artifacts
-- never attach. The LetterRevision model was added to schema.prisma without a migration; this is it.
-- Idempotent guards so it is safe whether or not the table was hand-created in a dev DB.
DO $$ BEGIN
  CREATE TYPE letter_revision_source AS ENUM ('drafter_run', 'editor_save', 'surgical_ai', 'approved_final');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "letter_revisions" (
  "id" TEXT NOT NULL,
  "case_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "parent_version" INTEGER NOT NULL,
  "source" letter_revision_source NOT NULL,
  "artifact_txt_s3_key" VARCHAR(500) NOT NULL,
  "artifact_pdf_s3_key" VARCHAR(500),
  "artifact_docx_s3_key" VARCHAR(500),
  "edited_by" TEXT NOT NULL,
  "editor_role" TEXT NOT NULL,
  "sanity_json" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "letter_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "letter_revisions_case_version_uq" ON "letter_revisions" ("case_id", "version");
CREATE INDEX IF NOT EXISTS "letter_revisions_case_id_idx" ON "letter_revisions" ("case_id");
CREATE INDEX IF NOT EXISTS "letter_revisions_case_id_version_idx" ON "letter_revisions" ("case_id", "version");

DO $$ BEGIN
  ALTER TABLE "letter_revisions" ADD CONSTRAINT "letter_revisions_case_id_fkey"
    FOREIGN KEY ("case_id") REFERENCES "cases" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
