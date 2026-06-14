import type { AppDb } from './db-types.js';

/**
 * Physician/admin override of the chart-readiness machine-read gate (CLM-4DACAF4A80, 2026-06-14).
 *
 * The chart-readiness gate HALTS sign-off/approve/finalize until every uploaded file is either
 * machine-read or carries an RN manual summary. That is the right default — but it has no escape
 * hatch, and the owner (physician+admin) could be stuck unable to ship a real $500 letter when a
 * file simply won't OCR, even though they have personally read it. Per the project HARD RULE
 * "everything must be overridable", the SIGN-OFF carries an explicit, audited override:
 *
 *   - ONLY a physician or admin (the roles that can sign) may override.
 *   - A non-empty, trimmed reason is REQUIRED (the legal basis is captured on the SignOff row).
 *   - The override is scoped to the chart-readiness MACHINE-READ gate ONLY. The separate
 *     affirmative-attestation gate (all five sign-off questions must be "Yes") is NOT weakened —
 *     the physician still attests "I reviewed all uploaded records and the chart" = Yes, which is
 *     the legal predicate for the override itself.
 *
 * Once a sign-off with chartReadinessOverridden=true exists for a case, the downstream approve +
 * finalize-import gates honor it (the physician already acknowledged the unread files at sign-off);
 * they do NOT each re-prompt. This helper is the single lookup the approve/finalize routes share.
 */

export interface ChartReadinessOverrideRow {
  readonly id: string;
  readonly chartReadinessOverrideReason: string | null;
}

/**
 * Return the most-recent SignOff for the case that overrode the chart-readiness gate, or null.
 * Newest-first by signedAt so the active sign-off's override governs.
 */
export async function findChartReadinessOverride(
  db: AppDb,
  caseId: string,
): Promise<ChartReadinessOverrideRow | null> {
  const row = await (db as unknown as {
    signOff: {
      findFirst: (a: {
        where: { caseId: string; chartReadinessOverridden: true };
        orderBy: { signedAt: 'desc' };
        select: { id: true; chartReadinessOverrideReason: true };
      }) => Promise<ChartReadinessOverrideRow | null>;
    };
  }).signOff.findFirst({
    where: { caseId, chartReadinessOverridden: true },
    orderBy: { signedAt: 'desc' },
    select: { id: true, chartReadinessOverrideReason: true },
  });
  return row ?? null;
}

/**
 * Validate an inbound override request. Returns the trimmed reason when the override is BOTH
 * requested AND authorized (flag true + non-empty reason + role physician|admin); otherwise null
 * (the caller keeps the gate closed). Role is the already-resolved single effective role.
 *
 * NOTE: an override flag with a missing/blank reason returns null INTENTIONALLY — the caller then
 * emits the descriptive 409 (the physician sees the gate + must supply a reason), so a blank-reason
 * override can never slip through.
 */
export function resolveOverrideReason(
  overrideRequested: boolean | undefined,
  reason: string | undefined,
  role: string,
): string | null {
  if (overrideRequested !== true) return null;
  if (role !== 'physician' && role !== 'admin') return null;
  if (typeof reason !== 'string') return null;
  const trimmed = reason.trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}
