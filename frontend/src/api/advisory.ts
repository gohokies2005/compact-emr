import { apiGet, apiPost } from './client';

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

export interface AdvisoryThreadItem {
  id: string;
  question: string;
  answer: string | null;
  status: AdvisoryStatus;
  citations: AdvisoryCitation[] | null;
  createdAt: string;
}

// The saved Q&A thread for a case (answered questions only), oldest-first.
export async function getAdvisoryThread(caseId: string): Promise<{ data: AdvisoryThreadItem[] }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/advisory/queries`);
}
