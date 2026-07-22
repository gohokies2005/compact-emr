// Ask Aegis ⇄ route-picker alignment (Ryan 2026-06-19). When the RN asks a VIABILITY-shaped question on
// a case, we ground the advisory answer in the SAME route-picker plan the drafter + the Overview card use
// — read from the PERSISTED snapshot (cases.ai_viability_plan_json), NOT recomputed. That keeps Ask Aegis,
// the card, and the drafter on ONE brain WITHOUT a second synchronous LLM call on the 29s-capped /ask path
// (the SOAP-timeout lesson). The picker DECIDES the framing; the advisory model only EXPLAINS this block
// (system-prompt section "AI ROUTE-PICKER PLAN").
//
// STALENESS / WRONG-CONDITION GUARD (QA 2026-06-19, both agents' #1 blocker): the persisted plan refreshes
// only when the Overview card is re-viewed. So the reader MUST participate in the freshness check, not just
// the writer. We refuse to narrate a plan whose (a) schemaVersion is unknown, or (b) inputClaimed no longer
// matches the case's live claimedCondition. Combined with explicit plan-invalidation on case edits
// (routes/cases.ts PATCH), this prevents narrating a stale/wrong-condition plan as authoritative.
//
// Fail-open everywhere: no plan persisted yet, a non-viability question, a stale/mismatched plan, or any
// throw → null block, and the ask path falls back to its corpus-only answer (today's behavior). Never throws.

import type { AppDb } from '../services/db-types.js';
import { type AiViabilityCard, AI_VIABILITY_PLAN_SCHEMA_VERSION } from '../services/ai-viability.js';
import { lookupNegativePairings, formatNegativePairingBlock } from './negativePairingLookup.js';

// Gate: only ground a question that is actually about whether a claim/pairing works / how it anchors.
// Tightened (QA 2026-06-19): dropped the bare "support(ed)?" token (matched "what records SUPPORT the dx")
// and now requires a viability/anchor/framing cue. The tab is case-scoped so we can be moderately permissive,
// but not so broad that a records/status/email question pulls in the framing plan.
const VIABILITY_Q =
  /\b(viab(?:le|ility)|secondary|anchor|pathway|aggravat|proximately due to|why not\b|best (?:anchor|theory|framing)|supportable|connect(?:ed|ion|ing|s)?\b[^.?!]{0,40}\bto\b|service[\s-]?connect(?:ed|ion|ing|s)?\b[^.?!]{0,40}\b(?:secondary|to|viab|anchor)\b)\b/i;

export function isViabilityShaped(question: string): boolean {
  return VIABILITY_Q.test(String(question ?? ''));
}

// Plain-English gloss for the picker's excluded-reason enum (never leak the enum token to the reader; the
// advisory model re-says these in its own words, but a human-readable reason keeps the block self-explaining).
// Cross-repo contract (producer = FRN aiRoutePicker.js TOOL schema) — kept in lockstep by a unit test; the
// fallback NEVER echoes a raw enum token (QA 2026-06-19) so a future producer-side enum add can't leak.
export const EXCLUDE_REASON: Record<string, string> = {
  reverse_causation: 'the cause/effect runs the wrong way',
  wrong_physiologic_direction: 'the physiology runs the wrong direction',
  'pyramiding_4.14_or_4.130': 'it would rate the same disability twice (pyramiding)',
  weaker_mechanism: 'a weaker mechanism than the lead',
  no_temporal_support: 'the timeline does not support it',
  off_mechanism: 'no established mechanism for this pairing',
};
function excludeReason(reason: string): string {
  return EXCLUDE_REASON[reason] || 'not a supportable pathway here';
}

// Defang any forged "===" fence inside a CHART-DERIVED plan string (rationale/mechanism/counterargument/
// nuance/why_not/note). These fields are machine-STRUCTURED but LLM-AUTHORED from chart facts that include
// the (untrusted) veteran statement, so a planted "=== ... ===" could otherwise forge a block header or
// break the chart fence below. Mirror advisoryAnswer.defangFence: collapse any run of 3+ '=' to a marker.
// (QA 2026-06-19, ai-sme #5 — the plan block is a privileged injection channel; treat its values as data.)
function defang(s: string): string {
  return String(s ?? '').replace(/={3,}/g, '[=]');
}

