-- Add 'auto_skipped' to the file_read_status terminal-status CHECK constraint.
--
-- ROOT-CAUSE FIX for the 2026-06-17 OCR Sonnet cost runaway. The app added 'auto_skipped' as a
-- terminal read status (backend/src/services/chart-build-state.ts TERMINAL_READ_STATUSES, 2026-06-14)
-- — emitted by the /pages writer when a scanned page reads as genuinely empty — but this CHECK
-- constraint (migration 20260526040000) was never updated to allow it. So the auto_skipped INSERT
-- failed with Postgres 23514 -> the whole /pages txn rolled back -> HTTP 500 -> the document never
-- reached a terminal read-status -> the stuck-doc-watcher re-fired OCR on it every cycle, re-running
-- Claude Sonnet vision on every page (~$231 burned). Aligning the constraint with the code's
-- TERMINAL_READ_STATUSES set makes the write succeed -> the doc reaches terminal -> the loop ends at
-- the root.
--
-- Safe: the new set is a SUPERSET of the old (read / manual_summary_required / manual_summary_provided
-- + auto_skipped), so no existing row can violate it (and none could ever have held 'auto_skipped',
-- which is exactly why it was failing).

ALTER TABLE "file_read_status" DROP CONSTRAINT "file_read_status_terminal_check";

ALTER TABLE "file_read_status" ADD CONSTRAINT "file_read_status_terminal_check"
  CHECK ("terminal_status" IN ('read', 'manual_summary_required', 'manual_summary_provided', 'auto_skipped'));
