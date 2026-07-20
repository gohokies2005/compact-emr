/**
 * Final "overall impression" sanity-check (Ryan 2026-06-16) — recreates the holistic "does this make
 * sense, did we miss anything, were the records really all checked?" review, run automatically at two
 * points: end of PRE-DRAFT (before a letter is written) and POST-DRAFT (after it's drafted + graded).
 *
 * It is the GENERALIST gut-check the narrow gates (viability / framing / Gate-2 / grader) can't be —
 * each of those sees one slice; this one steps back and reads the whole thing cold, as a careful PCP +
 * VA rater + VA-claims lawyer would. It catches the long-tail "weird stuff" (e.g. a nonsensical
 * "wrist pain → PTSD" theory, a draft leaning on pages that came back unread).
 *
 * Design (Ryan's parameters):
 *   - ADVISORY ONLY. Never blocks, never rewrites. Returns an impression the UI renders as ONE short
 *     SOAP-style "Overall impression" line (Clear / Caution / Concern + 1–3 lines). Not paragraphs.
 *   - HIGH BAR. Default is Clear; Caution/Concern only when something is genuinely off (no cry-wolf).
 *   - LOW TOKEN / LOW COST. Fed a STRUCTURED summary, not the raw chart. Opus 4.8, small max_tokens,
 *     draft text capped → ~$0.10–0.20/check.
 *   - FAIL-OPEN. Incomplete input, API error, or truncation → null (caller shows nothing / "not run").
 *     A safety net must never itself become a failure that blocks the pipeline.
 *
 * PURE of IO assembly: the caller builds the SanityContext (chart facts, theory, coverage, draft,
 * grade) and persists/render the result. This module only talks to Opus.
 */

import Anthropic from '@anthropic-ai/sdk';
import { resolveAnthropicApiKey } from './letter-surgical-propose.js';

const MODEL = 'claude-opus-4-8';
const MAX_DRAFT_CHARS = 18_000; // ~4–5 page letter; caps input cost (a letter never legitimately exceeds this)

export type ImpressionLevel = 'clear' | 'caution' | 'concern';

export interface SanityImpression {
  readonly stage: 'pre_draft' | 'post_draft';
  readonly impression: ImpressionLevel;
  // 1–3 plain-language sentences. The whole point is a glanceable line, never a wall of text.
  readonly summary: string;
  // The single biggest thing that looks missed/wrong, if any (else null). Kept to one short phrase.
  readonly missed: string | null;
}

export interface SanityContext {
  readonly stage: 'pre_draft' | 'post_draft';
  readonly claimedCondition: string;
  // The VETERAN'S OWN stated goal/request, in their words — the highest-signal input for "what do they
  // actually want". Often reveals a NON-standard but legitimate opinion (a Character-of-Discharge
  // §3.354 insanity IMO, a competency or aid-and-attendance opinion) that the rigid SC-anchor engine
  // mislabels as "not supportable" / "redundant". The reviewer should weigh this over the engine's label.
  readonly veteranTheory?: string | null;
  // The ENGINE'S chosen theory / framing / anchor in plain words (e.g. "OSA secondary to SC PTSD").
  // This can be WRONG or too narrow for an unusual case — it is the engine's guess, not ground truth.
  readonly theory?: string | null;
  // Service-connected conditions on file (anchors available to the argument).
  readonly scConditions?: readonly string[];
  // A few key facts the verdict should weigh (diagnoses, in-service events, dates) — short strings.
  readonly keyFacts?: readonly string[];
  // One line on how completely the records were captured (drives "were the records really all checked").
  // e.g. "All pages read." / "4 pages contain handwriting read with low confidence." / "2 pages unread."
  readonly coverageNote?: string | null;
  // POST-DRAFT only: the drafted letter text + its grade (the impression expands on the grade).
  readonly draftText?: string | null;
  readonly grade?: string | null;
}

const IMPRESSION_TOOL = {
  name: 'record_impression',
  description: 'Record a brief overall-impression sanity check of this VA nexus case.',
  input_schema: {
    type: 'object' as const,
    properties: {
      impression: {
        type: 'string' as const,
        enum: ['clear', 'caution', 'concern'],
        description: 'clear = makes sense, nothing big missed. caution = a notable concern worth a look before proceeding. concern = something is genuinely off (a nonsensical theory, a stronger anchor ignored, reliance on unread records).',
      },
      summary: {
        type: 'string' as const,
        description: '1 to 3 short plain-language sentences. Glanceable. No headers, no lists, no preamble.',
      },
      missed: {
        type: 'string' as const,
        description: 'The single biggest thing that looks missed or wrong, in one short phrase. Empty string if nothing.',
      },
    },
    required: ['impression', 'summary', 'missed'],
    additionalProperties: false,
  },
};

