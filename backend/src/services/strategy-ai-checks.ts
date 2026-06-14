// AI JUDGMENT CHECKS for the pre-draft strategy preview (E0, 2026-06-13).
//
// WHY THIS EXISTS: three of the five strategy-preview checks are not arithmetic — they are clinical
// JUDGMENT, and the deterministic cdsEngine fakes them:
//   1. "Current diagnosis on file" was a dumb COUNT (`activeProblems.length > 0`) — it never matched a
//      documented dx to the CLAIMED condition. Real failure (Porter): an allergic-conjunctivitis claim
//      with NO matching dx still showed "dx on file ✓" while the Ask-Aegis advisory AI correctly said
//      none. Same regex→AI lesson as the doctor-pack page picker.
//   2. PACT/TERA presumptive eligibility is a deployment/exposure-fact judgment (covered location +
//      window + claimed condition on the presumptive list) — a count can't do it.
//   3. "Service-connected anchor present" was dumb TOKEN-OVERLAP (cdsEngine.hasScAnchor): it required a
//      shared word between the upstream condition and an SC-condition name. Real failure (Woodley
//      CLM-B543F8D0BD): the veteran's service-connected trauma dx is recorded as "Other Specified
//      Trauma/Stressor Disorder" (his 70% dx) — ZERO shared tokens with the "PTSD" the secondary theory
//      anchors on, even though it is the SAME clinical entity within the mental-health cluster. The
//      token check wrongly said ✗ "PTSD is not among the SC conditions," making a SOUND secondary case
//      read as non-viable. Clinical equivalence is a JUDGMENT, not a string overlap. (E0 SC-anchor
//      equivalence, 2026-06-13.)
//
// This is the HYBRID move: the genuinely-deterministic checks (barred-theory, secondary-pathway,
// adverse-strength) STAY in cdsEngine. Only these three judgment checks move to Sonnet 4.6 on Bedrock,
// behind STRATEGY_AI_CHECKS_ENABLED (default OFF → no call, no spend, deterministic preview unchanged).
//
// MODEL: Claude Sonnet 4.6 (us.anthropic.claude-sonnet-4-6) — live-invokable on this account (the
// Ask-Aegis email Lambda runs it today). Cheaper/faster than the advisory Opus; adequate for a small
// grounded classification. ONE call per preview, temperature 0, strict JSON → deterministic-ish.
//
// GROUNDING (anti-fabrication, structural): the model must echo the EXACT documented string it matched,
// or return null. We then VERIFY that string is actually in the record in code — a named-but-absent
// match is rejected. The model can never assert a match it can't name from the record (mirrors the
// page-LLM validating returned page numbers + the drafter's verbatim-substring citation gate). This
// applies to BOTH judgment-with-an-echo fields:
//   • dx-match → matchedDx must be a verbatim activeProblems/SC string;
//   • SC-anchor → matchedCondition must be a verbatim serviceConnectedConditions string (E0 SC-anchor
//     equivalence, 2026-06-13). A model that names an SC condition NOT in the provided list is REJECTED
//     to matched:false, so the AI can never conjure an anchor that isn't documented as service-connected.
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

// E0 SC-anchor equivalence (2026-06-13). Does ANY of the veteran's service-connected conditions
// CLINICALLY ENCOMPASS the upstream condition the secondary theory anchors on — by synonym, clinical
// equivalence, or cluster membership (PTSD ≡ "Other Specified Trauma/Stressor Disorder" / "anxiety
// disorder" / "MDD"; "OSA" ≡ "obstructive sleep apnea")? RESCUE-ONLY: this can only flip a deterministic
// false-negative anchor to PASS; it can NEVER fail a deterministic pass (see strategy-preview overlay).
export interface StrategyAiScAnchorMatch {
  /** true only when an SC condition is the clinical equivalent of the upstream AND we verified the name. */
  readonly matched: boolean;
  /** the EXACT serviceConnectedConditions string the model matched (verified present), or null. */
  readonly matchedCondition: string | null;
  /** <=12-word plain reason ("PTSD == Other Specified Trauma/Stressor Disorder"). */
  readonly note: string;
}

