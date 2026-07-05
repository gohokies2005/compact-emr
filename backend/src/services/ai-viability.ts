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
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveAnthropicApiKey } from './letter-surgical-propose.js';
import { deriveCaseFramingForCase, loadMechanismFilter } from './case-framing-stamp.js';
import type { AppDb } from './db-types.js';

const MODEL = process.env['AI_ROUTE_PICKER_MODEL'] || 'claude-sonnet-4-6';
// 6000 (was 1800): the emit_argument_plan tool output is schema-bounded but, on a complex case (many granted
// SC conditions → large excluded/alternative/convergent arrays + per-field rationale, e.g. Zimmelman GERD with
// 197 facts), exceeded 1800 → stop_reason:'max_tokens' → the plan was truncated and rejected ("analysis was too
// long to complete"). This surfaced only AFTER the 120s/110s budget fix let the call run to the cap instead of
// timing out at 26s first. 6000 fits the full bounded plan with headroom; generation stays well inside the 110s
// async budget. Cost is per-token-generated (a ~3-4k-token plan ≈ 5-6¢), so the higher cap is headroom, not spend.
const MAX_TOKENS = 6000;

export function aiRoutePickerEnabled(): boolean {
  return process.env['AI_ROUTE_PICKER_ENABLED'] === 'true';
}

// ── The picker brain: loaded from the VENDORED canonical aiRoutePicker.cjs — ONE source of truth with
// the drafter (flatratenexus-project/app/services/aiRoutePicker.js, vendored to backend/src/vendor and
// copied to <task>/anchor-vendor at deploy). Pinned by ai-route-picker-pin.test.ts so a hand-edit or a
// drift from the canonical trips the red build. Fail-open: load failure -> null -> the card shows static.
interface PickerPrompt { SYSTEM: string; TOOL: Anthropic.Tool }
let _pickerPrompt: PickerPrompt | null | undefined;
function loadPickerPrompt(): PickerPrompt | undefined {
  if (_pickerPrompt !== undefined) return _pickerPrompt ?? undefined;
  try {
    const candidates = [
      path.join(process.cwd(), process.env['ANCHOR_VENDOR_DIR'] ?? 'anchor-vendor', 'aiRoutePicker.cjs'),
      path.join(process.cwd(), 'src', 'vendor', 'aiRoutePicker.cjs'),
      path.join(process.cwd(), 'backend', 'src', 'vendor', 'aiRoutePicker.cjs'),
    ];
    const entry = candidates.find((p) => existsSync(p));
    if (entry === undefined) { _pickerPrompt = null; return undefined; }
    const req = createRequire(path.join(process.cwd(), '_anchor_require_base.cjs'));
    const m = req(entry) as { SYSTEM?: string; TOOL?: Anthropic.Tool };
    if (!m.SYSTEM || !m.TOOL) { _pickerPrompt = null; return undefined; }
    _pickerPrompt = { SYSTEM: m.SYSTEM, TOOL: m.TOOL };
    return _pickerPrompt;
  } catch { _pickerPrompt = null; return undefined; }
}

// Bump when the persisted plan SHAPE changes — readers gate on it so an old-shape blob is cleanly
// ignored (degrade to corpus/static) instead of silently mis-rendering. (QA 2026-06-19, architect #6.)
export const AI_VIABILITY_PLAN_SCHEMA_VERSION = 1;

