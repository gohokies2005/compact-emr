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
/** v2 only — which axis the winning anchor came from. */
export type AnchorAxis = 'secondary' | 'direct';
/** v2 only — the winning axis at the case level (none = no anchor either axis). */
export type CaseAxis = 'secondary' | 'direct' | 'presumptive_redirect' | 'none';

/**
 * A pre-resolved in-service event for the DIRECT-SC axis. Built by the impure adapter from the
 * Case row's conceded fields (eventCanon.resolveEventCanon) UNIONed with any classifier-emitted
 * events, then passed through deriveCaseViability via chartFacts.in_service_events. event_canonical
 * is an eventCanon EVENT_ENUM member; evidence_span is the verbatim chart/lay text.
 */
export interface InServiceEvent {
  readonly event_canonical: string;
  readonly evidence_span: string;
  readonly source?: string;
}

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
  // ── v2 (DIRECT-SC axis) — present ONLY when the direct axis is enabled and folded ──────────
  /** v2: which axis this anchor came from. Absent in v1 (secondary-only). */
  readonly anchor_axis?: AnchorAxis;
  /** v2 DIRECT axis only: the eventCanon canonical in-service event type. */
  readonly event_canonical?: string;
  /** v2 DIRECT axis only: a verbatim substring of the chart/lay text evidencing the event. */
  readonly evidence_span?: string;
  /** v2 DIRECT axis only: the event is a presumptive pathway (routes to presumptive_redirect). */
  readonly presumptive?: boolean;
  /** v2: a 3.310(b) re-characterization may carry the donor pair it inherited from (engine _INHERIT_FROM). */
  readonly inherited_from?: string;
}

