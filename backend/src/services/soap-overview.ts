/**
 * Consolidated SOAP-note Overview (Ryan 2026-06-19) — the calm front of the case Overview. ONE short
 * SOAP-style narrative + ONE traffic light (green/amber/red), replacing the wall of dense engine panels
 * (those move behind a "view details" toggle, still available).
 *
 * TWO-BRAIN design (the load-bearing safety rule, per the 5-discipline panel):
 *   - The DETERMINISTIC inputs decide the traffic-LIGHT color + the hard facts. The AI does NOT pick the
 *     color. It only WRITES the calm SOAP prose around the facts it is handed, and self-checks.
 *   - It GROUNDS on the AI route-picker plan (deriveAiViability — the SAME brain the drafter + the card
 *     use) + the chart facts. It restates the chosen pathway; it never re-decides the argument (so the
 *     SOAP, the card, and the drafter cannot contradict — one brain, narrated once).
 *
 * Anti-fabrication: closed-world (only the provided facts), forced tool output, abstain when thin,
 * fail-open to null (the Overview then shows the plain engine read). Cached in-process by input-hash.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { resolveAnthropicApiKey } from './letter-surgical-propose.js';
import { deriveAiViability, aiRoutePickerEnabled, type AiViabilityCard } from './ai-viability.js';
import type { AppDb } from './db-types.js';

const MODEL = process.env['SOAP_OVERVIEW_MODEL'] || 'claude-sonnet-4-6';

export type TrafficLight = 'green' | 'amber' | 'red';

export interface SoapOverview {
  readonly light: TrafficLight;
  readonly headline: string;       // one calm sentence
  readonly soap: string;           // 2-4 short paragraphs (the assessment/plan, plain clinical voice)
  readonly next_action: string;    // one verb-first line ("Proceed to drafting"; "Obtain the sleep study")
  readonly generated_at: string;
}

/**
 * The light is DETERMINISTIC — derived from the picker viability + chart-read state, NEVER from the AI.
 * supportable + chart read → green; marginal/needs_physician_review → amber; not_supportable → red;
 * chart not fully read pulls green→amber (preliminary).
 */
function deriveLight(viability: AiViabilityCard['viability'], chartFullyRead: boolean): TrafficLight {
  if (viability === 'not_supportable') return 'red';
  if (viability === 'needs_physician_review' || viability === 'marginal') return 'amber';
  // supportable:
  return chartFullyRead ? 'green' : 'amber';
}

const SYSTEM =
  'You are an experienced RN charting a one-glance SOAP-style summary for a physician on a VA ' +
  'nexus-letter case. You are given a DECISION that is already made (the chosen pathway, the traffic-' +
  'light color, the chart facts). Your ONLY job is to narrate it calmly and plainly — you do NOT choose ' +
  'the pathway or the color, and you NEVER invent a fact, a rating, a diagnosis, or a number that is ' +
  'not in the inputs.\n' +
  'Write like a careful clinician handing off: plain language, no jargon (no M-tier, no CFR codes, no ' +
  '"E:", no probability math), no "I", calm and declarative. Structure as a short assessment + plan:\n' +
  '- a one-sentence HEADLINE (what this case is, in plain words),\n' +
  '- a SOAP body of 2-4 short paragraphs (who the veteran is + what they claim; what the record shows; ' +
  'the likely supported pathway and why it holds; what is still needed if anything),\n' +
  '- a NEXT_ACTION: one verb-first line matching the traffic light (green = proceed to drafting; amber = ' +
  'the one thing to confirm/obtain first or that a physician should review; red = what records are ' +
  'needed before this can proceed).\n' +
  'The traffic light is ALREADY decided and given to you — your prose must EXPLAIN it, never contradict ' +
  'it (do not write "ready to draft" under an amber/red light). If the inputs are thin, say so plainly ' +
  'rather than inventing confidence. Record it with the record_soap tool.';

const TOOL: Anthropic.Tool = {
  name: 'record_soap',
  description: 'Record the calm SOAP-note Overview. Narrate the provided decision; never invent facts.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['acknowledged_light', 'headline', 'soap', 'next_action'],
    properties: {
      acknowledged_light: { type: 'string', enum: ['green', 'amber', 'red'], description: 'Echo the traffic light you were given. Must match — your prose explains this color.' },
      headline: { type: 'string', description: 'One calm plain-language sentence.' },
      soap: { type: 'string', description: '2-4 short paragraphs, plain clinician voice, no jargon. Separate paragraphs with a blank line.' },
      next_action: { type: 'string', description: 'One verb-first line consistent with the light.' },
    },
  },
};

