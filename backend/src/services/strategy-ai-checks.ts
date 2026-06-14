// AI JUDGMENT CHECKS for the pre-draft strategy preview (E0, 2026-06-13).
//
// WHY THIS EXISTS: two of the five strategy-preview checks are not arithmetic — they are clinical
// JUDGMENT, and the deterministic cdsEngine fakes them:
//   1. "Current diagnosis on file" was a dumb COUNT (`activeProblems.length > 0`) — it never matched a
//      documented dx to the CLAIMED condition. Real failure (Porter): an allergic-conjunctivitis claim
//      with NO matching dx still showed "dx on file ✓" while the Ask-Aegis advisory AI correctly said
//      none. Same regex→AI lesson as the doctor-pack page picker.
//   2. PACT/TERA presumptive eligibility is a deployment/exposure-fact judgment (covered location +
//      window + claimed condition on the presumptive list) — a count can't do it.
//
// This is the HYBRID move: the genuinely-deterministic checks (barred-theory, secondary-pathway,
// adverse-strength) STAY in cdsEngine. Only these two judgment checks move to Sonnet 4.6 on Bedrock,
// behind STRATEGY_AI_CHECKS_ENABLED (default OFF → no call, no spend, deterministic preview unchanged).
//
// MODEL: Claude Sonnet 4.6 (us.anthropic.claude-sonnet-4-6) — live-invokable on this account (the
// Ask-Aegis email Lambda runs it today). Cheaper/faster than the advisory Opus; adequate for a small
// grounded classification. ONE call per preview, temperature 0, strict JSON → deterministic-ish.
//
// GROUNDING (anti-fabrication, structural): the model must echo the EXACT documented problem-list
// string it matched, or return matchedDx:null. We then VERIFY that string is actually in activeProblems
// in code — a named-but-absent dx is rejected as no-match. The model can never assert a match it can't
// name from the record (mirrors the page-LLM validating returned page numbers + the drafter's
// verbatim-substring citation gate).
//
// FAIL-OPEN: any failure (flag off, Bedrock error/timeout, unparseable output) returns null so the
// caller keeps the deterministic result + a note. Never blocks the preview.

import {
  invokeAdvisory,
  SONNET_MODEL_ID,
  SONNET_PRICE_PER_M_INPUT_USD,
  SONNET_PRICE_PER_M_OUTPUT_USD,
} from '../advisory/bedrockClient.js';

export const STRATEGY_AI_CHECKS_VERSION = 'strategy-ai-1.0.0';

const MAX_OUTPUT_TOKENS = 400; // a compact JSON verdict, never prose

/** True only when the flag is explicitly enabled. Default OFF → the AI is never called (no spend). */
export function strategyAiChecksEnabled(): boolean {
  return (process.env.STRATEGY_AI_CHECKS_ENABLED ?? '').toLowerCase() === 'true';
}

export interface StrategyAiDxMatch {
  /** true only when a documented dx clinically matches the claimed condition AND we verified the name. */
  readonly matched: boolean;
  /** the EXACT documented problem-list string the model matched (verified present), or null. */
  readonly matchedDx: string | null;
  /** <=12-word plain reason ("OSA == obstructive sleep apnea" / "no documented match"). */
  readonly note: string;
}

export interface StrategyAiPresumptive {
  /** true when the claimed condition is presumptive under a covered exposure/deployment. */
  readonly eligible: boolean;
  /** which presumptive program applies, or null when none. */
  readonly program: 'PACT' | 'TERA' | null;
  /** true when a covered deployment auto-flags TERA even if the veteran didn't self-check. */
  readonly teraAutoFlagged: boolean;
  /** <=20-word plain reason. */
  readonly note: string;
}

export interface StrategyAiChecks {
  readonly dxMatch: StrategyAiDxMatch;
  readonly presumptive: StrategyAiPresumptive;
  readonly costUsd: number;
}

