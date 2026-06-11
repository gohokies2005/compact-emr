// Pre-draft STRATEGY PREVIEW — a deterministic, reproducible read of what argument the draft will make
// and how viable it is, shown BEFORE "Send to drafter" so a human can catch a crazy pathway ("knee pain
// doesn't cause blindness — argue the toxic exposure instead") before spending ~$15.
//
// This is a THIN composition over the existing deterministic engine (cdsEngine.evaluateCds) — NOT a new
// scorer. Same chart in -> same tier out (no LLM). The redirect rides on the existing strategyOverride
// steer; a material mid-draft theory change re-surfaces via Gate-2. Critical: compute LIVE here, never
// read the stale Case.cdsVerdict column.

import { evaluateCds, findPair, type PairMatch } from './cdsEngine.js';

export interface PathwaySuggestion {
  readonly kind: 'direct' | 'secondary';
  readonly anchor: string | null;       // the granted SC condition, for a secondary recommendation
  readonly basis: string | null;        // human-readable Board basis for the recommendation
  readonly differsFromCurrent: boolean; // true when the suggestion isn't how the case is framed now
}

const TIER_RANK: Record<string, number> = { high: 3, moderate: 2, low: 1 };

// The granted-SC condition with the best high/moderate Board pair to the claimed condition, or null.
// Shared by suggestPathway (the advisory "Anticipated" line) and computeStrategyPreview (the effective-
// anchor scoring) — so the rubric and the suggestion are computed off the SAME derived anchor and can
// never contradict each other (architect QA 2026-06-07: the Stocks self-contradiction).
export function bestGrantedScPair(input: StrategyPreviewInput): PairMatch | null {
  let best: PairMatch | null = null;
  const score = (s: PairMatch): number => (TIER_RANK[s.tier] ?? 0) * 1e6 + (s.imoWinPct ?? s.winPct) * 1e3 + s.n;
  for (const sc of input.serviceConnectedConditions) {
    const m = findPair(sc, input.claimedCondition);
    if (m === null) continue;
    if (best === null || score(m) > score(best)) best = m;
  }
  return best !== null && (best.tier === 'high' || best.tier === 'moderate') ? best : null;
}

// Deterministic pathway recommender: the strongest granted-SC Board pairing to the claimed condition.
// The basis string is PLAIN LANGUAGE — no raw BVA n / tier / win-rate ever renders on the card or in
// the payload (P1 re-source 2026-06-11; the internal pair numbers still rank candidates, they just
// never serialize).
export function suggestPathway(input: StrategyPreviewInput): PathwaySuggestion {
  const best = bestGrantedScPair(input);
  if (best === null) return { kind: 'direct', anchor: null, basis: null, differsFromCurrent: false };
  // Don't nag "switch to X" when already anchored on a condition that resolves to the SAME atlas pair.
  const curPair = input.upstreamScCondition ? findPair(input.upstreamScCondition, input.claimedCondition) : null;
  const differs = curPair === null || curPair.upstream !== best.upstream;
  return {
    kind: 'secondary',
    anchor: best.upstream,
    basis: 'established secondary pathway',
    differsFromCurrent: differs,
  };
}

export type StrategyTier = 'Strong' | 'Plausible' | 'Thin' | 'Stop';

export interface StrategyCriterion {
  readonly key: 'diagnosis' | 'anchor' | 'plausible' | 'pathway' | 'strength';
  readonly label: string;
  readonly pass: boolean;
  readonly detail: string;
  /**
   * Distinct AMBER state (P1e 3-state in-service check, 2026-06-11): the criterion is not satisfied
   * but is not a flat red ✗ either — e.g. a veteran-stated-but-uncorroborated in-service exposure.
   * Absent = the existing binary ✓/✗ rendering.
   */
  readonly tone?: 'amber';
}

export interface StrategyPreview {
  // false on a bare/untriaged case (no claimed condition entered yet) — the card stays hidden rather than
  // showing an alarming "Stop" for a claim nobody has framed (architect QA FIX-2).
  readonly evaluable: boolean;
  readonly primaryArgument: string;
  readonly proposedMechanism: string | null;
  readonly anchor: string | null;
  readonly tier: StrategyTier;
  readonly recommendedPathway: PathwaySuggestion;
  readonly criteria: readonly StrategyCriterion[];
  readonly summary: string;
}

