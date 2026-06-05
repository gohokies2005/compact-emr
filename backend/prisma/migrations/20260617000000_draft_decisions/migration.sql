-- Gate-1 + Gate-2 decision/override log. Shown in the chart (case-page panel), never log-only.
CREATE TABLE IF NOT EXISTS "draft_decisions" (
  "id"            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "case_id"       TEXT NOT NULL REFERENCES "cases"("id") ON DELETE CASCADE,
  "draft_attempt" INTEGER NOT NULL,
  "gate"          SMALLINT NOT NULL,        -- 1 = checklist, 2 = ai_verification
  "item"          VARCHAR(40) NOT NULL,     -- dx_present | in_service_event | sc_conditions | prior_denial | nexus_switch
  "decision"      VARCHAR(20) NOT NULL,     -- yes | no | not_applicable | override | switch_accept | switch_decline | proceed | pause
  "reason"        TEXT,                     -- required for override/decline/switch_decline; else null
  "rn_user"       TEXT NOT NULL,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "draft_decisions_case_id_idx" ON "draft_decisions"("case_id");
CREATE INDEX IF NOT EXISTS "draft_decisions_case_attempt_idx" ON "draft_decisions"("case_id","draft_attempt");

-- Gate-2 halt payload (plain-English reason + switchProposal + evidence) the RN UI renders.
ALTER TABLE "draft_jobs" ADD COLUMN IF NOT EXISTS "halt_payload_json" JSONB;