export interface AiViabilityCard {
  readonly source: 'ai_route_picker';
  readonly schemaVersion: number;
  // The case's claimedCondition AT COMPUTE TIME (the raw input, not the picker's reworded label). The
  // advisory reader compares this to the live claimedCondition and REFUSES to narrate a plan whose claim
  // no longer matches — the staleness/wrong-condition guard both QA agents flagged as the #1 blocker.
  readonly inputClaimed: string;
  readonly viability: 'supportable' | 'marginal' | 'needs_physician_review' | 'not_supportable';
  readonly lead: { upstream: string; claimed: string; framing: string; cfr_basis: string; mechanism: string; confidence: string; rationale: string; counterargument: string };
  readonly convergent: ReadonlyArray<{ upstream: string; note: string }>;
  readonly alternatives: ReadonlyArray<{ upstream: string; framing: string; why_not: string }>;
  // Hard excludes (reverse-causation / pyramiding / wrong-direction) — the anchors the picker REFUSED.
  // Carried so Ask Aegis can answer "why not X" from the same brain (never revive an excluded pathway).
  readonly excluded: ReadonlyArray<{ upstream: string; reason: string }>;
  readonly missing: ReadonlyArray<{ fact: string; why: string }>;
  readonly nuance: string;
  readonly overall: string;
  /**
   * The sha of the plan's inputs (Case.aiViabilityPlanHash) AT THE ROW VERSION THIS CARD WAS READ FROM.
   * Stamped at return time by deriveAiViability from the SAME row read that produced the framing — so a caller
   * gets framing + hash from ONE row version (no second findFirst that an async recompute could race; QA
   * 2026-06-21 H3). OPTIONAL by design: it is NEVER persisted into aiViabilityPlanJson (it is the hash OF that
   * JSON's inputs — persisting it would be circular and let a stale embedded value override the live column),
   * so the persisted blob (and consumers that read it directly, e.g. aiViabilityPlanBlock) carry no planHash.
   * Absent/'' when read straight from the persisted JSON or when the column is empty (H4).
   */
  readonly planHash?: string;
}

const _cache = new Map<string, AiViabilityCard | null>();

/**
 * The reliability state of a case's route-picker plan (Ryan 2026-06-21, Zimmelman). The original API
 * returned `AiViabilityCard | null`, collapsing "no plan yet", "computing", and "compute FAILED" into a
 * single null — which is exactly why a failed compute looked identical to a cold plan and the card showed a
 * misleading "Not supportable" verdict forever. This discriminated state lets callers (the GET, the SOAP/
 * Gate-1, the FE) tell those apart and show an HONEST loading / failed / ready surface instead of a fake
 * no-go. `deriveAiViability` stays a thin back-compat wrapper that returns `card` (or null) from this.
 */
export type AiViabilityState =
  | { readonly status: 'off' } // the AI_ROUTE_PICKER_ENABLED flag is off — no AI surface at all
  | { readonly status: 'ready'; readonly card: AiViabilityCard } // a valid plan matching current inputs
  | { readonly status: 'computing' } // a compute is in flight (sync or async) — the FE shows a spinner + polls
  | { readonly status: 'error'; readonly error: string } // the last compute FAILED — the FE shows retry, NOT a verdict
  | { readonly status: 'none' }; // no plan, not computing, no recorded error (cold) — a compute should be triggered

// A compute that has not produced/refreshed within this many ms is treated as STALE-IN-FLIGHT: a prior
// 'computing' stamp from a crashed/timed-out invocation must not wedge the case in a spinner forever. After
// this window the read path treats a lingering 'computing' as recomputable (status:'none').
// MUST exceed the async picker budget (110s, placeholder-lambda.ts) + headroom — else a legitimately
// long in-flight compute (the large-chart case this exists for) is declared stale at 90s mid-run and a
// GET re-fires a SECOND Sonnet compute, double-billing the slow cases the dedup guard is meant to protect.
const COMPUTING_STALE_MS = 135_000;

