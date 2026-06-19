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
const MAX_TOKENS = 1800;

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
      select: { claimedCondition: true, veteranStatement: true, inServiceEvent: true, framingChoice: true, upstreamScCondition: true, aiViabilityPlanHash: true } as never,
    })) as unknown as { claimedCondition: string; veteranStatement: string | null; inServiceEvent: string | null; framingChoice: string | null; upstreamScCondition: string | null; aiViabilityPlanHash: string | null } | null;
    if (c === null || !c.claimedCondition) return null;

    const cf = await deriveCaseFramingForCase(db, caseId);
    let sc = (cf?.grantedScAnchors ?? []).map((a: { condition?: string; upstream_canonical?: string }) => a.condition ?? a.upstream_canonical ?? '').filter(Boolean) as string[];
    // C1 (QA 2026-06-19): mechanism-filter the candidate anchors with the SAME eligibility rule the
    // drafter's rankAnchorCandidates uses (ANCHOR_MECHANISM_GATE) so the card cannot LEAD an excluded
    // (M0 reverse/sympathetic) anchor the drafter would drop — else card and drafter contradict on the
    // highest-stakes pick. Fail-open: filter unavailable → unfiltered (the prompt's exclude backstop holds).
    try {
      const mech = loadMechanismFilter();
      if (mech && sc.length) {
        const filtered = sc.filter((n) => mech.isEligibleAnchor(n, c.claimedCondition));
        if (filtered.length) sc = filtered; // never empty the set (would strand a real-but-all-excluded case to the prompt backstop)
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

    const inputHash = createHash('sha256').update(JSON.stringify({ claimed: c.claimedCondition, sc, problems, events, guidance, vs: c.veteranStatement })).digest('hex');
    const cacheKey = `${caseId}:${inputHash}`;
    if (_cache.has(cacheKey)) return _cache.get(cacheKey) ?? null;

    const pp = loadPickerPrompt();
    if (!pp) return null; // vendored prompt unavailable → fail-open (card shows static)

    let anthropic: Anthropic;
    try { anthropic = new Anthropic({ apiKey: await resolveAnthropicApiKey(), timeout: 120_000, maxRetries: 2 }); }
    catch { return null; }

    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0.5,
      system: pp.SYSTEM,
      tools: [pp.TOOL],
      tool_choice: { type: 'tool', name: pp.TOOL.name },
      messages: [{ role: 'user', content: buildUserPrompt(c.claimedCondition, sc, problems, events, c.veteranStatement, guidance) }],
    });
    if (resp.stop_reason === 'max_tokens') return null;
    const block = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === pp.TOOL.name);
    const plan = block?.input as Record<string, unknown> | undefined;
    const pa = plan?.['primary_anchor'] as Record<string, unknown> | undefined;
    if (!plan || !pa || typeof pa['upstream'] !== 'string') return null;

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
    };
    _cache.set(cacheKey, card);
    // Persist the plan so Ask Aegis can NARRATE the same one-brain pick WITHOUT a second synchronous LLM
    // call on the 29s-capped /ask path (one brain: drafter + card + advisory). Hash-guarded so an
    // identical re-render is a no-op DB-side; fail-open (a write failure / missing column never breaks the
    // card — the advisory just falls back to its corpus-only answer).
    if (c.aiViabilityPlanHash !== inputHash) {
      await db.case
        .update({ where: { id: caseId }, data: { aiViabilityPlanJson: card as unknown as object, aiViabilityPlanHash: inputHash } as never })
        .catch((e: unknown) => { console.warn(JSON.stringify({ msg: 'ai-viability: plan persist failed open', caseId, error: e instanceof Error ? e.message : String(e) })); });
    }
    return card;
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'ai-viability: failed open', caseId, error: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}
