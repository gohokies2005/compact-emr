/**
 * AI-synthesized SOAP-note Overview (Ryan 2026-06-20). The RN's calm, human-readable lead on the case:
 * the model SYNTHESIZES the assembled facts into a smooth Subjective / Objective / Assessment / Plan note
 * — NOT a deterministic dump. It reads like a careful physician wrote it to be presented.
 *
 * Modeled on the proven sanity-impression path (tool-forced, fail-open, cached): a SINGLE bounded LLM call.
 *   - MODEL: Sonnet 4.6 — fast enough to reliably complete UNDER the 29s API cap (Opus risks a timeout on
 *     this longer output). Strong synthesis quality; cheap for volume.
 *   - OUTPUT: a tool with the four SOAP sections + an overall confidence + a one-word plan action. Smooth
 *     prose, no lists, no headers inside a section, no internal jargon (no M-tiers, no "pair-atlas", no BVA %).
 *   - GROUNDED: writes ONLY from the assembled context (the same facts the Overview already has). Never
 *     invents an AHI, an imaging finding, or a diagnosis not provided.
 *   - FAIL-OPEN: incomplete input / API error / truncation → null (the card falls back to the deterministic
 *     verdict line). Never throws.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { resolveAnthropicApiKey } from './letter-surgical-propose.js';

const MODEL = process.env['SOAP_NOTE_MODEL'] || 'claude-sonnet-4-6';

export type SoapConfidence = 'high' | 'moderate' | 'low';
export type SoapAction = 'draft' | 'get_records' | 'clarify' | 'physician_review' | 'reject';

export interface SoapNote {
  readonly subjective: string;
  readonly objective: string;
  readonly assessment: string;
  readonly plan: string;
  readonly confidence: SoapConfidence;
  readonly action: SoapAction;
  /** Deterministic grounding guard: a clinical measurement (AHI/BMI/%/mg/dB) stated in the note that does
   *  NOT appear in the source facts → likely fabricated. Null = clean. The FE shows it as a verify caveat. */
  readonly caveat: string | null;
}

// Anti-confabulation guard #1 (deterministic, $0): a CLINICAL MEASUREMENT value in the prose that is not
// in the source facts is likely fabricated. We target only measurement-PATTERNED numbers (AHI/RDI/BMI/
// O2 sat/%/mg/dB/mmHg) so we never false-flag a CFR cite (38 CFR 3.310), a year, or a page count. Numbers
// present anywhere in the source context are allowed. Conservative: flags, never edits the prose.
const MEASUREMENT_RE = /\b(AHI|RDI|BMI|apnea[- ]hypopnea index|oxygen saturation|O2 sat|SpO2)\b[^\d]{0,12}(\d{1,3}(?:\.\d+)?)|(\d{1,3}(?:\.\d+)?)\s?(%|mg|dB|mmHg)\b/gi;
function checkGrounding(note: { subjective: string; objective: string; assessment: string; plan: string }, contextText: string): string | null {
  const ctxDigits = new Set((contextText.match(/\d{1,4}(?:\.\d+)?/g) ?? []));
  const prose = `${note.subjective} ${note.objective} ${note.assessment} ${note.plan}`;
  const flagged: string[] = [];
  let m: RegExpExecArray | null;
  MEASUREMENT_RE.lastIndex = 0;
  while ((m = MEASUREMENT_RE.exec(prose)) !== null) {
    const num = m[2] ?? m[3]; // the captured numeric value
    if (num && !ctxDigits.has(num) && !ctxDigits.has(num.replace(/\.\d+$/, ''))) {
      flagged.push(m[0].trim());
    }
  }
  if (flagged.length === 0) return null;
  return `Verify these values — they are not in the chart facts provided: ${[...new Set(flagged)].slice(0, 4).join('; ')}.`;
}

