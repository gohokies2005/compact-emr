-- Phase 5: clarification queue. Physician (or ops_staff on behalf) raises a clarification
-- question against a case; later resolved with a free-text resolution + status flip.

CREATE TABLE IF NOT EXISTS "clarifications" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "case_id"      VARCHAR NOT NULL,
  "raised_by"    VARCHAR NOT NULL,
  "audience"     VARCHAR(20) NOT NULL,
  "question"     TEXT NOT NULL,
  "status"       VARCHAR(20) NOT NULL DEFAULT 'open',
  "resolution"   TEXT,
  "resolved_by"  VARCHAR,
  "resolved_at"  TIMESTAMPTZ(6),
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "version"      INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "clarifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "clarifications_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE,
  CONSTRAINT "clarifications_status_check" CHECK ("status" IN ('open', 'resolved', 'dismissed')),
  CONSTRAINT "clarifications_audience_check" CHECK ("audience" IN ('physician', 'ops_staff', 'veteran'))
);

CREATE INDEX IF NOT EXISTS "clarifications_case_id_idx" ON "clarifications"("case_id");
CREATE INDEX IF NOT EXISTS "clarifications_status_idx" ON "clarifications"("status");
CREATE INDEX IF NOT EXISTS "clarifications_audience_idx" ON "clarifications"("audience");
