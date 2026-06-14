// Pre-draft STRATEGY PREVIEW — a deterministic, reproducible read of what argument the draft will make
// and how viable it is, shown BEFORE "Send to drafter" so a human can catch a crazy pathway ("knee pain
// doesn't cause blindness — argue the toxic exposure instead") before spending ~$15.
//
// This is a THIN composition over the existing deterministic engine (cdsEngine.evaluateCds) — NOT a new
// scorer. Same chart in -> same tier out (no LLM). The redirect rides on the existing strategyOverride
// steer; a material mid-draft theory change re-surfaces via Gate-2. Critical: compute LIVE here, never
// read the stale Case.cdsVerdict column.

import { evaluateCds, findPair, type PairMatch } from './cdsEngine.js';
import { runStrategyAiChecks, type StrategyAiChecks } from './strategy-ai-checks.js';

export interface PathwaySuggestion {
  readonly kind: 'direct' | 'secondary';
  readonly anchor: string | null;       // the granted SC condition, for a secondary recommendation
  readonly basis: string | null;        // human-readable Board basis for the recommendation
  readonly differsFromCurrent: boolean; // true when the suggestion isn't how the case is framed now
}

const TIER_RANK: Record<string, number> = { high: 3, moderate: 2, low: 1 };

// E5 trustworthy viability (2026-06-13) — INTERMEDIARY CHAIN.
// A two-hop secondary pathway: a granted SC condition → an intermediary (a comorbid dx or a
// med-treated condition the chart records) → the claimed condition. We compose the engine's
// READ-ONLY findPair twice (no scoring lives here — cdsEngine is untouched). This runs ONLY as a
// rescue when no DIRECT granted-SC pair exists, so a flat "no" auto-explores the chain the Board
// recognizes (tinnitus→anxiety(SC)→OSA; a sedating med's indication as the bridge) before the RN
// trusts a decline. Advisory only — never changes the deterministic tier/booleans.
export interface ChainHop {
  readonly from: string;
  readonly to: string;
  /** Each hop is a recognized Board secondary pair (findPair matched) — tier carried for display only. */
  readonly tier: 'high' | 'moderate' | 'low';
}

export interface ChainPathway {
  /** The granted SC condition at the head of the chain. */
  readonly anchor: string;
  /** The non-SC bridge (a comorbid dx or a med-treated condition) between the anchor and the claim. */
  readonly intermediary: string;
  /** anchor → intermediary, intermediary → claimed. */
  readonly hops: readonly [ChainHop, ChainHop];
  /** Where the intermediary came from, for the card's "computed from" honesty. */
  readonly intermediarySource: 'comorbid_dx' | 'medication_indication';
}

// The weakest hop's tier ranks a candidate chain (a chain is only as strong as its weakest link);
// ties break on the anchor-hop tier then the head anchor's stable order.
function chainScore(c: ChainPathway): number {
  const weakest = Math.min(TIER_RANK[c.hops[0].tier] ?? 0, TIER_RANK[c.hops[1].tier] ?? 0);
  return weakest * 1e3 + (TIER_RANK[c.hops[0].tier] ?? 0);
}

/**
 * Find the best SC → intermediary → claimed two-hop pathway, or null. PURE: composes the engine's
 * exported findPair (read-only) — it introduces NO new scoring. `intermediaries` are the candidate
 * bridges the chart actually recorded (comorbid problems + med-treated conditions), each tagged with
 * its provenance so the UI can be honest about where the bridge came from. A self-pair
 * (intermediary === claimed or intermediary === anchor by atlas key) is skipped — a real chain has a
 * distinct middle node. Returns the strongest by weakest-hop tier (a chain is only as strong as its
 * weakest link).
 */
export function findChainPathway(
  claimedCondition: string,
  grantedScConditions: readonly string[],
  intermediaries: ReadonlyArray<{ readonly label: string; readonly source: 'comorbid_dx' | 'medication_indication' }>,
): ChainPathway | null {
  let best: ChainPathway | null = null;
  for (const sc of grantedScConditions) {
    for (const inter of intermediaries) {
      const hop1 = findPair(sc, inter.label); // anchor → intermediary
      if (hop1 === null) continue;
      const hop2 = findPair(inter.label, claimedCondition); // intermediary → claimed
      if (hop2 === null) continue;
      // Reject a degenerate chain where the bridge collapses onto either end by atlas key — that's a
      // direct pair, not a chain (e.g. the intermediary normalizes to the claimed or anchor key).
      if (hop1.upstream === hop2.claimed) continue; // anchor key === claimed key
      if (hop1.claimed === hop1.upstream || hop2.claimed === hop2.upstream) continue;
      const candidate: ChainPathway = {
        anchor: sc,
        intermediary: inter.label,
        hops: [
          { from: hop1.upstream, to: hop1.claimed, tier: hop1.tier },
          { from: hop2.upstream, to: hop2.claimed, tier: hop2.tier },
        ],
        intermediarySource: inter.source,
      };
      if (best === null || chainScore(candidate) > chainScore(best)) best = candidate;
    }
  }
  return best;
}

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
  readonly key: 'diagnosis' | 'anchor' | 'plausible' | 'pathway' | 'strength' | 'presumptive';
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

