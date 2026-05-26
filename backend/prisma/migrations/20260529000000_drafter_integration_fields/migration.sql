-- Drafter integration: compact-EMR ↔ FRN drafter wrapper contract.
-- See docs/COMPACT_EMR_BRIEF.md and the spine handoff for shape rationale.
--
-- Case  — terminal-state snapshot mirrored from v<N>_qa_grade.json + final manifest.
-- Triage filter for physician inbox is (run_complete = TRUE AND ship_recommendation = 'ship').
-- Anything else (paused / needs_one_thing / revise) stays in the ops queue.
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "probative_score" INTEGER;
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "grade" VARCHAR(8);
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "ship_recommendation" VARCHAR(8);
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "operator_state" VARCHAR(24);
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "run_complete" BOOLEAN;

CREATE INDEX IF NOT EXISTS "cases_physician_inbox_idx"
  ON "cases" ("assigned_physician_id", "run_complete", "ship_recommendation");

-- DraftJob — the wrapper running the FRN Node drafter posts progress here every phase
-- transition (manifest_snapshot updates) and the final on terminal (grade_sidecar_json +
-- artifact_*_s3_key). Fields mirror pipeline_manifest.json + v<N>_qa_grade.json shapes
-- exactly. Strategy_override + parent_version support the RN redraft-with-strategy flow.
-- Worker_id + last_heartbeat_at support stuck-job detection.
ALTER TABLE "draft_jobs" ADD COLUMN IF NOT EXISTS "manifest_snapshot" JSONB;
ALTER TABLE "draft_jobs" ADD COLUMN IF NOT EXISTS "current_phase" VARCHAR(40);
ALTER TABLE "draft_jobs" ADD COLUMN IF NOT EXISTS "next_retry_in_s" INTEGER;
ALTER TABLE "draft_jobs" ADD COLUMN IF NOT EXISTS "failure_class" VARCHAR(20);
ALTER TABLE "draft_jobs" ADD COLUMN IF NOT EXISTS "grade_sidecar_json" JSONB;
ALTER TABLE "draft_jobs" ADD COLUMN IF NOT EXISTS "artifact_pdf_s3_key" VARCHAR(500);
ALTER TABLE "draft_jobs" ADD COLUMN IF NOT EXISTS "artifact_txt_s3_key" VARCHAR(500);
ALTER TABLE "draft_jobs" ADD COLUMN IF NOT EXISTS "artifact_docx_s3_key" VARCHAR(500);
ALTER TABLE "draft_jobs" ADD COLUMN IF NOT EXISTS "strategy_override" TEXT;
ALTER TABLE "draft_jobs" ADD COLUMN IF NOT EXISTS "parent_version" INTEGER;
ALTER TABLE "draft_jobs" ADD COLUMN IF NOT EXISTS "worker_id" VARCHAR(80);
ALTER TABLE "draft_jobs" ADD COLUMN IF NOT EXISTS "last_heartbeat_at" TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "draft_jobs_last_heartbeat_at_idx"
  ON "draft_jobs" ("last_heartbeat_at");

-- Architect QA F3: prevent concurrent POST /api/v1/cases/:id/draft requests from creating
-- two in-flight DraftJob rows for the same case. The route's pre-flight findFirst+create
-- has a sub-millisecond race window; this partial unique index makes the second insert
-- fail at the DB level. Only enforces uniqueness when state is in-flight — historical
-- 'done' / 'failed' rows for the same case are unaffected. (Prisma's @@index syntax does
-- not support partial indexes, so this lives only in raw SQL; intentional.)
CREATE UNIQUE INDEX IF NOT EXISTS "draft_jobs_case_id_in_flight_uq"
  ON "draft_jobs" ("case_id")
  WHERE "state" IN ('queued', 'running');
