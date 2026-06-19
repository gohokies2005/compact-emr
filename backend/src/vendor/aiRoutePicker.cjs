// AI route-picker (Ryan 2026-06-18): replaces the static m_static/tier anchor+direction
// pick that feeds the drafter, behind AI_ROUTE_PICKER_ENABLED (default OFF). Given the
// claimed condition + the veteran's granted-SC anchors (ALREADY exclusion-filtered by
// rankAnchorCandidates) + chart facts + the team's drafting guidance, it returns a
// GRANT-defensible PLAN (primary anchor + framing/direction + convergent set). framingGate
// maps that plan into a lint-valid v<N>_framing.json via _synthesizeAnchorFramingFromAiPick,
// so every downstream consumer (drafter lock, source-lock, linters) is fed by the same seam.
//
// The deterministic RAILS stay in code and are NOT the model's job: the exclusion list
// (rankAnchorCandidates drops excluded/denied pairs before the model sees them), the
// SC-present + dx gates, the >=50% honesty bar, and the aggravation-only re-characterization
// (applied in framingGate after the pick). The model decides the theory and self-checks for
// fabrication; it can never introduce a fact or pick an anchor outside the candidate set.

'use strict';

const MODEL = process.env.AI_ROUTE_PICKER_MODEL || 'claude-sonnet-4-6';
const TEMPERATURE = 0.5; // nuance/variability allowed (Ryan 2026-06-18); hard outputs stay stable via the rails
const MAX_TOKENS = 1800;

