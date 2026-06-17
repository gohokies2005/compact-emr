import { apiPost } from './client';

// Auto-fired "overall impression" sanity check (Ryan 2026-06-16). The client passes the context it
// already assembled for the Overview; the server runs the Opus gut-check and returns the impression
// (or null — fail-open). Shapes mirror backend/src/services/sanity-impression.ts.

export type ImpressionLevel = 'clear' | 'caution' | 'concern';

export interface SanityImpression {
  readonly stage: 'pre_draft' | 'post_draft';
  readonly impression: ImpressionLevel;
  readonly summary: string;
  readonly missed: string | null;
}

export interface SanityContextInput {
  readonly stage: 'pre_draft' | 'post_draft';
  readonly claimedCondition: string;
  // The veteran's OWN stated goal (their words) — lets the check recognize a non-standard but legitimate
  // request (a Character-of-Discharge §3.354 insanity IMO, etc.) the rigid engine framing mislabels.
  readonly veteranTheory?: string | null;
  readonly theory?: string | null;
  readonly scConditions?: readonly string[];
  readonly keyFacts?: readonly string[];
  readonly coverageNote?: string | null;
  readonly draftText?: string | null;
  readonly grade?: string | null;
}

export async function getSanityImpression(caseId: string, ctx: SanityContextInput): Promise<{ data: SanityImpression | null }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(caseId)}/sanity-impression`, ctx);
}
