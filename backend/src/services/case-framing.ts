// SSOT caseFraming producer (v1) — the ONE place case framing is derived for the drafter bundle.
//
// Contract: backend/src/config/caseFraming.v1.schema.json (vendored byte-identical from the drafter
// repo's app/config/caseFraming.v1.schema.json; sha256 pinned in case-framing.test.ts — NEVER edit
// the vendored copy independently; contract changes go through the drafter window + a version bump).
// Plan of record: flatratenexus-project/docs/SSOT_CASEFRAMING_BUILD_PLAN_2026-06-10.md §2, §5.1-5.2.
//
// The evidence ladder below is the SAME precedence the shipped backfill endpoint uses
// (internal-worker.ts POST /internal/admin/backfill-intake-framing) — that endpoint now calls
// deriveFramingFromEvidence so there is exactly one derivation. A second independent derivation is
// the bug class this build eliminates.
//
// PURE module: no Prisma, no routes, no env. The impure adapter (db reads + bundle stamp + persist)
// lives in case-framing-stamp.ts.

import { bestGrantedScPair } from './strategy-preview.js';
import { findPair } from './cdsEngine.js';
import { isRecognizedSecondaryAnchor, parseSecondaryFraming } from './intake-derive.js';

export const CASE_FRAMING_VERSION = 1 as const;

export type CaseFramingTheory = 'direct' | 'secondary' | 'aggravation' | 'undetermined';
export type CaseFramingSource = 'rn_set' | 'derived' | 'text_parse_fallback' | 'default_direct';
export type ProducerClaimType = 'initial' | 'supplemental' | 'hlr' | 'appeal_bva';
export type RnFramingChoice = 'secondary' | 'aggravation' | 'direct';

export interface GrantedScAnchor {
  readonly condition: string;
  readonly ratingPct: number | null;
  readonly status: 'service_connected';
}

export interface CaseFraming {
  readonly version: 1;
  readonly framing: CaseFramingTheory;
  readonly grantedScAnchors: readonly GrantedScAnchor[];
  readonly upstreamScCondition: string | null;
  readonly framingChoice: RnFramingChoice | null;
  readonly claimType: ProducerClaimType;
  readonly source: CaseFramingSource;
  readonly derivedAt: string;
}

// Narrow input shapes — NOT the Prisma row. Keeps the producer pure and the tests plain-object.
// The route adapter (case-framing-stamp.ts) maps the Case/ScCondition rows to these.
export interface CaseFramingCaseInput {
  readonly claimedCondition: string;
  readonly claimType: ProducerClaimType;
  readonly framingChoice: string | null;
  readonly upstreamScCondition: string | null;
  readonly veteranStatement: string | null;
}

export interface ScConditionInput {
  readonly condition: string;
  readonly ratingPct: number | null;
  readonly status: string;
}