const PRE_DRAFT_SYSTEM =
  'You are a careful reviewer — a primary-care physician, a VA rater, and a VA-claims lawyer in one — ' +
  'doing a final gut-check BEFORE a nexus letter is drafted for this veteran. You are given the claimed ' +
  'condition, the chosen theory/anchor, the service-connected conditions on file, key facts, and how ' +
  'completely the records were read.\n' +
  'Ask yourself: Does this theory make medical and VA sense? Is there an obvious BETTER anchor or a ' +
  'missed condition? Is the plan leaning on something from records that were NOT fully read? Is the ' +
  'mechanism plausible in its established physiologic direction (a nonsensical chain like "wrist pain ' +
  'causing PTSD" is a Concern)?\n' +
  'IMPORTANT — read the VETERAN\'S OWN stated goal first, and judge against THAT, not the engine\'s ' +
  'auto-framing. The engine assumes a standard nexus/service-connection claim and can mislabel an ' +
  'unusual but LEGITIMATE request as "not supportable" or "redundant". Many real cases are not standard ' +
  'SC claims at all — e.g. a Character-of-Discharge opinion under 38 CFR 3.354(a) (was mental illness ' +
  'severe enough at the time of misconduct to meet the insanity exception), a competency opinion, an ' +
  'aid-and-attendance opinion, an opinion on severity/increase, or a secondary/aggravation pathway. If ' +
  'the veteran is clearly asking for one of these and the engine forced it into the wrong box, SAY SO ' +
  'plainly and put it in context (what the opinion actually needs to address) — do not just echo the ' +
  'engine\'s "not supportable". A genuinely confused or contradictory request is still a Concern.\n' +
  'CALIBRATION: be a neutral, faithful-but-cautious advisor — not agreeable, not a nitpicker. Do NOT ' +
  'sweat small stuff (those are Clear). But do NOT hold back something BIG: a wrong/weaker anchor, a ' +
  'nonsensical mechanism, or a plan leaning on unread records is a real Caution/Concern even if the case ' +
  'looks routine. Surfacing a genuine material problem is your job; inventing a trivial one is not. Be ' +
  'brief; this is a one-line gut-check, not a review. Record it with the record_impression tool.';

const POST_DRAFT_SYSTEM =
  'You are a neutral, faithful-but-cautious advisor giving a finished VA nexus letter a cold read, AFTER ' +
  'it was drafted and graded — a primary-care physician, a VA rater, and a VA-claims lawyer in one. You ' +
  'are given the draft and its grade. You work for NEITHER side: you are not the letter\'s cheerleader and ' +
  'not a nitpicker. The physician relies on you to tell it straight, not to be agreeable.\n' +
  'Ask yourself: Does the letter actually support its own opinion? Did it ANSWER what the veteran actually ' +
  'asked for (read their stated goal — an unusual but legitimate request like a Character-of-Discharge ' +
  '38 CFR 3.354(a) insanity opinion or a competency/aid-and-attendance opinion is valid; flag if the ' +
  'letter wrote a standard nexus instead)? Where would a specialist C&P examiner or VA rater have a REAL ' +
  'opening to attack it — a diagnosis or category mismatch (e.g. treating a likely-congenital condition ' +
  'as an acquired one), a fact stated more firmly than the record supports, a severity/onset claim with ' +
  'no evidence behind it, a stronger anchor or theory ignored, or reliance on records that were not read?\n' +
  'CALIBRATION — this is the whole point: do NOT sweat small stuff. Wording, style, tone, a slightly long ' +
  'sentence, cosmetic polish → those are Clear, stay silent on them. But do NOT hold back something BIG. ' +
  'If there is a MATERIAL vulnerability that could cost the veteran the claim, name it plainly — Caution ' +
  'for a notable opening worth a look before signing, Concern for a real and likely-fatal weakness — ' +
  'EVEN WHEN THE GRADE IS HIGH. A high grade does not immunize a letter from a substantive flaw, and an ' +
  '"A-" with a genuine category mismatch is a Caution, not a Clear. Surfacing a real material weakness is ' +
  'your job; inventing a trivial one to fill the field is not. If the letter is genuinely sound with no ' +
  'material weakness, Clear with an EMPTY missed field is correct — do not manufacture a concern.\n' +
  'Lead with the verdict, then state the single biggest real vulnerability in one plain phrase (the ' +
  'missed field). Keep it to 1–3 sentences. Record it with the record_impression tool.';

