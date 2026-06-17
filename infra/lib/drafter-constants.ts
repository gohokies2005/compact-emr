/**
 * SINGLE SOURCE OF TRUTH for the drafter concurrency cap.
 *
 * - DrafterStack uses this as the Fargate autoscaler `maxCapacity` (the real ceiling on how many
 *   drafter tasks can run at once).
 * - ApiStack injects this as the `DRAFTER_MAX_CONCURRENCY` env var on the API Lambda so the
 *   draft-concurrency endpoint can tell a queued draft how full the drafter is — WITHOUT
 *   hardcoding the number a second time (which would silently drift from the autoscaler).
 *
 * If you raise the cap, raise it HERE and both the infra ceiling and the UI's "queue is full"
 * threshold move together. The autoscaler's scalingSteps are DERIVED from this value
 * (drafter-stack.ts), so raising it can never silently top out below the cap again.
 *
 * Real-world ceilings that must rise IN LOCKSTEP to actually run this many at once (audit 2026-06-17,
 * memory project_drafter_concurrency_scaling_to_25): (1) Fargate On-Demand vCPU quota L-3032A538 —
 * 25 × 4 vCPU = 100 (requested 30→100); (2) account Lambda concurrent-executions L-B99A9384 — the
 * drafter callbacks all hit the one API Lambda (requested 10→1000); (3) Anthropic Opus tier.
 */
export const DRAFTER_MAX_CONCURRENCY = 25;
