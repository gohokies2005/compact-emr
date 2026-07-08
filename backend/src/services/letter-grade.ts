/**
 * On-demand FAST letter re-grader (Dr. Kasky 2026-07-08): powers the "Regrade letter" button that appears in
 * the letter editor (RN + doctor) ONLY when the current draft has unsaved edits. It runs a LIGHT, synchronous
 * probative grade on the EDITED letter TEXT so the reviewer can see whether their edits moved the quality
 * needle — without saving a new version or waiting on the full Fargate drafter pipeline.
 *
 * FAST-APPROXIMATE BY DESIGN (Ryan 2026-07-08 chose "fast approximate" over "match the drafter exactly"):
 * - This is Sonnet (not the drafter's Opus full-pipeline `runQaGradeApi`), and it grades the LETTER TEXT's
 *   internal probative quality on the SAME M21-1 factor set + hard-ceiling taxonomy as the real rubric
 *   (app/config/probative_rubric.json in the FRN drafter), distilled into one bounded prompt.
 * - It does NOT re-read the veteran's records, so it cannot fully run the Reonal "factual premise contradicted
 *   by the record" gate — it can only flag INTERNAL contradictions / unsupported premises. The grade may
 *   therefore differ slightly from the drafter's original Opus grade; that is the accepted trade-off. The UI
 *   labels it as an approximate re-grade of the edited text.
 *
 * MODELED EXACTLY on halt-explainer.ts: Anthropic-direct via resolveAnthropicApiKey, forced-tool JSON,
 * Sonnet, timeout 20s (≤ the ARCHITECTURE §5 22s sync-LLM cap; a ~700-token grade runs in ~3-8s, well inside
 * the API-Gateway 29s ceiling — no async self-invoke), maxRetries 0, FAIL-OPEN (returns null on missing key /
 * API error / timeout / truncation / malformed result), NEVER throws. The route surfaces a friendly
 * "couldn't grade, try again" on null. It is purely ADDITIVE and read-only (no save, no version, no DB write).
 */

import Anthropic from '@anthropic-ai/sdk';
import { resolveAnthropicApiKey } from './letter-surgical-propose.js';

const MODEL = process.env['LETTER_REGRADE_MODEL'] || 'claude-sonnet-4-6';
const MAX_TOKENS = 900;
const TIMEOUT_MS = 20_000;

// The grade bands from the drafter's probative rubric (overall_score_to_grade). Kept in sync with
// backend/src/routes/drafter.ts GRADES so the response renders in the existing <GradeChip/>.
export const REGRADE_GRADES = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'D', 'F'] as const;
export type RegradeGrade = (typeof REGRADE_GRADES)[number];

export interface LetterRegradeInput {
  /** The current (possibly edited, unsaved) full letter text to grade. */
  readonly letterText: string;
  /** The claimed condition, for light context in the prompt. */
  readonly claimedCondition: string;
}

export interface LetterRegrade {
  readonly grade: RegradeGrade;
  /** 1-10 probative score (the rubric's probative_score scale). */
  readonly probative_score: number;
  /** Advisory reviewer posture derived from the grade band. */
  readonly ship_recommendation: 'ship_ready' | 'normal_review' | 'examine_closely';
  /** 1-3 plain sentences: what the grade reflects + the strongest weak spot. */
  readonly rationale: string;
  /** Up to 3 short weak-criterion labels the reviewer could tighten. */
  readonly weak_spots: readonly string[];
}

const SYSTEM = `You are a VA nexus-letter probative-value grader. Grade the LETTER TEXT you are given for how persuasive it would be to a VA rater / the Board, using the M21-1-derived probative rubric below. Return a letter grade, a 1-10 probative score, and a short rationale.

You are grading the TEXT'S INTERNAL probative quality only — you do NOT have the veteran's underlying records in front of you. So judge internal reasoning, structure, and language; you can flag an INTERNAL contradiction or an unsupported-sounding premise, but do not assume a fact is false just because you can't see the record.

RUBRIC FACTORS (weights) — score the letter on each:
- Precision (26%): Is there an explicit, ordered causal reasoning chain (data → mechanism → this veteran → conclusion)? Is a specific named biological mechanism given (not a vague association)? Is the single operative opinion sentence unequivocal at ≥50% / "more likely than not" with NO hedging ("may/could/possibly/cannot be ruled out")?
- Thoroughness (22%): Where reasonably raised, are BOTH causation AND aggravation addressed (with the right doctrine)? Are leading alternative etiologies named AND dispositioned? Are specific dated record findings woven into the reasoning (not just listed)? Is a prior denial / negative C&P rationale identified and rebutted where present?
- Relevancy (21%): Is the reasoning individualized to THIS veteran (not a swappable template)? Is each cited study APPLIED to a specific fact about this veteran (not decorative)? Does the cited literature's population credibly fit this veteran's cohort?
- Credibility (18%): Objective, non-advocacy posture with calibrated certainty and no overreach (no sole-cause/exclusivity, no baseline-less aggravation, no salesmanship)?
- Competency (9%): Author credentials stated and adequate (NPI-only is fine; a specialty bridge is NOT required for common family-medicine-scope conditions).
- Date (4%): Opinion current; literature/criteria not superseded (DSM-5 not DSM-IV).

HARD CEILINGS — any of these caps the grade at C regardless of the rest (report which one tripped):
1. A fabricated or facially-unverifiable citation.
2. A factual premise the letter contradicts ITSELF on (internal contradiction).
3. Wrong path-to-rating (a secondary theory with no established service-connected primary anchor, or a non-ratable claim).
4. A load-bearing citation whose stated finding does not support the mechanism the letter asserts, left unreconciled.

GRADE BANDS (map your weighted judgment): A = 90-100 (airtight, Board-persuasive), A- = 85-89, B+ = 80-84 (solid, minor gaps — this is the ship floor), B = 73-79 (real exploitable vulnerability), B- = 67-72 (templated/under-individualized), C+ = 60-66 (conclusory / mechanism underdeveloped), C = 0-59 or any hard-ceiling trip (do-not-ship). Use D/F only for a letter that is not a real nexus opinion at all.

ANTI-INFLATION: a 4-equivalent on a factor is rare and must be earned; any genuine soft spot caps that factor below top. When torn, choose the LOWER grade.

probative_score: 1-10 where 9-10≈A, 8≈A-/B+, 7≈B, 6≈B-, 5≈C+, ≤4≈C/below.

Call grade_letter with: grade, probative_score, ship_recommendation, rationale (1-3 sentences, name the single biggest weak spot), and weak_spots (up to 3 short labels, e.g. "mechanism not named", "citations decorative", "hedged opinion sentence", "no alternative etiologies").`;

