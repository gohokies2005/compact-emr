/**
 * Halt explainer (Dr. Kasky 2026-07-02): an on-demand, LLM-generated PLAIN-LANGUAGE explanation of why a
 * nexus-letter draft PAUSED and exactly what the RN should change to unstick it. This replaces the truncated,
 * jargon-filled halt string the RN sees today (the drafter's pipelinePhase.js clips the raw reason to 200
 * chars — cutting off mid-word — and leaks raw terms like "plan_validity", "3.303", "upstream cause").
 *
 * Design: NOT a deterministic template — an LLM narrates the halt from the case's ACTUAL framing + chart
 * facts, so the RN gets a specific, case-grounded "here's what happened and here's the fix". Sonnet, temp 0.2,
 * max_tokens ~450, forced-tool JSON output (mirrors ai-viability.ts / citation-enricher.ts — the SAME
 * resolveAnthropicApiKey seam every direct-Anthropic EMR feature uses).
 *
 * FAIL-OPEN EVERYWHERE (mirrors ai-viability.ts / sanity-impression.ts): a missing key, API error, timeout,
 * truncation (stop_reason:'max_tokens'), or a malformed tool result → returns null. The panel then falls back
 * to the existing raw/technical halt message, so nothing is ever LOST — the explainer only ADDS a plain-
 * language layer. NEVER throws.
 *
 * LATENCY (ARCHITECTURE §5, the 29s API-Gateway cap): a single ~450-token Sonnet call runs in ~2-6s, well
 * inside the ~20s bound below (timeout 20s, maxRetries 0 → fails-open loudly inside the window). No async
 * self-invoke needed. The route wraps this in a short-TTL in-memory cache keyed by caseId + halt/framing hash
 * so re-opening the same paused case does not re-bill.
 */

import Anthropic from '@anthropic-ai/sdk';
import { resolveAnthropicApiKey } from './letter-surgical-propose.js';

// Sonnet by default (same tier the viability/SOAP brains use). Overridable per ARCHITECTURE §4 flag convention.
const MODEL = process.env['HALT_EXPLAIN_MODEL'] || 'claude-sonnet-4-6';
// 700 (was 450): 2-4 plain sentences + a concrete action + the tool-JSON envelope overran 450 often enough to
// hit stop_reason:'max_tokens' → the whole call fail-opened to null → the RN silently lost the feature and saw
// only the raw fallback. 700 fits the bounded output with headroom; a ~600-token narration is still <1¢.
const MAX_TOKENS = 700;
// ≤ the 22s sync-LLM cap the latency rule mandates. A 450-token narration is fast; this is a loud-fail ceiling,
// not an expected duration.
const TIMEOUT_MS = 20_000;

export interface HaltExplainFraming {
  /** The case's framing theory: 'direct' | 'secondary' | 'aggravation' | 'undetermined' (or any string). */
  readonly theory: string;
  /** The named upstream service-connected condition for a secondary/aggravation theory, if any. */
  readonly upstream: string | null;
  /** The CFR basis hint for the theory (e.g. '38 CFR 3.303' / '3.310(a)' / '3.310(b)'), if known. */
  readonly cfr: string | null;
}

export interface HaltExplainInput {
  /** The pipeline phase/gate that halted (e.g. 'framing_gate', 'plan_validity', a currentPhase, or a reasonCode). */
  readonly phase: string;
  /** The raw, un-truncated halt reason as the pipeline produced it (jargon OK — the model translates it). */
  readonly rawReason: string;
  readonly claimedCondition: string;
  readonly framing: HaltExplainFraming;
  /** The veteran's GRANTED service-connected conditions (the anchors a secondary theory can use). */
  readonly grantedScConditions: ReadonlyArray<{ readonly name: string; readonly ratingPct: number | null }>;
  /** The active problem list (charted diagnoses) — context for what is/isn't documented. */
  readonly problemList: readonly string[];
  /**
   * DETERMINISTIC (computed in the route, not by the model): the granted SC condition whose normalized name
   * EXACTLY matches the claimed condition, or null. This is the highest-stakes determination (already-SC →
   * re-route, not a nexus letter), so it is surfaced to the model as a STATED FACT rather than a fuzzy match
   * the model has to infer from the two lists.
   */
  readonly alreadyGrantedMatch: string | null;
}

