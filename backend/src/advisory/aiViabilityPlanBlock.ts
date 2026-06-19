// Ask Aegis ⇄ route-picker alignment (Ryan 2026-06-19). When the RN asks a VIABILITY-shaped question on
// a case, we ground the advisory answer in the SAME route-picker plan the drafter + the Overview card use
// — read from the PERSISTED snapshot (cases.ai_viability_plan_json), NOT recomputed. That keeps Ask Aegis,
// the card, and the drafter on ONE brain WITHOUT a second synchronous LLM call on the 29s-capped /ask path
// (the SOAP-timeout lesson). The picker DECIDES the framing; the advisory model only EXPLAINS this block
// (system-prompt section "AI ROUTE-PICKER PLAN").
//
// Fail-open everywhere: no plan persisted yet (card not viewed), a non-viability question, or any throw →
// null, and the ask path falls back to its corpus-only answer (today's behavior). Never throws.

import type { AppDb } from '../services/db-types.js';
import type { AiViabilityCard } from '../services/ai-viability.js';

// Gate: only ground a question that is actually about whether a claim/pairing works / how it anchors.
// Deliberately permissive (the tab is case-scoped) but not email-shaped. Mirrors the spirit of the
// vendored viabilityGrounding detector without importing the .js into the TS build.
const VIABILITY_Q =
  /\b(viab(?:le|ility)|service[\s-]?connect(?:ed|ion|ing|s)?|secondary|anchor|pathway|aggravat|proximately due to|why not\b|best (?:anchor|theory|framing)|support(?:able|ed)?|is (?:this|the|his|her) (?:case|claim|condition)|connect(?:ed|ion|ing|s)?\b.*\bto\b)\b/i;

export function isViabilityShaped(question: string): boolean {
  return VIABILITY_Q.test(String(question ?? ''));
}

// Plain-English gloss for the picker's excluded-reason enum (never leak the enum token to the reader; the
// advisory model re-says these in its own words, but a human-readable reason keeps the block self-explaining).
const EXCLUDE_REASON: Record<string, string> = {
  reverse_causation: 'the cause/effect runs the wrong way',
  wrong_physiologic_direction: 'the physiology runs the wrong direction',
  'pyramiding_4.14_or_4.130': 'it would rate the same disability twice (pyramiding)',
  weaker_mechanism: 'a weaker mechanism than the lead',
  no_temporal_support: 'the timeline does not support it',
  off_mechanism: 'no established mechanism for this pairing',
};

function fmtPlan(plan: AiViabilityCard): string {
  const L: string[] = [];
  L.push('=== AI ROUTE-PICKER PLAN (the anticipated drafter framing for THIS case — EXPLAIN it, do not re-pick) ===');
  L.push(`Claimed condition: ${plan.lead?.claimed || '(this case\'s claim)'}`);
  L.push(`Picker viability: ${plan.viability}`);

  const lead = plan.lead;
  const hasLead = !!(lead && lead.upstream);
  if (hasLead) {
    L.push(`Lead pathway: ${lead.upstream} → ${lead.claimed}, framed as ${lead.framing || '(framing)'}${lead.cfr_basis ? ` under 38 CFR ${lead.cfr_basis}` : ''}.`);
    if (lead.confidence) L.push(`Confidence the picker assigned: ${lead.confidence} (report this honestly — do not upgrade or downgrade it).`);
    if (lead.mechanism) L.push(`Dominant mechanism: ${lead.mechanism}`);
    if (lead.rationale) L.push(`Why this leads: ${lead.rationale}`);
    if (lead.counterargument) L.push(`Strongest counterargument (state it, don't sell past it): ${lead.counterargument}`);
  } else {
    // Abstain / no validated pathway — the picker found nothing >=50%. The model must NOT invent one.
    L.push('The picker found NO validated lead pathway for this case. Do NOT invent a band, an anchor, a framing, or a percentage it did not give. Treat this as needs-more-info / escalate, and reason ONLY from on-topic retrieved chunks or real PubMed PMIDs if you genuinely have them (label it "grounded reasoning, not a blessed pathway — confirm with Dr. Ryan"); otherwise say plainly we cannot back a pathway yet.');
  }

  const conv = (plan.convergent ?? []).filter((c) => c.upstream);
  if (conv.length) L.push(`Also supporting the SAME claim (convergent, not competing): ${conv.map((c) => `${c.upstream}${c.note ? ` (${c.note})` : ''}`).join('; ')}.`);

  const alts = (plan.alternatives ?? []).filter((a) => a.upstream);
  if (alts.length) L.push(`Other anchors considered and why they are NOT the lead: ${alts.map((a) => `${a.upstream} — ${a.why_not || 'weaker here'}`).join('; ')}.`);

  // The HARD excludes — answer any "why not X" from these; never revive an excluded pathway.
  const exc = (plan.excluded ?? []).filter((e) => e.upstream);
  if (exc.length) L.push(`Excluded anchors — OFF THE TABLE, never argue these: ${exc.map((e) => `${e.upstream} — ${EXCLUDE_REASON[e.reason] || e.reason}`).join('; ')}.`);

  const miss = (plan.missing ?? []).filter((m) => m.fact);
  if (miss.length) L.push(`Facts to confirm before it is solid (records-minimalism — a provider note is enough; do not re-demand imaging/tests for an already-documented dx): ${miss.map((m) => `${m.fact}${m.why ? ` (${m.why})` : ''}`).join('; ')}.`);

  if (plan.nuance) L.push(`Clinical nuance: ${plan.nuance}`);
  L.push('(This block carries NO BVA / win-rate / grant figures by design — viability is a mechanism-and-anchor call. Explain it in plain RN/physician language; never assert a band stronger than the picker gave, never name an anchor not listed here, and never print an internal field name.)');
  return L.join('\n');
}

/**
 * Read the persisted route-picker plan for a case and format it as the AI ROUTE-PICKER PLAN grounding
 * block — but ONLY for a viability-shaped question. Returns null (fail-open) when the question isn't
 * viability-shaped, no plan is persisted yet, the plan is malformed, or anything throws.
 */
export async function buildAiPlanGroundingBlock(db: AppDb, caseId: string, question: string): Promise<string | null> {
  try {
    if (!isViabilityShaped(question)) return null;
    const row = (await db.case.findFirst({
      where: { id: caseId },
      select: { aiViabilityPlanJson: true } as never,
    })) as unknown as { aiViabilityPlanJson: AiViabilityCard | null } | null;
    const plan = row?.aiViabilityPlanJson ?? null;
    if (!plan || typeof plan !== 'object' || !('viability' in plan)) return null;
    return fmtPlan(plan);
  } catch {
    return null;
  }
}