export interface StrategyAiChecks {
  readonly dxMatch: StrategyAiDxMatch;
  readonly presumptive: StrategyAiPresumptive;
  /**
   * Present only when an upstreamScCondition was provided to evaluate (a secondary theory). null when
   * there was no upstream to anchor (a direct claim) — the overlay then has nothing to rescue.
   */
  readonly scAnchorMatch: StrategyAiScAnchorMatch | null;
  readonly costUsd: number;
}

export interface StrategyAiInput {
  readonly claimedCondition: string;
  readonly activeProblems: readonly string[];
  /** Service-connected conditions (context only; they can satisfy a related dx). */
  readonly serviceConnectedConditions: readonly string[];
  /**
   * The upstream condition the secondary theory anchors on (e.g. "PTSD"), or null/absent on a direct
   * claim. When present, the model judges whether any SC condition clinically encompasses it (E0
   * SC-anchor equivalence, 2026-06-13). null/empty → scAnchorMatch comes back null (nothing to anchor).
   */
  readonly upstreamScCondition?: string | null;
  /** Free-text deployment / exposure facts the model reads for PACT/TERA (locations, dates, MOS). */
  readonly deploymentFacts?: string | null;
  readonly veteranStatement?: string | null;
}

// CACHED prefix (the stable rubric). No case_id / name / volatile data here — those go in the user
// message so the cache key stays stable across previews (bedrockClient enforces the cache_control block).
const SYSTEM_PROMPT = `You are a VA-claims clinical screener. You make up to THREE judgments for a pre-draft strategy preview, grounded ONLY in the facts given. Be precise and conservative; never invent a record fact.

JUDGMENT 1 — DIAGNOSIS MATCH. Decide whether any DOCUMENTED diagnosis (from the veteran's problem list / service-connected conditions provided) is the same clinical entity as the CLAIMED condition, by synonym or clinical equivalence.
- Match examples: "OSA" == "obstructive sleep apnea"; "DM2"/"type 2 diabetes" == "diabetes mellitus type 2"; "low back pain"/"lumbar strain" relate to a "lumbar spine" claim.
- NON-matches (do NOT match): "allergic conjunctivitis" != "chronic sinusitis"; "hypertension" != "sleep apnea"; a mere SYMPTOM or screening result is NOT a diagnosis.
- GROUNDING RULE (mandatory): if you assert a match, set "matchedDx" to the EXACT problem-list/SC string you matched, copied verbatim. If nothing in the provided record matches, set "matched":false and "matchedDx":null. NEVER name a diagnosis that is not in the provided lists.

JUDGMENT 2 — PRESUMPTIVE ELIGIBILITY (PACT Act / TERA). From the deployment/exposure facts, decide whether the CLAIMED condition is presumptively service-connected.
- PACT presumptives flow from covered toxic exposure (burn pits / airborne hazards in the Gulf War & post-9/11 theaters; Agent Orange in Vietnam-era locations; radiation; etc.). Surface this FIRST when it applies.
- TERA (Toxic Exposure Risk Activity): a covered deployment to a qualifying location/window (e.g. Iraq/Afghanistan or other post-9/11 Southwest-Asia theater) establishes a TERA. AUTO-FLAG TERA ("teraAutoFlagged":true) for such a deployment EVEN IF the veteran did not self-report it — TERA is about where they served, not what they checked.
- CLINICAL DISTINCTIONS you must honor: chronic sinusitis / chronic rhinosinusitis IS a PACT-presumptive respiratory condition; pure allergic rhinitis is NOT presumptive; allergic conjunctivitis is NOT PACT-presumptive. Asthma diagnosed post-deployment IS presumptive. Do not over-call.
- If the facts don't establish a covered exposure, set "eligible":false,"program":null,"teraAutoFlagged":false and say why briefly.

JUDGMENT 3 — SERVICE-CONNECTED ANCHOR EQUIVALENCE. An UPSTREAM CONDITION may be given (the condition a secondary theory anchors on, e.g. "PTSD"). Decide whether ANY of the veteran's SERVICE-CONNECTED conditions is the clinical equivalent of, or clinically ENCOMPASSES, that upstream condition — so the secondary theory is properly anchored on something already service-connected.
- Equivalence/encompassment examples (MATCH): upstream "PTSD" is anchored by a service-connected "Other Specified Trauma/Stressor Disorder", "anxiety disorder", or "major depressive disorder" (same mental-health / trauma cluster); upstream "OSA" by "obstructive sleep apnea"; upstream "DM2" by "type 2 diabetes mellitus"; upstream "lumbar radiculopathy" by a service-connected "lumbar spine" condition that encompasses it.
- NON-matches (do NOT match): upstream "PTSD" anchored by a service-connected "hypertension" or "tinnitus" (different system entirely); a mere symptom is not a service-connected condition.
- GROUNDING RULE (mandatory): if you assert a match, set "matchedCondition" to the EXACT service-connected string you matched, copied verbatim from the SERVICE-CONNECTED CONDITIONS list. If no service-connected condition is the equivalent, set "matched":false and "matchedCondition":null. NEVER name a condition that is not in the provided service-connected list.
- If NO upstream condition is provided (a direct claim), set "matched":false,"matchedCondition":null,"note":"no upstream to anchor".

Return ONLY this JSON object, no prose, no markdown fences:
{"dxMatch":{"matched":<bool>,"matchedDx":<string|null>,"note":"<<=12 words>"},"presumptive":{"eligible":<bool>,"program":<"PACT"|"TERA"|null>,"teraAutoFlagged":<bool>,"note":"<<=20 words>"},"scAnchorMatch":{"matched":<bool>,"matchedCondition":<string|null>,"note":"<<=12 words>"}}`;

