// Pre-sign theory reconciliation (Ryan 2026-07-11): above the "Considerations before signing" list the
// physician should see (1) the veteran's OWN stated theory (their literal intake words + what they
// claimed + what they said it's secondary to), (2) what the LETTER argues (the diagnosis + causation
// theory the drafter's route-picker plan led with), and (3) ONLY when the two DON'T match, a plain
// reason why + — when the veteran's anchor was itself a considered alternative — a nudge toward a brief
// surgical edit (physician discretion).
//
// PURE + DETERMINISTIC: the RECONCILIATION is pure string ops over structured Case fields (no LLM, no
// letter-text parse — nothing to hallucinate in the compare). Block 2's CONTENT is route-picker output
// (an AI artifact) and reflects the PLAN the drafter followed; in rare cases the drafter can diverge
// from the plan (a known limitation, honestly labeled).
//
// SAFETY (3-agent QA 2026-07-11): NO positive "✓ matches" affirmation is ever emitted — a green
// reassurance on a legal sign-off surface risks a FALSE positive, so we only WARN on a clear divergence.
// When the framing on file was RN-adjusted (framingStampSource='manual') the derived theory is the RN's,
// so it is labeled as such and the mismatch check is skipped (the literal veteranStatement is the
// veteran's ground truth). Fail-open: a missing route-picker plan just hides blocks 2+3.
import type { AiViabilityCard } from '../api/case-viability';

export interface PreSignTheoryInput {
  readonly claimedCondition?: string;
  readonly claimedConditions?: readonly string[];
  readonly framingChoice?: string;
  readonly upstreamScCondition?: string;
  readonly veteranStatement?: string;
  readonly aiViabilityPlanJson?: AiViabilityCard | null;
  // 'manual' ⇒ the framing/upstream on the row was set/adjusted by the RN, NOT the veteran.
  readonly framingStampSource?: string | null;
}

export interface PreSignTheory {
  /** The veteran's literal intake paragraph (why they think they're service-connected), or null. */
  readonly veteranStatement: string | null;
  /** The condition(s) the veteran claimed. */
  readonly veteranClaim: string | null;
  /** The veteran's stated causation theory, e.g. "Secondary to service-connected ankle". */
  readonly veteranTheory: string | null;
  /** Label for the theory line: "Their theory" normally, "Framing on file (RN-adjusted)" when manual. */
  readonly veteranTheoryLabel: string;
  /** The diagnosis the letter argues (route-picker lead.claimed), or null when no plan. */
  readonly letterDx: string | null;
  /** The causation theory the letter argues, e.g. "OSA secondary to PTSD" / "Direct — fall in service". */
  readonly letterTheory: string | null;
  /** Present ONLY when the veteran's theory and the letter's theory clearly differ. */
  readonly mismatch: { readonly reason: string | null; readonly suggestEdit: boolean } | null;
  /** Whether there is anything to render at all. */
  readonly hasContent: boolean;
}

type Framing = 'secondary' | 'direct' | 'aggravation' | 'other';

function norm(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function nonEmpty(s: string | null | undefined): string | null {
  return (s ?? '').trim() || null;
}

function framingBucket(f: string | null | undefined): Framing {
  const n = norm(f);
  if (n.includes('secondary')) return 'secondary';
  if (n.includes('aggrav')) return 'aggravation';
  if (n.includes('direct')) return 'direct';
  return 'other';
}

// Laterality / severity / generic-medical tokens that must NOT count as a condition match — otherwise
// "Right knee strain" vs "Right shoulder impingement" collide on "right" and a real upstream mismatch is
// silently swallowed (or the wrong alternative's reason is shown). (3-agent QA 2026-07-11.)
const MATCH_STOPWORDS = new Set([
  'left', 'right', 'chronic', 'acute', 'bilateral', 'joint', 'pain', 'disorder', 'syndrome', 'disease',
  'condition', 'mild', 'moderate', 'severe', 'service', 'connected', 'status', 'post', 'spine', 'strain',
  'injury', 'residuals',
]);
function significantTokens(n: string): string[] {
  return n.split(' ').filter((t) => t.length >= 4 && !MATCH_STOPWORDS.has(t));
}

// Acronym ↔ expansion equivalence so "PTSD" ~ "post traumatic stress disorder", "OSA" ~ "obstructive
// sleep apnea", "GERD" ~ "gastroesophageal reflux disease" don't FALSE-differ (AI-SME QA 2026-07-11).
function initialsOf(n: string): string {
  return n.split(' ').filter(Boolean).map((t) => t[0]).join('');
}
function acronymMatch(na: string, nb: string): boolean {
  const isAcr = (s: string) => /^[a-z]{2,6}$/.test(s); // single short all-letters token (already normed)
  if (isAcr(na) && !na.includes(' ') && initialsOf(nb) === na) return true;
  if (isAcr(nb) && !nb.includes(' ') && initialsOf(na) === nb) return true;
  return false;
}

// Loose condition match so "Asthma" vs "Asthma, Bronchial" (or "ankle" vs "limited motion of ankle")
// aren't flagged as a mismatch: equal, substring, acronym↔expansion, or a shared SIGNIFICANT token
// (>=4 chars, not a laterality/generic stopword). The stopword filter keeps "Right knee" ≠ "Right shoulder".
function looseMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  if (acronymMatch(na, nb)) return true;
  const ta = new Set(significantTokens(na));
  return significantTokens(nb).some((t) => ta.has(t));
}

