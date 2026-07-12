// Pre-sign theory reconciliation (Ryan 2026-07-11): above the "Considerations before signing" list the
// physician sees (1) the veteran's OWN stated theory (their literal intake words + what they claimed +
// what they said it's secondary to), (2) what the LETTER argues (the diagnosis + causation theory the
// drafter's route-picker plan led with), and (3) ONLY when the two genuinely differ, a plain reason why.
//
// PURE + DETERMINISTIC: pure string ops over structured Case fields (no LLM, no letter-text parse).
//
// TRUST GUARD (Ryan 2026-07-11, CLM-47FAC163B8): `upstreamScCondition` is an AUTO-derived field and can
// be STALE/WRONG (Jay's said "Ankle" while the veteran's own statement + the letter both said depression
// → a bogus "Their theory: Ankle" + a phantom mismatch). So we only assert the derived "secondary to X"
// theory (and only run the mismatch check) when X is CORROBORATED by the veteran's literal statement.
// If the field contradicts / is absent from the statement, we show ONLY the veteran's literal words +
// what the letter argues, and stay silent — the statement is the ground truth, never a stale column.
// NO positive "✓ matches" affirmation is ever emitted (a green ✓ on a sign-off surface risks false
// reassurance). Fail-open: a missing route-picker plan just hides blocks 2+3.
import type { AiViabilityCard } from '../api/case-viability';

export interface PreSignTheoryInput {
  readonly claimedCondition?: string;
  readonly claimedConditions?: readonly string[];
  readonly framingChoice?: string;
  readonly upstreamScCondition?: string;
  readonly veteranStatement?: string;
  readonly aiViabilityPlanJson?: AiViabilityCard | null;
  /**
   * Part B (Ryan 2026-07-11): the LLM restatement of the veteran's OWN theory, in concise clinical terms.
   * When present it SUPERSEDES the deterministic template — its `theory` prose is shown, and its
   * statement-grounded `upstream`/`framing` drive the reconciliation (full scope, Ryan's choice). null (flag
   * off / ungrounded / failure) → the deterministic path below is used unchanged (no regression). The
   * backend has already gated `upstream` on the veteran's statement, so it is trusted here (the Ankle guard
   * lives server-side in veteran-theory-ai.ts).
   */
  readonly veteranTheoryAi?: {
    readonly theory: string;
    readonly framing: 'secondary' | 'direct' | 'aggravation' | 'unclear';
    readonly upstream: string | null;
  } | null;
}