export interface StrategyPreviewInput {
  readonly claimedCondition: string;
  readonly claimType: string;
  readonly framingChoice: string | null;
  readonly upstreamScCondition: string | null;
  readonly serviceConnectedConditions: readonly string[];
  readonly activeProblems: readonly string[];
  /** DISPLAY ONLY (the "Veteran's theory" line) — never feeds the pass/fail of any check (P1e). */
  readonly proposedMechanism?: string | null;
  /** The EXTRACTION-CORROBORATED in-service event — the only thing that turns the hook green (P1e). */
  readonly inServiceEvent?: string | null;
  /** The veteran's own statement — shown, and AMBER on the hook check, but never a pass (the Porter fix). */
  readonly veteranStatement?: string | null;
  /**
   * The viability-engine read for this case (band + one-line why), threaded in by the route from
   * deriveCaseViabilityForCase (flag-free, fail-open null). Sources the pathway/strength WORDING —
   * the deterministic cds gates keep driving the ✓/✗ booleans. Never carries a BVA n/%/win-rate
   * (structural in the resolver).
   */
  readonly viability?: { readonly band: string; readonly why: string } | null;
}

function framingLabel(framingChoice: string | null): string {
  const f = (framingChoice ?? '').toLowerCase();
  if (f.includes('aggrav')) return 'aggravation';
  if (f.includes('causa') || f.includes('secondary')) return 'causation';
  if (f.includes('direct')) return 'direct service connection';
  return 'causation';
}

function buildPrimaryArgument(input: StrategyPreviewInput, effectiveAnchor: string | null): string {
  const isSecondary = input.claimType.toLowerCase().includes('secondary') || effectiveAnchor != null;
  if (isSecondary) {
    const anchor = effectiveAnchor ?? '(no service-connected anchor set)';
    return `${input.claimedCondition} — secondary to service-connected ${anchor} (${framingLabel(input.framingChoice)})`;
  }
  return `${input.claimedCondition} — direct service connection`;
}