export interface HaltExplanation {
  /** 2-4 plain sentences: what happened + why, in everyday language. */
  readonly summary: string;
  /** The concrete next step the RN can take to unstick the draft. */
  readonly what_to_do: string;
  readonly confidence: 'high' | 'medium' | 'low';
}

const SYSTEM = `You explain to a nurse (an RN with no legal training), in plain everyday language, why an automated VA nexus-letter draft PAUSED and exactly what to change to get it moving again.

Rules:
- Write like you are talking to a smart colleague who is not a lawyer. Short, calm, concrete sentences.
- No legal jargon unless you immediately explain it in plain words. If you must mention a CFR number or a term like "secondary" or "upstream cause", explain what it means in the same sentence.
- Ground ONLY in the facts provided in the case block. NEVER invent, assume, or add a condition, diagnosis, date, disability rating, service event, or service-connection status that is not in the facts. If a needed fact is missing, say it is missing and tell the RN to verify it — do not guess.
- Do NOT assert that one condition CAUSES or AGGRAVATES another unless the halt reason itself states that link. The granted service-connected conditions are CONTEXT, not a menu of causes to choose from. If a secondary theory is implied but the specific upstream cause is not named in the halt reason, tell the RN to identify which granted condition is the medical cause — do NOT guess the upstream, and set confidence to "low".
- Be specific to THIS case (name the actual claimed condition and the actual upstream/service-connected conditions from the facts), and be actionable: end with a single clear next step the RN can take in the EMR.
- The RN can fix things a computer can't. Frame this as "here's the one thing to adjust", never as "this claim is bad".

How to reason about the common halt situations (do NOT hardcode — decide from the provided facts which one applies, if any):
1. BEFORE ANYTHING ELSE — already service-connected: if the case block says the claimed condition already appears on the granted service-connected list (already_granted_match names a condition), the ONLY correct answer is to RE-ROUTE the case — this is a rating-increase request, not a nexus letter, and is out of scope. Do NOT reframe it, do NOT propose a secondary theory. This determination dominates every rule below.
2. Direct framing that names a service-connected condition as the cause: if the halt reason says the framing is DIRECT but the claimed condition is being caused by a service-connected condition, this is really a SECONDARY claim (one service-connected condition causing another). The fix is to set the case framing to Secondary and point it at THAT upstream condition — but only the one the halt reason actually names (see the causal-link rule above; never pick one off the SC list yourself).
3. Secondary/aggravation theory with an unanchored upstream: if the framing is secondary/aggravation but the named upstream condition is NOT on the granted service-connected list, the theory has no anchor. The fix is to pick an upstream condition that IS granted and service-connected, or establish a direct in-service basis.
4. If none of these clearly fit, explain the halt honestly from the raw reason in plain terms and tell the RN what to verify.

If you are not sure which situation applies given the facts, say so plainly and set confidence to "low" — do not fabricate a cause to sound confident.

Call the explain_halt tool with your answer. Keep summary to 2-4 sentences and what_to_do to a single concrete step.`;

const TOOL: Anthropic.Tool = {
  name: 'explain_halt',
  description: 'Return the plain-language explanation of the draft pause and the concrete next step for the RN.',
  input_schema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: '2-4 plain everyday-language sentences: what happened and why the draft paused. No unexplained jargon. Grounded only in the provided facts.',
      },
      what_to_do: {
        type: 'string',
        description: 'The single concrete next step the RN should take to unstick the draft (e.g. re-set the framing to Secondary with a specific upstream condition; re-route the case; verify a missing fact).',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'How confident you are that this explanation and fix are correct given the facts. Use "low" if a needed fact is missing or the raw reason is ambiguous.',
      },
    },
    required: ['summary', 'what_to_do', 'confidence'],
  },
};