// E5 trustworthy viability (2026-06-13) — INPUT VISIBILITY. The exact fact set the verdict was
// COMPUTED FROM, so a missing SC condition / med is obvious at a glance and a thin-parse "no" is
// distrusted on sight (the Woodley lesson — a verdict you can't see the inputs to is untrustworthy).
// DISPLAY ONLY: this never feeds any check; it mirrors the inputs the engine already received.
export interface StrategyInputSet {
  /** The granted-SC conditions the viability/engine actually scored against. */
  readonly scConditions: readonly string[];
  /** Current meds (drug + indication) — the bridge candidates for the intermediary chain. */
  readonly medications: ReadonlyArray<{ readonly drugName: string; readonly indication: string | null }>;
  /** The extracted comorbid problem list. */
  readonly activeProblems: readonly string[];
  /** Key clinical facts the strategy turns on (e.g. weight) — label/value pairs, never fabricated. */
  readonly keyFacts: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  /** Total distinct facts fed in — the headline "Computed from N facts" count. */
  readonly factCount: number;
}

// E5 — INTERMEDIARY CHECK result. Present (non-null) only when the deterministic ladder found NO
// direct granted-SC pathway AND a two-hop chain was recovered. Advisory; never moves the tier.
export interface ChainAttempt {
  readonly searched: boolean;
  readonly pathway: ChainPathway | null;
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
  /**
   * True only when the AI judgment checks (Sonnet 4.6) ran and overlaid the dx-match / presumptive
   * criteria (flag STRATEGY_AI_CHECKS_ENABLED on, call succeeded). Absent/false = the deterministic
   * preview, byte-identical to before this feature. Lets the UI label the AI-sourced rows.
   */
  readonly aiChecked?: boolean;
  /**
   * E5 INPUT VISIBILITY — the fact set this verdict was computed from. Absent on legacy callers that
   * don't supply it (the field is opt-in via input.inputSet); the card simply hides the section.
   */
  readonly inputSet?: StrategyInputSet;
  /**
   * E5 INTERMEDIARY CHECK — populated only when the direct pathway failed and we searched the chain.
   * `pathway` is null when no chain was found (then the decline stands, but the card SHOWS that the
   * chain was searched — an honest "we looked"). Absent when a direct pathway already exists.
   */
  readonly chainAttempt?: ChainAttempt;
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
  /**
   * E5 (2026-06-13) — the chart's current meds, each as a bridge candidate for the intermediary
   * chain (drugName + the indication that names the condition the med treats). Absent = no chain
   * bridge from meds (the comorbid problem list is still used). DISPLAY + chain-search only.
   */
  readonly medications?: ReadonlyArray<{ readonly drugName: string; readonly indication: string | null }>;
  /**
   * E5 — key clinical facts to surface in the input set (weight, AHI, BMI…). The route assembles
   * these from the chart; DISPLAY ONLY, never feeds a check.
   */
  readonly keyFacts?: ReadonlyArray<{ readonly label: string; readonly value: string }>;
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

  // E5 INPUT VISIBILITY — mirror the fact set this verdict was computed from (display only). factCount
  // is the distinct count of SC conditions + meds + active problems + key facts: the headline number
  // an RN scans to catch a thin parse ("computed from 2 facts" on a 1,119pp chart is a red flag).
  const meds = input.medications ?? [];
  const keyFacts = input.keyFacts ?? [];
  const inputSet: StrategyInputSet = {
    scConditions: input.serviceConnectedConditions,
    medications: meds,
    activeProblems: input.activeProblems,
    keyFacts,
    factCount: input.serviceConnectedConditions.length + meds.length + input.activeProblems.length + keyFacts.length,
  };