export function buildUserPrompt(claimed: string, sc: string[], problems: string[], events: string[], statement: string | null, guidance: string | null, docHints: string[]): string {
  const scLines = sc.length ? sc.map((s) => `- ${s}`).join('\n') : '- (none parsed)';
  const cand = sc.length ? sc.map((s) => `- ${s}`).join('\n') : '- (none)';
  const docLines = docHints.length ? docHints.map((h) => `- ${h}`).join('\n') : '- (none uploaded beyond the intake form)';
  // DIRECT-ROUTE EVIDENCE (Ryan 2026-06-22, Zimmelman): the structured inServiceEvent column is often
  // empty even when the veteran's own statement documents an in-service onset/diagnosis (Zimmelman: 1984
  // STR esophagitis/GERD). The veteran statement is competent lay evidence under 38 USC 1154(b) and MUST
  // reach the picker as a candidate IN-SERVICE EVENT so a DIRECT 3.303 route can lead — not only as the
  // untrusted "proposed theory". Without this the picker saw "(none documented)" and fell to a secondary
  // anchor (or, before, declared "no anchor → not supportable"). We surface BOTH: the statement stays in
  // veteran_proposed_theory (its goal/narrative role) AND, when it plausibly references service, it is also
  // listed as a lay in-service event the picker weighs for a direct route.
  // 1154(b) laundering fix (Ryan 2026-07-04): only a GENUINE service token surfaces the statement as a
  // candidate in-service event — a bare civilian year (e.g. a 2022 civilian surgery) is NOT service evidence,
  // so the `\b(19|20)\d{2}\b` alternative was removed. Even on a real match it is labeled SELF-REPORTED /
  // UNCORROBORATED, not a flat "competent evidence" assertion.
  const allEvents = [...events];
  if (statement && statement.trim().length >= 12 && /\b(in[- ]?service|active duty|while serving|during service|enlist|deploy|STR|service treatment|in the (navy|army|air force|marines|service))\b/i.test(statement)) {
    allEvents.push(`Veteran self-reported in-service onset/treatment (UNCORROBORATED lay statement under 38 USC 1154(b) — verify against a service/medical record): ${statement.trim().slice(0, 600)}`);
  }
  return `<case>
<claimed_condition source="veteran self-reported claim">${claimed || '(unknown)'}</claimed_condition>

<granted_sc_conditions>
${scLines}
</granted_sc_conditions>

<uploaded_documents note="titles are HINTS ONLY; a single PDF may bundle several record types — do not treat a title as proof. The intake form and lay statements are NOT medical records.">
${docLines}
</uploaded_documents>

<in_service_events>
${allEvents.length ? allEvents.map((e) => `- ${e}`).join('\n') : '- (none documented)'}
</in_service_events>

<chart_facts>
Problems noted in the chart: ${problems.slice(0, 60).join('; ') || '(none)'}
DIAGNOSIS PROVENANCE: the claimed condition "${claimed || '(unknown)'}" is the veteran's SELF-REPORTED claim. It counts as a CONFIRMED diagnosis ONLY if an uploaded MEDICAL RECORD (not the intake form and not a lay statement) documents it. If no medical record is present among the uploaded documents above, the diagnosis is NOT yet documented — do not treat the claim itself as confirmation.
</chart_facts>

<candidate_anchors>
These SC conditions passed the exclusion filter and are the candidate anchors for a SECONDARY/aggravation theory. A DIRECT (3.303) or in-service aggravation route needs NO anchor from this list — if the record shows the claimed condition began in service, lead direct regardless of whether this list is empty:
${cand}
</candidate_anchors>

<team_drafting_guidance authority="physician/RN" trust="trusted-steer">
${guidance || '(none provided)'}
</team_drafting_guidance>

<veteran_proposed_theory authority="none" trust="untrusted-input">
${statement || '(none provided)'}
</veteran_proposed_theory>
</case>

Produce the argument plan by calling emit_argument_plan. Pick the single best GRANT-defensible theory under the framing-priority doctrine; honor the team steer when defensible; abstain honestly if no theory reaches >=50%.

RECORDS SELF-CHECK (Ryan 2026-07-04): a nexus opinion requires a provider-documented CURRENT DIAGNOSIS in a medical record — the intake form and lay statements are NOT medical records and do not document a diagnosis. If the ONLY source for the claimed condition is the intake form / a lay statement (no corroborating medical record among the uploaded documents), you MUST set viability to needs_physician_review and name "awaiting corroborating medical records (current diagnosis)" in missing_facts — do NOT select a supportable theory off an uncorroborated self-reported claim.`;
}