export interface StrategyAiInput {
  readonly claimedCondition: string;
  readonly activeProblems: readonly string[];
  /** Service-connected conditions (context only; they can satisfy a related dx). */
  readonly serviceConnectedConditions: readonly string[];
  /** Free-text deployment / exposure facts the model reads for PACT/TERA (locations, dates, MOS). */
  readonly deploymentFacts?: string | null;
  readonly veteranStatement?: string | null;
}

// CACHED prefix (the stable rubric). No case_id / name / volatile data here — those go in the user
// message so the cache key stays stable across previews (bedrockClient enforces the cache_control block).
const SYSTEM_PROMPT = `You are a VA-claims clinical screener. You make TWO judgments for a pre-draft strategy preview, grounded ONLY in the facts given. Be precise and conservative; never invent a record fact.

JUDGMENT 1 — DIAGNOSIS MATCH. Decide whether any DOCUMENTED diagnosis (from the veteran's problem list / service-connected conditions provided) is the same clinical entity as the CLAIMED condition, by synonym or clinical equivalence.
- Match examples: "OSA" == "obstructive sleep apnea"; "DM2"/"type 2 diabetes" == "diabetes mellitus type 2"; "low back pain"/"lumbar strain" relate to a "lumbar spine" claim.
- NON-matches (do NOT match): "allergic conjunctivitis" != "chronic sinusitis"; "hypertension" != "sleep apnea"; a mere SYMPTOM or screening result is NOT a diagnosis.
- GROUNDING RULE (mandatory): if you assert a match, set "matchedDx" to the EXACT problem-list/SC string you matched, copied verbatim. If nothing in the provided record matches, set "matched":false and "matchedDx":null. NEVER name a diagnosis that is not in the provided lists.

JUDGMENT 2 — PRESUMPTIVE ELIGIBILITY (PACT Act / TERA). From the deployment/exposure facts, decide whether the CLAIMED condition is presumptively service-connected.
- PACT presumptives flow from covered toxic exposure (burn pits / airborne hazards in the Gulf War & post-9/11 theaters; Agent Orange in Vietnam-era locations; radiation; etc.). Surface this FIRST when it applies.
- TERA (Toxic Exposure Risk Activity): a covered deployment to a qualifying location/window (e.g. Iraq/Afghanistan or other post-9/11 Southwest-Asia theater) establishes a TERA. AUTO-FLAG TERA ("teraAutoFlagged":true) for such a deployment EVEN IF the veteran did not self-report it — TERA is about where they served, not what they checked.
- CLINICAL DISTINCTIONS you must honor: chronic sinusitis / chronic rhinosinusitis IS a PACT-presumptive respiratory condition; pure allergic rhinitis is NOT presumptive; allergic conjunctivitis is NOT PACT-presumptive. Asthma diagnosed post-deployment IS presumptive. Do not over-call.
- If the facts don't establish a covered exposure, set "eligible":false,"program":null,"teraAutoFlagged":false and say why briefly.

Return ONLY this JSON object, no prose, no markdown fences:
{"dxMatch":{"matched":<bool>,"matchedDx":<string|null>,"note":"<<=12 words>"},"presumptive":{"eligible":<bool>,"program":<"PACT"|"TERA"|null>,"teraAutoFlagged":<bool>,"note":"<<=20 words>"}}`;

interface RawChecks {
  dxMatch?: { matched?: unknown; matchedDx?: unknown; note?: unknown };
  presumptive?: { eligible?: unknown; program?: unknown; teraAutoFlagged?: unknown; note?: unknown };
}

// Pull the JSON object out of the model text (tolerant of stray prose / fences). Returns null on any
// structural failure so the caller fails open.
function parseChecks(text: string): RawChecks | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as RawChecks;
  } catch {
    return null;
  }
}

