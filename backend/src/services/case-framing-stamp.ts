// IMPURE adapter for the SSOT caseFraming producer (build-plan §5.2, D4) — the ONLY place
// bundle.caseFraming is stamped. Both drafter routes call this at route level:
//   POST /api/v1/cases/:id/draft      → stampCaseFraming(db, caseId, bundle, { persist: true })
//   GET  /cases/:id/drafter-export    → stampCaseFraming(db, caseId, bundle, { persist: false })
// buildDrafterBundle itself stays pure-read (its documented contract) — the stamp happens on the
// route's copy, after the builder returns and before the S3 write.
//
// persist: true additionally writes the derived framingChoice/upstreamScCondition onto the Case row
// ONLY-WHEN-NULL — an RN-set value (case-validation.ts PATCH path) is never clobbered. The export GET
// stamps without persisting so a debug export never mutates the case (GET stays side-effect-free).

import {
  deriveCaseFraming,
  type CaseFraming,
  type ProducerClaimType,
} from './case-framing.js';
import type { DrafterBundle } from './drafter-bundle.js';
import type { AppDb } from './db-types.js';

interface CaseRowForFraming {
  readonly id: string;
  readonly claimedCondition: string;
  readonly claimType: string;
  readonly framingChoice: string | null;
  readonly upstreamScCondition: string | null;
  readonly veteranStatement: string | null;
  readonly veteran: { readonly scConditions: ReadonlyArray<{ condition: string; ratingPct: number | null; status: string }> } | null;
}

/**
 * Persist the derived theory onto the Case row, mirroring the backfill endpoint's write semantics
 * (internal-worker.ts: NULL fields only, never overwriting an RN edit). The contract's
 * `framingChoice` FIELD is the RN-mirror (null when derived) — what persists into the Case
 * framingChoice COLUMN is the derived THEORY (cf.framing), exactly as internal-worker.ts:766
 * writes 'secondary'/'aggravation'. A bare derived 'direct' is not persisted (the column stays
 * null = unframed; internal-worker only writes 'direct' when clearing a garbage anchor, which the
 * backfill endpoint continues to own). 'undetermined' is never persisted — that's an explicit
 * "could not decide", not a value.
 */
async function persistFramingWhenNull(db: AppDb, row: CaseRowForFraming, cf: CaseFraming): Promise<void> {
  const data: Record<string, unknown> = {};
  if (
    row.framingChoice === null
    && cf.source !== 'rn_set'
    && (cf.framing === 'secondary' || cf.framing === 'aggravation')
  ) {
    data['framingChoice'] = cf.framing;
  }
  if (row.upstreamScCondition === null && cf.upstreamScCondition !== null) {
    data['upstreamScCondition'] = cf.upstreamScCondition;
  }
  if (Object.keys(data).length > 0) {
    await db.case.update({ where: { id: row.id }, data: data as never });
  }
}

/**
 * Derive caseFraming for the case and return a copy of the bundle with it stamped. Fail-open by
 * construction: if the case row vanished (raced delete), the bundle is returned UNSTAMPED — every
 * consumer treats absence as "use legacy derivation", so a missing stamp can never break a draft.
 */
export async function stampCaseFraming(
  db: AppDb,
  caseId: string,
  bundle: DrafterBundle,
  opts: { readonly persist: boolean },
): Promise<DrafterBundle> {
  const c = await db.case.findFirst({
    where: { id: caseId },
    select: {
      id: true,
      claimedCondition: true,
      claimType: true,
      framingChoice: true,
      upstreamScCondition: true,
      veteranStatement: true,
      veteran: { select: { scConditions: { select: { condition: true, ratingPct: true, status: true } } } },
    },
  }) as unknown as CaseRowForFraming | null;
  if (c === null) return bundle;

  const caseFraming = deriveCaseFraming(
    {
      claimedCondition: c.claimedCondition,
      claimType: c.claimType as ProducerClaimType,
      framingChoice: c.framingChoice,
      upstreamScCondition: c.upstreamScCondition,
      veteranStatement: c.veteranStatement,
    },
    (c.veteran?.scConditions ?? []).map((s) => ({
      condition: s.condition,
      ratingPct: s.ratingPct,
      status: String(s.status),
    })),
  );

  if (opts.persist) {
    await persistFramingWhenNull(db, c, caseFraming);
  }
  return { ...bundle, caseFraming };
}