// The shape we read off the case row for both the read and the compute path.
interface CaseRow {
  claimedCondition: string;
  veteranStatement: string | null;
  inServiceEvent: string | null;
  framingChoice: string | null;
  upstreamScCondition: string | null;
  aiViabilityPlanHash: string | null;
  aiViabilityPlanJson: AiViabilityCard | null;
  aiViabilityPlanStatus: string | null;
  aiViabilityPlanError: string | null;
  aiViabilityPlanComputedAt: Date | string | null;
}

// The deterministic compute INPUTS for a case: the hash (cache + persist key) plus everything the LLM needs.
interface PlanInputs {
  readonly inputHash: string;
  readonly sc: string[];
  readonly problems: string[];
  readonly events: string[];
  readonly guidance: string | null;
  // Uploaded-document titles as HINTS for the records-present / provenance judgment (Ryan 2026-07-04).
  // The titler's docType/autoTitle is a FREE-FORM label, so it is a HINT only — never a deterministic gate.
  readonly docHints: string[];
}

/** Order-invariant sha256 of the plan inputs — the cache + persist key. The array fields are sorted on
 *  COPIES so the key is stable regardless of Postgres row order (the compute-Lambda write and the GET-Lambda
 *  read run in different invocations, and unordered `findMany`/relation reads can return rows in a different
 *  order → a permanent hash mismatch → the perpetual-recompute wedge, CLM-BE673DFF78). Sorting copies here
 *  fixes the key WITHOUT reordering the arrays the caller hands to buildUserPrompt (the prompt stays
 *  byte-identical). Key ORDER of the serialized object is unchanged from the original inline hash. */
export function planInputHash(parts: {
  claimed: string; sc: string[]; problems: string[]; events: string[];
  guidance: string | null; vs: string | null; docHints: string[];
}): string {
  return createHash('sha256').update(JSON.stringify({
    claimed: parts.claimed,
    sc: [...parts.sc].sort(),
    problems: [...parts.problems].sort(),
    events: [...parts.events].sort(),
    guidance: parts.guidance,
    vs: parts.vs,
    docHints: [...parts.docHints].sort(),
  })).digest('hex');
}

/** Build the deterministic route-picker inputs + the inputHash for a case. The hash MUST be computed
 *  identically on the read short-circuit and the persist (else a fresh plan is never found again — the
 *  permanent-mismatch failure mode). Sharing this one builder between read + write is the guarantee. */
async function buildPlanInputs(db: AppDb, caseId: string, c: CaseRow): Promise<PlanInputs> {
  const cf = await deriveCaseFramingForCase(db, caseId);
  let sc = (cf?.grantedScAnchors ?? []).map((a: { condition?: string; upstream_canonical?: string }) => a.condition ?? a.upstream_canonical ?? '').filter(Boolean) as string[];
  // C1 (QA 2026-06-19): mechanism-filter the candidate anchors with the SAME eligibility rule the
  // drafter's rankAnchorCandidates uses (ANCHOR_MECHANISM_GATE) so the card cannot LEAD an excluded
  // (M0 reverse/sympathetic) anchor the drafter would drop. Fail-open: filter unavailable → unfiltered.
  try {
    const mech = loadMechanismFilter();
    if (mech && sc.length) {
      const filtered = sc.filter((n) => mech.isEligibleAnchor(n, c.claimedCondition));
      if (filtered.length) sc = filtered; // never empty the set (would strand a real-but-all-excluded case)
    }
  } catch { /* fail-open: unfiltered */ }

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

  // Uploaded-document inventory as HINTS (Ryan 2026-07-04): the model uses these to judge whether a real
  // MEDICAL RECORD (vs only the intake form / a lay statement) documents the claimed diagnosis. Free-form
  // titler labels → hint only. Sorted for a stable hash. Fail-open to []. Folded into inputHash so a case
  // that was intake-only and later gets a real record RE-PLANS (records-present flips → verdict can change).
  let docHints: string[] = [];
  try {
    const docs = (await db.document.findMany({
      where: { caseId },
      select: { docType: true, autoTitle: true, docTag: true },
    })) as unknown as Array<{ docType: string | null; autoTitle: string | null; docTag: string | null }>;
    // Exclude the extraction OUTPUT file — a screening-summary is our own artifact, not a veteran-uploaded
    // record, so it must not count as an uploaded document hint (screening-summary wedge guard).
    docHints = [...new Set(docs.filter((d) => d.docTag !== 'screening_summary').map((d) => (d.autoTitle ?? d.docType ?? '').trim()).filter(Boolean))].sort();
  } catch { docHints = []; }

  const inputHash = planInputHash({ claimed: c.claimedCondition, sc, problems, events, guidance, vs: c.veteranStatement, docHints });
  return { inputHash, sc, problems, events, guidance, docHints };
}

