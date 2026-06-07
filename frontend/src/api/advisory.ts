import { apiPost } from './client';

export type AdvisoryStatus = 'ok' | 'thin' | 'empty' | 'degraded';

export interface AdvisoryCitation {
  citation: string;
  source: string;
  letter_citable: boolean;
}

export interface AdvisoryAnswer {
  answer: string;
  citations: AdvisoryCitation[];
  status: AdvisoryStatus;
  guidance: string | null; // a caveat for thin/empty/degraded retrieval, else null
  costUsd: number;
  notes: string[];
}

// Ask the case-scoped advisory model a plain-language question. Decision support only.
export async function askAdvisory(caseId: string, question: string): Promise<{ data: AdvisoryAnswer }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(caseId)}/advisory/ask`, { question });
}
