import { apiGet } from './client';

// LLM restatement of the veteran's OWN causal theory, in concise clinical terms (Part B "Ankle nowhere",
// Ryan 2026-07-11). Generated on-demand by GET /cases/:id/veteran-theory (Sonnet 4.6, grounded in the
// veteran's literal statement, fail-open). DISPLAY-ONLY on the physician page; never influences the drafter.
// `data: null` = flag off / no statement / ungrounded / any failure → the panel falls back to the
// deterministic Part A theory line, so a null loses nothing.
export type VeteranTheoryFraming = 'secondary' | 'direct' | 'aggravation' | 'unclear';

export interface VeteranTheoryData {
  // The veteran's OWN restated theory (Part B). null when that overlay produced nothing (letter-only payload).
  readonly theory: string | null;
  readonly framing: VeteranTheoryFraming | null;
  readonly upstream: string | null;
  // Letter-vs-veteran overlay (Dr. Kasky 2026-07-22): what the LETTER argues, read by an LLM from the letter's
  // final §VII opinion — NOT the route-picker plan (which diverges from the drafted letter by design). When
  // present these SUPERSEDE the plan-derived "what the letter argues" line + the deterministic reconcile.
  // `difference` is the plain "where they differ" sentence, or null when the two theories align. Both absent
  // (flag off / letter unreadable / LLM fail-open) -> the panel keeps today's deterministic plan-based path.
  readonly letterTheory?: string | null;
  readonly difference?: string | null;
  readonly costUsd?: number;
}

export async function getVeteranTheory(caseId: string): Promise<{ data: VeteranTheoryData | null }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/veteran-theory`);
}
