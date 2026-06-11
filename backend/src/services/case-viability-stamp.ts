// IMPURE adapter for the SSOT caseViability producer (build plan §3.2) — the ONLY place
// bundle.caseViability is stamped, mirroring case-framing-stamp.ts. Both drafter routes call this
// at route level, immediately AFTER stampCaseFraming and behind EMR_CASE_VIABILITY_ENABLED:
//   POST /api/v1/cases/:id/draft      → stampCaseViability(db, caseId, bundle, { persist: true })
//   GET  /cases/:id/drafter-export    → stampCaseViability(db, caseId, bundle, { persist: false })
//
// deriveCaseViabilityForCase REUSES deriveCaseFramingForCase — ONE derivation builds the
// grantedScAnchors that feed BOTH blocks (design §3d; no second SC re-filter, the bug class the
// SSOT eliminates). The CaseViabilityCard's GET endpoint calls the same function LIVE (G10) —
// request-time reads and the draft-time stamp can differ if the Case row changed in between; that
// is BY DESIGN (stamp = value at draft time).
//
// persist: true additionally writes caseViabilityBand/caseViabilityAnchor onto the Case row
// ONLY-WHEN-NULL (same contract as persistFramingWhenNull — an RN-set value is never clobbered).
// The export GET stamps without persisting (GET stays side-effect-free).
//
// Fail-open EVERYWHERE: missing case row, vendor-module load failure, or any unexpected throw →
// the bundle is returned UNSTAMPED / the live read returns null. Absence = consumers use their
// legacy behavior; a viability problem can never break a draft (design §5.3).

import { deriveCaseViability, type CaseViability } from './case-viability.js';
import { deriveCaseFramingForCase } from './case-framing-stamp.js';
import type { DrafterBundle } from './drafter-bundle.js';
import type { AppDb } from './db-types.js';

/**
 * Flag gate (build plan §3.5): ships DARK. Read at request time so a revert is flag→false with no
 * image rebuild. SEPARATE from the drafter's ANCHOR_MECHANISM_GATE — the EMR producer + panel
 * activate on their own smoke + Playwright, never waiting on the drafter flag.
 */
export function caseViabilityEnabled(): boolean {
  return process.env['EMR_CASE_VIABILITY_ENABLED'] === 'true';
}

/**
 * THE shared Case-row → caseViability derivation (one mapping for the stamp AND the request-time
 * card read, mirroring deriveCaseFramingForCase's role). Returns null when the case row doesn't
 * exist or the derivation fails for any reason; callers fail open on null.
 */
export async function deriveCaseViabilityForCase(db: AppDb, caseId: string): Promise<CaseViability | null> {
  try {
    const cf = await deriveCaseFramingForCase(db, caseId); // REUSE — one derivation feeds both
    if (cf === null) return null; // fail open (raced delete)
    const c = (await db.case.findFirst({
      where: { id: caseId },
      select: { claimedCondition: true },
    })) as { claimedCondition: string } | null;
    if (c === null) return null;
    // chartFacts omitted (G9: no EMR chart-fact normalization yet) → info_light, conservative.
    return deriveCaseViability(c.claimedCondition, cf.grantedScAnchors);
  } catch (err) {
    // Loud in logs, silent to the caller — a vendor-load or DB hiccup must never break a draft.
    console.warn(JSON.stringify({
      msg: 'case-viability: derivation failed open',
      caseId,
      error: err instanceof Error ? err.message : String(err),
    }));
    return null;
  }
}

/** The persisted anchor value for a band: redirect/abstain never commit an anchor. */
function anchorForBand(cv: CaseViability): string | null {
  return cv.viability === 'redirect' || cv.viability === 'abstain'
    ? null
    : cv.best_anchor?.upstream_canonical ?? null;
}

