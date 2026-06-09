/**
 * The EXACT errorMessage the stuck-job-watcher stamps on a DraftJob it reaps for staleness.
 *
 * drafter.ts POST /complete keys its RESURRECT path on this exact string — NOT on failureClass
 * ('system'), because the RN-cancel path uses the identical failureClass and must NOT be resurrected.
 * Sharing the constant keeps the watcher and the route in lockstep (a typo on either side would
 * silently disable resurrect). See the 2026-06-06 "reaped queued letters" incident.
 */
export const DRAFT_JOB_WATCHER_SWEPT_MESSAGE = 'Heartbeat stale; Fargate task assumed crashed. Watcher swept.';

/**
 * SINGLE SOURCE OF TRUTH for the two in-flight DraftJob time thresholds. Shared by the
 * stuck-job-watcher (which REAPS stale jobs) and the draft-concurrency count (which EXCLUDES
 * the same stale jobs from runningSlots). Both must agree on what "stale" means: if the count
 * treated a zombie as a live slot, a real queued draft would show "queue is full" forever even
 * though the watcher already considers that slot dead. Defining them once keeps the reaper and
 * the counter in lockstep — change the budget here and both move together.
 */

/** A RUNNING job that hasn't heartbeated within this window is assumed crashed (worker dead). */
export const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 min

/**
 * ABSOLUTE in-flight lifetime cap. ANY job (queued OR running) older than this is dead regardless
 * of state/heartbeat — the longest legit real run is ~15.5 min, so 60 min is far past any healthy
 * job. Catches a 'running' job that NEVER heartbeated (NULL lastHeartbeatAt evades the stale clause).
 */
export const MAX_LIFETIME_MS = 60 * 60 * 1000; // 60 min