const TOOL: Anthropic.Tool = {
  name: 'grade_letter',
  description: 'Return the probative-value grade of the letter text.',
  input_schema: {
    type: 'object',
    properties: {
      grade: { type: 'string', enum: [...REGRADE_GRADES], description: 'The overall letter grade.' },
      probative_score: { type: 'integer', minimum: 1, maximum: 10, description: '1-10 probative score.' },
      ship_recommendation: {
        type: 'string',
        enum: ['ship_ready', 'normal_review', 'examine_closely'],
        description: 'ship_ready for A/A-/B+, normal_review for B/B-, examine_closely for C+ and below or any hard-ceiling trip.',
      },
      rationale: { type: 'string', description: '1-3 plain sentences: what the grade reflects and the single biggest weak spot.' },
      weak_spots: {
        type: 'array',
        items: { type: 'string' },
        description: 'Up to 3 short labels for the weakest criteria the reviewer could tighten.',
      },
    },
    required: ['grade', 'probative_score', 'ship_recommendation', 'rationale'],
  },
};

/**
 * Fast approximate re-grade of edited letter text. Returns null on ANY failure (missing key, API error,
 * timeout, truncation, malformed result) so the route can surface a friendly retry message. NEVER throws.
 */
export async function gradeLetterText(input: LetterRegradeInput): Promise<LetterRegrade | null> {
  try {
    const text = (input.letterText || '').trim();
    if (text.length < 200) return null; // not a gradeable letter — route treats null as "couldn't grade"

    let anthropic: Anthropic;
    try {
      anthropic = new Anthropic({ apiKey: await resolveAnthropicApiKey(), timeout: TIMEOUT_MS, maxRetries: 0 });
    } catch {
      return null;
    }

    let resp: Anthropic.Message;
    try {
      resp = await anthropic.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0, // a grade is a judgment, not prose — keep it stable
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: TOOL.name },
        messages: [
          {
            role: 'user',
            content: `Claimed condition: ${input.claimedCondition || '(unknown)'}\n\nGrade this nexus-letter draft:\n\n<letter>\n${text.slice(0, 60_000)}\n</letter>\n\nCall grade_letter.`,
          },
        ],
      });
    } catch (e) {
      console.warn(JSON.stringify({ msg: 'letter-grade: LLM call failed (fail-open)', error: e instanceof Error ? e.message : String(e) }));
      return null;
    }

    if (resp.stop_reason === 'max_tokens') return null;

    const block = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === TOOL.name);
    const out = block?.input as Record<string, unknown> | undefined;
    if (!out) return null;

    const gradeRaw = String(out['grade'] ?? '').trim() as RegradeGrade;
    if (!REGRADE_GRADES.includes(gradeRaw)) return null;

    let score = Number(out['probative_score']);
    if (!Number.isFinite(score)) return null;
    score = Math.max(1, Math.min(10, Math.round(score)));

    const shipRaw = String(out['ship_recommendation'] ?? '').trim();
    const ship_recommendation: LetterRegrade['ship_recommendation'] =
      shipRaw === 'ship_ready' || shipRaw === 'examine_closely' ? shipRaw : 'normal_review';

    const rationale = typeof out['rationale'] === 'string' ? (out['rationale'] as string).trim() : '';
    if (rationale.length === 0) return null;

    const weak_spots = Array.isArray(out['weak_spots'])
      ? (out['weak_spots'] as unknown[]).filter((w): w is string => typeof w === 'string' && w.trim().length > 0).slice(0, 3).map((w) => w.trim())
      : [];

    return { grade: gradeRaw, probative_score: score, ship_recommendation, rationale, weak_spots };
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'letter-grade: failed open', error: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}
