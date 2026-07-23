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

import {
  deriveCaseViability,
  directScViabilityEnabled,
  recommendedActionFor,
  resolveInServiceEvents,
  type CaseViability,
  type InServiceEvent,
  type VaConcessionsLike,
} from './case-viability.js';
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
    // DIRECT-SC axis (gated, DARK): only when DIRECT_SC_VIABILITY_ENABLED build the in-service event
    // floor. When OFF, no extra query, no events → deriveCaseViability is byte-identical v1 (G9
    // info_light). The flag check fences the extra read so the dark path's cost is exactly today's.
    const directEvents = directScViabilityEnabled()
      ? await buildInServiceEvents(db, caseId)
      : undefined;
    // BRIDGE-ANCHOR PREREQ (2026-06-16): the present-diagnosis constellation (bridge G2). Built on the
    // SAME gated direct-axis fence as the event floor — the bridge only fires on the v2 shape. Inert
    // until the bridge is re-vendored (the current vendored resolver ignores the extra chartFacts key).
    const dxConstellation = directScViabilityEnabled()
      ? await buildDxConstellation(db, caseId)
      : undefined;
    const cv = deriveCaseViability(c.claimedCondition, cf.grantedScAnchors, directEvents, dxConstellation);
    // Stamp the SSOT band→action policy (incl. the physician_reviewed over-call guard) so the card +
    // Ask Aegis consume ONE mapping. Fail-open: a null wrapper leaves recommended_action absent.
    const action = recommendedActionFor(cv);
    return action === null ? cv : { ...cv, recommended_action: action };
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

/** YesNoUnknown 'yes' → conceded:true; anything else → not conceded (conservative). */
function concededFlag(v: string | null | undefined): boolean {
  return v === 'yes';
}

/**
 * DIRECT-SC axis: build the deterministic in-service-event floor from the Case/Veteran row's
 * conceded fields, UNIONed with the classifier residue. ONLY called on the gated path.
 *
 * Source mapping (the EMR has no structured va_concessions object yet — this synthesizes the shape
 * eventCanon reads from the columns that DO exist):
 *   - Case.inServiceEvent      → in_service_event_conceded (free-text conceded event)
 *   - Case.veteranStatement    → lay free text (scanned for oblique phrasing)
 *   - Veteran.combatVeteran    → (advisory only; not a direct eventCanon flag — folded via free text)
 *   - Veteran.teraConceded='yes'→ tera_concession.conceded=true
 *
 * CLASSIFIER RESIDUE: the LLM event classifier currently only LOGS (no write endpoint), so there is
 * no persisted classifier-event column to union yet. When that lands, fetch it here and pass it as
 * the 3rd arg — resolveInServiceEvents already dedupes it behind the deterministic floor. Until then
 * this is the deterministic floor alone. Fail-open: any error → [] (the secondary axis still stands).
 */
export async function buildInServiceEvents(db: AppDb, caseId: string): Promise<InServiceEvent[]> {
  try {
    const row = (await db.case.findFirst({
      where: { id: caseId },
      select: {
        inServiceEvent: true,
        veteranStatement: true,
        veteran: { select: { teraConceded: true } },
      } as never,
    })) as unknown as {
      inServiceEvent: string | null;
      veteranStatement: string | null;
      veteran: { teraConceded: string | null } | null;
    } | null;
    if (row === null) return [];
    const concessions: VaConcessionsLike = {
      in_service_event_conceded: row.inServiceEvent,
      tera_concession: concededFlag(row.veteran?.teraConceded) ? { conceded: true } : null,
    };
    // No persisted classifier events yet (log-only) — deterministic floor + lay free text only.
    return resolveInServiceEvents(concessions, row.veteranStatement, undefined);
  } catch (err) {
    console.warn(JSON.stringify({
      msg: 'case-viability: in-service event floor failed open',
      caseId,
      error: err instanceof Error ? err.message : String(err),
    }));
    return [];
  }
}

/**
 * BRIDGE-ANCHOR PREREQ (2026-06-16): build `chartFactsPresent.dx_constellation` — the veteran's
 * PRESENT diagnoses (the problem list), which the bridge's G2 reads to find a PACT-presumptive
 * intermediate dx. RAW labels: the vendored `assessBridgePathways` canonicalizes each via
 * conditionCanon and drops already-granted ones, so no EMR-side canonicalization is needed (and a
 * granted SC in the list is harmless — the bridge skips it). Deduped (case-insensitive), non-empty.
 * ONLY called on the gated direct-axis path. Fail-open: any error → [] (the secondary axis stands).
 */
export async function buildDxConstellation(db: AppDb, caseId: string): Promise<string[]> {
  try {
    const row = (await db.case.findFirst({
      where: { id: caseId },
      select: { veteran: { select: { activeProblems: { select: { problem: true } } } } } as never,
    })) as unknown as { veteran: { activeProblems: Array<{ problem: string }> } | null } | null;
    if (row === null) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of row.veteran?.activeProblems ?? []) {
      const label = (p.problem ?? '').trim();
      if (label.length === 0) continue;
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(label);
    }
    return out;
  } catch (err) {
    console.warn(JSON.stringify({
      msg: 'case-viability: dx_constellation build failed open',
      caseId,
      error: err instanceof Error ? err.message : String(err),
    }));
    return [];
  }
}

/** The persisted anchor value for a band: redirect/abstain never commit an anchor.
 *  QA F2: for a DIRECT anchor, persist the canonical event token (event_canonical), NOT the
 *  humanized prose label (e.g. "in-service hazardous noise exposure") — the column is keyed off a
 *  machine value, and a direct anchor is an in-service EVENT, not an SC condition. Secondary anchors
 *  keep upstream_canonical (the SC condition). */
function anchorForBand(cv: CaseViability): string | null {
  if (cv.viability === 'redirect' || cv.viability === 'abstain') return null;
  const a = cv.best_anchor;
  if (!a) return null;
  if (a.anchor_axis === 'direct') return a.event_canonical ?? null;
  return a.upstream_canonical ?? null;
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
