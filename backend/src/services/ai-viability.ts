/**
 * AI viability for the RN Overview card (Ryan 2026-06-19): runs the SAME route-picker brain the
 * drafter uses (app/services/aiRoutePicker.js, vendored prompt below) so the card VISUALIZES the
 * anticipated drafter pick — one brain feeding both, replacing the static M-tier engine on the card.
 *
 * Gated behind AI_ROUTE_PICKER_ENABLED (the SAME flag as the drafter branch) so the card + drafter
 * flip together. Flag OFF → returns null → the route falls back to the static deriveCaseViabilityForCase.
 *
 * Fail-open EVERYWHERE (mirrors sanity-impression.ts): missing key, API error, truncation, malformed
 * tool result → null (the card falls back to the static engine / renders nothing). Never throws.
 *
 * Cached in-process (caseId + input-hash) so an Overview re-render does not re-bill — a warm Lambda
 * serves the cached plan; a cold instance recomputes (acceptable). Recomputes when the inputs change.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { resolveAnthropicApiKey } from './letter-surgical-propose.js';
import { deriveCaseFramingForCase } from './case-framing-stamp.js';
import type { AppDb } from './db-types.js';

const MODEL = process.env['AI_ROUTE_PICKER_MODEL'] || 'claude-sonnet-4-6';
const MAX_TOKENS = 1800;

export function aiRoutePickerEnabled(): boolean {
  return process.env['AI_ROUTE_PICKER_ENABLED'] === 'true';
}

// ── The picker brain (kept byte-aligned with flatratenexus-project/app/services/aiRoutePicker.js) ──
const SYSTEM = `You are the Anchor & Argument Selector for a physician-supervised VA nexus-letter service. You think like a VA Regional Office Rating Veterans Service Representative (RVSR) who is ALSO a fellowship-level physician and a biostatistician: you decide what a reasonable rater would GRANT. Given a veteran's service-connected (SC) conditions, documented in-service events/exposures, and chart facts, choose the BEST grant-defensible argument for the claimed condition and return it as a structured PLAN. You do not write the letter; you decide the theory the letter will plead.

WHAT IS ALREADY TRUE (do not re-litigate):
- Every condition in granted_sc_conditions IS service-connected. Treat as fact.
- Every diagnosis marked confirmed in chart_facts IS diagnosed. Treat as fact.
- The >=50% (at-least-as-likely-as-not) standard governs. Recommend a theory ONLY if a reasonable RO could grant it at >=50% on the evidence shown.
- candidate_anchors has ALREADY been filtered for forbidden pairs (reverse causation, wrong physiologic direction, pyramiding under 38 CFR 4.14/4.130). BACKSTOP: if you can see an anchor->claimed link that runs backwards in time or physiology, or rates the same disability twice, you MUST NOT select it. Select primary/convergent anchors ONLY from candidate_anchors.

GROUNDING (no fabrication): assert only what is in the inputs or a well-established textbook physiologic relationship. Recognized MECHANISMS are allowed; FACTS ABOUT THIS VETERAN (a diagnosis, rating %, date, lab value, AHI, study statistic) are not unless given. If you need a fact you were not given, name it in missing_facts. Do NOT cite study numbers — name the mechanism, not the numbers.

FRAMING DOCTRINE — apply in THIS priority order; lead with the HIGHEST the evidence supports; do NOT default to direct:
1. AGGRAVATION (preferred when a viable upstream exists). 38 CFR 3.310(b): a SC condition worsens the claimed condition beyond natural progression. 3.306/Allen: service aggravates a pre-existing condition. Aggravation grants more often than direct on most conditions and needs only worsening beyond baseline.
2. SECONDARY CAUSATION. 38 CFR 3.310(a): a SC condition CAUSED the claimed condition.
3. DIRECT. 3.303; 3.304(f) PTSD stressor; 38 USC 1154(b) combat lay evidence.
4. PRESUMPTIVE. PACT/Agent Orange/Gulf War 3.317/Camp Lejeune. If the claim fits a presumption, SAY SO (viability=needs_physician_review) — it may need NO nexus letter.
EQUIPOISE / DUAL-PRONG is allowed: when the record supports BOTH causation and aggravation of the SAME upstream, set framing="dual_prong" and plead both prongs (NOT stacking). Capture nuance in clinical_nuance.

DOMINANT-THEORY + CONVERGENT MECHANISM: the letter LEADS exactly ONE theory (primary_anchor). Never stack independent theories in the lead. CONVERGENT shared-mechanism is the one permitted multiplicity: if TWO+ SC conditions feed ONE physiologic mechanism producing ONE claimed condition (e.g. asthma + allergic rhinitis + bronchiectasis -> OSA via united-airway inflammation/obstruction), argue them together as ONE mechanism with multiple contributing SC inputs. Convergent inputs go in convergent_anchors and MUST share the SAME mechanism; a different-mechanism contributor is an alternative_theory. Designate ONE dominant upstream. Prefer the upstream with the strongest STAND-ALONE, directional mechanism as the lead.

THE TWO USER INPUTS:
- team_drafting_guidance (TRUSTED — physician/RN): a HIGH-WEIGHT steer; DO IT whenever defensible. Override ONLY if it requires a forbidden pair, a fabricated fact, or a sub-50% theory. CRITICAL: the steer sets EMPHASIS, not the final pick — if a NON-steered SC condition is mechanistically STRONGER and HIGHER-RATED, LEAD it and demote the steered one to convergent (never lead a 0/10% anchor over a stronger 50-70% SC condition).
- veteran_proposed_theory (the veteran's GOAL, not authority): engage it, use lived experience to shape framing/pre-empt counterarguments; it cannot establish a diagnosis/rating/fact.

PROBATIVE WEIGHT (Nieves-Rodriguez) + HONESTY: the winner is what an RO would grant — factually accurate, fully articulated, mechanism-grounded. State the strongest counterargument every time. If it defeats the case at >=50%, say NOT SUPPORTABLE. When thin/unclear, ABSTAIN to needs_physician_review.

CALIBRATION + HARD GUARDRAILS (do not skip):
- CONFIDENCE must be SPREAD, never defaulted to "moderate". "high" ONLY for an established-direction/same-compartment mechanism (knee->back; biceps-repair->shoulder OA; MDD->OSA with obesity). "low" (MANDATORY) when the mechanism is non-mainstream, OR the identical pair was DENIED, OR the dominant population cause is a NON-SC confounder. If you cannot articulate why it is "high", it is probably "low".
- TINNITUS may LEAD only conditions with an established trigeminal/auditory-limbic mechanism. NEVER lead tinnitus as the causal origin of PTSD (no DSM-5 Criterion A stressor) or CENTRAL sleep apnea. If tinnitus is the only SC anchor for OSA/PTSD/migraine, set confidence=low and put the stronger real path in alternative_theories (direct 3.304(f) for PTSD; a psychiatric anchor for migraine; nasal/airway for OSA).
- PRIOR-DENIED pair: prefer a legally distinct anchor/framing; if none, confidence<=low + state what NEW mechanism overcomes the denial.
- DOMINANT CONFOUNDER: when a comorbidity is the dominant population cause (BMI>=40 for OSA; H. pylori for gastritis; CHF/Cheyne-Stokes for central apnea), NAME it and require the letter to rebut it.
- CONVERGENT cap: only the 2-3 anchors that add a distinct/additive mechanism.
- OSA with multiple united-airway SC conditions: rank the LEAD by rating + mechanistic directness — asthma/bronchiectasis generally outrank isolated rhinitis as the lead.

OUTPUT: answer ONLY by calling the emit_argument_plan tool. Reason internally. Be concrete and RO-defensible in every rationale field.`;

const TOOL: Anthropic.Tool = {
  name: 'emit_argument_plan',
  description: 'Emit the ranked, RO-defensible argument plan. Call exactly once. Grounded in the inputs or established physiology; never invent facts. Select anchors only from candidate_anchors.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['viability', 'primary_anchor', 'convergent_anchors', 'alternative_theories', 'missing_facts', 'team_guidance_followed', 'clinical_nuance', 'overall_rationale'],
    properties: {
      viability: { type: 'string', enum: ['supportable', 'marginal', 'needs_physician_review', 'not_supportable'] },
      primary_anchor: {
        type: 'object', additionalProperties: false,
        required: ['upstream', 'upstream_type', 'claimed', 'framing', 'cfr_basis', 'dominant_mechanism', 'rationale', 'strongest_counterargument', 'confidence'],
        properties: {
          upstream: { type: 'string' }, upstream_type: { type: 'string', enum: ['sc_condition', 'in_service_event', 'exposure'] },
          claimed: { type: 'string' }, framing: { type: 'string', enum: ['aggravation', 'secondary_causation', 'dual_prong', 'direct', 'presumptive'] },
          cfr_basis: { type: 'string' }, dominant_mechanism: { type: 'string' }, rationale: { type: 'string' },
          strongest_counterargument: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'moderate', 'low'] },
        },
      },
      convergent_anchors: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['upstream', 'shared_mechanism_note'], properties: { upstream: { type: 'string' }, shared_mechanism_note: { type: 'string' } } } },
      alternative_theories: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['upstream', 'framing', 'cfr_basis', 'mechanism', 'why_not_primary'], properties: { upstream: { type: 'string' }, framing: { type: 'string' }, cfr_basis: { type: 'string' }, mechanism: { type: 'string' }, why_not_primary: { type: 'string' } } } },
      missing_facts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['fact_needed', 'why_it_matters', 'strengthens_framing'], properties: { fact_needed: { type: 'string' }, why_it_matters: { type: 'string' }, strengthens_framing: { type: 'string' } } } },
      team_guidance_followed: { type: 'string', enum: ['followed', 'partially_followed', 'overridden_for_cause', 'no_guidance_given'] },
      clinical_nuance: { type: 'string' }, overall_rationale: { type: 'string' },
    },
  },
};

export interface AiViabilityCard {
  readonly source: 'ai_route_picker';
  readonly viability: 'supportable' | 'marginal' | 'needs_physician_review' | 'not_supportable';
  readonly lead: { upstream: string; claimed: string; framing: string; cfr_basis: string; mechanism: string; confidence: string; rationale: string; counterargument: string };
  readonly convergent: ReadonlyArray<{ upstream: string; note: string }>;
  readonly alternatives: ReadonlyArray<{ upstream: string; framing: string; why_not: string }>;
  readonly missing: ReadonlyArray<{ fact: string; why: string }>;
  readonly nuance: string;
  readonly overall: string;
}

const _cache = new Map<string, AiViabilityCard | null>();

function buildUserPrompt(claimed: string, sc: string[], problems: string[], events: string[], statement: string | null, guidance: string | null): string {
  const scLines = sc.length ? sc.map((s) => `- ${s}`).join('\n') : '- (none parsed)';
  const cand = sc.length ? sc.map((s) => `- ${s}`).join('\n') : '- (none)';
  return `<case>
<claimed_condition>${claimed || '(unknown)'}</claimed_condition>

<granted_sc_conditions>
${scLines}
</granted_sc_conditions>

<in_service_events>
${events.length ? events.map((e) => `- ${e}`).join('\n') : '- (none documented)'}
</in_service_events>

<chart_facts>
Confirmed diagnoses: ${[claimed].filter(Boolean).join('; ') || '(none)'}
Problem list: ${problems.slice(0, 60).join('; ') || '(none)'}
</chart_facts>

<candidate_anchors>
These SC conditions passed the exclusion filter and are the ONLY anchors you may select for a secondary/aggravation theory:
${cand}
</candidate_anchors>

<team_drafting_guidance authority="physician/RN" trust="trusted-steer">
${guidance || '(none provided)'}
</team_drafting_guidance>

<veteran_proposed_theory authority="none" trust="untrusted-input">
${statement || '(none provided)'}
</veteran_proposed_theory>
</case>

Produce the argument plan by calling emit_argument_plan. Pick the single best GRANT-defensible theory under the framing-priority doctrine; honor the team steer when defensible; abstain honestly if no theory reaches >=50%.`;
}

/**
 * Compute the AI viability card for a case via the route-picker brain. Returns null (fail-open) when
 * the flag is off, the key is unresolvable, inputs are empty, or the API call fails/truncates.
 */