function renderContext(ctx: SanityContext): string {
  const lines: string[] = [];
  lines.push(`Claimed condition: ${ctx.claimedCondition}`);
  if (ctx.veteranTheory) lines.push(`Veteran's OWN stated goal (their words — weigh this heavily): ${ctx.veteranTheory}`);
  if (ctx.theory) lines.push(`Engine's auto-framing (a guess — may be wrong/too narrow): ${ctx.theory}`);
  if (ctx.scConditions && ctx.scConditions.length > 0) lines.push(`Service-connected on file: ${ctx.scConditions.join('; ')}`);
  if (ctx.keyFacts && ctx.keyFacts.length > 0) lines.push(`Key facts:\n- ${ctx.keyFacts.join('\n- ')}`);
  if (ctx.coverageNote) lines.push(`Records capture: ${ctx.coverageNote}`);
  if (ctx.stage === 'post_draft') {
    if (ctx.grade) lines.push(`Grade: ${ctx.grade}`);
    const draft = (ctx.draftText ?? '').slice(0, MAX_DRAFT_CHARS);
    if (draft.trim().length > 0) lines.push(`\nDrafted letter:\n${draft}`);
  }
  return lines.join('\n');
}

/** True when the context lacks what its stage needs — caller skips the call (no spend, returns null). */
function contextIncomplete(ctx: SanityContext): boolean {
  if (!ctx.claimedCondition || ctx.claimedCondition.trim().length === 0) return true;
  if (ctx.stage === 'post_draft') return !(ctx.draftText && ctx.draftText.trim().length >= 200);
  return false;
}

function clampSummary(s: unknown): string {
  if (typeof s !== 'string') return '';
  // Keep it glanceable — a few sentences, never a wall. Hard cap defends against a runaway model.
  return s.trim().replace(/\s+/g, ' ').slice(0, 600);
}

/**
 * Run the sanity check. Returns the impression, or null (fail-open) on incomplete input / API error /
 * truncation / a malformed tool result. Never throws — a safety net must not become a new failure mode.
 */
export async function buildSanityImpression(ctx: SanityContext): Promise<SanityImpression | null> {
  if (contextIncomplete(ctx)) return null;

  let anthropic: Anthropic;
  try {
    anthropic = new Anthropic({ apiKey: await resolveAnthropicApiKey(), timeout: 30_000, maxRetries: 2 });
  } catch {
    return null; // key not resolvable → no impression, never block
  }

  try {
    const resp = await anthropic.messages.create({
      model: MODEL,
      // 500 = a few lines + the tool envelope. NOTE: extended `thinking` is intentionally OMITTED (off)
      // — turning it on would spend this budget on thinking tokens → truncation → discarded impressions.
      // Opus 4.8 also deprecated temperature/top_p, so no sampling params.
      max_tokens: 500,
      system: ctx.stage === 'pre_draft' ? PRE_DRAFT_SYSTEM : POST_DRAFT_SYSTEM,
      tools: [IMPRESSION_TOOL],
      tool_choice: { type: 'tool', name: 'record_impression' },
      messages: [{ role: 'user', content: renderContext(ctx) }],
    });
    if (resp.stop_reason === 'max_tokens') return null; // truncated → discard
    const block = resp.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'record_impression',
    );
    const input = block?.input as { impression?: unknown; summary?: unknown; missed?: unknown } | undefined;
    const level = input?.impression;
    if (level !== 'clear' && level !== 'caution' && level !== 'concern') return null;
    const summary = clampSummary(input?.summary);
    if (summary.length === 0) return null;
    const missedRaw = typeof input?.missed === 'string' ? input.missed.trim() : '';
    return {
      stage: ctx.stage,
      impression: level,
      summary,
      missed: missedRaw.length > 0 ? missedRaw.slice(0, 240) : null,
    };
  } catch {
    return null; // API/network error → no impression, never block
  }
}
