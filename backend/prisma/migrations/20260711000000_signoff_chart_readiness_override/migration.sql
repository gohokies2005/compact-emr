-- Chart-readiness machine-read gate override (CLM-4DACAF4A80, 2026-06-14). A physician/admin who
-- has personally reviewed records that wouldn't machine-read can sign off despite the chart-
-- readiness gate, capturing an audited override on the sign-off. ADDITIVE only — defaulted/nullable,
-- NO backfill: existing sign-offs read as chart_readiness_overridden=false (the gate's prior
-- behavior, unchanged). Scoped to the machine-read gate ONLY; the affirmative-attestation gate
-- (all five answers "Yes") is untouched.
--
-- IF NOT EXISTS keeps the migration idempotent on re-run (same convention as the prior migrations).
ALTER TABLE "sign_offs" ADD COLUMN IF NOT EXISTS "chart_readiness_overridden" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "sign_offs" ADD COLUMN IF NOT EXISTS "chart_readiness_override_reason" TEXT;
ALTER TABLE "sign_offs" ADD COLUMN IF NOT EXISTS "chart_readiness_override_files" JSONB;
