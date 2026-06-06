-- Feature B: Email Communications log (Ryan 2026-06-06). Port of the local EMR's email_log pattern
-- (ARCHITECTURE.md §3: Gmail poller IN / Resend OUT, matched to veteran by address) to RDS + a Lambda
-- ingester + S3. ADDITIVE ONLY: makes case_id nullable (veteran-level + unmatched emails), adds
-- veteran linkage, the Message-ID idempotent-dedupe key, raw/attachments S3 pointers, and the
-- sort/lookup indexes the chart + claim tabs query on. Every statement is idempotent — safe for
-- `prisma migrate deploy`. The existing case_id FK (ON DELETE CASCADE) and the partial delivery
-- unique index are untouched (a nullable FK column simply doesn't constrain NULL rows).

-- case_id nullable: chart-level email (caseId NULL) + unmatched email (caseId AND veteran_id NULL).
ALTER TABLE "emails" ALTER COLUMN "case_id" DROP NOT NULL;

ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "veteran_id"       TEXT;
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "mailbox"          TEXT;
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "message_id"       TEXT;
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "snippet"          TEXT;
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "raw_s3_key"       TEXT;
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "attachments_json" JSONB;
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "received_at"      TIMESTAMPTZ(6);

-- One row per RFC Message-ID (idempotent ingest; first monitored mailbox wins). Multiple NULLs are
-- allowed by a btree unique, so outbound stub rows (no Message-ID) coexist. Name matches Prisma's
-- @unique convention so `migrate deploy` sees the schema and DB agree.
CREATE UNIQUE INDEX IF NOT EXISTS "emails_message_id_key" ON "emails" ("message_id");

-- Veteran linkage. ON DELETE SET NULL preserves the email log if a veteran is ever purged.
DO $$ BEGIN
  ALTER TABLE "emails" ADD CONSTRAINT "emails_veteran_id_fkey"
    FOREIGN KEY ("veteran_id") REFERENCES "veterans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Compound indexes matching the tab queries (newest-first by effective timestamp).
CREATE INDEX IF NOT EXISTS "emails_veteran_received_idx" ON "emails" ("veteran_id", "received_at");
CREATE INDEX IF NOT EXISTS "emails_case_received_idx"    ON "emails" ("case_id", "received_at");