  // E5 INTERMEDIARY CHECK — when a SECONDARY claim found NO direct granted-SC pathway (no atlas pair
  // matched), auto-search the two-hop chain before the decline stands. Bridges = the comorbid problem
  // list + each med's indication (the med-treating-the-primary bridge). Advisory: the recovered chain
  // never moves the deterministic tier — it just gives the RN the pathway the flat "no" was hiding.
  let chainAttempt: ChainAttempt | undefined;
  const directPathwayMissing = isSecondary && !cds.bva.matched && !gate.triggered;
  if (directPathwayMissing) {
    const bridges: Array<{ label: string; source: 'comorbid_dx' | 'medication_indication' }> = [
      ...input.activeProblems.map((p) => ({ label: p, source: 'comorbid_dx' as const })),
      ...meds
        .map((m) => (m.indication ?? '').trim())
        .filter((ind) => ind.length > 0)
        .map((ind) => ({ label: ind, source: 'medication_indication' as const })),
    ];
    const pathway = findChainPathway(input.claimedCondition, input.serviceConnectedConditions, bridges);
    chainAttempt = { searched: true, pathway };
  }

  return {
    evaluable: input.claimedCondition.trim().length > 0,
    primaryArgument: buildPrimaryArgument(input, effectiveAnchor),
    proposedMechanism: mech.length > 0 ? mech : null,
    anchor: effectiveAnchor,
    tier,
    recommendedPathway: suggestPathway(input),
    criteria,
    summary: plainSummary,
    inputSet,
    ...(chainAttempt ? { chainAttempt } : {}),
  };
}

// ============================================================================
// E0 — AI judgment-check overlay (Sonnet 4.6, behind STRATEGY_AI_CHECKS_ENABLED)
// ============================================================================

export interface StrategyAiOverlayInput {
  /** Free-text deployment / exposure facts (locations, dates, MOS) for the PACT/TERA judgment. */
  readonly deploymentFacts?: string | null;
}

/**
 * Overlay the AI JUDGMENT checks onto a deterministic preview. HYBRID: the deterministic
 * `computeStrategyPreview` runs first (it always does), then — only when the flag is on AND the Sonnet
 * call succeeds — we apply three overlays:
 *   1. RESCUE a token-overlap false-negative SC-ANCHOR (E0 SC-anchor equivalence, 2026-06-13) by
 *      recomputing the deterministic ladder with the grounded clinically-equivalent SC condition as the
 *      anchor — rescue-only, never a downgrade (Stop is the floor; the AI only supplies a verified SC
 *      string the engine then scores honestly). It can never turn a passing anchor into a fail.
 *   2. REPLACE the dumb "diagnosis count" check with a GROUNDED dx-match.
 *   3. SURFACE a PACT/TERA presumptive row FIRST when eligible.
 *
 * FAIL-OPEN + FLAG-OFF: `runStrategyAiChecks` returns null when the flag is off or on any error, and on
 * null we return the deterministic preview OBJECT UNCHANGED (byte-identical, `aiChecked` absent). The AI
 * is never called when the flag is off, so there is no spend in the default path.
 *
 * Async + separate from computeStrategyPreview so the deterministic core stays sync and its other
 * consumers (case-framing, cds) are untouched. The route awaits this.
 */