export interface SoapContext {
  readonly claimedCondition: string;
  /** The veteran's own words (their reported history / goal) — the Subjective source. */
  readonly veteranStatement?: string | null;
  /** The engine's framing in plain words, e.g. "OSA secondary to service-connected sinusitis/rhinitis". */
  readonly theory?: string | null;
  readonly mechanism?: string | null;
  /** Service-connected conditions on file (anchors) — pass them ALL; the model picks the PERTINENT ones. */
  readonly scConditions?: readonly string[];
  /** Active problems / diagnoses. */
  readonly activeProblems?: readonly string[];
  /** Salient labeled facts (dx dates, AHI, imaging excerpts, in-service events) — {label,value}. */
  readonly keyFacts?: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  /** Medications (drug + indication), when relevant to a secondary mechanism. */
  readonly medications?: ReadonlyArray<{ readonly drugName: string; readonly indication: string | null }>;
  /** One line on records capture, e.g. "All 1463 pages read." / "2 pages unread." */
  readonly coverageNote?: string | null;
  /** The deterministic engine read (band + confidence + next action) — a HINT the model explains, not gospel. */
  readonly engineVerdict?: string | null;
  readonly engineNextAction?: string | null;
}

const SOAP_TOOL: Anthropic.Tool = {
  name: 'write_soap_note',
  description: 'Write a smooth, human-readable SOAP-note overview of this VA nexus case for an RN to read at a glance.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['subjective', 'objective', 'assessment', 'plan', 'confidence', 'action'],
    properties: {
      subjective: { type: 'string', description: 'PERTINENT patient-reported information only, in flowing prose (2-4 sentences). What the veteran reports about onset, symptoms, in-service experience, and their own theory — distilled and readable, NOT a verbatim copy of their statement. No headers, no lists.' },
      objective: { type: 'string', description: 'A short, readable overview of the PERTINENT objective findings: the confirmed diagnosis, the relevant service-connected conditions (only those that matter to this claim — NOT every rated condition), and any key diagnostics provided (e.g. AHI, imaging excerpts, sleep study, labs). End with the records-capture status (e.g. "All records were reviewed."). 2-4 sentences of prose, no lists.' },
      assessment: { type: 'string', description: 'Tie it together as a clinician + VA-claims expert would: the medical mechanism linking the claim to the service-connected condition(s), how it fits VA theory and language (secondary causation/aggravation under 38 CFR 3.310, direct under 3.303, etc., as applicable), the strongest counterpoint, and an honest overall read of how strong what we have is. 3-5 sentences of smooth prose. No internal jargon (no M-tiers, no BVA percentages, no "pair-atlas").' },
      plan: { type: 'string', description: 'The concrete next step in plain language: draft the letter, get specific records, clarify a specific point with the veteran, route to a physician, or decline — and WHY, in one or two sentences.' },
      confidence: { type: 'string', enum: ['high', 'moderate', 'low'], description: 'Overall confidence in what we have to support this claim as filed.' },
      action: { type: 'string', enum: ['draft', 'get_records', 'clarify', 'physician_review', 'reject'], description: 'The single recommended next action, matching the plan.' },
    },
  },
};

const SYSTEM =
  'You are a board-certified physician who also knows VA disability law, writing a concise SOAP-note overview ' +
  'of a veteran\'s nexus case for a nurse to read at a glance before the letter is drafted. Synthesize the ' +
  'facts you are given into SMOOTH, HUMAN PROSE that reads like a thoughtful colleague wrote it — never a ' +
  'list, never a data dump, never a verbatim echo of the inputs.\n' +
  'Subjective = the pertinent things the VETERAN reports (distilled, in your words). Objective = the pertinent ' +
  'confirmed diagnoses + the service-connected conditions that actually matter to THIS claim + any real ' +
  'diagnostics provided (AHI, imaging, sleep study, labs) + the records-capture status. Do NOT list every ' +
  'rated condition — pick what is pertinent. Assessment = the medical mechanism + how it maps to VA theory ' +
  'and regulation (3.310 secondary/aggravation, 3.303 direct, presumptives) + the strongest counterpoint + an ' +
  'honest overall read. Plan = the one concrete next step (draft / get records / clarify / physician review / ' +
  'reject) and why.\n' +
  'GROUND STRICTLY in the facts provided — never invent an AHI, an imaging finding, a date, or a diagnosis ' +
  'that is not given. If a useful objective datum (like an AHI) was not provided, simply do not mention it. ' +
  'No internal jargon (no M-tiers, no BVA/win-rate percentages, no "pair-atlas"), no markdown, no headers ' +
  'inside a section. Write it with write_soap_note.';

