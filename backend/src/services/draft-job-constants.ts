/**
 * The EXACT errorMessage the stuck-job-watcher stamps on a DraftJob it reaps for staleness.
 *
 * drafter.ts POST /complete keys its RESURRECT path on this exact string — NOT on failureClass
 * ('system'), because the RN-cancel path uses the identical failureClass and must NOT be resurrected.
 * Sharing the constant keeps the watcher and the route in lockstep (a typo on either side would
 * silently disable resurrect). See the 2026-06-06 "reaped queued letters" incident.
 */
export const DRAFT_JOB_WATCHER_SWEPT_MESSAGE = 'Heartbeat stale; Fargate task assumed crashed. Watcher swept.';
