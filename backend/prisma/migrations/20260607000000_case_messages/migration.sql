-- Per-case RN<->physician messaging thread (2026-05-30). Distinct from veteran-scoped chart_notes:
-- case-scoped, with read-state. PHI expected in body (clinical communication). FK cascade with case.
CREATE TABLE IF NOT EXISTS "case_messages" (
  "id" TEXT NOT NULL,
  "case_id" TEXT NOT NULL,
  "sender_sub" TEXT NOT NULL,
  "sender_role" VARCHAR(16) NOT NULL,
  "body" TEXT NOT NULL,
  "read_at" TIMESTAMPTZ(6),
  "read_by_sub" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "case_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "case_messages_case_id_idx" ON "case_messages" ("case_id");
CREATE INDEX IF NOT EXISTS "case_messages_case_id_created_at_idx" ON "case_messages" ("case_id", "created_at");
CREATE INDEX IF NOT EXISTS "case_messages_case_id_read_at_idx" ON "case_messages" ("case_id", "read_at");

DO $$ BEGIN
  ALTER TABLE "case_messages" ADD CONSTRAINT "case_messages_case_id_fkey"
    FOREIGN KEY ("case_id") REFERENCES "cases" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