/**
 * Only-when-null persist (build plan §3.2): write the band + best-anchor snapshot onto the Case
 * row ONLY when BOTH columns are currently null — never clobbers an RN override. The anchor is
 * NOT persisted for redirect/abstain bands (no committed anchor for a parked/redirected case).
 * Provenance (keystone pkg 5): the write always covers the FULL band+anchor group, so it always
 * stamps viabilityStampSource='derived'. Returns whether it wrote.
 */
async function persistViabilityWhenNull(db: AppDb, caseId: string, cv: CaseViability): Promise<boolean> {
  const row = (await db.case.findFirst({
    where: { id: caseId },
    select: { caseViabilityBand: true, caseViabilityAnchor: true } as never,
  })) as unknown as { caseViabilityBand: string | null; caseViabilityAnchor: string | null } | null;
  if (row === null) return false;
  if (row.caseViabilityBand !== null || row.caseViabilityAnchor !== null) return false;
  await db.case.update({
    where: { id: caseId },
    data: { caseViabilityBand: cv.viability, caseViabilityAnchor: anchorForBand(cv), viabilityStampSource: 'derived' } as never,
  });
  return true;
}

/**
 * Keystone 4c/5 — refresh the viability stamp after the chart changed (new merged SC rows can
 * change the anchor set). Overwrite rule (pkg 5): only a `viabilityStampSource === 'derived'`
 * band+anchor may be overwritten; 'manual' and null (legacy/unknown) are immutable to
 * auto-refresh; null COLUMNS still fill via the same only-when-null contract as draft time.
 * Respects the EMR_CASE_VIABILITY_ENABLED dark flag — the hook must never be the thing that
 * activates a dark surface. (The stored band columns never feed the derivation, so no
 * as-if-null re-derive is needed here, unlike framing.)
 */
export async function refreshDerivedViability(db: AppDb, caseId: string): Promise<'overwritten' | 'filled' | 'skipped'> {
  if (!caseViabilityEnabled()) return 'skipped';
  const row = (await db.case.findFirst({
    where: { id: caseId },
    select: { caseViabilityBand: true, caseViabilityAnchor: true, viabilityStampSource: true } as never,
  })) as unknown as { caseViabilityBand: string | null; caseViabilityAnchor: string | null; viabilityStampSource: string | null } | null;
  if (row === null) return 'skipped'; // raced delete — fail open
  if (row.viabilityStampSource === 'manual') return 'skipped';

  const cv = await deriveCaseViabilityForCase(db, caseId);
  if (cv === null) return 'skipped'; // fail open (vendor load / DB hiccup — already logged loud)

  if (row.viabilityStampSource === 'derived') {
    const anchor = anchorForBand(cv);
    if (cv.viability !== row.caseViabilityBand || anchor !== row.caseViabilityAnchor) {
      await db.case.update({
        where: { id: caseId },
        data: { caseViabilityBand: cv.viability, caseViabilityAnchor: anchor, viabilityStampSource: 'derived' } as never,
      });
      return 'overwritten';
    }
    return 'skipped';
  }

  // null source: legacy non-null values stay untouched; both-null fills exactly like draft time.
  return (await persistViabilityWhenNull(db, caseId, cv)) ? 'filled' : 'skipped';
}

/**
 * Derive caseViability for the case and return a copy of the bundle with it stamped. The route
 * adapter stamps derivedAt here (kept out of the pure producer for determinism, exactly like
 * caseFraming). Fail-open: null derivation → bundle returned UNSTAMPED.
 */
export async function stampCaseViability(
  db: AppDb,
  caseId: string,
  bundle: DrafterBundle,
  opts: { readonly persist: boolean },
): Promise<DrafterBundle> {
  const cv = await deriveCaseViabilityForCase(db, caseId);
  if (cv === null) return bundle; // fail open: bundle returned UNSTAMPED
  if (opts.persist) {
    await persistViabilityWhenNull(db, caseId, cv);
  }
  const stamped: CaseViability = { ...cv, derivedAt: new Date().toISOString() }; // route-stamp derivedAt (G3)
  return { ...bundle, caseViability: stamped };
}
