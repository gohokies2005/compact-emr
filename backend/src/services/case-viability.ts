// SSOT caseViability producer (v1) — the EMR-side wrapper around the VENDORED anchor-mechanism
// resolver (backend/src/vendor/anchorMechanism.cjs, sha-pinned by anchor-table-pin.test.ts).
//
// Contract: backend/src/config/caseViability.v1.schema.json (authored from the resolver's VERIFIED
// real output bytes — build plan §1 / BLOCKER-2; sha256 pinned in anchor-table-pin.test.ts).
// Plan of record: docs/P4_ANCHOR_VIABILITY_BUILD_PLAN.md §3.1.
//
// PURE module: no Prisma, no routes, no env-flag reads. The impure adapter (db reads + bundle
// stamp + only-when-null persist + the EMR_CASE_VIABILITY_ENABLED gate) lives in
// case-viability-stamp.ts, mirroring the caseFraming split.
//
// The band logic itself lives in ONE place — the vendored assessClaimViability. This module never
// re-implements any of it (the cross-repo single-home requirement, design §1). chartFacts is
// omitted in v1: the EMR has no chart-fact normalization yet (build plan G9), so every derivation
// is info_light. Chart-refined is a documented follow-on.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const CASE_VIABILITY_VERSION = 1 as const;

export type ViabilityBand = 'strong' | 'moderate' | 'conditional' | 'weak' | 'abstain' | 'redirect';
export type AnchorTier = 'blessed' | 'conditional' | 'chain' | 'plausible' | 'excluded';

export interface ViabilityBestAnchor {
  readonly upstream_canonical: string;
  readonly upstream_verbatim: string;
  readonly M_static: number | null;
  readonly M_eff: number | null;
  /** null = not-yet-scored (true for all 513 rows today) — NEVER render as 0/"no evidence". */
  readonly E: number | null;
  readonly tier: AnchorTier;
  /** e.g. '3.310a' (NO parens — the design sketch's '3.310(a)' is wrong; build plan G4). */
  readonly basis: string | null;
  readonly is_granted_sc: boolean;
  readonly mechanism_class: string | null;
  readonly requires: string | null;
  /** Present ONLY after a 4.130 psych collapse (build plan G6 — the Hatfield shape). */
  readonly mechanism_member?: string;
  /** Present (true) only on a 3.310(b) aggravation-only re-characterized pair (FRN engine 5d04b62). */
  readonly aggravation_only?: boolean;
  /** Present (true) only alongside aggravation_only — direct causation is reliably denied (best_anchor only). */
  readonly causation_denied?: boolean;
}

export interface ViabilityAlternative {
  readonly upstream_canonical: string;
  readonly M_eff: number | null;
  readonly tier: AnchorTier;
  readonly is_granted_sc: boolean;
  /** Present (true) only on a 3.310(b) aggravation-only re-characterized pair (FRN engine 5d04b62). */
  readonly aggravation_only?: boolean;
}

export interface ViabilityPresumptiveRedirect {
  readonly path: string;
  readonly note: string;
  /** true = info-light advisory note; false = hard redirect (chart-refined only). Build plan G5. */
  readonly advisory: boolean;
}

export interface ViabilityGraveyardRedirect {
  readonly dead_anchor: string;
  readonly redirect_to: string;
  readonly rationale: string;
  /** true = redirect target is not granted → the case parks (abstain). Build plan G5. */
  readonly redirect_blocked: boolean;
}

export interface ViabilityExcludedTrap {
  readonly upstream_canonical: string;
  readonly reason: string;
}

/** The resolver's 14-key output shape (build plan G3) + the OPTIONAL route-stamped derivedAt. */
export interface CaseViability {
  readonly version: 1;
  readonly claimed_canonical: string | null;
  readonly viability: ViabilityBand;
  readonly best_anchor: ViabilityBestAnchor | null;
  readonly alternatives: readonly ViabilityAlternative[];
  readonly why: string;
  readonly missing_fact: string | null;
  readonly presumptive_redirect: ViabilityPresumptiveRedirect | null;
  readonly graveyard_redirect: ViabilityGraveyardRedirect | null;
  readonly excluded_traps: readonly ViabilityExcludedTrap[];
  readonly confidence: 'high' | 'low';
  readonly mode: 'info_light' | 'chart_refined';
  readonly table_version: string | null;
  readonly table_content_hash: string | null;
  /** OPTIONAL — added by the EMR route adapter only; the pure resolver/website omit it (G3). */
  readonly derivedAt?: string;
}

interface AnchorMechanismModule {
  assessClaimViability(
    claimedText: string,
    grantedScConditions: readonly string[],
    chartFactsPresent?: unknown,
  ): CaseViability;
}

// The vendored resolver is CommonJS and reads its table by __dirname-relative path, so it is NOT
// esbuild-bundled — it is loaded at RUNTIME from disk, exactly like the advisory vendor tree
// (realRetrieve.ts pattern: createRequire with an ABSOLUTE entry is format-agnostic — it works
// whether esbuild emits CJS or ESM — and avoids import.meta.url, which is undefined in a CJS
// bundle). Candidate paths cover the Lambda (afterBundling copies backend/src/vendor →
// <task>/anchor-vendor), vitest/tsx dev (cwd = backend/), and a repo-root cwd.
const VENDOR_DIR = process.env['ANCHOR_VENDOR_DIR'] ?? 'anchor-vendor';

let _resolver: AnchorMechanismModule | null = null;

function loadResolver(): AnchorMechanismModule {
  if (_resolver !== null) return _resolver;
  const candidates = [
    path.join(process.cwd(), VENDOR_DIR, 'anchorMechanism.cjs'), // Lambda runtime (anchor-vendor copy)
    path.join(process.cwd(), 'src', 'vendor', 'anchorMechanism.cjs'), // backend/ cwd (vitest, tsx dev)
    path.join(process.cwd(), 'backend', 'src', 'vendor', 'anchorMechanism.cjs'), // repo-root cwd
  ];
  const entry = candidates.find((c) => existsSync(c));
  if (entry === undefined) {
    // Loud here (the producer is the wiring proof — tests fail immediately); the IMPURE adapter
    // catches and fails open so a runtime load problem can never break a draft.
    throw new Error(`anchorMechanism vendor module not found (tried: ${candidates.join(' | ')})`);
  }
  const req = createRequire(path.join(process.cwd(), '_anchor_require_base.cjs'));
  _resolver = req(entry) as AnchorMechanismModule;
  return _resolver;
}

/**
 * PURE. Reuses the grantedScAnchors the framing producer already built (one derivation feeds
 * both — design §3d): the SAME strict-filtered, deduped, granted-only list. No second SC re-filter
 * (the bug class the SSOT eliminates). chartFacts omitted in v1 (G9 → info_light). derivedAt is
 * NOT added here (kept out of the pure fn for determinism, exactly like caseFraming) — the route
 * adapter stamps it.
 *
 * assessClaimViability is fail-open by construction (returns abstain on a bad/stub table) — it
 * never throws on table problems. The only throw path is a missing vendor MODULE (wiring bug).
 */
export function deriveCaseViability(
  claimedCondition: string,
  grantedScAnchors: ReadonlyArray<{ readonly condition: string }>,
  chartFacts?: unknown,
): CaseViability {
  const grantedNames = grantedScAnchors.map((a) => a.condition);
  return loadResolver().assessClaimViability(claimedCondition, grantedNames, chartFacts);
}