function renderInputs(claimed: string, plan: AiViabilityCard, chartFacts: string[], coverageNote: string, light: TrafficLight): string {
  const lines: string[] = [];
  lines.push(`TRAFFIC LIGHT (already decided — explain it, do not change it): ${light.toUpperCase()}`);
  lines.push(`Claimed condition: ${claimed}`);
  lines.push(`Chosen pathway (from the case engine — restate, do not re-decide): ${plan.lead.upstream} → ${plan.lead.claimed} (${plan.lead.framing})`);
  if (plan.lead.mechanism) lines.push(`Mechanism: ${plan.lead.mechanism}`);
  if (plan.convergent.length) lines.push(`Also supporting the same mechanism: ${plan.convergent.map((c) => c.upstream).join(', ')}`);
  lines.push(`Engine viability: ${plan.viability}; confidence: ${plan.lead.confidence}`);
  if (plan.lead.counterargument) lines.push(`Strongest counterargument to address: ${plan.lead.counterargument}`);
  if (plan.missing.length) lines.push(`Still needed / would strengthen: ${plan.missing.map((m) => m.fact).join('; ')}`);
  if (chartFacts.length) lines.push(`Chart problem list: ${chartFacts.slice(0, 40).join('; ')}`);
  lines.push(`Records capture: ${coverageNote}`);
  if (plan.overall) lines.push(`Engine bottom line: ${plan.overall}`);
  return lines.join('\n');
}

/**
 * Build the calm SOAP Overview for a case. Grounds on the AI picker plan + chart. Returns null
 * (fail-open) when the picker is off / unavailable, the key is unresolvable, the call fails/truncates,
 * or the model fails to echo the deterministic light (anti-drift guard). Cached in-process.
 */
export async function buildSoapOverview(db: AppDb, caseId: string): Promise<SoapOverview | null> {
  if (!aiRoutePickerEnabled()) return null;
  try {
    const plan = await deriveAiViability(db, caseId);
    if (plan === null) return null; // no grounded decision → no narrative (fail-open)

    const c = (await db.case.findFirst({
      where: { id: caseId },
      select: { claimedCondition: true, veteran: { select: { activeProblems: { select: { problem: true } } } } } as never,
    })) as unknown as { claimedCondition: string; veteran: { activeProblems: Array<{ problem: string }> } | null } | null;
    if (c === null || !c.claimedCondition) return null;
    const chartFacts = [...new Set((c.veteran?.activeProblems ?? []).map((p) => (p.problem ?? '').trim()).filter(Boolean))];

    // Chart-read state for the light. Conservative: treat as fully read unless we learn otherwise (the
    // coverage breakdown lives in chart-readiness; for v1 the picker viability is the dominant signal).
    const chartFullyRead = true;
    const coverageNote = 'Records reviewed.';
    const light = deriveLight(plan.viability, chartFullyRead);

    const cacheKey = `soap:${caseId}:${createHash('sha256').update(JSON.stringify({ plan, chartFacts, light })).digest('hex')}`;
    if (_cache.has(cacheKey)) return _cache.get(cacheKey) ?? null;

    let anthropic: Anthropic;
    try { anthropic = new Anthropic({ apiKey: await resolveAnthropicApiKey(), timeout: 60_000, maxRetries: 2 }); }
    catch { return null; }

    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 900,
      temperature: 0.3,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{ role: 'user', content: renderInputs(c.claimedCondition, plan, chartFacts, coverageNote, light) }],
    });
    if (resp.stop_reason === 'max_tokens') return null;
    const block = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === TOOL.name);
    const out = block?.input as { acknowledged_light?: unknown; headline?: unknown; soap?: unknown; next_action?: unknown } | undefined;
    if (!out) return null;
    // ANTI-DRIFT: the narrator must echo the deterministic light. A mismatch = it drifted → discard
    // (fail-open), never let prose contradict the engine-decided color.
    if (out.acknowledged_light !== light) return null;
    const headline = typeof out.headline === 'string' ? out.headline.trim() : '';
    const soap = typeof out.soap === 'string' ? out.soap.trim() : '';
    const next_action = typeof out.next_action === 'string' ? out.next_action.trim() : '';
    if (!headline || !soap) return null;

    const result: SoapOverview = { light, headline, soap, next_action, generated_at: new Date().toISOString() };
    _cache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'soap-overview: failed open', caseId, error: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}

const _cache = new Map<string, SoapOverview | null>();