const PLAN_ROW_SELECT = { claimedCondition: true, veteranStatement: true, inServiceEvent: true, framingChoice: true, upstreamScCondition: true, aiViabilityPlanHash: true, aiViabilityPlanJson: true, aiViabilityPlanStatus: true, aiViabilityPlanError: true, aiViabilityPlanComputedAt: true } as never;

/** True when a 'computing' stamp is still within the in-flight window (a real compute may be running). */
function computingIsFresh(row: CaseRow): boolean {
  const at = row.aiViabilityPlanComputedAt ? new Date(row.aiViabilityPlanComputedAt).getTime() : 0;
  return at > 0 && Date.now() - at < COMPUTING_STALE_MS;
}

/**
 * The RELIABILITY-AWARE read of a case's route-picker plan (Ryan 2026-06-21, Zimmelman). Returns a
 * discriminated state so the caller can show an HONEST surface — loading / failed / ready — instead of the
 * old null-collapses-everything behavior that rendered a misleading "Not supportable" verdict on a failed
 * or never-run compute.
 *
 * opts.compute=false (default for synchronous GET/SOAP/Gate-1 paths): NO LLM call. Returns:
 *   - 'ready'      when a persisted plan matches the current inputs (the $0 short-circuit)
 *   - 'computing'  when a compute is in flight (a fresh 'computing' stamp) — the FE polls
 *   - 'error'      when the last compute FAILED (a stable 'error' stamp) — the FE shows retry, not a verdict
 *   - 'none'       when there is no plan, none in flight, and no recorded failure (cold) — trigger a compute
 *   - 'off'        when the flag is off
 * opts.compute=true (the async self-invoke + the synchronous on-demand endpoint): runs the ~22-26s picker
 * call, persists 'computing'→'ready'/'error', and returns the resulting state. opts.timeoutMs bounds the call.
 */
