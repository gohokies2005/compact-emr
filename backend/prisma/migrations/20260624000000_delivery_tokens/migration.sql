-- Password-protected PDF delivery portal (Ryan 2026-06-06). On a confirmed Stripe payment the EMR mints
-- a token + unique password; the veteran unlocks an online copy (presigned S3 URL) rather than getting
-- a PHI attachment in email. Additive, standalone table.
CREATE TABLE IF NOT EXISTS "delivery_tokens" (
  "id"               TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "case_id"          TEXT NOT NULL,
  "token"            TEXT NOT NULL,
  "password_hash"    TEXT NOT NULL,
  "letter_version"   INTEGER NOT NULL,
  "pdf_s3_key"       TEXT NOT NULL,
  "expires_at"       TIMESTAMPTZ(6) NOT NULL,
  "download_count"   INTEGER NOT NULL DEFAULT 0,
  "last_accessed_at" TIMESTAMPTZ(6),
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "delivery_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_tokens_token_key" ON "delivery_tokens" ("token");
CREATE INDEX IF NOT EXISTS "delivery_tokens_case_id_idx" ON "delivery_tokens" ("case_id");
DO $$ BEGIN
  ALTER TABLE "delivery_tokens" ADD CONSTRAINT "delivery_tokens_case_id_fkey"
    FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