export interface ViabilityAlternative {
  readonly upstream_canonical: string;
  readonly M_eff: number | null;
  readonly tier: AnchorTier;
  readonly is_granted_sc: boolean;
  /** Present (true) only on a 3.310(b) aggravation-only re-characterized pair (FRN engine 5d04b62). */
  readonly aggravation_only?: boolean;
  /** v2: which axis this alternative came from. Absent in v1. */
  readonly anchor_axis?: AnchorAxis;
  /** v2 DIRECT axis only: the eventCanon canonical in-service event type. */
  readonly event_canonical?: string;
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

/** v2 only — per-table provenance (replaces the single flat table_content_hash). */
export interface ViabilityTableProvenance {
  readonly version: string | null;
  readonly content_hash: string;
}

/**
 * The resolver's output shape (build plan G3) + the OPTIONAL route-stamped derivedAt.
 *
 * SUPERSET of v1 and v2 (version-gated reader): `version` is 1 (secondary-only, the default DARK
 * shape) or 2 (the two-axis fold, emitted only when the direct axis is enabled). The v2-only fields
 * (`axis`, `tables`) are optional so a v1 object still satisfies this type. Readers MUST branch on
 * `version` before consuming a v2 field — absence/unknown version = fail open to v1 behavior.
 */
export interface CaseViability {
  readonly version: 1 | 2;
  /** v2 only: the winning axis at the case level. Absent in v1. */
  readonly axis?: CaseAxis;
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
  /** v2 only: per-table provenance (secondary + direct). Absent in v1. */
  readonly tables?: { readonly secondary: ViabilityTableProvenance; readonly direct: ViabilityTableProvenance };
  readonly table_version: string | null;
  /** v1: the secondary table hash. v2: a DEPRECATED flat mirror of tables.secondary.content_hash. */
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
  /** Folds the direct axis into the resolve+rank and emits v2. Idempotent; null restores env default. */
  setDirectAxisEnabled(on: boolean | null): void;
  /** Enables the presumptive bridge-anchor branch (fires only on the v2 shape). null restores env default. */
  setBridgeEnabled(on: boolean | null): void;
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

// ── eventCanon (DIRECT-SC deterministic event floor) ─────────────────────────────────────────
// Loaded from the SAME vendor tree as the resolver (api afterBundling copies backend/src/vendor →
// anchor-vendor, so eventCanon.cjs is co-located). Only invoked on the gated direct-SC path; the
// load is lazy so the DARK path never touches it.
interface EventCanonModule {
  resolveEventCanon(input: unknown): Array<{ event_canonical: string; evidence: string; source: string }>;
  isValidEvent(evt: string): boolean;
}
let _eventCanon: EventCanonModule | null = null;
function loadEventCanon(): EventCanonModule {
  if (_eventCanon !== null) return _eventCanon;
  const candidates = [
    path.join(process.cwd(), VENDOR_DIR, 'eventCanon.cjs'), // Lambda runtime (anchor-vendor copy)
    path.join(process.cwd(), 'src', 'vendor', 'eventCanon.cjs'), // backend/ cwd (vitest, tsx dev)
    path.join(process.cwd(), 'backend', 'src', 'vendor', 'eventCanon.cjs'), // repo-root cwd
  ];
  const entry = candidates.find((c) => existsSync(c));
  if (entry === undefined) {
    throw new Error(`eventCanon vendor module not found (tried: ${candidates.join(' | ')})`);
  }
  const req = createRequire(path.join(process.cwd(), '_anchor_require_base.cjs'));
  _eventCanon = req(entry) as EventCanonModule;
  return _eventCanon;
}

/**
 * A chart's conceded in-service facts, shaped for eventCanon.resolveEventCanon. The adapter builds
 * this from the Case/Veteran row's conceded fields. Only the fields eventCanon reads are typed.
 */
export interface VaConcessionsLike {
  readonly in_service_event_conceded?: string | null;
  readonly noise_exposure_conceded?: { readonly conceded: boolean } | null;
  readonly tera_concession?: { readonly conceded: boolean } | null;
}

/**
 * DIRECT-SC deterministic event floor + classifier-residue union, deduped by event_canonical. The
 * deterministic floor (eventCanon over conceded fields + free text) wins a slot; classifier events
 * (validated against EVENT_ENUM) fill only the gaps the floor missed. Returns the InServiceEvent[]
 * shape deriveCaseViability folds in. Pure given its inputs; never throws (eventCanon never throws).
 */
export function resolveInServiceEvents(
  concessions: VaConcessionsLike | null,
  freeText: string | null,
  classifierEvents?: ReadonlyArray<{ readonly event_canonical: string; readonly evidence?: string }>,
): InServiceEvent[] {
  const ec = loadEventCanon();
  const out: InServiceEvent[] = [];
  const seen = new Set<string>();
  const push = (evt: string, span: string, source: string): void => {
    if (!evt || seen.has(evt) || !ec.isValidEvent(evt)) return;
    seen.add(evt);
    out.push({ event_canonical: evt, evidence_span: span, source });
  };
  // (a) deterministic floor: conceded object first (highest confidence), then free text.
  if (concessions) {
    for (const e of ec.resolveEventCanon(concessions)) push(e.event_canonical, e.evidence, e.source || 'chart_concession');
  }
  if (freeText && freeText.trim()) {
    for (const e of ec.resolveEventCanon(freeText)) push(e.event_canonical, e.evidence, e.source || 'free_text');
  }
  // (b) classifier residue — fills only event types the floor did not already claim.
  for (const e of classifierEvents ?? []) push(e.event_canonical, e.evidence ?? '', 'llm_str_classify');
  return out;
}

/**
 * DIRECT-SC axis gate (ships DARK). Read at call time so a deploy/flip toggles it with no rebuild.
 * SAME flag the chart-extract event classifier reads (event-classifier.eventClassifierEnabled) — the
 * direct-SC producer and the classifier activate together. SEPARATE from EMR_CASE_VIABILITY_ENABLED
 * (which gates the whole viability stamp); the direct axis only adds the second axis on top.
 */
export function directScViabilityEnabled(): boolean {
  return process.env['DIRECT_SC_VIABILITY_ENABLED'] === 'true';
}

/**
 * BRIDGE-ANCHOR gate (ships DARK, 2026-06-16). The presumptive two-hop suggestion (exposure →
 * PACT-presumptive intermediate dx → claimed secondary). SEPARATE from DIRECT_SC_VIABILITY_ENABLED:
 * the bridge only attaches on the v2 (direct-axis) shape, so it is meaningful ONLY when the direct
 * axis is also on. Additive — flag OFF leaves the v2 object byte-identical (no bridge_pathways key).
 */
export function bridgeAnchorViabilityEnabled(): boolean {
  return process.env['BRIDGE_ANCHOR_ENABLED'] === 'true';
}

/**
 * Reuses the grantedScAnchors the framing producer already built (one derivation feeds both —
 * design §3d): the SAME strict-filtered, deduped, granted-only list. No second SC re-filter (the
 * bug class the SSOT eliminates). derivedAt is NOT added here (kept out for determinism, exactly
 * like caseFraming) — the route adapter stamps it.
 *
 * DIRECT-SC AXIS (gated, DARK): when DIRECT_SC_VIABILITY_ENABLED==='true', the caller passes the
 * pre-resolved in-service events (eventCanon floor UNIONed with classifier residue, deduped by the
 * adapter); this fn flips the vendored resolver into v2 via setDirectAxisEnabled(true) and folds the
 * events in via chartFactsPresent.in_service_events. When the flag is OFF the setter is NEVER called
 * and no events are passed, so the output is byte-identical to the v1 secondary-only engine.
 *
 * assessClaimViability is fail-open by construction (returns abstain on a bad/stub table) — it never
 * throws on table problems. The only throw path is a missing vendor MODULE (wiring bug).
 */
export function deriveCaseViability(
  claimedCondition: string,
  grantedScAnchors: ReadonlyArray<{ readonly condition: string }>,
  directInServiceEvents?: readonly InServiceEvent[],
  dxConstellation?: readonly string[],
): CaseViability {
  const grantedNames = grantedScAnchors.map((a) => a.condition);
  const resolver = loadResolver();
  if (!directScViabilityEnabled()) {
    // DARK path — byte-identical to v1 (no chartFacts → info_light, secondary-only). The setter is
    // reset to null (env default) FIRST so a prior on-derivation in the SAME process cannot leak its
    // sticky override and emit v2 here. EMR never sets DIRECT_SC_AXIS_ENABLED, so null = OFF. This is
    // determinism insurance for the long-lived Lambda/worker — not just the test harness.
    resolver.setDirectAxisEnabled(null);
    resolver.setBridgeEnabled(null); // bridge can't fire on the v1 shape; reset for determinism insurance
    return resolver.assessClaimViability(claimedCondition, grantedNames);
  }
  // Direct axis ON: flip the resolver to v2 and fold the pre-resolved events. The setter is an
  // explicit per-derivation flip (NOT relying on the resolver's own env read) for determinism — the
  // Lambda has process.env but the override wins and is unambiguous. Events default to [] when none.
  //
  // BRIDGE-ANCHOR PREREQ (2026-06-16): dx_constellation rides in the SAME chartFactsPresent object.
  // The vendored assessBridgePathways (gated on BRIDGE_ANCHOR_ENABLED + the v2 shape) reads it for G2;
  // an EMR vendored copy WITHOUT the bridge simply ignores the extra key, so this is inert until the
  // bridge is re-vendored. Defaults to [] when none — the bridge stays dark on an empty constellation.
  resolver.setDirectAxisEnabled(true);
  // BRIDGE-ANCHOR (DARK): explicit per-derivation set (not the resolver's own env read) for determinism
  // in the long-lived Lambda — the override wins and is reset on the v1 path above, so a prior on-
  // derivation can never leak a sticky bridge into a later one.
  resolver.setBridgeEnabled(bridgeAnchorViabilityEnabled());
  const chartFactsPresent = {
    in_service_events: directInServiceEvents ?? [],
    dx_constellation: dxConstellation ?? [],
  };
  return resolver.assessClaimViability(claimedCondition, grantedNames, chartFactsPresent);
}