export async function getAiViabilityState(
  db: AppDb,
  caseId: string,
  opts?: { compute?: boolean; timeoutMs?: number },
): Promise<AiViabilityState> {
  if (!aiRoutePickerEnabled()) return { status: 'off' };
  let inputHash = '';
  try {
    const c = (await db.case.findFirst({ where: { id: caseId }, select: PLAN_ROW_SELECT })) as unknown as CaseRow | null;
    if (c === null || !c.claimedCondition) return { status: 'none' };

    const inputs = await buildPlanInputs(db, caseId, c);
    inputHash = inputs.inputHash;
    const cacheKey = `${caseId}:${inputHash}`;
    if (_cache.has(cacheKey)) {
      const cached = _cache.get(cacheKey) ?? null;
      if (cached) return { status: 'ready', card: cached };
    }

    // ── $0 short-circuit: a persisted plan whose hash + shape match the current inputs. Read + write compute
    // the hash through the SAME buildPlanInputs, so a fresh plan is always re-found (kills the permanent
    // hash-mismatch failure mode by construction).
    const persisted = c.aiViabilityPlanJson;
    if (c.aiViabilityPlanHash === inputHash && persisted && typeof persisted === 'object'
        && persisted.schemaVersion === AI_VIABILITY_PLAN_SCHEMA_VERSION && persisted.source === 'ai_route_picker' && persisted.lead) {
      const stamped: AiViabilityCard = { ...persisted, planHash: c.aiViabilityPlanHash ?? '' };
      _cache.set(cacheKey, stamped);
      return { status: 'ready', card: stamped };
    }

    // READ-ONLY (synchronous paths): never run the ~22s LLM under the 29s cap. Map the persisted status —
    // for THESE inputs — to an honest state so the FE shows the right surface and the caller triggers a
    // compute only when one is actually needed (status 'none' or a stale 'computing').
    if (opts?.compute === false) {
      const statusMatchesInputs = c.aiViabilityPlanHash === inputHash; // the recorded status is ABOUT these inputs
      if (statusMatchesInputs && c.aiViabilityPlanStatus === 'error') {
        return { status: 'error', error: c.aiViabilityPlanError || 'The analysis could not be completed.' };
      }
      if (statusMatchesInputs && c.aiViabilityPlanStatus === 'computing' && computingIsFresh(c)) {
        return { status: 'computing' };
      }
      // No fresh plan, no error/in-flight for these inputs → cold. The caller fires the compute.
      return { status: 'none' };
    }

    // ── COMPUTE path (async self-invoke OR the synchronous on-demand endpoint).
    // IN-FLIGHT GUARD (Ryan 2026-06-22, cost): a cold open can fan out multiple compute triggers (the GET fires
    // the async recompute on 'none', and the FE's /compute auto-fire / Retry also fires it). If a FRESH
    // 'computing' stamp for THESE EXACT inputs already exists, a compute is already running — short-circuit to
    // {status:'computing'} WITHOUT firing a second ~5¢ Sonnet call. The `c` row was read at the top of this fn
    // (same row that produced inputHash), so this is free (no extra query). This makes a cold open cost ONE
    // compute, not three. (computingIsFresh keys off the stamp time so a crashed prior compute can still recompute
    // after COMPUTING_STALE_MS.)
    if (c.aiViabilityPlanHash === inputHash && c.aiViabilityPlanStatus === 'computing' && computingIsFresh(c)) {
      return { status: 'computing' };
    }
    // Mark 'computing' so a concurrent read shows a spinner (not a fake verdict) while this runs; then persist
    // 'ready'/'error'. AWAIT the stamp (QA 2026-06-21): a fire-and-forget 'computing' write could land AFTER the
    // awaited 'error' write on the instant-fail paths below (missing prompt / unconfigured key) and clobber it
    // back to a 90s spinner; awaiting also makes the "concurrent read shows a spinner" comment actually true.
    await markPlanStatus(db, caseId, inputHash, 'computing', null);

    const pp = loadPickerPrompt();
    if (!pp) { // vendored prompt unavailable → honest error (NOT a silent null that looks like "no plan")
      await markPlanStatus(db, caseId, inputHash, 'error', 'The route-picker brain is unavailable.');
      return { status: 'error', error: 'The route-picker brain is unavailable.' };
    }

    let anthropic: Anthropic;
    try { anthropic = new Anthropic({ apiKey: await resolveAnthropicApiKey(), timeout: opts?.timeoutMs ?? 22_000, maxRetries: 0 }); }
    catch {
      await markPlanStatus(db, caseId, inputHash, 'error', 'The analysis service is not configured.');
      return { status: 'error', error: 'The analysis service is not configured.' };
    }

    let resp: Anthropic.Message;
    try {
      resp = await anthropic.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        // DETERMINISM (Dr. Kasky 2026-06-28, "the chip keeps changing color on its own"). The viability BAND
        // this call emits is the go/no-go the Overview chip + the SOAP action derive from — it MUST be stable
        // across recomputes of an unchanged case, or the chip wobbles amber→green→amber. temperature:0 (was
        // 0.5) makes the band a deterministic function of the inputs; non-zero sampling let the band re-roll
        // on identical inputs, which (with the recompute storm during drafting) was a root cause of the flicker.
        temperature: 0,
        system: pp.SYSTEM,
        tools: [pp.TOOL],
        tool_choice: { type: 'tool', name: pp.TOOL.name },
        messages: [{ role: 'user', content: buildUserPrompt(c.claimedCondition, inputs.sc, inputs.problems, inputs.events, c.veteranStatement, inputs.guidance, inputs.docHints) }],
      });
    } catch (e) {
      // The LLM call FAILED (timeout / overload / network) — the dominant Zimmelman failure on a large chart.
      // Persist an honest, STABLE error for these inputs so the next read shows "analysis failed — retry"
      // and the GET stops re-firing the async recompute on every open (the infinite-loop fix).
      const error = e instanceof Error ? e.message : String(e);
      await markPlanStatus(db, caseId, inputHash, 'error', humanizeComputeError(error));
      console.warn(JSON.stringify({ msg: 'ai-viability: compute LLM call failed', caseId, error }));
      return { status: 'error', error: humanizeComputeError(error) };
    }

    if (resp.stop_reason === 'max_tokens') {
      await markPlanStatus(db, caseId, inputHash, 'error', 'The analysis was too long to complete. Please retry.');
      return { status: 'error', error: 'The analysis was too long to complete. Please retry.' };
    }
    const block = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === pp.TOOL.name);
    const plan = block?.input as Record<string, unknown> | undefined;
    const pa = plan?.['primary_anchor'] as Record<string, unknown> | undefined;
    if (!plan || !pa || typeof pa['upstream'] !== 'string') {
      await markPlanStatus(db, caseId, inputHash, 'error', 'The analysis returned an unusable result. Please retry.');
      return { status: 'error', error: 'The analysis returned an unusable result. Please retry.' };
    }

    const card: AiViabilityCard = {
      source: 'ai_route_picker',
      schemaVersion: AI_VIABILITY_PLAN_SCHEMA_VERSION,
      inputClaimed: c.claimedCondition,
      viability: (plan['viability'] as AiViabilityCard['viability']) ?? 'needs_physician_review',
      lead: {
        upstream: String(pa['upstream'] ?? ''), claimed: String(pa['claimed'] ?? c.claimedCondition),
        framing: String(pa['framing'] ?? ''), cfr_basis: String(pa['cfr_basis'] ?? ''),
        mechanism: String(pa['dominant_mechanism'] ?? ''), confidence: String(pa['confidence'] ?? ''),
        rationale: String(pa['rationale'] ?? ''), counterargument: String(pa['strongest_counterargument'] ?? ''),
      },
      convergent: ((plan['convergent_anchors'] as Array<Record<string, unknown>>) ?? []).map((x) => ({ upstream: String(x['upstream'] ?? ''), note: String(x['shared_mechanism_note'] ?? '') })).filter((x) => x.upstream),
      alternatives: ((plan['alternative_theories'] as Array<Record<string, unknown>>) ?? []).map((x) => ({ upstream: String(x['upstream'] ?? ''), framing: String(x['framing'] ?? ''), why_not: String(x['why_not_primary'] ?? '') })).filter((x) => x.upstream),
      excluded: ((plan['excluded_anchors'] as Array<Record<string, unknown>>) ?? []).map((x) => ({ upstream: String(x['upstream'] ?? ''), reason: String(x['reason'] ?? '') })).filter((x) => x.upstream),
      missing: ((plan['missing_facts'] as Array<Record<string, unknown>>) ?? []).map((x) => ({ fact: String(x['fact_needed'] ?? ''), why: String(x['why_it_matters'] ?? '') })).filter((x) => x.fact),
      nuance: String(plan['clinical_nuance'] ?? ''),
      overall: String(plan['overall_rationale'] ?? ''),
      planHash: inputHash,
    };
    _cache.set(cacheKey, card);
    // Persist the plan JSON hash-FREE + stamp status 'ready' + the matching hash, ATOMICALLY in one update so
    // a reader never sees status:'ready' against a stale hash. Fail-open (a write failure never breaks the card).
    const { planHash: _ph, ...persistCard } = card;
    void _ph;
    await db.case
      .update({ where: { id: caseId }, data: { aiViabilityPlanJson: persistCard as unknown as object, aiViabilityPlanHash: inputHash, aiViabilityPlanStatus: 'ready', aiViabilityPlanError: null, aiViabilityPlanComputedAt: new Date() } as never })
      .catch((e: unknown) => { console.warn(JSON.stringify({ msg: 'ai-viability: plan persist failed open', caseId, error: e instanceof Error ? e.message : String(e) })); });
    return { status: 'ready', card };
  } catch (err) {
    // An UNEXPECTED error (not the LLM call itself — that is caught above) on the compute path. On a read-only
    // path we still degrade to 'none' (the GET handles it). On the compute path, persist an honest error so the
    // failure is visible + stable rather than an endless silent re-fire.
    const error = err instanceof Error ? err.message : String(err);
    console.warn(JSON.stringify({ msg: 'ai-viability: failed open', caseId, error }));
    if (opts?.compute !== false && inputHash) {
      await markPlanStatus(db, caseId, inputHash, 'error', humanizeComputeError(error)).catch(() => {});
      return { status: 'error', error: humanizeComputeError(error) };
    }
    return { status: 'none' };
  }
}

