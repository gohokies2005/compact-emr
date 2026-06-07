// Pre-draft STRATEGY PREVIEW — a deterministic, reproducible read of what argument the draft will make
// and how viable it is, shown BEFORE "Send to drafter" so a human can catch a crazy pathway ("knee pain
// doesn't cause blindness — argue the toxic exposure instead") before spending ~$15.
//
// This is a THIN composition over the existing deterministic engine (cdsEngine.evaluateCds) — NOT a new
// scorer. Same chart in -> same tier out (no LLM). The redirect rides on the existing strategyOverride
// steer; a material mid-draft theory change re-surfaces via Gate-2. Critical: compute LIVE here, never
// read the stale Case.cdsVerdict column.

import { evaluateCds } from './cdsEngine.js';

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

function buildPrimaryArgument(input: StrategyPreviewInput): string {
  const isSecondary = input.claimType.toLowerCase().includes('secondary') || input.upstreamScCondition != null;
  if (isSecondary) {
    const anchor = input.upstreamScCondition ?? '(no service-connected anchor set)';
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
  const cds = evaluateCds({
    claimedCondition: input.claimedCondition,
    claimType: input.claimType,
    framingChoice: input.framingChoice,
    upstreamScCondition: input.upstreamScCondition,
    serviceConnectedConditions: input.serviceConnectedConditions,
    activeProblems: input.activeProblems,
  });

  const gate = cds.hardGate;
  const barred = gate.triggered && gate.rule === 'barred_theory';
  const noDx = gate.triggered && gate.rule === 'no_diagnosis';
  const noAnchor = gate.triggered && gate.rule === 'no_sc_anchor';

  const criteria: StrategyCriterion[] = [
    {
      key: 'diagnosis',
      label: 'Current diagnosis on file',
      pass: !noDx,
      detail: noDx ? (gate.detail ?? 'No current diagnosis recorded') : `${input.activeProblems.length} active problem(s) recorded`,
    },
    {
      key: 'anchor',
      label: 'Service-connected anchor present',
      pass: !noAnchor,
      detail: noAnchor ? (gate.detail ?? 'No service-connected anchor') : (input.upstreamScCondition ? `Anchored on ${input.upstreamScCondition}` : 'Direct claim — no secondary anchor needed'),
    },
    {
      key: 'plausible',
      label: 'Theory is not barred',
      pass: !barred,
      detail: barred ? (gate.detail ?? 'Theory is statutorily / medically barred') : 'No statutory / medical-impossibility bar detected',
    },
    {
      key: 'pathway',
      label: 'Established Board pathway for the pairing',
      pass: cds.bva.matched,
      detail: cds.bva.matched
        ? `${cds.bva.upstream} → ${cds.bva.claimed} (n=${cds.bva.n}, tier ${cds.bva.tier})`
        : 'No Board pair on record for this pairing — would rely on medical literature; confirm the theory is sound',
    },
    {
      key: 'strength',
      label: 'Adequate strength signal',
      pass: cds.verdict === 'accept',
      detail: cds.oddsPct != null ? `${cds.oddsPct}% Board signal (relative ranking, not a win probability)` : 'No quantified signal',
    },
  ];

  let tier: StrategyTier;
  if (gate.triggered) tier = 'Stop';
  else if (cds.verdict === 'accept') tier = 'Strong';
  else if (cds.verdict === 'reject') tier = 'Thin';
  else tier = cds.bva.matched ? 'Plausible' : 'Stop'; // caution: matched=mid-odds Plausible; unmatched=no pathway, Stop

  const mech = (input.proposedMechanism ?? '').trim();
  return {
    evaluable: input.claimedCondition.trim().length > 0,
    primaryArgument: buildPrimaryArgument(input),
    proposedMechanism: mech.length > 0 ? mech : null,
    anchor: input.upstreamScCondition,
    tier,
    criteria,
    summary: cds.summary,
  };
}
