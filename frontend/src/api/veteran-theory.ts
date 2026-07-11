import { apiGet } from './client';

// LLM restatement of the veteran's OWN causal theory, in concise clinical terms (Part B "Ankle nowhere",
// Ryan 2026-07-11). Generated on-demand by GET /cases/:id/veteran-theory (Sonnet 4.6, grounded in the
// veteran's literal statement, fail-open). DISPLAY-ONLY on the physician page; never influences the drafter.
// `data: null` = flag off / no statement / ungrounded / any failure → the panel falls back to the
// deterministic Part A theory line, so a null loses nothing.
export type VeteranTheoryFraming = 'secondary' | 'direct' | 'aggravation' | 'unclear';

export interface VeteranTheoryData {
  readonly theory: string;
  readonly framing: VeteranTheoryFraming;
  readonly upstream: string | null;
  readonly costUsd?: number;
}

export async function getVeteranTheory(caseId: string): Promise<{ data: VeteranTheoryData | null }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/veteran-theory`);
}