/** trim + lowercase + collapse whitespace — the §2.6 dedupe/exclusion KEY (never the stored value). */
function normCond(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Normalize a Case.framingChoice column value to the contract's RN-mirror enum, or null when the
 * value carries no recognizable pathway. The schema pins framingChoice to the 3-value enum, so a
 * free-text RN value ("Secondary to PTSD") mirrors as its normalized form; garbage mirrors as null.
 */
export function normalizeFramingChoice(framingChoice: string | null): RnFramingChoice | null {
  if (framingChoice === null) return null;
  const f = framingChoice.toLowerCase();
  if (/aggravat/.test(f)) return 'aggravation';
  if (/secondary|causa/.test(f)) return 'secondary';
  if (/direct/.test(f)) return 'direct';
  return null;
}

/**
 * §2.6 anchor-list hygiene (D7): strict status filter, self-anchor exclusion, dedupe by normalized
 * condition keeping the higher ratingPct (null sorts lowest), ordered by descending ratingPct then
 * condition ascending — grantedScAnchors[0] is a deterministic "best" anchor.
 */
export function buildGrantedScAnchors(
  scConditions: readonly ScConditionInput[],
  claimedCondition: string,
): GrantedScAnchor[] {
  const claimedNorm = normCond(claimedCondition);
  const byKey = new Map<string, GrantedScAnchor>();
  for (const s of scConditions) {
    if (s.status.toLowerCase() !== 'service_connected') continue; // strict filter (§2.3)
    if (s.condition.trim().length === 0) continue; // schema requires non-empty condition
    const key = normCond(s.condition);
    if (key === claimedNorm) continue; // self-anchor exclusion (§2.6)
    const cand: GrantedScAnchor = { condition: s.condition, ratingPct: s.ratingPct, status: 'service_connected' };
    const prev = byKey.get(key);
    if (prev === undefined || (cand.ratingPct ?? -1) > (prev.ratingPct ?? -1)) byKey.set(key, cand);
  }
  return [...byKey.values()].sort((a, b) => {
    const ra = a.ratingPct ?? -1;
    const rb = b.ratingPct ?? -1;
    if (rb !== ra) return rb - ra;
    return a.condition.localeCompare(b.condition);
  });
}

export interface EvidenceFramingInput {
  readonly claimedCondition: string;
  readonly upstreamScCondition: string | null;
  readonly grantedScConditionNames: readonly string[];
  /** Caller-computed /aggravat/ wording signal from its framingChoice (internal-worker.ts:763). */
  readonly aggravationWording: boolean;
  /**
   * Pre-parsed text-parse hint. The backfill endpoint passes the intake rawAnswers derivation
   * (deriveIntakeFields); the bundle producer passes parseSecondaryFraming(veteranStatement).
   * Same rung, different text source — the ladder logic itself is shared.
   */
  readonly textParseHint?: { readonly upstream: string; readonly framing: string } | undefined;
}

export interface EvidenceFramingResult {
  readonly framing: 'secondary' | 'aggravation' | 'direct';
  readonly upstreamScCondition: string | null;
  readonly source: 'derived' | 'text_parse_fallback' | 'default_direct';
}

/**
 * The shared evidence ladder — rungs 2..4 of §2.4, mirroring internal-worker.ts:753-773 exactly:
 *   derived (stored-scoreable kept, else best granted Board pair) → text_parse_fallback →
 *   garbage-anchor clear → default_direct.
 * The rn_set rung (§2.4 step 1) is deriveCaseFraming's, NOT here: the backfill endpoint deliberately
 * normalizes/overwrites a stale framingChoice (its whole purpose), while the bundle producer treats a
 * normalizable RN value as authoritative and never reaches this ladder.
 */
export function deriveFramingFromEvidence(input: EvidenceFramingInput): EvidenceFramingResult {
  const stored = input.upstreamScCondition;
  const storedScoreable = stored !== null && findPair(stored, input.claimedCondition) !== null;
  if (storedScoreable) {
    // Keep a scoreable stored anchor (internal-worker.ts:757 — the backfill writes nothing here).
    return {
      framing: input.aggravationWording ? 'aggravation' : 'secondary',
      upstreamScCondition: stored,
      source: 'derived',
    };
  }
  // AUTHORITATIVE anchor: the granted-SC condition with the best Board pair to the claimed condition.
  // claimType:'secondary' is a deliberate literal (internal-worker.ts:760) — it forces the secondary
  // pair scan regardless of the case's procedural claimType. Do NOT pass the case's real claimType.
  const authoritative = bestGrantedScPair({
    claimedCondition: input.claimedCondition,
    claimType: 'secondary',
    framingChoice: null,
    upstreamScCondition: null,
    serviceConnectedConditions: input.grantedScConditionNames,
    activeProblems: [],
  });
  if (authoritative !== null) {
    return {
      framing: input.aggravationWording ? 'aggravation' : 'secondary',
      upstreamScCondition: authoritative.upstream,
      source: 'derived',
    };
  }
  if (input.textParseHint !== undefined) {
    return {
      framing: input.textParseHint.framing === 'aggravation' ? 'aggravation' : 'secondary',
      upstreamScCondition: input.textParseHint.upstream,
      source: 'text_parse_fallback',
    };
  }
  if (stored !== null && !isRecognizedSecondaryAnchor(stored)) {
    // Garbage stored anchor ("service I wake up with headaches") — clear it (internal-worker.ts:770-772).
    return { framing: 'direct', upstreamScCondition: null, source: 'default_direct' };
  }
  return { framing: 'direct', upstreamScCondition: stored, source: 'default_direct' };
}

/**
 * The SSOT producer (§2.4 full ladder + §2.6 anchors). Pure; `now` is injectable so derivedAt is
 * deterministic under test. Output always validates against caseFraming.v1.schema.json — the
 * contract test pins that plus the vendored schema's sha256.
 */
export function deriveCaseFraming(
  caseInput: CaseFramingCaseInput,
  scConditions: readonly ScConditionInput[],
  now: Date = new Date(),
): CaseFraming {
  const grantedScAnchors = buildGrantedScAnchors(scConditions, caseInput.claimedCondition);
  const grantedNames = grantedScAnchors.map((a) => a.condition);
  const rnChoice = normalizeFramingChoice(caseInput.framingChoice);
  const base = {
    version: CASE_FRAMING_VERSION,
    grantedScAnchors,
    framingChoice: rnChoice,
    claimType: caseInput.claimType,
    derivedAt: now.toISOString(),
  } as const;

  if (rnChoice !== null) {
    // §2.4 step 1 — rn_set is authoritative. One exception (§2.4 last paragraph): RN says secondary
    // but there is NO granted anchor, NO recoverable Board pair, and NO usable upstream — a secondary
    // theory cannot exist without a primary, so emit 'undetermined' rather than guessing. An RN-set
    // 'aggravation' with no anchor is NOT a contradiction (3.306-style own-condition aggravation is
    // framingGate's downstream call — the SSOT never encodes the CFR mechanism). A recognized-but-not-
    // granted upstream (pending primary) also stays 'secondary' — consumers see the empty anchor list.
    const upstreamUsable =
      caseInput.upstreamScCondition !== null && isRecognizedSecondaryAnchor(caseInput.upstreamScCondition);
    const contradiction =
      rnChoice === 'secondary'
      && grantedScAnchors.length === 0
      && !upstreamUsable
      && bestGrantedScPair({
        claimedCondition: caseInput.claimedCondition,
        claimType: 'secondary',
        framingChoice: null,
        upstreamScCondition: null,
        serviceConnectedConditions: grantedNames,
        activeProblems: [],
      }) === null;
    return {
      ...base,
      framing: contradiction ? 'undetermined' : rnChoice,
      upstreamScCondition: caseInput.upstreamScCondition,
      source: 'rn_set',
    };
  }

  const evidence = deriveFramingFromEvidence({
    claimedCondition: caseInput.claimedCondition,
    upstreamScCondition: caseInput.upstreamScCondition,
    grantedScConditionNames: grantedNames,
    aggravationWording: /aggravat/.test((caseInput.framingChoice ?? '').toLowerCase()),
    textParseHint: caseInput.veteranStatement !== null && caseInput.veteranStatement.length > 0
      ? parseSecondaryFraming(caseInput.veteranStatement)
      : undefined,
  });
  return {
    ...base,
    framing: evidence.framing,
    upstreamScCondition: evidence.upstreamScCondition,
    source: evidence.source,
  };
}
