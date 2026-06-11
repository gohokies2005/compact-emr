/**
 * Keystone 4c — the post-merge restamp hook. When a chart-extract merge WRITES rows (autofill on,
 * written > 0), the framing/viability/cds stamps computed at an earlier draft may be stale (new SC
 * conditions just landed). Re-derive + restamp each group under the pkg-5 provenance rule:
 *
 *   - source === 'derived'  → machine-written → MAY be overwritten by a fresh derivation.
 *   - source === 'manual'   → RN/staff-set    → NEVER auto-overwritten.
 *   - source === null       → legacy/unknown  → non-null values NEVER auto-overwritten
 *                              (conservative: presumed possibly RN-set); null columns may still
 *                              FILL via the same only-when-null contract the draft-time stamp uses.
 *
 * Called from the extracted-chart-items completion path (internal-worker.ts) in a log-only
 * try/catch AFTER applyExtractionMerge returns — a restamp failure must never fail the worker
 * callback or the merge (which already committed). Each group is also isolated here so one
 * group's failure can't starve the others. Loud in logs, silent to the caller.
 */

import { refreshDerivedFraming, type StampRefreshOutcome } from './case-framing-stamp.js';
import { refreshDerivedViability } from './case-viability-stamp.js';
import { evaluateAndPersistCds } from './cds-run.js';
import { SERVICE_ACTORS } from './service-actors.js';
import type { AppDb } from './db-types.js';

export interface StampRefreshSummary {
  readonly framing: StampRefreshOutcome | 'failed';
  readonly viability: StampRefreshOutcome | 'failed';
  readonly cds: StampRefreshOutcome | 'failed';
}

function logGroupFailure(group: string, caseId: string, err: unknown): void {
  console.error(JSON.stringify({
    msg: `post-merge restamp: ${group} refresh failed (merge unaffected)`,
    caseId,
    error: err instanceof Error ? err.message : String(err),
  }));
}

/**
 * CDS refresh: gated on CDS_ENABLED (the engine is unwired by default — the hook must never be
 * the thing that re-activates it). May run when the verdict is machine-stamped ('derived') OR has
 * never been computed at all (cdsVerdict 'not_yet_run' with null source — writing a first value
 * into an empty slot is a fill, not an overwrite). An RN-triggered run ('manual') is immutable.
 */
async function refreshDerivedCds(db: AppDb, caseId: string): Promise<StampRefreshOutcome> {
  if (process.env['CDS_ENABLED'] !== 'on') return 'skipped';
  const row = (await db.case.findFirst({
    where: { id: caseId },
    select: { cdsVerdict: true, cdsStampSource: true } as never,
  })) as unknown as { cdsVerdict: string; cdsStampSource: string | null } | null;
  if (row === null) return 'skipped'; // raced delete — fail open
  const mayWrite = row.cdsStampSource === 'derived'
    || (row.cdsStampSource === null && row.cdsVerdict === 'not_yet_run');
  if (!mayWrite) return 'skipped';
  const rationale = await evaluateAndPersistCds(db, caseId, { actorUserId: SERVICE_ACTORS.WORKER, stampSource: 'derived' });
  if (rationale === null) return 'skipped';
  return row.cdsStampSource === 'derived' ? 'overwritten' : 'filled';
}

/** Refresh all three stamp groups for the case. Never throws — per-group failures log + report. */
export async function refreshDerivedStamps(db: AppDb, caseId: string): Promise<StampRefreshSummary> {
  let framing: StampRefreshOutcome | 'failed';
  let viability: StampRefreshOutcome | 'failed';
  let cds: StampRefreshOutcome | 'failed';
  try { framing = await refreshDerivedFraming(db, caseId); } catch (err) { logGroupFailure('framing', caseId, err); framing = 'failed'; }
  try { viability = await refreshDerivedViability(db, caseId); } catch (err) { logGroupFailure('viability', caseId, err); viability = 'failed'; }
  try { cds = await refreshDerivedCds(db, caseId); } catch (err) { logGroupFailure('cds', caseId, err); cds = 'failed'; }
  return { framing, viability, cds };
}