function renderContext(ctx: SoapContext): string {
  const L: string[] = [];
  L.push(`Claimed condition: ${ctx.claimedCondition}`);
  if (ctx.veteranStatement) L.push(`Veteran's own statement (their words): ${ctx.veteranStatement}`);
  if (ctx.theory) L.push(`Working theory/framing: ${ctx.theory}`);
  if (ctx.mechanism) L.push(`Proposed mechanism: ${ctx.mechanism}`);
  if (ctx.scConditions?.length) L.push(`Service-connected conditions on file: ${ctx.scConditions.join('; ')}`);
  if (ctx.activeProblems?.length) L.push(`Active problems: ${ctx.activeProblems.join('; ')}`);
  if (ctx.keyFacts?.length) L.push(`Key facts:\n- ${ctx.keyFacts.map((f) => `${f.label}: ${f.value}`).join('\n- ')}`);
  if (ctx.medications?.length) L.push(`Medications: ${ctx.medications.map((m) => `${m.drugName}${m.indication ? ` (${m.indication})` : ''}`).join('; ')}`);
  if (ctx.coverageNote) L.push(`Records capture: ${ctx.coverageNote}`);
  if (ctx.engineVerdict) L.push(`Engine read (a hint to explain, not gospel): ${ctx.engineVerdict}`);
  if (ctx.engineNextAction) L.push(`Engine's suggested next step: ${ctx.engineNextAction}`);
  return L.join('\n');
}

function clamp(s: unknown, n: number): string {
  return typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').slice(0, n) : '';
}

const _cache = new Map<string, SoapNote | null>();

/** Synthesize the SOAP note. Returns null (fail-open) on incomplete input / API error / truncation. */
export async function buildSoapNote(ctx: SoapContext): Promise<SoapNote | null> {
  if (!ctx.claimedCondition || ctx.claimedCondition.trim().length === 0) return null;

  const key = createHash('sha256').update(JSON.stringify(ctx)).digest('hex');
  if (_cache.has(key)) return _cache.get(key) ?? null;

  let anthropic: Anthropic;
  // Bound to the 29s API cap (Sonnet fits comfortably); fail-open if a slow call would blow the window.
  try { anthropic = new Anthropic({ apiKey: await resolveAnthropicApiKey(), timeout: 25_000, maxRetries: 0 }); }
  catch { return null; }

  try {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1300,
      system: SYSTEM,
      tools: [SOAP_TOOL],
      tool_choice: { type: 'tool', name: 'write_soap_note' },
      messages: [{ role: 'user', content: renderContext(ctx) }],
    });
    if (resp.stop_reason === 'max_tokens') return null; // truncated → discard, card falls back
    const block = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'write_soap_note');
    const inp = block?.input as Record<string, unknown> | undefined;
    if (!inp) return null;
    const subjective = clamp(inp['subjective'], 1200);
    const objective = clamp(inp['objective'], 1200);
    const assessment = clamp(inp['assessment'], 1600);
    const plan = clamp(inp['plan'], 800);
    const conf = inp['confidence'];
    const action = inp['action'];
    if (!assessment || !plan) return null;
    const base = { subjective, objective, assessment, plan };
    const note: SoapNote = {
      ...base,
      confidence: (conf === 'high' || conf === 'moderate' || conf === 'low') ? conf : 'moderate',
      action: (action === 'draft' || action === 'get_records' || action === 'clarify' || action === 'physician_review' || action === 'reject') ? action : 'physician_review',
      caveat: checkGrounding(base, renderContext(ctx)),
    };
    _cache.set(key, note);
    return note;
  } catch {
    return null; // API/network error → fail-open
  }
}
