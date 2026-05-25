-- Phase 5: physician sign-off records for case finalization.
-- One row per sign-off event; re-signing creates a new row. Latest by signedAt is the active sign-off.

CREATE TABLE IF NOT EXISTS "sign_offs" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "case_id"       VARCHAR NOT NULL,
  "physician_id"  VARCHAR NOT NULL,
  "signed_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "answers_json"  JSONB NOT NULL,
  "notes"         TEXT,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "version"       INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "sign_offs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sign_offs_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE,
  CONSTRAINT "sign_offs_physician_id_fkey" FOREIGN KEY ("physician_id") REFERENCES "physicians"("id") ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS "sign_offs_case_id_idx" ON "sign_offs"("case_id");
CREATE INDEX IF NOT EXISTS "sign_offs_physician_id_idx" ON "sign_offs"("physician_id");
CREATE INDEX IF NOT EXISTS "sign_offs_signed_at_idx" ON "sign_offs"("signed_at");
