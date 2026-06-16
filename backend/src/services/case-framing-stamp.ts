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

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  deriveCaseFraming,
  type AnchorMechanismFilter,
  type CaseFraming,
  type ProducerClaimType,
} from './case-framing.js';
import type { DrafterBundle } from './drafter-bundle.js';
import type { AppDb } from './db-types.js';

// Bug C (Pichette, 2026-06-15): load the VENDORED anchor-mechanism resolver and hand it to the pure
// producer as an AnchorMechanismFilter, so the framing pick is mechanism-gated (drops EXCLUDED pairs
// like Tinnitus→OSA). Same runtime-load pattern as case-viability.ts loadResolver (createRequire with
// an absolute entry; candidate paths cover Lambda anchor-vendor copy, backend/ cwd, repo-root cwd).
// FAIL-OPEN: any load/resolve error ⇒ undefined filter ⇒ the producer keeps its legacy behavior, so a
// vendor problem can never break framing derivation.
const VENDOR_DIR = process.env['ANCHOR_VENDOR_DIR'] ?? 'anchor-vendor';
interface AnchorResolverModule {
  resolveAnchorEligibility(upstream: string, claimed: string): { eligibility: string };
  presumptiveFor(claimed: string): unknown | null;
}
let _mechFilter: AnchorMechanismFilter | null | undefined; // undefined = not tried; null = unavailable
export function loadMechanismFilter(): AnchorMechanismFilter | undefined {
  if (_mechFilter !== undefined) return _mechFilter ?? undefined;
  try {
    const candidates = [
      path.join(process.cwd(), VENDOR_DIR, 'anchorMechanism.cjs'), // Lambda runtime (anchor-vendor copy)
      path.join(process.cwd(), 'src', 'vendor', 'anchorMechanism.cjs'), // backend/ cwd (vitest, tsx dev)
      path.join(process.cwd(), 'backend', 'src', 'vendor', 'anchorMechanism.cjs'), // repo-root cwd
    ];
    const entry = candidates.find((c) => existsSync(c));
    if (entry === undefined) { _mechFilter = null; return undefined; }
    const req = createRequire(path.join(process.cwd(), '_anchor_require_base.cjs'));
    const m = req(entry) as AnchorResolverModule;
    _mechFilter = {
      isEligibleAnchor: (u: string, c: string): boolean => {
        try { return m.resolveAnchorEligibility(u, c).eligibility !== 'excluded'; } catch { return true; }
      },
      isPresumptive: (c: string): boolean => {
        try { return m.presumptiveFor(c) !== null; } catch { return false; }
      },
    };
    return _mechFilter;
  } catch {
    _mechFilter = null; // remember the failure; never retry-throw on a hot path
    return undefined;
  }
}