export async function computeStrategyPreviewWithAi(
  input: StrategyPreviewInput & StrategyAiOverlayInput,
): Promise<StrategyPreview> {
  const base = computeStrategyPreview(input);
  if (!base.evaluable) return base; // nothing framed yet — never spend a call on a bare case

  const ai: StrategyAiChecks | null = await runStrategyAiChecks({
    claimedCondition: input.claimedCondition,
    activeProblems: input.activeProblems,
    serviceConnectedConditions: input.serviceConnectedConditions,
    upstreamScCondition: input.upstreamScCondition ?? null,
    deploymentFacts: input.deploymentFacts ?? null,
    veteranStatement: input.veteranStatement ?? null,
  });
  if (ai === null) return base; // flag off OR fail-open → deterministic preview, byte-identical

  // SC-ANCHOR RESCUE (E0 SC-anchor equivalence, 2026-06-13). The deterministic anchor check is dumb
  // TOKEN-OVERLAP (cdsEngine.hasScAnchor): Woodley's secondary-to-PTSD theory failed the ✗ because his
  // service-connected trauma dx is recorded as "Other Specified Trauma/Stressor Disorder" — zero shared
  // tokens with "PTSD", though it is the SAME clinical entity. When the deterministic anchor criterion
  // FAILED but the AI found a GROUNDED clinically-equivalent SC condition, we RECOMPUTE the deterministic
  // preview with that real SC string injected as the upstream anchor — the engine then scores the whole
  // ladder honestly (anchor ✓, real BVA pair, real tier) instead of a contradictory ✓-anchor-on-a-Stop.
  //
  // RESCUE-ONLY, NEVER DOWNGRADE (HARD): we recompute on a VERIFIED service-connected condition the AI
  // grounded against the SC list, so the new base can only be EQUAL-OR-BETTER than the prior Stop (Stop
  // is the floor tier). We apply it ONLY when the deterministic anchor criterion was failing — the AI
  // can rescue a false-negative anchor, but it can NEVER turn a passing anchor into a fail (a matched:true
  // when the anchor already passed is a no-op). Barred-theory / no-diagnosis gates are NOT anchor failures
  // and are untouched by this path.
  const detAnchor = base.criteria.find((c) => c.key === 'anchor') ?? null;
  const isSecondaryBase =
    input.claimType.toLowerCase().includes('secondary') ||
    base.anchor != null ||
    /secondary|aggravat/.test((input.framingChoice ?? '').toLowerCase());
  const anchorWasFailing = isSecondaryBase && detAnchor !== null && detAnchor.pass === false;
  let rescuedBase = base;
  // Nullish-guard: a mocked/older ai object may omit scAnchorMatch entirely (treated as no rescue).
  const scMatch = ai.scAnchorMatch ?? null;
  if (
    anchorWasFailing &&
    scMatch !== null &&
    scMatch.matched &&
    scMatch.matchedCondition !== null
  ) {
    const matchedSc = scMatch.matchedCondition;
    // Recompute deterministically with the grounded SC condition as the anchor. matchedSc is verified to
    // be one of serviceConnectedConditions, so cdsEngine.hasScAnchor now passes and the no_sc_anchor gate
    // no longer fires — the tier + downstream criteria recompute off a real, service-connected anchor.
    const recomputed = computeStrategyPreview({ ...input, upstreamScCondition: matchedSc });
    // Cite the equivalence on the anchor row so the card explains WHY the token-mismatched anchor holds.
    const rescuedAnchor: StrategyCriterion = {
      key: 'anchor',
      label: recomputed.criteria.find((c) => c.key === 'anchor')?.label ?? 'Service-connected anchor present',
      pass: true,
      detail: `${input.upstreamScCondition ?? 'Upstream'} anchored by service-connected ${matchedSc} — ${scMatch.note}`,
    };
    rescuedBase = {
      ...recomputed,
      criteria: recomputed.criteria.map((c) => (c.key === 'anchor' ? rescuedAnchor : c)),
    };
  }
  // From here the overlay (dx-match replace + presumptive surface) runs on the (possibly rescued) base.
  const overlayBase = rescuedBase;

  // Replace the diagnosis criterion with the GROUNDED dx-match. The model cites the documented dx it
  // matched (verified present in strategy-ai-checks) or we render an honest "no documented match" — the
  // Porter fix: a claim with no matching dx no longer shows a false "dx on file ✓".
  const dxCriterion: StrategyCriterion = {
    key: 'diagnosis',
    label: 'Documented diagnosis matches the claim',
    pass: ai.dxMatch.matched,
    detail: ai.dxMatch.matched && ai.dxMatch.matchedDx !== null
      ? `Matched documented diagnosis: "${ai.dxMatch.matchedDx}"`
      : `No documented diagnosis matches "${input.claimedCondition}" — ${ai.dxMatch.note}`,
  };
  const overlaid: StrategyCriterion[] = overlayBase.criteria.map((c) => (c.key === 'diagnosis' ? dxCriterion : c));

  // SURFACE PRESUMPTIVE FIRST when eligible (PACT/TERA short-circuits the usual secondary analysis —
  // a presumptive claim is the strongest path and the RN should see it before anything else). When not
  // eligible we still add a (passing-N/A) row so the auto-TERA flag is visible, but at the END.
  const presRow: StrategyCriterion = {
    key: 'presumptive',
    label: 'Presumptive eligibility (PACT / TERA)',
    pass: ai.presumptive.eligible,
    detail: ai.presumptive.eligible
      ? `${ai.presumptive.program ?? 'Presumptive'} presumptive${ai.presumptive.teraAutoFlagged ? ' — TERA auto-flagged from a covered deployment' : ''}: ${ai.presumptive.note}`
      : ai.presumptive.teraAutoFlagged
        ? `TERA auto-flagged from a covered deployment, but the claimed condition is not presumptive: ${ai.presumptive.note}`
        : `Not presumptive under PACT/TERA: ${ai.presumptive.note}`,
  };
  const criteria = ai.presumptive.eligible ? [presRow, ...overlaid] : [...overlaid, presRow];

  // Spread overlayBase (NOT base) so a rescued tier/anchor/summary carries through to the response.
  return { ...overlayBase, criteria, aiChecked: true };
}
