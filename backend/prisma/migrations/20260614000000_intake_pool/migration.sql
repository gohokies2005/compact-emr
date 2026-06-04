-- Jotform intake pool (intake triage). One Jotform submission = one Intake row. See
-- docs/JOTFORM_INTAKE_INGESTION_SPEC.md. Additive — no existing table is touched.
CREATE TABLE IF NOT EXISTS "intakes" (
  "id" TEXT NOT NULL,
  "jotform_form_id" VARCHAR(40) NOT NULL,
  "jotform_submission_id" VARCHAR(40) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "submitted_name" TEXT,
  "submitted_email" TEXT,
  "submitted_phone" TEXT,
  "submitted_state" VARCHAR(2),
  "submitted_condition" TEXT,
  "raw_answers_json" JSONB,
  "file_manifest_json" JSONB,
  "submitted_at" TIMESTAMPTZ(6),
  "webhook_received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "assigned_veteran_id" TEXT,
  "assigned_case_id" TEXT,
  "assigned_at" TIMESTAMPTZ(6),
  "assigned_by" TEXT,
  "dismissed_reason" TEXT,
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "error_message" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "intakes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "intakes_submission_uq" ON "intakes"("jotform_submission_id");
CREATE INDEX IF NOT EXISTS "intakes_status_created_at_idx" ON "intakes"("status", "created_at");
CREATE INDEX IF NOT EXISTS "intakes_jotform_form_id_idx" ON "intakes"("jotform_form_id");
