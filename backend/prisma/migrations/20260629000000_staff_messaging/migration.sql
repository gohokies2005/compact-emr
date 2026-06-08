-- Internal STAFF messaging (admin/ops_staff/physician), NEVER veteran-facing. Three tables:
--   staff_messages            — threaded, multi-recipient, immutable messages (optional case-link)
--   staff_message_recipients  — per-recipient participation + read/archive state (keyed to the thread)
--   staff_message_attachments — file attachments bound to a single message (all-or-nothing)
-- Distinct from the flat 2-party case_messages table (left untouched). Idempotent DDL: this file is
-- applied verbatim by scripts/codebuild-prisma-migrate.sh (psql, ON_ERROR_STOP=1), so every statement
-- is IF NOT EXISTS / duplicate-object-safe to allow re-runs.

CREATE TABLE IF NOT EXISTS "staff_messages" (
  "id" TEXT NOT NULL,
  "thread_id" TEXT NOT NULL,
  "case_id" TEXT,
  "author_sub" TEXT NOT NULL,
  "subject" TEXT,
  "body" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "staff_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "staff_messages_thread_id_idx" ON "staff_messages" ("thread_id");
CREATE INDEX IF NOT EXISTS "staff_messages_case_id_idx" ON "staff_messages" ("case_id");
CREATE INDEX IF NOT EXISTS "staff_messages_created_at_idx" ON "staff_messages" ("created_at");

DO $$ BEGIN
  ALTER TABLE "staff_messages" ADD CONSTRAINT "staff_messages_case_id_fkey"
    FOREIGN KEY ("case_id") REFERENCES "cases" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "staff_message_recipients" (
  "id" TEXT NOT NULL,
  "thread_id" TEXT NOT NULL,
  "recipient_sub" TEXT NOT NULL,
  "kind" VARCHAR(4) NOT NULL,
  "added_by_sub" TEXT NOT NULL,
  "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "read_at" TIMESTAMPTZ(6),
  "archived_at" TIMESTAMPTZ(6),
  CONSTRAINT "staff_message_recipients_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "staff_message_recipients_thread_recipient_uq"
  ON "staff_message_recipients" ("thread_id", "recipient_sub");
CREATE INDEX IF NOT EXISTS "staff_message_recipients_recipient_sub_read_at_idx"
  ON "staff_message_recipients" ("recipient_sub", "read_at");
CREATE INDEX IF NOT EXISTS "staff_message_recipients_thread_id_idx"
  ON "staff_message_recipients" ("thread_id");

CREATE TABLE IF NOT EXISTS "staff_message_attachments" (
  "id" TEXT NOT NULL,
  "message_id" TEXT, -- nullable: a pending (registered, not-yet-bound) attachment has no message yet
  "filename" TEXT NOT NULL,
  "content_type" TEXT NOT NULL,
  "size_bytes" BIGINT NOT NULL,
  "s3_key" TEXT NOT NULL,
  "uploaded_by_sub" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "staff_message_attachments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "staff_message_attachments_s3_key_key"
  ON "staff_message_attachments" ("s3_key");
CREATE INDEX IF NOT EXISTS "staff_message_attachments_message_id_idx"
  ON "staff_message_attachments" ("message_id");

DO $$ BEGIN
  ALTER TABLE "staff_message_attachments" ADD CONSTRAINT "staff_message_attachments_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "staff_messages" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
