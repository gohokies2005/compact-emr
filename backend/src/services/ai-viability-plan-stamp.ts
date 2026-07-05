// Persisted route-picker PLAN → drafter bundle stamp (Ryan 2026-06-25, "honor the SOAP theory on redraft").
//
// THE GAP THIS CLOSES: the drafter (FRN framingGate, behind AI_ROUTE_PICKER_ENABLED) RE-RAN the route-picker
// FRESH every draft/redraft — a second, independent LLM call that could (and did, Spring CLM-E0BF075984)
// diverge from the PERSISTED plan the RN already saw. The persisted plan (Case.aiViabilityPlanJson, source
// ai_route_picker) is the SAME brain the SOAP note + the Overview viability card render. It is the AUTHORITATIVE
// lead theory. This stamp threads it INTO the drafter bundle so the drafter can FOLLOW it instead of re-deciding.
//
// SIBLING block to caseFraming (case-framing-stamp.ts): stamped at ROUTE level (drafter.ts), never inside
// buildDrafterBundle (which stays pure-read). Fail-open by construction — absent / no plan / a non-ready plan
// → the bundle is returned UNSTAMPED and the drafter falls through to its existing fresh-derive behavior, byte-
// identical to today. This stamp NEVER mutates the Case row (read-only); the plan was already persisted by
// ai-viability.ts when the card/SOAP was computed.
//
// STALENESS GUARD (mirrors aiViabilityPlanBlock.ts, the advisory reader): we only stamp a plan that is
// (a) schema-current, (b) source ai_route_picker, (c) carries a lead, AND (d) whose inputClaimed still matches
// the case's live claimedCondition. A drifted/wrong-condition plan is NOT stamped (absence ⇒ fresh-derive),
// so the drafter is never fed a lead for a claim the case no longer makes.

import type { AppDb } from './db-types.js';
import type { DrafterBundle } from './drafter-bundle.js';
import { type AiViabilityCard, AI_VIABILITY_PLAN_SCHEMA_VERSION } from './ai-viability.js';

function norm(s: string): string {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The persisted-plan block carried on the drafter bundle. The FRN drafter consumes `plan.lead` as the
 * authoritative lead theory (override > THIS > fresh-derive). `hash` is the plan-inputs sha
 * (Case.aiViabilityPlanHash) at stamp time — carried for the drafter's framing_plan_lead_mismatch provenance,
 * never as a gate. Absence of this whole block ⇒ the drafter derives fresh (today's behavior).
 */
export interface AiViabilityPlanBlock {
  /** Schema discriminator — the drafter ignores an unknown version (fail-open). */
  readonly version: 1;
  /** The persisted route-picker plan (the SAME object the SOAP + Overview card render). */
  readonly plan: AiViabilityCard;
  /** sha of the plan's inputs at stamp time (Case.aiViabilityPlanHash), or '' when the column is empty. */
  readonly hash: string;
}

interface PlanRow {
  claimedCondition: string;
  aiViabilityPlanJson: AiViabilityCard | null;
  aiViabilityPlanHash: string | null;
  aiViabilityPlanStatus: string | null;
}

const PLAN_STAMP_SELECT = {
  claimedCondition: true,
  aiViabilityPlanJson: true,
  aiViabilityPlanHash: true,
  aiViabilityPlanStatus: true,
} as never;

/**
 * Read the persisted route-picker plan for a case and return a copy of the bundle with an `aiViabilityPlan`
 * block stamped — but ONLY when the plan is current, ready, on-condition, and carries a lead. Fail-open:
 * no row / no plan / a non-ready or wrong-condition plan / any throw ⇒ the bundle is returned UNCHANGED and
 * the drafter falls through to its fresh-derive path. Never throws; never mutates the Case row.
 */
export async function stampAiViabilityPlan(
  db: AppDb,
  caseId: string,
  bundle: DrafterBundle,
): Promise<DrafterBundle> {
  try {
    const row = (await db.case.findFirst({
      where: { id: caseId },
      select: PLAN_STAMP_SELECT,
    })) as unknown as PlanRow | null;
    if (row === null) return bundle;

    const plan = row.aiViabilityPlanJson;
    // Stamp a settled plan. 'ready' is the steady state; 'computing' is honored TOO, because a TRANSIENT
    // recompute (the recompute-on-open churn, or a one-time re-hash after a deploy) must NOT starve the drafter
    // of the authoritative plan and force a fresh mis-derive. CLM-BE673DFF78 (Drummond): a 'computing' window at
    // draft-enqueue dropped the good dual-prong secondary plan → the drafter fresh-derived a self-contradictory
    // "direct 3.303 naming the SC right shoulder as cause" framing → the Stage-0.5a plan-validity PARK
    // hard-failed the run with NO letter. markPlanStatus NEVER nulls aiViabilityPlanJson, so a 'computing' row
    // still carries the last-good plan; the coherence guards below (on-condition, has-lead, source, schema)
    // fully gate it, and a claim-CHANGE nulls the JSON → the `!plan` guard below correctly skips → fresh-derive
    // on the new claim. 'error' still defers (a failed compute's JSON is not trustworthy).
    if (row.aiViabilityPlanStatus !== 'ready' && row.aiViabilityPlanStatus !== 'computing') return bundle;
    if (!plan || typeof plan !== 'object' || !('viability' in plan)) return bundle;
    if (plan.schemaVersion !== AI_VIABILITY_PLAN_SCHEMA_VERSION) return bundle;
    if (plan.source !== 'ai_route_picker') return bundle;
    // No lead ⇒ the picker abstained (needs_physician_review with no anchor). There is nothing authoritative
    // to honor; let the drafter derive fresh (its abstain/derive behavior is unchanged).
    if (!plan.lead || !plan.lead.upstream) return bundle;

    // Staleness / wrong-condition guard (mirrors aiViabilityPlanBlock.ts): the plan's claim AT COMPUTE TIME
    // must still match the case's live claimedCondition. A mismatch means the case was re-claimed since the
    // plan was computed — do NOT feed the drafter a lead for a claim the case no longer makes.
    const liveClaimed = norm(row.claimedCondition);
    const planClaimed = norm(plan.inputClaimed);
    if (liveClaimed && planClaimed && liveClaimed !== planClaimed) return bundle;

    const block: AiViabilityPlanBlock = {
      version: 1,
      plan,
      hash: row.aiViabilityPlanHash ?? '',
    };
    return { ...bundle, aiViabilityPlan: block };
  } catch {
    return bundle; // fail-open: a read/throw never blocks a draft — the drafter derives fresh
  }
}