export interface PreSignTheory {
  readonly veteranStatement: string | null;
  readonly veteranClaim: string | null;
  /** The veteran's stated causation theory as a SHORT template, e.g. "Secondary to service-connected PTSD"
   *  — ONLY when the upstream is corroborated by their statement (else null; the literal statement stands
   *  alone). null in the LLM path (superseded by `veteranTheoryProse`). */
  readonly veteranTheory: string | null;
  /** Part B: the LLM's concise clinical restatement of the veteran's OWN theory (a full sentence). Present
   *  only when the veteran-theory model produced a grounded result; else null (the template/quote stands). */
  readonly veteranTheoryProse: string | null;
  readonly letterDx: string | null;
  readonly letterTheory: string | null;
  /** Present ONLY when there is a SPECIFIC, grounded difference to show (never a generic "they differ").
   *  `summary` is the specific sentence (preferred by the UI); `reason` is the plan's why_not detail
   *  (appended after the summary); `suggestEdit` adds the surgical-edit nudge. */
  readonly mismatch: { readonly reason: string | null; readonly suggestEdit: boolean; readonly summary?: string } | null;
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

// Physician-facing words for a route-picker framing key (mirrors CaseViabilityCard FRAMING_LABEL). The
// point is NEVER to render a raw enum key like "dual_prong" — it's code-speak to a physician (Ryan
// 2026-07-11, Cox CLM-58482FEB66). Unknown keys degrade to a de-underscored phrase, never the raw token.
const FRAMING_WORD: Record<string, string> = {
  secondary_causation: 'secondary',
  secondary: 'secondary',
  aggravation: 'aggravating',
  dual_prong: 'secondary and aggravating',
  direct: 'direct',
  presumptive: 'presumptive',
};
function humanFramingWord(f: string | null | undefined): string {
  const n = norm(f).replace(/\s+/g, '_');
  return FRAMING_WORD[n] ?? norm(f);
}
// Join framing words: ["secondary","aggravating"] → "secondary and aggravating"; 3+ → oxford list.
function joinWords(ws: readonly string[]): string {
  const u = [...new Set(ws.filter(Boolean))];
  if (u.length <= 1) return u[0] ?? '';
  if (u.length === 2) return `${u[0]} and ${u[1]}`;
  return `${u.slice(0, -1).join(', ')}, and ${u[u.length - 1]}`;
}

// Laterality / severity / generic-medical tokens that must NOT count as a condition match — otherwise
// "Right knee" vs "Right shoulder" collide on "right". (3-agent QA 2026-07-11.)
const MATCH_STOPWORDS = new Set([
  'left', 'right', 'chronic', 'acute', 'bilateral', 'joint', 'pain', 'disorder', 'syndrome', 'disease',
  'condition', 'mild', 'moderate', 'severe', 'service', 'connected', 'status', 'post', 'spine', 'strain',
  'injury', 'residuals',
]);
function significantTokens(n: string): string[] {
  return n.split(' ').filter((t) => t.length >= 4 && !MATCH_STOPWORDS.has(t));
}

// Acronym ↔ expansion equivalence ("PTSD" ~ "post traumatic stress disorder", "OSA" ~ "obstructive
// sleep apnea") so they don't FALSE-differ (AI-SME QA 2026-07-11).
function initialsOf(n: string): string {
  return n.split(' ').filter(Boolean).map((t) => t[0]).join('');
}
function acronymMatch(na: string, nb: string): boolean {
  const isAcr = (s: string) => /^[a-z]{2,6}$/.test(s);
  if (isAcr(na) && !na.includes(' ') && initialsOf(nb) === na) return true;
  if (isAcr(nb) && !nb.includes(' ') && initialsOf(na) === nb) return true;
  return false;
}

// Loose condition match: equal, substring, acronym↔expansion, or a shared SIGNIFICANT token.
function looseMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  if (acronymMatch(na, nb)) return true;
  const ta = new Set(significantTokens(na));
  return significantTokens(nb).some((t) => ta.has(t));
}

// Is `needle` (a condition name) actually mentioned in `haystack` (the veteran's free-text statement)?
// A significant token of the needle appearing in the statement (as a word or substring) corroborates it.
function mentionedIn(needle: string | null | undefined, haystack: string | null | undefined): boolean {
  const h = norm(haystack);
  if (!h) return false;
  const toks = significantTokens(norm(needle));
  if (toks.length === 0) return false;
  const words = new Set(h.split(' '));
  return toks.some((t) => words.has(t) || h.includes(t));
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
  const claimed = (lead.claimed ?? '').trim() || 'The claimed condition';
  const up = (lead.upstream ?? '').trim();
  const mech = (lead.mechanism ?? '').trim();
  const f = norm(lead.framing);
  // dual_prong = 3.310(a)+(b): BOTH causation AND aggravation of the SAME upstream (not two conditions).
  if (f.includes('dual')) {
    return up ? `${claimed} secondary to — and aggravated by — service-connected ${up}` : 'Secondary service connection (causation and aggravation)';
  }
  if (f.includes('presumptive')) {
    return up ? `${claimed} on a presumptive basis (${up})` : `${claimed} on a presumptive basis`;
  }
  switch (framingBucket(lead.framing)) {
    case 'secondary':
      return up ? `${claimed} secondary to ${up}` : 'Secondary service connection';
    case 'aggravation':
      return up ? `Aggravation of service-connected ${up}` : 'Aggravation of a service-connected condition';
    case 'direct':
      return mech ? `Direct service connection — ${mech}` : 'Direct service connection';
    default:
      // Never leak a raw framing key — humanize it (e.g. an unknown "foo_bar" → "foo bar").
      return nonEmpty(lead.framing) ? `${claimed}${up ? ` — ${up}` : ''} (${humanFramingWord(lead.framing)})` : null;
  }
}

function humanBucketWord(b: Framing): string {
  return b === 'secondary' ? 'secondary' : b === 'aggravation' ? 'aggravation' : b === 'direct' ? 'direct service connection' : '';
}
function leadLabel(lead: AiViabilityCard['lead']): string {
  const up = (lead.upstream ?? '').trim();
  const fw = humanFramingWord(lead.framing);
  return up ? `${up}${fw ? ` (${fw})` : ''}` : fw || 'its lead theory';
}