interface RawChecks {
  dxMatch?: { matched?: unknown; matchedDx?: unknown; note?: unknown };
  presumptive?: { eligible?: unknown; program?: unknown; teraAutoFlagged?: unknown; note?: unknown };
  scAnchorMatch?: { matched?: unknown; matchedCondition?: unknown; note?: unknown };
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
  const upstream = (input.upstreamScCondition ?? '').trim();
  return [
    `CLAIMED CONDITION: ${input.claimedCondition}`,
    '',
    // The upstream the secondary theory anchors on — JUDGMENT 3 reads this. Empty line on a direct claim
    // so the model returns scAnchorMatch:matched=false ("no upstream to anchor").
    `UPSTREAM CONDITION (the secondary theory anchors on this; empty = direct claim): ${upstream.length > 0 ? upstream : '(none — direct claim)'}`,
    '',
    'DOCUMENTED PROBLEM LIST (the only diagnoses you may match against):',
    probs,
    '',
    'SERVICE-CONNECTED CONDITIONS (the only conditions JUDGMENT 3 may anchor against):',
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

    // --- GROUNDING CROSS-CHECK on SC-anchor (E0 SC-anchor equivalence, 2026-06-13). Identical shape to
    // the dx-match backstop: a claimed match must name a string actually in the SERVICE-CONNECTED list
    // (only that list — an anchor must be something already service-connected, not merely a problem-list
    // entry). A model that names a condition we can't verify there is rejected to matched:false, so the
    // AI can never assert an anchor it can't ground. Only evaluated when an upstream was provided; with
    // no upstream there is nothing to anchor → scAnchorMatch stays null and the overlay has nothing to do.
    const hasUpstream = (input.upstreamScCondition ?? '').trim().length > 0;
    let scAnchorMatch: StrategyAiScAnchorMatch | null = null;
    if (hasUpstream) {
      const rawSc = raw.scAnchorMatch ?? {};
      const claimedSc = typeof rawSc.matchedCondition === 'string' ? rawSc.matchedCondition : null;
      const scList = input.serviceConnectedConditions.map(norm);
      const scVerified = claimedSc !== null && scList.includes(norm(claimedSc));
      scAnchorMatch =
        rawSc.matched === true && scVerified
          ? { matched: true, matchedCondition: claimedSc, note: String(rawSc.note ?? 'service-connected condition anchors the upstream') }
          : {
              matched: false,
              matchedCondition: null,
              // model claimed a match but named a condition not in the SC list → rejected hallucination.
              note:
                rawSc.matched === true && !scVerified
                  ? 'model named an SC condition not in the record — rejected'
                  : String(rawSc.note ?? 'no service-connected condition anchors the upstream'),
            };
    }

    return { dxMatch, presumptive, scAnchorMatch, costUsd: res.costUsd };
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