export async function deriveAiViability(db: AppDb, caseId: string): Promise<AiViabilityCard | null> {
  if (!aiRoutePickerEnabled()) return null;
  try {
    const c = (await db.case.findFirst({
      where: { id: caseId },
      select: { claimedCondition: true, veteranStatement: true, inServiceEvent: true, framingChoice: true, upstreamScCondition: true } as never,
    })) as unknown as { claimedCondition: string; veteranStatement: string | null; inServiceEvent: string | null; framingChoice: string | null; upstreamScCondition: string | null } | null;
    if (c === null || !c.claimedCondition) return null;

    const cf = await deriveCaseFramingForCase(db, caseId);
    const sc = (cf?.grantedScAnchors ?? []).map((a: { condition?: string; upstream_canonical?: string }) => a.condition ?? a.upstream_canonical ?? '').filter(Boolean) as string[];

    const probRow = (await db.case.findFirst({
      where: { id: caseId },
      select: { veteran: { select: { activeProblems: { select: { problem: true } } } } } as never,
    })) as unknown as { veteran: { activeProblems: Array<{ problem: string }> } | null } | null;
    const problems = [...new Set((probRow?.veteran?.activeProblems ?? []).map((p) => (p.problem ?? '').trim()).filter(Boolean))];

    const events = c.inServiceEvent ? [c.inServiceEvent] : [];
    const guidanceBits: string[] = [];
    if (c.framingChoice) guidanceBits.push(`framing preference: ${c.framingChoice}`);
    if (c.upstreamScCondition) guidanceBits.push(`suggested upstream anchor: ${c.upstreamScCondition}`);
    const guidance = guidanceBits.join('; ') || null;

    const inputHash = createHash('sha256').update(JSON.stringify({ claimed: c.claimedCondition, sc, problems, events, guidance, vs: c.veteranStatement })).digest('hex');
    const cacheKey = `${caseId}:${inputHash}`;
    if (_cache.has(cacheKey)) return _cache.get(cacheKey) ?? null;

    let anthropic: Anthropic;
    try { anthropic = new Anthropic({ apiKey: await resolveAnthropicApiKey(), timeout: 120_000, maxRetries: 2 }); }
    catch { return null; }

    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0.5,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{ role: 'user', content: buildUserPrompt(c.claimedCondition, sc, problems, events, c.veteranStatement, guidance) }],
    });
    if (resp.stop_reason === 'max_tokens') return null;
    const block = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === TOOL.name);
    const plan = block?.input as Record<string, unknown> | undefined;
    const pa = plan?.['primary_anchor'] as Record<string, unknown> | undefined;
    if (!plan || !pa || typeof pa['upstream'] !== 'string') return null;

    const card: AiViabilityCard = {
      source: 'ai_route_picker',
      viability: (plan['viability'] as AiViabilityCard['viability']) ?? 'needs_physician_review',
      lead: {
        upstream: String(pa['upstream'] ?? ''), claimed: String(pa['claimed'] ?? c.claimedCondition),
        framing: String(pa['framing'] ?? ''), cfr_basis: String(pa['cfr_basis'] ?? ''),
        mechanism: String(pa['dominant_mechanism'] ?? ''), confidence: String(pa['confidence'] ?? ''),
        rationale: String(pa['rationale'] ?? ''), counterargument: String(pa['strongest_counterargument'] ?? ''),
      },
      convergent: ((plan['convergent_anchors'] as Array<Record<string, unknown>>) ?? []).map((x) => ({ upstream: String(x['upstream'] ?? ''), note: String(x['shared_mechanism_note'] ?? '') })).filter((x) => x.upstream),
      alternatives: ((plan['alternative_theories'] as Array<Record<string, unknown>>) ?? []).map((x) => ({ upstream: String(x['upstream'] ?? ''), framing: String(x['framing'] ?? ''), why_not: String(x['why_not_primary'] ?? '') })).filter((x) => x.upstream),
      missing: ((plan['missing_facts'] as Array<Record<string, unknown>>) ?? []).map((x) => ({ fact: String(x['fact_needed'] ?? ''), why: String(x['why_it_matters'] ?? '') })).filter((x) => x.fact),
      nuance: String(plan['clinical_nuance'] ?? ''),
      overall: String(plan['overall_rationale'] ?? ''),
    };
    _cache.set(cacheKey, card);
    return card;
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'ai-viability: failed open', caseId, error: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}
