-- Gate-2 pre-draft dx/event verification: new case statuses (RN-facing parking states) + a new
-- DraftJob terminal-for-the-watcher state. ALTER TYPE ... ADD VALUE must run outside a transaction
-- and in its own migration (cannot add an enum value and use it in the same migration).
ALTER TYPE "case_status" ADD VALUE IF NOT EXISTS 'needs_rn_decision';
ALTER TYPE "case_status" ADD VALUE IF NOT EXISTS 'needs_records';
-- 'halted' is the watcher-immunity value: the stuck-job-watcher scans state IN ('queued','running'),
-- so a halted job is never resurrected. NOT reusing 'failed' (collides with late-artifact recovery).
ALTER TYPE "draft_job_state" ADD VALUE IF NOT EXISTS 'halted';