function norm(s: string): string {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export interface PlanGrounding {
  /** The formatted "AI ROUTE-PICKER PLAN" block, or null when not applicable / stale / fail-open. */
  readonly block: string | null;
  /** Excluded-anchor names for the deterministic self-check (never-argue hints). Empty when no block. */
  readonly excludedHints: readonly string[];
  /**
   * Deterministic CURATED NEGATIVE PAIRING PRE-CHECK block (from negative_pairings.md), or null when no
   * candidate upstream for this claim hits a curated "not supportable" entry. RECOMMENDATION-ONLY — it
   * augments the answer with the crisp mechanism reason + VA counterargument + deciding PMIDs. Fail-open.
   */
  readonly negativePairingBlock: string | null;
}

const EMPTY: PlanGrounding = { block: null, excludedHints: [], negativePairingBlock: null };

function fmtPlan(plan: AiViabilityCard): string {
  const L: string[] = [];
  L.push('=== AI ROUTE-PICKER PLAN (the anticipated drafter framing for THIS case — EXPLAIN it, do not re-pick) ===');
  L.push(`Claimed condition: ${defang(plan.lead?.claimed || plan.inputClaimed || "(this case's claim)")}`);
  L.push(`Picker viability: ${plan.viability}`);

  const lead = plan.lead;
  const hasLead = !!(lead && lead.upstream);
  if (hasLead) {
    L.push(`Lead pathway: ${defang(lead.upstream)} → ${defang(lead.claimed)}, framed as ${lead.framing || '(framing)'}${lead.cfr_basis ? ` under 38 CFR ${lead.cfr_basis}` : ''}.`);
    if (lead.confidence) L.push(`Confidence the picker assigned: ${lead.confidence}. IMPORTANT: this confidence ASSUMES the diagnosis and the service-connected anchor are already established — it is the picker's starting assumption, NOT a finding about this chart. Report it honestly, but do NOT tell the RN the case is "supportable/strong/likely viable" unless the current diagnosis AND the anchor (the in-service event, or the primary's SC status) are actually confirmed in the chart in front of you; if they are not confirmed, the honest verdict is needs-more-info.`);
    if (lead.mechanism) L.push(`Dominant mechanism: ${defang(lead.mechanism)}`);
    if (lead.rationale) L.push(`Why this leads: ${defang(lead.rationale)}`);
    if (lead.counterargument) L.push(`Strongest counterargument (state it, don't sell past it): ${defang(lead.counterargument)}`);
  } else {
    // Abstain / no validated pathway — the picker found nothing >=50%. The model must NOT invent one.
    L.push('The picker found NO validated lead pathway for this case. Do NOT invent a band, an anchor, a framing, or a percentage it did not give. Treat this as needs-more-info / escalate, and reason ONLY from retrieved chunks or PubMed PMIDs you can confirm are genuinely ON-TOPIC for THIS condition — nearest-neighbor chunks that are not actually about this condition do NOT count (label any such read "grounded reasoning, not a blessed pathway — confirm with Dr. Ryan"). If you are not sure the material is on-topic, say plainly we cannot back a pathway yet and escalate.');
  }

  const conv = (plan.convergent ?? []).filter((c) => c.upstream);
  if (conv.length) L.push(`Also supporting the SAME claim (convergent, not competing): ${conv.map((c) => `${defang(c.upstream)}${c.note ? ` (${defang(c.note)})` : ''}`).join('; ')}.`);

  const alts = (plan.alternatives ?? []).filter((a) => a.upstream);
  if (alts.length) L.push(`Other anchors considered and why they are NOT the lead: ${alts.map((a) => `${defang(a.upstream)} — ${defang(a.why_not || 'weaker here')}`).join('; ')}.`);

  // The HARD excludes — answer any "why not X" from these; never revive an excluded pathway.
  const exc = (plan.excluded ?? []).filter((e) => e.upstream);
  if (exc.length) L.push(`Excluded anchors — OFF THE TABLE, never argue these: ${exc.map((e) => `${defang(e.upstream)} — ${excludeReason(e.reason)}`).join('; ')}.`);

  const miss = (plan.missing ?? []).filter((m) => m.fact);
  if (miss.length) L.push(`Facts to confirm before it is solid (records-minimalism — a provider note is enough; do not re-demand imaging/tests for an already-documented dx): ${miss.map((m) => `${defang(m.fact)}${m.why ? ` (${defang(m.why)})` : ''}`).join('; ')}.`);

  if (plan.nuance) L.push(`Clinical nuance: ${defang(plan.nuance)}`);
  L.push('(This block carries NO BVA / win-rate / grant figures by design — viability is a mechanism-and-anchor call. Explain it in plain RN/physician language; never assert a band stronger than the picker gave, never name an anchor not listed here, and never print an internal field name.)');
  return L.join('\n');
}

/**
 * Read the persisted route-picker plan for a case and format it as the AI ROUTE-PICKER PLAN grounding
 * block — but ONLY for a viability-shaped question whose plan is fresh and on-condition. Returns the empty
 * grounding (fail-open) when the question isn't viability-shaped, no plan is persisted, the plan schema is
 * unknown, the plan's claimed condition no longer matches the live case, or anything throws.
 */
export async function buildAiPlanGroundingBlock(db: AppDb, caseId: string, question: string): Promise<PlanGrounding> {
  try {
    if (!isViabilityShaped(question)) return EMPTY;
    const row = (await db.case.findFirst({
      where: { id: caseId },
      select: { aiViabilityPlanJson: true, claimedCondition: true } as never,
    })) as unknown as { aiViabilityPlanJson: AiViabilityCard | null; claimedCondition: string } | null;
    const plan = row?.aiViabilityPlanJson ?? null;
    if (!plan || typeof plan !== 'object' || !('viability' in plan)) return EMPTY;
    // Schema guard: an old-shape blob (after a future card-shape change) is cleanly ignored, not mis-rendered.
    if (plan.schemaVersion !== AI_VIABILITY_PLAN_SCHEMA_VERSION) return EMPTY;
    // Staleness / wrong-condition guard: the plan's claimed condition (the raw input at compute time) must
    // still match the case's live claimedCondition. A mismatch means the case was re-framed/re-claimed since
    // the plan was computed (or the RN is asking about a different claim) — narrate nothing rather than the
    // wrong anchor. Same-field compare → no synonym false-rejects.
    const liveClaimed = norm(row?.claimedCondition ?? '');
    const planClaimed = norm(plan.inputClaimed ?? '');
    if (liveClaimed && planClaimed && liveClaimed !== planClaimed) return EMPTY;

    const excludedHints = (plan.excluded ?? [])
      .map((e) => String(e.upstream ?? '').trim())
      .filter((u) => u.length >= 6);

    // CURATED NEGATIVE PAIRING PRE-CHECK (2026-07-22). Check the claimed condition against EVERY upstream
    // the plan considered — the lead pathway plus alternatives + excluded anchors — for a curated
    // "NOT SUPPORTABLE secondary" hit. This enriches a "why not X" answer with the crisp mechanism reason,
    // the VA counterargument, and the deciding PMIDs (better than the plan's terse excluded-reason gloss).
    // Deterministic + fail-open: a bad lookup throws nothing and simply yields no block.
    const claimedForNeg =
      String(plan.lead?.claimed || plan.inputClaimed || row?.claimedCondition || '').trim();
    const candidateUpstreams = [
      plan.lead?.upstream,
      ...(plan.alternatives ?? []).map((a) => a.upstream),
      ...(plan.excluded ?? []).map((e) => e.upstream),
    ]
      .map((u) => String(u ?? '').trim())
      .filter((u) => u.length > 0);
    // KILL-SWITCH (Ryan 2026-07-22): the advisory negative-pairing block is gated so it can be flipped OFF
    // without a redeploy (mirrors the drafter's FRN_NEGATIVE_PAIRINGS). Default OFF → block null → byte-identical
    // to pre-feature behavior; set NEGATIVE_PAIRINGS_ADVISORY=on (cdk env) to surface curated negatives.
    const negEnabled = process.env.NEGATIVE_PAIRINGS_ADVISORY === 'on';
    const negRecs = negEnabled && claimedForNeg ? lookupNegativePairings(claimedForNeg, candidateUpstreams) : [];
    const negativePairingBlock = formatNegativePairingBlock(negRecs);

    return { block: fmtPlan(plan), excludedHints, negativePairingBlock };
  } catch {
    return EMPTY;
  }
}
