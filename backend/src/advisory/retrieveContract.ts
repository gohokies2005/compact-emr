// The §5 retrieve() contract — a TS mirror of flatratenexus app/services/advisory/retrieve.js. The EMR
// ask-path is built against THIS; the real retrieve.js (which adds pgvector kNN + BVA live-SQL) swaps in
// with ZERO interface change. RetrievalResult = { status, mode_ran[], errors[], chunks[], stats?, notes[] }.

export interface RetrievalChunk {
  text: string;
  source: string; // 'sql' | 'semantic' | 'exact' | ...
  citation: string;
  metadata?: Record<string, unknown>;
  letter_citable: boolean; // false = internal strategy (BVA aggregates) — never in a letter / to the veteran (CLAUDE.md #17)
}
export type RetrievalStatus = 'ok' | 'thin' | 'empty' | 'degraded';
export interface RetrievalInput {
  question: string;
  caseConditions: string[]; // routing-canonical topic keys (from the chart slice)
  framingHint?: string;
}
export interface RetrievalResult {
  status: RetrievalStatus;
  mode_ran: string[];
  errors: string[];
  chunks: RetrievalChunk[];
  stats?: Record<string, unknown>;
  notes: string[];
}
export type RetrieveFn = (input: RetrievalInput) => RetrievalResult | Promise<RetrievalResult>;

// Build-time stub (replaced by the vendored real retrieve.js). Exercises all 4 statuses + BOTH
// letter_citable values so the endpoint's branches are all tested before the swap (architect gap #6).
// Status is driven by magic substrings in the question so tests can hit each branch deterministically.
export function stubRetrieve(input: RetrievalInput): RetrievalResult {
  const q = (input.question || '').toLowerCase();
  if (q.includes('__degraded__')) {
    return { status: 'degraded', mode_ran: [], errors: ['a reference source was unavailable'], chunks: [], notes: [] };
  }
  if (q.includes('__empty__')) {
    return { status: 'empty', mode_ran: ['semantic'], errors: [], chunks: [], notes: ['no matches in the library'] };
  }
  const semantic: RetrievalChunk = {
    text: 'PTSD is epidemiologically associated with obstructive sleep apnea.',
    source: 'semantic',
    citation: 'PMID:12345678',
    letter_citable: true,
  };
  const bva: RetrievalChunk = {
    text: 'PTSD -> OSA: 71% grant among 200 cases (tier high). RELATIVE RANKING SIGNAL ONLY — not a win probability.',
    source: 'sql',
    citation: 'BVA pair atlas (internal aggregate)',
    metadata: { n: 200, tier: 'high' },
    letter_citable: false,
  };
  if (q.includes('__thin__')) {
    return { status: 'thin', mode_ran: ['semantic'], errors: [], chunks: [semantic], notes: ['thin match'] };
  }
  return {
    status: 'ok',
    mode_ran: ['semantic', 'sql'],
    errors: [],
    chunks: [semantic, bva],
    stats: { n: 200, tier: 'high' },
    notes: ['intent=viability (high)'],
  };
}
