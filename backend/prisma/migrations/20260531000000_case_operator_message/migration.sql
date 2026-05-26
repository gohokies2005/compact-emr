-- G8 (architect audit): RN-facing operator message field on Case.
-- The drafter's summarizeForOperator() emits {state, message}; we store the message verbatim
-- so the RN/physician UI renders it without rebuilding from state. Also populated by the
-- stuck-job watcher when it sweeps stale jobs ("We had a problem and gave up after 10
-- minutes — click Retry") instead of leaving the RN to interpret "system error".
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "operator_message" TEXT;