interface CaseRowForFraming {
  readonly id: string;
  readonly claimedCondition: string;
  readonly claimType: string;
  readonly framingChoice: string | null;
  readonly upstreamScCondition: string | null;
  /** 'derived' | 'manual' | null(legacy/unknown — immutable to auto-refresh). Keystone pkg 5. */
  readonly framingStampSource: string | null;
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
 *
 * KNOWN ASYMMETRY (architect QA 2026-06-10, intentional): the stamp adapter only FILLS null
 * columns — it never CLEARS a non-null garbage upstreamScCondition the way the backfill endpoint's
 * 4th branch does. A garbage row value therefore survives a draft: the BUNDLE carries the corrected
 * framing (direct, upstream null) while the row stays dirty until the admin backfill runs. Clearing
 * from a draft path would be a write the RN didn't ask for on a non-null column — the only-when-null
 * contract is stricter on purpose.
 */
async function persistFramingWhenNull(db: AppDb, row: CaseRowForFraming, cf: CaseFraming): Promise<'none' | 'partial' | 'full'> {
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
  if (Object.keys(data).length === 0) return 'none';
  // Provenance (keystone pkg 5): stamp 'derived' ONLY when the FULL pair was machine-written.
  // A partial fill (one column was already non-null — e.g. an RN typed the upstream and the
  // derivation filled framingChoice) is MIXED provenance: leave the source null = legacy =
  // immutable-to-refresh, so a later auto-refresh can never clobber the RN-typed half.
  const full = 'framingChoice' in data && 'upstreamScCondition' in data;
  if (full) data['framingStampSource'] = 'derived';
  await db.case.update({ where: { id: row.id }, data: data as never });
  return full ? 'full' : 'partial';
}

/** Refresh outcome shared by the three stamp groups (consumed by the 4c post-merge hook). */
export type StampRefreshOutcome = 'overwritten' | 'filled' | 'skipped';

/**
 * Keystone 4c/5 — refresh the framing stamp after the chart changed (new merged SC rows).
 * Overwrite rule (pkg 5): only a `framingStampSource === 'derived'` pair may be overwritten;
 * 'manual' (RN-set) and null (legacy/unknown) are immutable to auto-refresh. Null COLUMNS are
 * still fair game via the same fill-when-null contract the draft-time stamp uses.
 *
 * The 'derived' path re-derives AS IF the stamped pair were null: deriveCaseFraming mirrors a
 * non-null framingChoice as rn_set, so re-deriving naively would just echo the stale stamp back.
 * It writes only a PERSISTABLE fresh value (secondary/aggravation with an upstream); a fresh
 * derivation of direct/undetermined leaves the stamped value alone (clearing is the admin
 * backfill's job — same asymmetry as the draft-time stamp, documented above).
 */
export async function refreshDerivedFraming(db: AppDb, caseId: string): Promise<StampRefreshOutcome> {
  const c = await fetchCaseRowForFraming(db, caseId);
  if (c === null) return 'skipped'; // raced delete — fail open
  if (c.framingStampSource === 'manual') return 'skipped';

  if (c.framingStampSource === 'derived') {
    const fresh = deriveForRow({ ...c, framingChoice: null, upstreamScCondition: null });
    const persistable = (fresh.framing === 'secondary' || fresh.framing === 'aggravation') && fresh.upstreamScCondition !== null;
    if (persistable && (fresh.framing !== c.framingChoice || fresh.upstreamScCondition !== c.upstreamScCondition)) {
      await db.case.update({
        where: { id: c.id },
        data: { framingChoice: fresh.framing, upstreamScCondition: fresh.upstreamScCondition, framingStampSource: 'derived' } as never,
      });
      return 'overwritten';
    }
    return 'skipped';
  }

  // null source: legacy non-null values stay untouched; null columns fill exactly like draft time.
  const wrote = await persistFramingWhenNull(db, c, deriveForRow(c));
  return wrote === 'none' ? 'skipped' : 'filled';
}

/**
 * THE shared Case-row → caseFraming derivation (architect QA 2026-06-10: one row→input mapping for
 * every consumer, so the stamp + the request-time consumers — viability gate, strategy preview,
 * draft readiness — cannot drift into N hand-written mappings). Returns null when the case row
 * doesn't exist; callers fail open to their legacy derivations on null.
 *
 * Request-time consumers calling this LIVE and the draft-time stamp reading the same function may
 * see different values if the Case row changed in between — that is BY DESIGN: the stamp is the
 * value AT DRAFT TIME; the cards are advisory request-time reads of the same single derivation.
 */
export async function deriveCaseFramingForCase(db: AppDb, caseId: string): Promise<CaseFraming | null> {
  const c = await fetchCaseRowForFraming(db, caseId);
  if (c === null) return null;
  return deriveForRow(c);
}

async function fetchCaseRowForFraming(db: AppDb, caseId: string): Promise<CaseRowForFraming | null> {
  return await db.case.findFirst({
    where: { id: caseId },
    select: {
      id: true,
      claimedCondition: true,
      claimType: true,
      framingChoice: true,
      upstreamScCondition: true,
      framingStampSource: true,
      veteranStatement: true,
      veteran: { select: { scConditions: { select: { condition: true, ratingPct: true, status: true } } } },
    },
  }) as unknown as CaseRowForFraming | null;
}

function deriveForRow(c: CaseRowForFraming): CaseFraming {
  return deriveCaseFraming(
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
    new Date(),
    loadMechanismFilter(), // Bug C: mechanism-gate the anchor pick (fail-open to undefined)
  );
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
  const c = await fetchCaseRowForFraming(db, caseId);
  if (c === null) return bundle;
  const caseFraming = deriveForRow(c);
  if (opts.persist) {
    await persistFramingWhenNull(db, c, caseFraming);
  }
  return { ...bundle, caseFraming };
}