// Deterministic 5-criterion ladder over evaluateCds, mapped to a tier. Reproducible + explainable: the
// failing criteria are the "why". Tiering:
//   Stop      = a hard gate fired (barred theory / no diagnosis / no anchor) OR no established Board
//               pathway for the pairing (the knee->blindness catch — verify the theory before drafting).
//   Strong    = engine accept (good odds + a known pathway).
//   Plausible = engine caution WITH a known Board pathway (mid odds, established mechanism).
//   Thin      = engine reject (a known pathway, but weak odds).
export function computeStrategyPreview(input: StrategyPreviewInput): StrategyPreview {
  // EFFECTIVE ANCHOR: the stored upstreamScCondition is sometimes a garbage intake text-parse ("service I
  // wake up with headaches") that resolves to NO atlas pair + fails the SC-anchor check — which made the
  // rubric say "no anchor / no pair / Stop" while suggestPathway separately found the real granted-SC Board
  // pair (the Stocks self-contradiction). RECOVER only when the stored anchor is UNSCOREABLE: a granted-SC
  // condition with a high/moderate pair is authoritative (verified SC + Board data). We do NOT override a
  // stored anchor that IS scoreable — that would clobber a deliberate RN/aggravation framing (the
  // "Anticipated" line handles "stronger elsewhere"). framingChoice is left as stored. (architect QA 2026-06-07)
  const storedPair = input.upstreamScCondition ? findPair(input.upstreamScCondition, input.claimedCondition) : null;
  const recovered = storedPair === null ? bestGrantedScPair(input) : null;
  const effectiveAnchor = recovered !== null ? recovered.upstream : input.upstreamScCondition;

  const cds = evaluateCds({
    claimedCondition: input.claimedCondition,
    claimType: input.claimType,
    framingChoice: input.framingChoice,
    upstreamScCondition: effectiveAnchor,
    serviceConnectedConditions: input.serviceConnectedConditions,
    activeProblems: input.activeProblems,
  });

  const gate = cds.hardGate;
  const barred = gate.triggered && gate.rule === 'barred_theory';
  const noDx = gate.triggered && gate.rule === 'no_diagnosis';
  const noAnchor = gate.triggered && gate.rule === 'no_sc_anchor';
  // The BVA atlas holds ONLY secondary pairs, so its pathway/strength signals apply only to secondary
  // claims. A direct claim has no pairing by construction — absence of a pair is "rely on literature",
  // NEVER a blocker (architect + physician review 2026-06-07: don't false-Stop every direct claim).
  const isSecondary = input.claimType.toLowerCase().includes('secondary')
    || effectiveAnchor != null
    || /secondary|aggravat/.test((input.framingChoice ?? '').toLowerCase());
  // A direct claim's whole case is the in-service event/onset + the veteran's account of it. 3-STATE
  // (P1e, the Porter fix 2026-06-11): "documented" keys ONLY on the extraction-corroborated
  // inServiceEvent — a veteran's unverified statement alone is AMBER (shown, never a pass), and
  // neither is "absent" red. The old boolean let veteranStatement satisfy the green check and the
  // tier read "Plausible" on an uncorroborated story. If the document-pipeline lane later adds a
  // stronger corroboration signal, widen 'documented' to include it then.
  type InServiceState = 'documented' | 'stated_only' | 'absent';
  const inServiceState: InServiceState =
    (input.inServiceEvent ?? '').trim().length > 0 ? 'documented'
      : (input.veteranStatement ?? '').trim().length > 0 ? 'stated_only'
        : 'absent';

  // CHANGE 1 — TIER RESCUE (Option A): a THIN-sample pair (tier !== 'high', i.e. n<~40) whose grant rate
  // is a near-miss (40% <= grantPct < 50%) leans on the established mechanism rather than reading as a flat
  // "Thin" — the Board record is thin, not adverse. A thin sample that's clearly low (<40%) STAYS Thin; a
  // ROBUST pair (tier==='high') keeps its verdict-driven tier (robust-and-low stays Thin). Only applies to
  // a matched pair, never to a hard gate (Stop) or the no-pathway case. (owner-approved 2026-06-07)
  const grantPct = cds.bva.grantPct;
  const thinSampleRescue =
    cds.bva.matched &&
    cds.bva.tier !== 'high' &&
    grantPct != null &&
    grantPct >= 40 &&
    grantPct < 50;

  // P1 RE-SOURCE (2026-06-11, Ryan items 2+5): the two BVA-pair-atlas strings ("Established Board
  // pathway … (n=60, tier high)" and "Granted in 45 of 60 decided Board appeals (75%)") are GONE —
  // no raw BVA n / % / win-rate / tier ever serializes. The pathway/strength TEXT is band-sourced
  // plain language (the viability engine's one-line why); the cds booleans keep driving the ✓/✗.
  const viabilityWhy = (input.viability?.why ?? '').trim();

  const criteria: StrategyCriterion[] = [
    {
      key: 'diagnosis',
      label: 'Current diagnosis on file',
      pass: !noDx,
      detail: noDx
        ? (gate.detail ?? 'No current diagnosis recorded')
        : `${input.activeProblems.length} active problem(s) recorded${input.activeProblems.length > 15 ? ' — unusually high; verify the problem list extracted correctly' : ''}`,
    },
    {
      key: 'anchor',
      label: isSecondary ? 'Service-connected anchor present' : 'In-service event documented',
      pass: isSecondary ? !noAnchor : inServiceState === 'documented',
      // AMBER (3rd state): stated-but-uncorroborated — displayed distinctly, never a pass (P1e).
      ...(!isSecondary && inServiceState === 'stated_only' ? { tone: 'amber' as const } : {}),
      detail: isSecondary
        ? (noAnchor ? (gate.detail ?? 'No service-connected anchor') : `Anchored on ${effectiveAnchor}`)
        : inServiceState === 'documented'
          ? 'In-service event documented in the record'
          : inServiceState === 'stated_only'
            ? 'Veteran states an in-service exposure — not yet corroborated in the record; verify the DD-214/service records before drafting.'
            : 'No in-service event or veteran account on file yet — confirm the nexus hook before drafting',
    },
    {
      key: 'plausible',
      label: 'Theory is not barred',
      pass: !barred,
      detail: barred ? (gate.detail ?? 'Theory is statutorily / medically barred') : 'No statutory / medical-impossibility bar detected',
    },
    {
      key: 'pathway',
      label: isSecondary ? 'Recognized secondary pathway for the pairing' : 'Secondary pathway (secondary claims only)',
      pass: isSecondary ? cds.bva.matched : true, // N/A for direct claims — never a ✗ for absent secondary data
      detail: !isSecondary
        ? 'Direct claim — a secondary pathway does not apply'
        : cds.bva.matched
          ? `Recognized secondary pathway: ${cds.bva.upstream} → ${cds.bva.claimed}`
          : 'No recognized pathway on record — would rely on medical literature; confirm the theory is sound',
    },
    {
      key: 'strength',
      label: 'No adverse strength signal',
      // ✗ ONLY when the engine actively recommends reject AND the pair wasn't rescued as a thin near-miss —
      // a rescued Plausible must not show an adverse ✗ (it rests on mechanism, thin Board sample).
      pass: cds.verdict !== 'reject' || thinSampleRescue,
      // Band-sourced wording: the viability engine's one-line why (its band word leads the line, e.g.
      // "Strong: …" / "Aggravation only: …"). Fail-open (viability null) and direct claims get plain
      // non-numeric copy — never a Board count or rate.
      detail: !isSecondary
        ? 'Not applicable to a direct claim — strength rests on the record and the medical literature'
        : viabilityWhy.length > 0
          ? viabilityWhy
          : 'Viability read unavailable — rests on the established mechanism and the medical literature',
    },
  ];

  let tier: StrategyTier;
  if (gate.triggered) tier = 'Stop';
  else if (cds.verdict === 'accept') tier = 'Strong';
  // A verdict-reject pair is normally Thin — UNLESS it's a thin-sample near-miss, which we rescue to
  // Plausible (lean on mechanism; the Board record is thin, not adverse). See thinSampleRescue above.
  else if (cds.verdict === 'reject') tier = thinSampleRescue ? 'Plausible' : 'Thin';
  // caution: Plausible normally; Thin (not Stop) when a real gap exists — a SECONDARY claim with no Board
  // pair (rely on literature), OR a DIRECT claim with no in-service hook on file (we don't know the nexus
  // story yet). NEVER Stop on absent data — Stop is only a hard gate above. (FIX 2026-06-07)
  else if (isSecondary && !cds.bva.matched) tier = 'Thin';
  // An amber-only hook (stated_only) must NEVER read "Plausible" — both stated_only and absent
  // yield Thin on a direct claim until the in-service event is corroborated (P1e, the Porter fix).
  else if (!isSecondary && inServiceState !== 'documented') tier = 'Thin';
  else tier = 'Plausible';

  const mech = (input.proposedMechanism ?? '').trim();
  // cds.summary carries raw BVA stats ("Accept: 82.1% IMO BVA win rate (… n=688, tier high)") —
  // it must NEVER serialize (P1 no-BVA-string lock). Band-sourced why when available, else a plain
  // verdict line. cdsEngine itself is untouched (other consumers keep their richer summary).
  const plainSummary = viabilityWhy.length > 0
    ? viabilityWhy
    : cds.verdict === 'accept'
      ? 'Recognized pathway with no adverse signal on record.'
      : cds.verdict === 'reject'
        ? 'Adverse signal on record — review the pathway before drafting.'
        : 'Verify the theory against the record before drafting.';
  return {
    evaluable: input.claimedCondition.trim().length > 0,
    primaryArgument: buildPrimaryArgument(input, effectiveAnchor),
    proposedMechanism: mech.length > 0 ? mech : null,
    anchor: effectiveAnchor,
    tier,
    recommendedPathway: suggestPathway(input),
    criteria,
    summary: plainSummary,
  };
}