// Reconcile the veteran's theory against the letter's plan and produce a SPECIFIC, GROUNDED "where they
// differ" line — or stay SILENT. NEVER the old useless generic "they differ" (Ryan 2026-07-11, Cox
// CLM-58482FEB66: "'where they differ' is just 'they differ' — totally useless"). We only assert things we
// can ground in the plan's structured fields, so we can't produce a FALSE differ from lexical mismatch
// (e.g. the veteran's "limited mobility" vs the letter's "knee strain" — same theory, different words).
//   1. Veteran is pushing an anchor the letter DEMOTED to an alternative → name it + the plan's own why_not.
//   2. The letter also weighs DIFFERENT-mechanism alternatives the veteran never raised (checked against
//      the literal statement) → "the letter also weighs GERD as a secondary and aggravating cause…".
//   3. A clear framing conflict (veteran direct vs a secondary letter, etc.) → name it specifically.
//   4. Otherwise → silent. (`convergent` = the SAME mechanism/theory, more anchors — never a "difference".)
function reconcileLlmWithPlan(
  llmFraming: 'secondary' | 'direct' | 'aggravation' | 'unclear',
  llmUpstream: string | null,
  plan: AiViabilityCard,
  veteranStatement: string | null,
): PreSignTheory['mismatch'] {
  const lead = plan.lead;
  const vUp = (llmUpstream ?? '').trim() || null;
  const alternatives = plan.alternatives ?? [];

  // (1) Is the veteran pushing a specific anchor the letter considered but DEMOTED? (confident divergence)
  const vetPushesDemoted = vUp ? alternatives.find((a) => looseMatch(a.upstream, vUp)) : undefined;
  if (vetPushesDemoted) {
    return {
      reason: nonEmpty(vetPushesDemoted.why_not),
      suggestEdit: true,
      summary: `The veteran points to ${vetPushesDemoted.upstream}; the letter leads with ${leadLabel(lead)} and treats ${vetPushesDemoted.upstream} as a fallback.`,
    };
  }

  // (2) DIFFERENT-mechanism alternatives the letter weighs that the veteran NEVER raised (grounded against
  //     the literal statement, and not the veteran's own anchor). Dedup by upstream, collect framings.
  const groups = new Map<string, { upstream: string; framings: string[] }>();
  for (const a of alternatives) {
    const upA = (a.upstream ?? '').trim();
    if (!upA) continue;
    if (mentionedIn(upA, veteranStatement)) continue; // the veteran DID raise it → not a difference
    if (vUp && looseMatch(upA, vUp)) continue; // it's the veteran's own anchor
    const key = norm(upA);
    const g = groups.get(key) ?? { upstream: upA, framings: [] };
    if (a.framing) g.framings.push(humanFramingWord(a.framing));
    groups.set(key, g);
  }
  const additions = [...groups.values()];
  if (additions.length > 0) {
    const phrase = additions
      .map((g) => (g.framings.length ? `${g.upstream} as a ${joinWords(g.framings)} cause` : g.upstream))
      .join('; ');
    return { reason: null, suggestEdit: false, summary: `The letter also weighs ${phrase}, which the veteran didn't raise.` };
  }

  // (3) A clear framing conflict — but NOT when a dual_prong lead already covers the veteran's prong.
  const vBucket = framingBucket(llmFraming);
  const leadBucket = framingBucket(lead.framing);
  const leadIsDual = norm(lead.framing).includes('dual');
  const framingConflicts =
    vBucket !== 'other' &&
    leadBucket !== 'other' &&
    vBucket !== leadBucket &&
    !(leadIsDual && (vBucket === 'secondary' || vBucket === 'aggravation'));
  if (framingConflicts) {
    return { reason: null, suggestEdit: false, summary: `The veteran frames it as ${humanBucketWord(vBucket)}; the letter argues ${humanFramingWord(lead.framing)}.` };
  }

  // (4) Nothing specific + grounded to say → stay silent (the veteran quote + letter line stand on their own).
  return null;
}