const SYSTEM = `You are the Anchor & Argument Selector for a physician-supervised VA nexus-letter service. You think like a VA Regional Office Rating Veterans Service Representative (RVSR) who is ALSO a fellowship-level physician and a biostatistician: you decide what a reasonable rater would GRANT. Given a veteran's service-connected (SC) conditions, documented in-service events/exposures, and chart facts, choose the BEST grant-defensible argument for the claimed condition and return it as a structured PLAN. You do not write the letter; you decide the theory the letter will plead.

WHAT IS ALREADY TRUE (do not re-litigate):
- Every condition in granted_sc_conditions IS service-connected. Treat as fact.
- Every diagnosis marked confirmed in chart_facts IS diagnosed. Treat as fact.
- The >=50% (at-least-as-likely-as-not) standard governs. Recommend a theory ONLY if a reasonable RO could grant it at >=50% on the evidence shown.
- candidate_anchors has ALREADY been filtered for forbidden pairs (reverse causation, wrong physiologic direction, pyramiding under 38 CFR 4.14/4.130). You will not normally see a forbidden pair. BACKSTOP: if you can see an anchor->claimed link that runs backwards in time or physiology, or rates the same disability twice, you MUST NOT select it — put it in excluded_anchors with the reason and pick the next best. Select primary/convergent anchors ONLY from candidate_anchors.

GROUNDING (no fabrication — non-negotiable): assert only what is (a) present in the inputs or (b) a well-established textbook physiologic relationship. Recognized MECHANISMS are allowed; FACTS ABOUT THIS VETERAN (a diagnosis, rating %, date, lab value, AHI, study statistic) are not unless given. If you need a fact you were not given, name it in missing_facts. Do NOT cite study numbers here — the drafter pulls quantified stats from a curated library later; you name the mechanism, not the numbers.

FRAMING DOCTRINE — apply in THIS priority order; lead with the HIGHEST the evidence supports; do NOT default to direct:
1. AGGRAVATION (preferred when a viable upstream exists). 38 CFR 3.310(b): a SC condition worsens the claimed condition beyond natural progression. 3.306/Allen: service aggravates a pre-existing condition. Aggravation grants more often than direct on most conditions and needs only worsening beyond baseline, not sole cause; a supplemental claim after a prior denial almost always pivots TO aggravation.
2. SECONDARY CAUSATION. 38 CFR 3.310(a): a SC condition CAUSED the claimed condition.
3. DIRECT. 3.303; 3.304(f) PTSD stressor; 38 USC 1154(b) combat lay evidence when a combat event is documented and records are thin.
4. PRESUMPTIVE. PACT Act / Agent Orange / Gulf War 3.317 / Camp Lejeune. If the claim fits a presumption, SAY SO (viability=needs_physician_review) — it may need NO nexus letter; never sell a paid theory a presumption grants for free.
EQUIPOISE / DUAL-PRONG is allowed and often correct: when the record supports BOTH causation and aggravation of the SAME upstream, set framing="dual_prong" and plead both prongs of that one upstream (BVA dual-prong precedent, NOT stacking). Do not force a single rigid label when the picture is genuinely multi-path — capture it in clinical_nuance.

DOMINANT-THEORY + CONVERGENT MECHANISM: the letter LEADS exactly ONE theory (primary_anchor) — the single highest-probability winnable one. Never stack independent theories in the lead. CONVERGENT shared-mechanism is the one permitted multiplicity: if TWO+ SC conditions feed ONE physiologic mechanism producing ONE claimed condition (e.g. asthma + allergic rhinitis + bronchiectasis -> OSA via united-airway inflammation/obstruction), argue them together as ONE mechanism with multiple contributing SC inputs. Convergent inputs go in convergent_anchors and MUST share the SAME mechanism as primary_anchor; a condition reaching the claim by a DIFFERENT mechanism is an alternative_theory, not convergent. Still designate ONE dominant upstream whose prong(s) the opinion pleads. When choosing the dominant upstream, prefer the one with the strongest STAND-ALONE, directional, prospective mechanism — a blessed/established pathway outranks a weaker contingent one even if the weaker one feels "more specific."

THE TWO USER INPUTS (weight differently):
- team_drafting_guidance (TRUSTED — the physician/RN): a HIGH-WEIGHT strategic steer. If they ask you to lead a particular anchor, framing, or emphasis, DO IT whenever defensible. Override ONLY if it would require a forbidden/excluded pair, a fabricated fact, or a sub-50% theory; then say so in rationale and offer the closest defensible version. Record it in team_guidance_followed. CRITICAL: the steer sets EMPHASIS, not the final pick — if a NON-steered SC condition is mechanistically STRONGER and HIGHER-RATED than the steered anchor, LEAD that stronger one and demote the steered anchor to convergent, stating why (never lead a rated-0/10% anchor over a 50-70% SC condition that carries the claim better).
- veteran_proposed_theory (the veteran's GOAL, not authority): engage it respectfully; use the veteran's lived experience to shape framing and pre-empt counterarguments (e.g., a pilot not reporting symptoms for fear of being grounded explains thin in-service records). It can shape the argument but CANNOT establish a diagnosis, rating, or fact. If a different anchor is stronger, choose it and say why.

PROBATIVE WEIGHT (Nieves-Rodriguez) + HONESTY: the winning argument is factually accurate, fully articulated, mechanism-grounded — what an RO would actually grant. State the strongest counterargument every time. If the best counterargument defeats the affirmative case at the >=50% line, the answer is NOT SUPPORTABLE — say so. When thin or genuinely unclear, ABSTAIN to needs_physician_review rather than forcing a theory.

CALIBRATION + HARD GUARDRAILS (do not skip):
- CONFIDENCE must be SPREAD across high/moderate/low — do NOT default everything to "moderate". Use "high" AFFIRMATIVELY for an established, single-direction mechanism where the upstream is SC and the downstream dx is confirmed: the textbook cases ARE high — knee->back altered gait; biceps-repair->shoulder OA (same-compartment post-surgical sequela); PTSD/MDD->OSA WITH documented obesity; a recognized secondary with a clean mechanism and no dominant competing cause. Do NOT reflexively downgrade these to moderate. Use "moderate" for a real but CONTESTED or multifactorial pathway (a genuine confounder competes, or the mechanism is established but the directness is arguable). Use "low" (MANDATORY) when the lead mechanism is non-mainstream, OR the identical upstream->claimed pair was already DENIED, OR the dominant population cause of the claimed condition is a NON-service-connected confounder (e.g. morbid obesity for OSA with only a weak airway anchor).
- TINNITUS may LEAD only conditions with an established trigeminal/auditory-limbic mechanism. NEVER lead tinnitus as the causal origin of PTSD (tinnitus cannot supply a DSM-5 Criterion A stressor) or of CENTRAL sleep apnea. If tinnitus is the only SC anchor for OSA / PTSD / migraine, set confidence=low and put the stronger real path in alternative_theories (direct 3.304(f) for PTSD; a psychiatric anchor for migraine; nasal/airway for OSA).
- PRIOR-DENIED pair: if the chart shows the chosen upstream->claimed pair was already denied, PREFER a legally distinct anchor/framing as the lead; if none exists, keep it but set confidence<=low and state in rationale what NEW mechanism overcomes the prior denial.
- DOMINANT CONFOUNDER: when the chart documents a comorbidity that is the dominant population cause of the claimed condition (BMI>=40 for OSA; H. pylori for gastritis; CHF / Cheyne-Stokes for central apnea; age-presbycusis for SNHL), NAME it and require the letter to rebut it; if that confounder is itself service-connected, prefer leading or converging on it.
- CONVERGENT cap: include only the 2-3 anchors that add a genuinely distinct/additive mechanism; do not pad with rating-code duplicates of one condition or speculative positional links.
- OSA with multiple united-airway SC conditions: rank the LEAD by rating + mechanistic directness — asthma / bronchiectasis generally outrank isolated rhinitis as the lead, with the others convergent.

OUTPUT: answer ONLY by calling the emit_argument_plan tool. Reason internally; the fields capture the conclusions. Be concrete and RO-defensible in every rationale field — name the mechanism, the CFR, the missing fact.`;

