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
// 60s per-request timeout (over the 45s global default): this is a Bedrock/Opus grounded-RAG answer
// and its output cap was raised +50% (2026-06-25), so it genuinely runs long. The old 30s ceiling
// falsely timed out before the answer landed (Dr. Kasky: "navigate away, come back, it's done").
export async function askAdvisory(caseId: string, question: string): Promise<{ data: AdvisoryAnswer }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(caseId)}/advisory/ask`, { question }, { timeout: 60000 });
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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// task #189 — recover the answer that completed AFTER the API-Gateway 30s cap already 5xx'd the
// browser. The Lambda runs to completion and PERSISTS the answer, so we poll the existing GET queries
// endpoint for the freshly-landed row and render it as if the ask had returned normally.
//
// We identify the just-completed answer with TWO signals so a stale duplicate can't false-match:
//   1. its id is NOT among `knownIds` (the thread rows present BEFORE the ask) — the strong signal;
//   2. its question text matches what the user just asked AND its createdAt is at/after the ask
//      (with a generous skew floor for client/server clock differences) — the corroborating signal.
// Returns the landed item, or null if none appeared within the window (caller then shows the calm msg).
export async function pollForCompletedAnswer(
  caseId: string,
  question: string,
  askedAtMs: number,
  knownIds: ReadonlySet<string>,
  opts?: { readonly intervalMs?: number; readonly timeoutMs?: number },
): Promise<AdvisoryThreadItem | null> {
  const intervalMs = opts?.intervalMs ?? 3000;
  const timeoutMs = opts?.timeoutMs ?? 45000;
  const normalizedQ = question.trim();
  const floorMs = askedAtMs - 60_000; // clock-skew allowance so a just-over-30s completion isn't missed
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(intervalMs);
    let thread: { data: AdvisoryThreadItem[] };
    try {
      thread = await getAdvisoryThread(caseId);
    } catch {
      continue; // transient GET failure — keep polling until the deadline rather than giving up
    }
    // Thread is oldest-first; scan newest-first so we return the most recent matching completion.
    const match = [...thread.data].reverse().find(
      (it) =>
        !knownIds.has(it.id) &&
        it.answer !== null &&
        it.question.trim() === normalizedQ &&
        new Date(it.createdAt).getTime() >= floorMs,
    );
    if (match) return match;
  }
  return null;
}

// ── ASYNC ask (Ryan 2026-07-21): submit → poll by queryId, so a 20-40s Opus answer never 504s at the
// API-Gateway 30s cap. Gated in the panel by VITE_ADVISORY_ASYNC; the sync askAdvisory above is the fallback.
export interface AdvisorySubmitResult {
  queryId: string;
  status: string;
}
export async function submitAdvisory(caseId: string, question: string): Promise<{ data: AdvisorySubmitResult }> {
  return apiPost(`/api/v1/cases/${encodeURIComponent(caseId)}/advisory/ask-async`, { question });
}

export interface AdvisoryQueryPoll {
  id: string;
  question: string;
  status: string; // pending | ok | thin | empty | degraded | error | refused
  answer: string | null;
  citations: AdvisoryCitation[] | null;
  createdAt: string;
}
export async function getAdvisoryQuery(caseId: string, queryId: string): Promise<{ data: AdvisoryQueryPoll }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/advisory/queries/${encodeURIComponent(queryId)}`);
}

// Poll ONE query until it is terminal (status !== 'pending'). Returns the terminal row, or null if it
// never left 'pending' within the window (caller then shows the calm retry message). 90s window covers a
// cold-start self-invoke + a 40s answer + margin.
export async function pollAdvisoryQuery(
  caseId: string,
  queryId: string,
  opts?: { readonly intervalMs?: number; readonly timeoutMs?: number },
): Promise<AdvisoryQueryPoll | null> {
  const intervalMs = opts?.intervalMs ?? 3000;
  const timeoutMs = opts?.timeoutMs ?? 90000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(intervalMs);
    try {
      const r = await getAdvisoryQuery(caseId, queryId);
      if (r.data.status !== 'pending') return r.data;
    } catch {
      continue; // transient GET failure — keep polling until the deadline
    }
  }
  return null;
}
