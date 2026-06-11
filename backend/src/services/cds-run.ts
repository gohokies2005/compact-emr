/**
 * The CDS evaluate-and-persist core, extracted from POST /cases/:id/cds (keystone pkg 5) so the
 * RN-triggered route and the post-merge restamp hook (pkg 4c) run ONE copy. The route stamps
 * cdsStampSource='manual' (an explicit staff action); the hook stamps 'derived' (machine refresh).
 *
 * Callers own the CDS_ENABLED flag check and any role gating — this service assumes the caller
 * decided the run should happen.
 */

import { evaluateCdsMulti } from './cdsEngine.js';
import type { AppDb, CaseRecord, VeteranDetailRecord } from './db-types.js';

export type CdsStampSource = 'manual' | 'derived';

export interface CdsRunRationale {
  readonly verdict: string;
  readonly oddsPct: number | null;
  readonly driverCondition: string | null;
  readonly perCondition: readonly unknown[];
  readonly [key: string]: unknown;
}

function names(rows: readonly unknown[] | undefined, field: 'condition' | 'problem'): string[] {
  return (rows ?? [])
    .map((row) => String((row as Record<string, unknown>)[field] ?? '').trim())
    .filter((s) => s.length > 0);
}

/**
 * Evaluate CDS for the case (clustered-claim aware) and persist verdict/odds/rationale + the
 * provenance stamp in one transaction, with the activity-log row. Returns the enriched rationale
 * (the route's response body), or null when the case doesn't exist (caller 404s / skips).
 */
export async function evaluateAndPersistCds(
  db: AppDb,
  caseId: string,
  opts: { readonly actorUserId: string; readonly stampSource: CdsStampSource },
): Promise<CdsRunRationale | null> {
  const caseRow = (await db.case.findFirst({
    where: { id: caseId },
    select: { id: true, veteranId: true, claimedCondition: true, claimedConditions: true, claimType: true, framingChoice: true, upstreamScCondition: true },
  })) as Pick<CaseRecord, 'id' | 'veteranId' | 'claimedCondition' | 'claimedConditions' | 'claimType' | 'framingChoice' | 'upstreamScCondition'> | null;
  if (caseRow === null) return null;

  const veteran = (await db.veteran.findUnique({
    where: { id: caseRow.veteranId },
    include: { scConditions: true, activeProblems: true },
  })) as VeteranDetailRecord | null;

  // Clustered-claim support: evaluate EVERY claimed condition and take the best-odds overall.
  // Fall back to the single primary if claimedConditions is empty (legacy / single-condition).
  const claimedConditions = caseRow.claimedConditions.length > 0
    ? caseRow.claimedConditions
    : [caseRow.claimedCondition];

  const multi = evaluateCdsMulti({
    claimedConditions,
    claimType: caseRow.claimType,
    framingChoice: caseRow.framingChoice,
    upstreamScCondition: caseRow.upstreamScCondition,
    serviceConnectedConditions: names(veteran?.scConditions, 'condition'),
    activeProblems: names(veteran?.activeProblems, 'problem'),
  });

  const result = multi.overall;
  // Persist the OVERALL verdict/odds exactly as before; enrich cdsRationale with the
  // per-condition breakdown + driver so the UI can show each condition's verdict.
  const rationale = {
    ...result,
    driverCondition: multi.driverCondition,
    perCondition: multi.perCondition,
  };

  await db.$transaction(async (tx) => {
    await tx.case.update({
      where: { id: caseId },
      data: {
        cdsVerdict: result.verdict,
        cdsOddsPct: result.oddsPct === null ? null : Math.round(result.oddsPct),
        cdsRationale: rationale,
        cdsStampSource: opts.stampSource,
      } as never,
    });
    await tx.activityLog.create({
      data: { actorUserId: opts.actorUserId, action: 'cds_evaluated', caseId, veteranId: caseRow.veteranId, detailsJson: { caseId, verdict: result.verdict, oddsPct: result.oddsPct, driverCondition: multi.driverCondition, conditionCount: claimedConditions.length } },
    });
  });

  return rationale as unknown as CdsRunRationale;
}
