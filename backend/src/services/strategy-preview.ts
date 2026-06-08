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
export function suggestPathway(input: StrategyPreviewInput): PathwaySuggestion {
  const best = bestGrantedScPair(input);
  if (best === null) return { kind: 'direct', anchor: null, basis: null, differsFromCurrent: false };
  // Don't nag "switch to X" when already anchored on a condition that resolves to the SAME atlas pair.
  const curPair = input.upstreamScCondition ? findPair(input.upstreamScCondition, input.claimedCondition) : null;
  const differs = curPair === null || curPair.upstream !== best.upstream;
  return {
    kind: 'secondary',
    anchor: best.upstream,
    basis: `Board pairing n=${best.n}, tier ${best.tier}${best.imoWinPct != null ? `, IMO ${best.imoWinPct}%` : ''}`,
    differsFromCurrent: differs,
  };
}

export type StrategyTier = 'Strong' | 'Plausible' | 'Thin' | 'Stop';

export interface StrategyCriterion {
  readonly key: 'diagnosis' | 'anchor' | 'plausible' | 'pathway' | 'strength';
  readonly label: string;
  readonly pass: boolean;
  readonly detail: string;
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
  readonly proposedMechanism?: string | null; // the veteran's stated theory / in-service event
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
  // A direct claim's whole case is the in-service event/onset + the veteran's account of it. No hook on
  // file = we don't yet know the nexus story — the #1 pre-draft gap for a direct claim, and why everything
  // was falsely passing (physician review 2026-06-07). proposedMechanism = inServiceEvent ?? veteranStatement.
  const hasInServiceHook = (input.proposedMechanism ?? '').trim().length > 0;

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
      label: isSecondary ? 'Service-connected anchor present' : 'In-service event / veteran account on file',
      pass: isSecondary ? !noAnchor : hasInServiceHook,
      detail: isSecondary
        ? (noAnchor ? (gate.detail ?? 'No service-connected anchor') : `Anchored on ${effectiveAnchor}`)
        : (hasInServiceHook ? 'Veteran account / in-service event on file' : 'No in-service event or veteran account on file yet — confirm the nexus hook before drafting'),
    },
    {
      key: 'plausible',
      label: 'Theory is not barred',
      pass: !barred,
      detail: barred ? (gate.detail ?? 'Theory is statutorily / medically barred') : 'No statutory / medical-impossibility bar detected',
    },
    {
      key: 'pathway',
      label: isSecondary ? 'Established Board pathway for the pairing' : 'Board pairing (secondary claims only)',
      pass: isSecondary ? cds.bva.matched : true, // N/A for direct claims — never a ✗ for absent secondary data
      detail: !isSecondary
        ? 'Direct claim — a Board secondary-pairing does not apply'
        : cds.bva.matched
          ? `${cds.bva.upstream} → ${cds.bva.claimed} (n=${cds.bva.n}, tier ${cds.bva.tier})`
          : 'No Board pair on record — would rely on medical literature; confirm the theory is sound',
    },
    {
      key: 'strength',
      label: 'No adverse strength signal',
      pass: cds.verdict !== 'reject', // ✗ ONLY when the engine actively recommends reject (a real low-odds pair)
      detail: cds.oddsPct != null
        ? `${cds.oddsPct}% Board signal (relative ranking, not a win probability)`
        : 'No Board odds — normal for a direct or novel claim; rests on the record + literature',
    },
  ];

  let tier: StrategyTier;
  if (gate.triggered) tier = 'Stop';
  else if (cds.verdict === 'accept') tier = 'Strong';
  else if (cds.verdict === 'reject') tier = 'Thin';
  // caution: Plausible normally; Thin (not Stop) when a real gap exists — a SECONDARY claim with no Board
  // pair (rely on literature), OR a DIRECT claim with no in-service hook on file (we don't know the nexus
  // story yet). NEVER Stop on absent data — Stop is only a hard gate above. (FIX 2026-06-07)
  else if (isSecondary && !cds.bva.matched) tier = 'Thin';
  else if (!isSecondary && !hasInServiceHook) tier = 'Thin';
  else tier = 'Plausible';

  const mech = (input.proposedMechanism ?? '').trim();
  return {
    evaluable: input.claimedCondition.trim().length > 0,
    primaryArgument: buildPrimaryArgument(input, effectiveAnchor),
    proposedMechanism: mech.length > 0 ? mech : null,
    anchor: effectiveAnchor,
    tier,
    recommendedPathway: suggestPathway(input),
    criteria,
    summary: cds.summary,
  };
}