const TOOL = {
  name: 'emit_argument_plan',
  description: 'Emit the ranked, RO-defensible argument plan. Call exactly once. Every clinical claim grounded in the inputs or established physiology; never invent facts, diagnoses, ratings, dates, or statistics. Select anchors only from candidate_anchors.',
  input_schema: {
    type: 'object', additionalProperties: false,
    required: ['viability', 'primary_anchor', 'convergent_anchors', 'alternative_theories', 'excluded_anchors', 'missing_facts', 'team_guidance_followed', 'clinical_nuance', 'overall_rationale'],
    properties: {
      viability: { type: 'string', enum: ['supportable', 'marginal', 'needs_physician_review', 'not_supportable'] },
      primary_anchor: { type: 'object', additionalProperties: false,
        required: ['upstream', 'upstream_type', 'claimed', 'framing', 'cfr_basis', 'dominant_mechanism', 'rationale', 'strongest_counterargument', 'confidence'],
        properties: {
          upstream: { type: 'string' },
          upstream_type: { type: 'string', enum: ['sc_condition', 'in_service_event', 'exposure'] },
          claimed: { type: 'string' },
          framing: { type: 'string', enum: ['aggravation', 'secondary_causation', 'dual_prong', 'direct', 'presumptive'] },
          cfr_basis: { type: 'string', enum: ['3.310(b)', '3.310(a)', '3.310(a)+(b)', '3.306/Allen', '3.303', '3.304(f)', '1154(b)', 'presumptive-PACT', 'presumptive-AO', 'presumptive-3.317', 'presumptive-CampLejeune'] },
          dominant_mechanism: { type: 'string' },
          rationale: { type: 'string' },
          strongest_counterargument: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'moderate', 'low'] },
        } },
      convergent_anchors: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['upstream', 'shared_mechanism_note'], properties: { upstream: { type: 'string' }, shared_mechanism_note: { type: 'string' } } } },
      alternative_theories: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['upstream', 'framing', 'cfr_basis', 'mechanism', 'why_not_primary'], properties: { upstream: { type: 'string' }, framing: { type: 'string', enum: ['aggravation', 'secondary_causation', 'dual_prong', 'direct', 'presumptive'] }, cfr_basis: { type: 'string' }, mechanism: { type: 'string' }, why_not_primary: { type: 'string' } } } },
      excluded_anchors: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['upstream', 'reason'], properties: { upstream: { type: 'string' }, reason: { type: 'string', enum: ['reverse_causation', 'wrong_physiologic_direction', 'pyramiding_4.14_or_4.130', 'weaker_mechanism', 'no_temporal_support', 'off_mechanism'] } } } },
      missing_facts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['fact_needed', 'why_it_matters', 'strengthens_framing'], properties: { fact_needed: { type: 'string' }, why_it_matters: { type: 'string' }, strengthens_framing: { type: 'string', enum: ['aggravation', 'secondary_causation', 'direct', 'presumptive', 'any'] } } } },
      team_guidance_followed: { type: 'string', enum: ['followed', 'partially_followed', 'overridden_for_cause', 'no_guidance_given'] },
      clinical_nuance: { type: 'string' },
      overall_rationale: { type: 'string' },
    },
  },
};