// Normalize for the grounding cross-check: a returned matchedDx must actually be one of the documented
// strings (problem list or SC list). Lenient on whitespace/case so a verbatim-ish echo still verifies,
// but a fabricated dx the model invented is rejected → matched:false.
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function buildUserContent(input: StrategyAiInput): string {
  const probs = input.activeProblems.length > 0 ? input.activeProblems.map((p) => `- ${p}`).join('\n') : '(none recorded)';
  const scs =
    input.serviceConnectedConditions.length > 0
      ? input.serviceConnectedConditions.map((s) => `- ${s}`).join('\n')
      : '(none recorded)';
  const deployment = (input.deploymentFacts ?? '').trim();
  const stmt = (input.veteranStatement ?? '').trim();
  return [
    `CLAIMED CONDITION: ${input.claimedCondition}`,
    '',
    'DOCUMENTED PROBLEM LIST (the only diagnoses you may match against):',
    probs,
    '',
    'SERVICE-CONNECTED CONDITIONS:',
    scs,
    '',
    'DEPLOYMENT / EXPOSURE FACTS:',
    deployment.length > 0 ? deployment : '(none provided)',
    ...(stmt.length > 0 ? ['', 'VETERAN STATEMENT (context only, not a diagnosis):', stmt] : []),
  ].join('\n');
}

/**
 * Run the two AI judgment checks. Returns null when the flag is off OR on ANY failure (Bedrock error,
 * timeout, unparseable output) so the caller falls back to the deterministic checks. Never throws.
 */
export async function runStrategyAiChecks(input: StrategyAiInput): Promise<StrategyAiChecks | null> {
  if (!strategyAiChecksEnabled()) return null;

  try {
    const res = await invokeAdvisory(SYSTEM_PROMPT, buildUserContent(input), {
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
      modelId: SONNET_MODEL_ID,
      pricePerMInput: SONNET_PRICE_PER_M_INPUT_USD,
      pricePerMOutput: SONNET_PRICE_PER_M_OUTPUT_USD,
    });
    const raw = parseChecks(res.text);
    if (raw === null || raw.dxMatch === undefined || raw.presumptive === undefined) {
      console.warn(JSON.stringify({ msg: 'strategy_ai_unparsed', claimed: input.claimedCondition, costUsd: res.costUsd }));
      return null;
    }

    // --- GROUNDING CROSS-CHECK on dx-match: a claimed match must name a string actually in the record.
    const claimedDx = typeof raw.dxMatch.matchedDx === 'string' ? raw.dxMatch.matchedDx : null;
    const documented = [...input.activeProblems, ...input.serviceConnectedConditions].map(norm);
    const dxVerified = claimedDx !== null && documented.includes(norm(claimedDx));
    const dxMatch: StrategyAiDxMatch =
      raw.dxMatch.matched === true && dxVerified
        ? { matched: true, matchedDx: claimedDx, note: String(raw.dxMatch.note ?? 'documented diagnosis matches the claim') }
        : {
            matched: false,
            matchedDx: null,
            // If the model claimed a match but named a dx we can't find, that's a rejected hallucination.
            note:
              raw.dxMatch.matched === true && !dxVerified
                ? 'model named a dx not in the record — rejected'
                : String(raw.dxMatch.note ?? 'no documented diagnosis matches the claim'),
          };

    const programRaw = raw.presumptive.program;
    const program: 'PACT' | 'TERA' | null = programRaw === 'PACT' || programRaw === 'TERA' ? programRaw : null;
    const presumptive: StrategyAiPresumptive = {
      eligible: raw.presumptive.eligible === true && program !== null,
      program: raw.presumptive.eligible === true ? program : null,
      teraAutoFlagged: raw.presumptive.teraAutoFlagged === true,
      note: String(raw.presumptive.note ?? ''),
    };

    return { dxMatch, presumptive, costUsd: res.costUsd };
  } catch (e) {
    console.warn(
      JSON.stringify({
        msg: 'strategy_ai_failed',
        claimed: input.claimedCondition,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return null;
  }
}