function buildUserPrompt(input: HaltExplainInput): string {
  const scLines = input.grantedScConditions.length
    ? input.grantedScConditions
        .map((s) => `- ${s.name}${typeof s.ratingPct === 'number' ? ` (${s.ratingPct}% service-connected)` : ' (service-connected)'}`)
        .join('\n')
    : '- (none on file)';
  const problems = input.problemList.length ? input.problemList.slice(0, 60).map((p) => `- ${p}`).join('\n') : '- (none on file)';
  const upstream = input.framing.upstream && input.framing.upstream.trim().length > 0 ? input.framing.upstream.trim() : '(none named)';
  const cfr = input.framing.cfr && input.framing.cfr.trim().length > 0 ? input.framing.cfr.trim() : '(not specified)';
  const theory = input.framing.theory && input.framing.theory.trim().length > 0 ? input.framing.theory.trim() : '(undetermined)';
  const alreadyGranted = input.alreadyGrantedMatch && input.alreadyGrantedMatch.trim().length > 0 ? input.alreadyGrantedMatch.trim() : 'none';
  return `<case>
<claimed_condition>${input.claimedCondition || '(unknown)'}</claimed_condition>

<already_granted_match>${alreadyGranted}</already_granted_match>

<current_framing>
theory: ${theory}
named upstream (cause) condition: ${upstream}
CFR basis (internal): ${cfr}
</current_framing>

<granted_service_connected_conditions>
${scLines}
</granted_service_connected_conditions>

<charted_problem_list>
${problems}
</charted_problem_list>

<halt>
phase/gate: ${input.phase || '(unknown)'}
raw pipeline reason (translate this into plain language for the RN): ${input.rawReason || '(none provided)'}
</halt>
</case>

Explain, in plain language grounded ONLY in the facts above, why this draft paused and the single next step the RN should take. Call explain_halt.`;
}

/**
 * Explain a halt in plain language. Returns null on ANY failure (missing key, API error, timeout, truncation,
 * malformed result) so the caller falls back to the raw halt message. NEVER throws.
 */
export async function explainHalt(input: HaltExplainInput): Promise<HaltExplanation | null> {
  try {
    let anthropic: Anthropic;
    try {
      anthropic = new Anthropic({ apiKey: await resolveAnthropicApiKey(), timeout: TIMEOUT_MS, maxRetries: 0 });
    } catch {
      // Key unconfigured → no AI surface. Fall back to the raw message.
      return null;
    }

    let resp: Anthropic.Message;
    try {
      resp = await anthropic.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        // Low but non-zero: this is prose for a human, not a go/no-go band. 0.2 keeps it stable while allowing
        // natural phrasing.
        temperature: 0.2,
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: TOOL.name },
        messages: [{ role: 'user', content: buildUserPrompt(input) }],
      });
    } catch (e) {
      console.warn(JSON.stringify({ msg: 'halt-explainer: LLM call failed (fail-open)', error: e instanceof Error ? e.message : String(e) }));
      return null;
    }

    // Truncated → an incomplete narration is worse than the raw fallback.
    if (resp.stop_reason === 'max_tokens') return null;

    const block = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === TOOL.name);
    const out = block?.input as Record<string, unknown> | undefined;
    if (!out) return null;

    const summary = typeof out['summary'] === 'string' ? (out['summary'] as string).trim() : '';
    const whatToDo = typeof out['what_to_do'] === 'string' ? (out['what_to_do'] as string).trim() : '';
    if (summary.length === 0 || whatToDo.length === 0) return null;

    const confRaw = String(out['confidence'] ?? 'medium').toLowerCase();
    const confidence: HaltExplanation['confidence'] = confRaw === 'high' || confRaw === 'low' ? confRaw : 'medium';

    return { summary, what_to_do: whatToDo, confidence };
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'halt-explainer: failed open', error: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}