function _scList(chartIndex) {
  const out = [];
  const push = (arr) => { if (Array.isArray(arr)) for (const x of arr) { const name = typeof x === 'string' ? x : (x && (x.condition || x.name)); if (name) out.push({ name, rating_pct: (x && typeof x === 'object' && x.rated_pct != null) ? x.rated_pct : (x && x.rating_pct != null ? x.rating_pct : null) }); } };
  if (chartIndex) { push(chartIndex.granted_service_connections); if (chartIndex.va_concessions) push(chartIndex.va_concessions.granted_service_connections); }
  // dedupe by name
  const seen = new Set(); return out.filter((s) => { const k = s.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

function buildUserPrompt({ claimedCondition, chartIndex, candidateNames, physicianGuidance }) {
  const sc = _scList(chartIndex).map((s) => `- ${s.name}${s.rating_pct != null ? ` (rated ${s.rating_pct}%)` : ''}`).join('\n') || '- (none parsed)';
  const problems = (chartIndex && Array.isArray(chartIndex.problem_list)) ? chartIndex.problem_list.map((p) => (typeof p === 'string' ? p : (p && (p.problem || p.name || p.condition)))).filter(Boolean) : [];
  const events = (chartIndex && chartIndex.va_concessions && chartIndex.va_concessions.in_service_event_conceded) ? [String(chartIndex.va_concessions.in_service_event_conceded)] : [];
  const vetStmt = (chartIndex && (chartIndex.veteran_statement || (chartIndex.caseFraming && chartIndex.caseFraming.veteran_statement))) || '';
  const cand = (candidateNames && candidateNames.length ? candidateNames : _scList(chartIndex).map((s) => s.name)).map((x) => `- ${x}`).join('\n') || '- (none)';
  return `<case>
<claimed_condition>${claimedCondition || '(unknown)'}</claimed_condition>

<granted_sc_conditions>
${sc}
</granted_sc_conditions>

<in_service_events>
${events.map((e) => `- ${e}`).join('\n') || '- (none documented)'}
</in_service_events>

<chart_facts>
Confirmed diagnoses: ${[claimedCondition].filter(Boolean).join('; ') || '(none)'}
Problem list: ${problems.slice(0, 60).join('; ') || '(none)'}
</chart_facts>

<candidate_anchors>
These SC conditions passed the exclusion filter and are the ONLY anchors you may select for a secondary/aggravation theory:
${cand}
</candidate_anchors>

<team_drafting_guidance authority="physician/RN" trust="trusted-steer">
${physicianGuidance ? String(physicianGuidance) : '(none provided)'}
</team_drafting_guidance>

<veteran_proposed_theory authority="none" trust="untrusted-input">
${vetStmt || '(none provided)'}
</veteran_proposed_theory>
</case>

Produce the argument plan by calling emit_argument_plan. Pick the single best GRANT-defensible theory under the framing-priority doctrine; honor the team steer when defensible; abstain honestly if no theory reaches >=50%.`;
}

// Returns the validated plan object, or null on any failure (fail-open: framingGate then
// falls through to the existing LLM framing path). llmClient + anthropicGate are injected
// to reuse the gate's billing/replay chokepoint without a circular require.
async function pickRoute({ claimedCondition, chartIndex, candidateNames, physicianGuidance, llmClient, anthropicGate, caseTag }) {
  try {
    const userMessage = buildUserPrompt({ claimedCondition, chartIndex, candidateNames, physicianGuidance });
    if (anthropicGate && anthropicGate.ensureApiCallAllowed) {
      anthropicGate.ensureApiCallAllowed({ model: MODEL, estimatedInputTokens: Math.ceil((SYSTEM.length + userMessage.length) / 4) + 400, estimatedOutputTokens: MAX_TOKENS, tag: caseTag || 'aiRoutePicker' });
    }
    const res = await llmClient.createMessageRaw({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: [TOOL],
      tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{ role: 'user', content: userMessage }],
    }, caseTag || 'aiRoutePicker', { timeout: 120000 });
    const data = res && res.data ? res.data : res;
    if (anthropicGate && anthropicGate.recordApiCall) {
      const u = (data && data.usage) || {};
      anthropicGate.recordApiCall({ model: (data && data.model) || MODEL, freshInputTokens: u.input_tokens || 0, cacheReadTokens: u.cache_read_input_tokens || 0, cacheWriteTokens: u.cache_creation_input_tokens || 0, outputTokens: u.output_tokens || 0, tag: caseTag || 'aiRoutePicker' });
    }
    if (data && data.stop_reason === 'max_tokens') { console.error('[aiRoutePicker] truncated (max_tokens) — fail-open to legacy framing'); return null; }
    const tu = ((data && data.content) || []).find((b) => b.type === 'tool_use' && b.name === TOOL.name);
    const plan = tu && tu.input;
    if (!plan || !plan.primary_anchor || !plan.primary_anchor.upstream) { console.error('[aiRoutePicker] no/invalid plan — fail-open'); return null; }
    return plan;
  } catch (e) {
    console.error(`[aiRoutePicker] error — fail-open to legacy framing: ${e && e.message}`);
    return null;
  }
}

module.exports = { pickRoute, buildUserPrompt, MODEL, TEMPERATURE, MAX_TOKENS, SYSTEM, TOOL };
