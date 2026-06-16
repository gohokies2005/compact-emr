import { apiPost } from './client';

// Recommended-plan outreach email (2026-06-16). The RN clicks "Draft outreach email" in the
// Recommended-plan section; the backend drafts it with Sonnet 4.6 (FRN voice + mechanical fee/dash
// guards) and returns it for the staffer to edit + copy. NEVER auto-sent. `source: 'template'` means
// the AI was unavailable / fee-blocked and a safe deterministic template was used (show a banner).

export interface OutreachEmailFlag {
  readonly type: string;
  readonly severity?: 'block' | 'review';
}
export interface OutreachEmailResult {
  readonly text: string;
  readonly source: 'ai' | 'template';
  readonly flags: readonly OutreachEmailFlag[];
}
export interface OutreachEmailRequest {
  readonly kind: 'contact_records' | 'contact_alternative';
  readonly missingFact?: string;
  readonly bridge?: { readonly intermediate_dx: string; readonly claimed: string; readonly intermediate_presumptive_basis: string };
}

export function postRecommendationEmail(caseId: string, body: OutreachEmailRequest): Promise<{ data: OutreachEmailResult }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(caseId)}/recommendation-email`, body);
}