function veteranTheoryLine(bucket: Framing, framingRaw: string | null | undefined, upstream: string | null | undefined): string | null {
  const up = (upstream ?? '').trim();
  switch (bucket) {
    case 'secondary':
      return up ? `Secondary to service-connected ${up}` : 'Secondary service connection';
    case 'aggravation':
      return up ? `Aggravation of service-connected ${up}` : 'Aggravation of a service-connected condition';
    case 'direct':
      return 'Direct service connection';
    default:
      return nonEmpty(framingRaw);
  }
}

function letterTheoryLine(lead: AiViabilityCard['lead']): string | null {
  const claimed = (lead.claimed ?? '').trim();
  const up = (lead.upstream ?? '').trim();
  const mech = (lead.mechanism ?? '').trim();
  switch (framingBucket(lead.framing)) {
    case 'secondary':
      return up ? `${claimed || 'The claimed condition'} secondary to ${up}` : 'Secondary service connection';
    case 'aggravation':
      return up ? `Aggravation of service-connected ${up}` : 'Aggravation of a service-connected condition';
    case 'direct':
      return mech ? `Direct service connection — ${mech}` : 'Direct service connection';
    default:
      return nonEmpty(lead.framing);
  }
}

export function buildPreSignTheory(c: PreSignTheoryInput): PreSignTheory {
  const veteranStatement = nonEmpty(c.veteranStatement);
  const claimList = (c.claimedConditions && c.claimedConditions.length > 0 ? c.claimedConditions : c.claimedCondition ? [c.claimedCondition] : [])
    .map((x) => x.trim())
    .filter(Boolean);
  const veteranClaim = claimList.length > 0 ? claimList.join(', ') : null;

  const framingIsRnAdjusted = (c.framingStampSource ?? '').toLowerCase() === 'manual';
  const hasUpstream = !!(c.upstreamScCondition ?? '').trim();
  // "Auto" framing ('') + a named upstream ⇒ the veteran indicated a secondary theory even without
  // picking the enum. Infer secondary so their theory shows AND a direct/secondary conflict can surface.
  const vBucketRaw = framingBucket(c.framingChoice);
  const vBucket: Framing = vBucketRaw === 'other' && hasUpstream ? 'secondary' : vBucketRaw;
  const veteranTheory = veteranTheoryLine(vBucket, c.framingChoice, c.upstreamScCondition);
  const veteranTheoryLabel = framingIsRnAdjusted ? 'Framing on file (RN-adjusted)' : 'Their theory';

  const lead = c.aiViabilityPlanJson?.lead ?? null;
  const letterDx = nonEmpty(lead?.claimed);
  const letterTheory = lead ? letterTheoryLine(lead) : null;

  let mismatch: PreSignTheory['mismatch'] = null;
  // Compare ONLY when the framing on file is the VETERAN's (not RN-adjusted) AND the veteran actually
  // expressed a theory (vBucket known). Otherwise it isn't honestly "veteran vs letter" — Block 1's
  // literal statement stays the physician's ground truth. NO positive affirmation is emitted either way.
  if (lead && !framingIsRnAdjusted && vBucket !== 'other') {
    const lBucket = framingBucket(lead.framing);
    const framingDiffers = lBucket !== 'other' && vBucket !== lBucket;
    const secondaryish = lBucket === 'secondary' || lBucket === 'aggravation';
    const upstreamDiffers =
      secondaryish && hasUpstream && !!(lead.upstream ?? '').trim() && !looseMatch(c.upstreamScCondition, lead.upstream);
    if (framingDiffers || upstreamDiffers) {
      // Use ONLY the plan's explicit "why this alternative wasn't led" (alternatives[].why_not). Do NOT
      // reuse counterargument/rationale — those are about the CHOSEN theory, not why the veteran's was
      // set aside (counterargument would wrongly argue AGAINST the letter). (AI-SME QA.)
      const alt = (c.aiViabilityPlanJson?.alternatives ?? []).find((a) => looseMatch(a.upstream, c.upstreamScCondition));
      mismatch = { reason: nonEmpty(alt?.why_not), suggestEdit: !!alt };
    }
  }

  const hasContent = !!(veteranStatement || veteranTheory || veteranClaim || letterTheory);
  return { veteranStatement, veteranClaim, veteranTheory, veteranTheoryLabel, letterDx, letterTheory, mismatch, hasContent };
}