export function buildPreSignTheory(c: PreSignTheoryInput): PreSignTheory {
  const veteranStatement = nonEmpty(c.veteranStatement);
  const claimList = (c.claimedConditions && c.claimedConditions.length > 0 ? c.claimedConditions : c.claimedCondition ? [c.claimedCondition] : [])
    .map((x) => x.trim())
    .filter(Boolean);
  const veteranClaim = claimList.length > 0 ? claimList.join(', ') : null;

  const hasUpstream = !!(c.upstreamScCondition ?? '').trim();
  // TRUST GUARD: an upstream is trusted as the veteran's own theory only if their statement corroborates
  // it — OR there is no statement to check against (then the field is all we have). A stale/contradicting
  // field (Jay's "Ankle" vs a depression statement) is NOT trusted.
  const upstreamTrusted = hasUpstream && (!veteranStatement || mentionedIn(c.upstreamScCondition, veteranStatement));

  const vBucketRaw = framingBucket(c.framingChoice);
  // "Auto" framing ('') + a TRUSTED upstream ⇒ infer secondary (the veteran indicated a secondary theory).
  const vBucket: Framing = vBucketRaw === 'other' && upstreamTrusted ? 'secondary' : vBucketRaw;
  const isSecondaryish = vBucket === 'secondary' || vBucket === 'aggravation';
  // Show the derived theory line only when it doesn't rest on an untrusted upstream. Direct claims need
  // no upstream; secondary/aggravation need a trusted one.
  const veteranTheory = isSecondaryish && !upstreamTrusted ? null : veteranTheoryLine(vBucket, c.framingChoice, c.upstreamScCondition);

  const plan = c.aiViabilityPlanJson ?? null;
  const lead = plan?.lead ?? null;
  const letterDx = nonEmpty(lead?.claimed);
  const letterTheory = lead ? letterTheoryLine(lead) : null;

  // Part B (Ryan 2026-07-11): when the veteran-theory model produced a grounded restatement, it SUPERSEDES
  // the deterministic template — show its prose and reconcile using its statement-grounded upstream/framing
  // (full scope). Absent (flag off / ungrounded / failure) → fall through to the deterministic path below,
  // which is unchanged (no regression). The stale-upstream guard for THIS path lives server-side.
  const llmTheory = nonEmpty(c.veteranTheoryAi?.theory);
  if (c.veteranTheoryAi && llmTheory) {
    const llmMismatch = plan && lead ? reconcileLlmWithPlan(c.veteranTheoryAi.framing, c.veteranTheoryAi.upstream ?? null, plan, veteranStatement) : null;
    return {
      veteranStatement,
      veteranClaim,
      veteranTheory: null, // superseded by the prose restatement
      veteranTheoryProse: llmTheory,
      letterDx,
      letterTheory,
      mismatch: llmMismatch,
      hasContent: !!(veteranStatement || llmTheory || veteranClaim || letterTheory),
    };
  }

  let mismatch: PreSignTheory['mismatch'] = null;
  // Compare ONLY when the veteran expressed a theory we can trust — a known framing, and for a
  // secondary/aggravation theory a CORROBORATED upstream. Otherwise it isn't honestly "veteran vs letter"
  // (Block 1's literal statement stays the physician's ground truth). No positive affirmation either way.
  const canCompare = vBucket !== 'other' && (!isSecondaryish || upstreamTrusted);
  if (lead && canCompare) {
    const lBucket = framingBucket(lead.framing);
    const framingDiffers = lBucket !== 'other' && vBucket !== lBucket;
    const leadSecondaryish = lBucket === 'secondary' || lBucket === 'aggravation';
    const upstreamDiffers =
      leadSecondaryish && hasUpstream && !!(lead.upstream ?? '').trim() && !looseMatch(c.upstreamScCondition, lead.upstream);
    if (framingDiffers || upstreamDiffers) {
      // Use ONLY the plan's explicit "why this alternative wasn't led" (alternatives[].why_not).
      const alt = (c.aiViabilityPlanJson?.alternatives ?? []).find((a) => looseMatch(a.upstream, c.upstreamScCondition));
      mismatch = { reason: nonEmpty(alt?.why_not), suggestEdit: !!alt };
    }
  }

  const hasContent = !!(veteranStatement || veteranTheory || veteranClaim || letterTheory);
  return { veteranStatement, veteranClaim, veteranTheory, veteranTheoryProse: null, letterDx, letterTheory, mismatch, hasContent };
}