/** Map a raw compute error to a short, RN-safe message (no stack traces / provider internals leaked). */
function humanizeComputeError(raw: string): string {
  const r = raw.toLowerCase();
  if (r.includes('timeout') || r.includes('timed out') || r.includes('aborted')) {
    return 'The analysis timed out (the chart is large). Please retry.';
  }
  if (r.includes('overloaded') || r.includes('rate') || r.includes('529') || r.includes('429')) {
    return 'The analysis service is busy. Please retry in a moment.';
  }
  return 'The analysis could not be completed. Please retry.';
}

/** Stamp the plan status for a case AGAINST a specific inputHash (so a reader can tell the status is about
 *  the CURRENT inputs, not a prior version). Best-effort: a write failure is logged, never thrown. The hash
 *  is written alongside the status so 'computing'/'error' are scoped to these exact inputs. */
async function markPlanStatus(db: AppDb, caseId: string, inputHash: string, status: 'computing' | 'error', error: string | null): Promise<void> {
  try {
    await db.case.update({
      where: { id: caseId },
      data: { aiViabilityPlanStatus: status, aiViabilityPlanError: error, aiViabilityPlanHash: inputHash, aiViabilityPlanComputedAt: new Date() } as never,
    });
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'ai-viability: status stamp failed open', caseId, status, error: e instanceof Error ? e.message : String(e) }));
  }
}

/**
 * Back-compat wrapper preserving the original `AiViabilityCard | null` contract. Existing callers (the GET,
 * the SOAP/Gate-1, advisory) keep working unchanged; the rich reliability state is available via
 * getAiViabilityState for the new loading/error-aware surfaces.
 */
export async function deriveAiViability(
  db: AppDb,
  caseId: string,
  opts?: { compute?: boolean; timeoutMs?: number },
): Promise<AiViabilityCard | null> {
  const state = await getAiViabilityState(db, caseId, opts);
  return state.status === 'ready' ? state.card : null;
}
