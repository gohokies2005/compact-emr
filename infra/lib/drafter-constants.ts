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
 * threshold move together. (Above 7 also needs an AWS Fargate vCPU quota increase — see
 * drafter-stack.ts.)
 */
export const DRAFTER_MAX_CONCURRENCY = 6;
