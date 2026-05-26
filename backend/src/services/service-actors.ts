/**
 * F6a — service-actor identity constants.
 *
 * Activity log writes from non-Cognito service principals (workers, watchers, internal
 * service code) use a `service:<name>` actorUserId so audit trails can distinguish them
 * from human users. Previously these strings were scattered free-form across files
 * (`'service:worker'`, `'service:drafter'`, etc.) — easy to typo, hard to grep, hard to
 * extend.
 *
 * Codify here so:
 *   - One source of truth for every service actor ID
 *   - TypeScript catches typos at compile time
 *   - Future grep'ing for "who writes activity logs" is trivial
 */
export const SERVICE_ACTORS = {
  /** Generic OCR / Doctor Pack assembler / other internal-worker callbacks. */
  WORKER: 'service:worker',
  /** Drafter Fargate task posting progress + complete to /internal/drafter/*. */
  DRAFTER: 'service:drafter',
  /** Scheduled Lambda that sweeps stuck DraftJob rows after heartbeat goes stale. */
  STUCK_JOB_WATCHER: 'service:stuck-job-watcher',
} as const;

export type ServiceActor = (typeof SERVICE_ACTORS)[keyof typeof SERVICE_ACTORS];
