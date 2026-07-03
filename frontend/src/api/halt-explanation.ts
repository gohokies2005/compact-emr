import { apiGet } from './client';

// Plain-language explanation of why a paused draft halted + the concrete next step (Dr. Kasky 2026-07-02).
// LLM-generated on-demand by GET /cases/:id/halt-explanation. The panel keeps its raw/technical halt message
// as a collapsible fallback, so `available:false` (not paused / LLM unavailable / failed) loses nothing.
export interface HaltExplanationResponse {
  readonly summary?: string;
  readonly what_to_do?: string;
  readonly confidence?: 'high' | 'medium' | 'low';
  readonly available?: boolean;
}

export async function getHaltExplanation(caseId: string): Promise<{ data: HaltExplanationResponse }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/halt-explanation`);
}
