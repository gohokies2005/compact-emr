/**
 * AI-narrow a GENERIC "Other …" Jotform claim label to a SPECIFIC, record-documented diagnosis (Ryan
 * 2026-07-04, Drummond CLM-BE673DFF78: claimedCondition arrived as "Other Joint (shoulder, Hip, Ankle,
 * Elbow, Wrist)" — which the drafter correctly refuses). Reads the extracted chart digest + the granted-SC
 * list and asks Haiku for the single most specific diagnosis the RECORDS document, then writes it to the
 * Case (source='ai') — but ONLY when the current claim is generic AND has not been set 'manual' by a human.
 *
 * LLM, not deterministic (Ryan's ruling). Fail-open EVERYWHERE — a narrow failure never blocks anything; the
 * generic label simply stays and an RN can fix it by hand. Compute-then-persist (manual always wins): the
 * 'manual' immutability is re-checked at write time so a concurrent RN edit is never clobbered.
 */

import Anthropic from '@anthropic-ai/sdk';
import { resolveAnthropicApiKey } from './letter-surgical-propose.js';
import { buildDigestForCase } from '../advisory/chartSlice.js';
import { isGenericClaimLabel } from './generic-claim-label.js';
import type { AppDb } from './db-types.js';

const MAX_TOKENS = 400;

export function resolveClaimNarrowModel(): string {
  const m = process.env.AI_CLAIM_NARROW_MODEL;
  return m && m.trim().length > 0 ? m.trim() : 'claude-haiku-4-5-20251001';
}

const SYSTEM = [
  'You are a medical records analyst for a VA nexus-letter service. A veteran\'s claimed condition was captured',
  'from an intake dropdown as a GENERIC catch-all label (e.g. "Other Joint (shoulder, Hip, Ankle, Elbow,',
  'Wrist)"). Your ONLY job: read the uploaded medical records and return the SINGLE most specific diagnosis the',
  'RECORDS actually document that the veteran is claiming.',
  'RULES: (1) The diagnosis MUST be documented in the provided records — never invent or infer one that is not',
  'written there. (2) Return a specific clinical diagnosis with laterality where the records give it (e.g.',
  '"Left shoulder rotator cuff tendinosis with impingement", "Obstructive sleep apnea", "Lumbar degenerative',
  'disc disease"). (3) If the records do NOT clearly document one specific diagnosis for the claimed body',
  'region, ABSTAIN — return null. A wrong narrow mis-drives the whole letter, so abstaining is correct when',
  'unsure. (4) Do NOT return another generic/"Other" label. (5) Do NOT return an already-service-connected',
  'condition as the claim (that would not be a new nexus claim).',
  'Respond ONLY by calling emit_narrowed_claim.',
].join(' ');

const TOOL: Anthropic.Tool = {
  name: 'emit_narrowed_claim',
  description: 'Return the specific documented diagnosis to use as the claimed condition, or null to abstain.',
  input_schema: {
    type: 'object',
    properties: {
      specific_diagnosis: { type: ['string', 'null'], description: 'The single specific, record-documented diagnosis (with laterality), or null if the records do not clearly document one.' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      evidence: { type: 'string', description: 'The record phrase/finding that documents this diagnosis (1 sentence).' },
    },
    required: ['specific_diagnosis', 'confidence'],
  },
};

interface CaseRow {
  claimedCondition: string;
  claimedConditionSource: string | null;
  claimedConditions: string[];
  veteran: { scConditions: Array<{ condition: string; status: string }> } | null;
}

export interface NarrowResult { updated: boolean; skipped?: string; diagnosis?: string }

export async function narrowAndPersistClaim(db: AppDb, caseId: string): Promise<NarrowResult> {
  if (process.env.AI_CLAIM_NARROW_ENABLED === 'off') return { updated: false, skipped: 'flag_off' };
  try {
    const c = (await db.case.findFirst({
      where: { id: caseId },
      select: {
        claimedCondition: true,
        claimedConditionSource: true,
        claimedConditions: true,
        veteran: { select: { scConditions: { select: { condition: true, status: true } } } },
      } as never,
    })) as unknown as CaseRow | null;
    if (c === null) return { updated: false, skipped: 'no_case' };

    // IMMUTABILITY + applicability guards: never touch a human-set claim; only narrow a generic catch-all.
    if (c.claimedConditionSource === 'manual') return { updated: false, skipped: 'manual' };
    if (!isGenericClaimLabel(c.claimedCondition)) return { updated: false, skipped: 'not_generic' };

    // Records-present gate: narrowing requires the actual chart content. Fail-open to skip when absent.
    const digest = await buildDigestForCase(db, caseId).catch(() => null);
    if (typeof digest !== 'string' || digest.trim().length < 40) return { updated: false, skipped: 'no_records' };

    const grantedSc = (c.veteran?.scConditions ?? [])
      .filter((s) => s.status === 'service_connected')
      .map((s) => (s.condition ?? '').trim())
      .filter(Boolean);

    const userPrompt = `<generic_claimed_label>${c.claimedCondition}</generic_claimed_label>
<already_service_connected note="do NOT return one of these as the claim">
${grantedSc.length ? grantedSc.map((s) => `- ${s}`).join('\n') : '- (none)'}
</already_service_connected>
<extracted_records>
${digest.slice(0, 14000)}
</extracted_records>

Return the single most specific documented diagnosis the veteran is claiming (with laterality), or null to abstain, via emit_narrowed_claim.`;

    const anthropic = new Anthropic({ apiKey: await resolveAnthropicApiKey(), timeout: 25_000, maxRetries: 1 });
    const resp = await anthropic.messages.create({
      model: resolveClaimNarrowModel(),
      max_tokens: MAX_TOKENS,
      temperature: 0,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{ role: 'user', content: userPrompt }],
    });
    const block = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === TOOL.name);
    const out = (block?.input ?? {}) as { specific_diagnosis?: unknown };
    const dx = typeof out.specific_diagnosis === 'string' ? out.specific_diagnosis.trim() : '';

    // Abstain / no-op guards: empty, unchanged, or still-generic → leave the label alone.
    if (dx.length === 0) return { updated: false, skipped: 'abstained' };
    if (dx.toLowerCase() === c.claimedCondition.trim().toLowerCase()) return { updated: false, skipped: 'unchanged' };
    if (isGenericClaimLabel(dx)) return { updated: false, skipped: 'still_generic' };

    // RE-CHECK immutability at write time (compute-then-persist): a concurrent RN edit could have stamped
    // 'manual' while Haiku was running — manual ALWAYS wins, so re-read and refuse to clobber it.
    const fresh = (await db.case.findFirst({ where: { id: caseId }, select: { claimedConditionSource: true } as never })) as unknown as { claimedConditionSource: string | null } | null;
    if (fresh?.claimedConditionSource === 'manual') return { updated: false, skipped: 'manual_race' };

    await db.case.update({
      where: { id: caseId },
      data: {
        claimedCondition: dx,
        claimedConditions: [dx],
        claimedConditionSource: 'ai',
        // Editing the claim invalidates the persisted route-picker plan (same as a PATCH) so viability +
        // SOAP recompute on the narrowed dx, not the discarded generic label.
        aiViabilityPlanJson: null,
        aiViabilityPlanHash: null,
      } as never,
    });
    return { updated: true, diagnosis: dx };
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'aiClaimNarrow failed open', caseId, error: e instanceof Error ? e.message : String(e) }));
    return { updated: false, skipped: 'error' };
  }
}
