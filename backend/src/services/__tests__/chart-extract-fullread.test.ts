import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Drive the full-read path's truncation handling through makeChartExtractor by mocking the Anthropic
// SDK. Architect flagged this branch as zero-coverage before the live Armand smoke — it is the exact
// buried-grant failure class (a single dense rating-decision page that overflows the token ceiling).

const createMock = vi.fn();
// The extractor now calls messages.stream(params, opts).finalMessage() (streaming fix 2026-06-23).
// Mock BOTH surfaces onto the same createMock so call-arg/count assertions are unchanged: stream()
// returns a thenable-ish handle whose finalMessage() resolves to whatever createMock returns. We pass
// only the first arg (the params object) to createMock so existing arg-shape assertions still match,
// ignoring the per-request { timeout } options arg.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: (...args: unknown[]) => createMock(...args),
      stream: (params: unknown) => ({ finalMessage: () => createMock(params) }),
    };
  },
}));

// Import AFTER the mock is registered.
const { makeChartExtractor, perCallTimeoutMs } = await import('../chart-extract-llm.js');
import type { BundleDocument } from '../chart-extractor.js';

// One single-page document (so splitChunkText can't split → forces the char-split/floor branch).
const QUOTE = 'service connection for ptsd is granted 70 percent';
const docs: BundleDocument[] = [
  { id: 'doc-rd', filename: 'rating.pdf', pages: [{ pageNumber: 19, text: `decision: ${QUOTE} (diagnostic code 9411)` }] },
];

// A DENSE, MULTI-LINE single page: under the input char budget (so the chunker's splitOversizedPage
// never touched it) but its OUTPUT overflows — the exact Reckart CLM-84B137F353 case. splitChunkText
// still returns null (one [p.N] marker), so recovery must come from the extract-time char-split.
const denseRows = Array.from({ length: 40 }, (_, i) => `${i + 1}. service connection for condition ${i + 1} is granted 30 percent`).join('\n');
const denseDocs: BundleDocument[] = [
  { id: 'doc-dense', filename: 'rating.pdf', pages: [{ pageNumber: 19, text: denseRows }] },
];

function toolResp(stop_reason: string) {
  return {
    usage: { input_tokens: 1000, output_tokens: 500 },
    stop_reason,
    content: [{ type: 'tool_use', input: { items: [
      { category: 'sc_condition', name: 'PTSD', status: 'service_connected', ratingPct: 70, sourcePage: 19, sourceQuote: QUOTE, confidence: 0.95 },
    ] } }],
  };
}

// Distinct-items fixtures (architect + AI-SME QA test-strength fix): a dense PROBLEM-LIST page (NOT grant
// recitals, so the deterministic grant parser contributes nothing — isolating the char-split LLM path).
// The two halves return DISTINCT grounded problems; both must survive grounding + the a.raw++b.raw merge.
const denseProblemRows = Array.from({ length: 40 }, (_, i) => `Active problem ${i}: chronic condition alpha${i} documented on exam.`).join('\n');
const denseProblemDocs: BundleDocument[] = [
  { id: 'doc-dense-pl', filename: 'problem-list.pdf', pages: [{ pageNumber: 7, text: denseProblemRows }] },
];
function problemResp(stop_reason: string, name: string, quote: string) {
  return {
    usage: { input_tokens: 1000, output_tokens: 500 },
    stop_reason,
    content: [{ type: 'tool_use', input: { items: [
      { category: 'active_problem', name, sourcePage: 7, sourceQuote: quote, confidence: 0.95 },
    ] } }],
  };
}

beforeEach(() => { createMock.mockReset(); process.env.CHART_EXTRACT_FULLREAD = 'on'; });
afterEach(() => { delete process.env.CHART_EXTRACT_FULLREAD; });

describe('full-read truncation handling (single dense page)', () => {
  // Reckart CLM-84B137F353 (2026-07-12): the OLD path re-ran a dense single page at the 32k ceiling — a
  // 5-9 min call that blew the 15-min Lambda wall and DLQ'd the whole chart. It now CHAR-SPLITS the page
  // into base-budget halves: two FAST re-reads that can't time out, recovering the items with NO 32k call.
  it('recovers a dense multi-line page via char-split (two BASE-budget re-reads, truncated=0) — never escalates to 32k', async () => {
    createMock
      .mockResolvedValueOnce(toolResp('max_tokens'))  // first pass on the whole page truncates
      .mockResolvedValueOnce(toolResp('end_turn'))     // half A completes at the base budget
      .mockResolvedValueOnce(toolResp('end_turn'));    // half B completes at the base budget
    const result = await makeChartExtractor('sk-test').extract(denseDocs);

    expect(createMock).toHaveBeenCalledTimes(3); // 1 truncated whole-page + 2 halves
    // The re-reads used the BASE budget — NEVER the retired 32k ceiling (that slow call blew the wall).
    expect((createMock.mock.calls[1]![0] as { max_tokens: number }).max_tokens).toBe(8192);
    expect((createMock.mock.calls[2]![0] as { max_tokens: number }).max_tokens).toBe(8192);
    for (const call of createMock.mock.calls) expect((call[0] as { max_tokens: number }).max_tokens).not.toBe(32_000);
    expect(result.fullRead).toBe(true);
    expect(result.truncatedWindows).toBe(0); // recovered → not counted as a loss
    expect(result.items.length).toBeGreaterThanOrEqual(1);
  });

  // Architect + AI-SME QA test-strength fix: the recovery test above mocks IDENTICAL items, so dedup could
  // mask a merge that keeps only ONE half. Here the two halves return DISTINCT grounded problems; BOTH must
  // land — proving the char-split merge (a.raw ++ b.raw) preserves both halves, not just one.
  it('char-split MERGE preserves DISTINCT items from BOTH halves (not just one)', async () => {
    createMock
      .mockResolvedValueOnce(problemResp('max_tokens', 'discarded', 'nope'))                                         // whole page truncates → items discarded
      .mockResolvedValueOnce(problemResp('end_turn', 'Alpha Zero', 'chronic condition alpha0 documented on exam'))    // half A
      .mockResolvedValueOnce(problemResp('end_turn', 'Alpha ThirtyNine', 'chronic condition alpha39 documented on exam')); // half B
    const result = await makeChartExtractor('sk-test').extract(denseProblemDocs);

    expect(createMock).toHaveBeenCalledTimes(3);
    const names = result.items.map((i) => i.name.toLowerCase());
    expect(names).toContain('alpha zero');        // half A survived the merge
    expect(names).toContain('alpha thirtynine');  // half B survived — BOTH halves merged, not just one
    expect(names).not.toContain('discarded');     // the truncated whole-page response's items are dropped
    expect(result.truncatedWindows).toBe(0);
  });

  // A truly unsplittable page (ONE over-long line, no internal newline) can't char-split → it degrades
  // to the FLOOR: accept the base-budget partial + flag truncatedWindows. A loud partial beats a total
  // run failure. Crucially it must NEVER escalate to 32k (the Lambda-timeout crash this fix removes).
  it('a single unsplittable line floors (partial captured + flagged), never escalating to 32k', async () => {
    createMock.mockResolvedValue(toolResp('max_tokens')); // never completes
    const result = await makeChartExtractor('sk-test').extract(docs);

    for (const call of createMock.mock.calls) expect((call[0] as { max_tokens: number }).max_tokens).not.toBe(32_000);
    expect(result.truncatedWindows).toBe(1); // surfaced — the run is flagged incomplete
    // The partial items from the final response are still captured (grounded), never silently dropped.
    expect(result.items).toHaveLength(1);
  });

  it('clean (no truncation): one call, items captured, telemetry set', async () => {
    createMock.mockResolvedValue(toolResp('end_turn'));
    const result = await makeChartExtractor('sk-test').extract(docs);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.chunksProcessed).toBe(1);
    expect(result.uncoveredPages).toBe(0);
    expect(result.truncatedWindows).toBe(0);
    expect(result.items).toHaveLength(1);
  });
});

describe('full-read self-budget cutoff (silent-timeout root fix)', () => {
  afterEach(() => { delete process.env.CHART_EXTRACT_SELF_BUDGET_MS; });

  // 9 single-page docs → 9 chunks → 2 batches at CHUNK_CONCURRENCY=8. A zero budget makes the
  // SECOND batch's pre-launch check trip, so only the first 8 chunks run; the 9th chunk's page is
  // folded into uncoveredPages (→ complete_with_gaps) instead of being silently dropped on a kill.
  function nDocs(n: number): BundleDocument[] {
    // pageNumber 19 matches toolResp's sourcePage so items ground; unique doc ids keep the
    // per-document page keys distinct for uncovered-page counting.
    return Array.from({ length: n }, (_, i) => ({
      id: `doc-${i}`, filename: `f${i}.pdf`,
      pages: [{ pageNumber: 19, text: `decision: ${QUOTE} (item ${i})` }],
    }));
  }

  it('stops launching new batches past the budget and records the un-run pages as uncovered', async () => {
    process.env.CHART_EXTRACT_SELF_BUDGET_MS = '0';
    createMock.mockResolvedValue(toolResp('end_turn'));
    const result = await makeChartExtractor('sk-test').extract(nDocs(9));

    expect(createMock).toHaveBeenCalledTimes(8);   // only the first batch ran; 9th chunk skipped
    expect(result.chunksProcessed).toBe(8);
    expect(result.uncoveredPages).toBe(1);          // the un-run chunk's page surfaces as a gap
    expect(result.items.length).toBeGreaterThan(0); // partial results still captured, never dropped
  });

  it('no cutoff under a large budget: all chunks run, zero uncovered', async () => {
    process.env.CHART_EXTRACT_SELF_BUDGET_MS = '600000';
    createMock.mockResolvedValue(toolResp('end_turn'));
    const result = await makeChartExtractor('sk-test').extract(nDocs(9));
    expect(createMock).toHaveBeenCalledTimes(9);
    expect(result.chunksProcessed).toBe(9);
    expect(result.uncoveredPages).toBe(0);
  });
});

// LAMBDA-DEADLINE GUARD (Reckart CLM-84B137F353 hardening, 2026-07-12): when the SQS handler passes the
// runtime's ABSOLUTE deadline, extraction must stop launching/splitting before the 900s wall and degrade
// to complete_with_gaps / FLOOR — never be killed mid-run → DLQ. deadlineMs threads extract → extractFullRead
// → extractOneChunk. These gates fire ONLY when a deadline is supplied; without one, behavior is unchanged.
describe('lambda-deadline guard (structural no-timeout)', () => {
  const QUOTE_LOCAL = QUOTE;
  const nine: BundleDocument[] = Array.from({ length: 9 }, (_, i) => ({
    id: `dd-${i}`, filename: `f${i}.pdf`, pages: [{ pageNumber: 19, text: `decision: ${QUOTE_LOCAL} (item ${i})` }],
  }));

  it('recursion gate: a max_tokens chunk within the deadline margin FLOORs instead of char-splitting', async () => {
    createMock.mockResolvedValue(toolResp('max_tokens')); // would normally char-split; the near deadline forbids it
    const result = await makeChartExtractor('sk-test').extract(denseDocs, { deadlineMs: Date.now() + 1000 });
    expect(createMock).toHaveBeenCalledTimes(1); // ONE call — NO split recursion started near the wall
    expect(result.truncatedWindows).toBe(1);     // partial captured + flagged (→ complete_with_gaps)
  });

  it('batch-launch gate: stops launching new batches within the deadline margin (default self-budget does NOT fire)', async () => {
    createMock.mockResolvedValue(toolResp('end_turn')); // no CHART_EXTRACT_SELF_BUDGET_MS override → the DEADLINE must be what stops it
    const result = await makeChartExtractor('sk-test').extract(nine, { deadlineMs: Date.now() + 1000 });
    expect(createMock).toHaveBeenCalledTimes(8);  // only the first batch ran; the deadline blocked batch 2
    expect(result.uncoveredPages).toBe(1);        // the un-run chunk's page surfaces as a gap (complete_with_gaps)
    expect(result.items.length).toBeGreaterThan(0); // partial results still captured
  });

  it('a far-future deadline trips neither gate (normal full run, no early stop)', async () => {
    createMock.mockResolvedValue(toolResp('end_turn'));
    const result = await makeChartExtractor('sk-test').extract(nine, { deadlineMs: Date.now() + 60 * 60 * 1000 });
    expect(createMock).toHaveBeenCalledTimes(9);
    expect(result.uncoveredPages).toBe(0);
  });

  it('no deadline supplied → old behavior preserved (all chunks run)', async () => {
    process.env.CHART_EXTRACT_SELF_BUDGET_MS = '600000';
    createMock.mockResolvedValue(toolResp('end_turn'));
    const result = await makeChartExtractor('sk-test').extract(nine); // no opts
    expect(createMock).toHaveBeenCalledTimes(9);
    delete process.env.CHART_EXTRACT_SELF_BUDGET_MS;
  });

  // AI-SME finding: the SDK `timeout` only bounds time-to-headers on a stream, so a mid-stream STALL is
  // bounded ONLY by the deadline AbortSignal. When it fires the SDK rejects; extractOneChunk must degrade
  // THAT chunk to a FLOOR (complete_with_gaps) rather than let the rejection crash the whole run.
  it('deadline abort (AbortSignal fired mid-stream) degrades to complete_with_gaps — never crashes', async () => {
    const abortErr = Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' });
    createMock.mockRejectedValue(abortErr); // simulate the wall-clock signal firing mid-generation
    const result = await makeChartExtractor('sk-test').extract(denseDocs, { deadlineMs: Date.now() + 5 * 60 * 1000 });
    expect(result.truncatedWindows).toBeGreaterThanOrEqual(1); // the aborted chunk floored, run still returned
  });

  // The catch must be SURGICAL: only a deadline abort degrades to FLOOR. A genuine error (a transient 5xx
  // that exhausted retries, a 400) must STILL throw so the handler retries / marks the run failed — never
  // silently swallow a real failure into a false "complete_with_gaps".
  it('a NON-abort error still throws (transient-retry / fail-loud semantics preserved)', async () => {
    createMock.mockRejectedValue(new Error('overloaded 529 after retries'));
    await expect(makeChartExtractor('sk-test').extract(denseDocs, { deadlineMs: Date.now() + 5 * 60 * 1000 }))
      .rejects.toThrow(/overloaded 529/);
  });
});

describe('perCallTimeoutMs (SDK per-call timeout vs remaining Lambda budget)', () => {
  it('no deadline → the fixed 14-min ceiling (unchanged)', () => {
    expect(perCallTimeoutMs(undefined)).toBe(14 * 60 * 1000);
  });
  it('ample budget → still the 14-min ceiling (never raised)', () => {
    expect(perCallTimeoutMs(Date.now() + 60 * 60 * 1000)).toBe(14 * 60 * 1000);
  });
  it('tight budget → floored so a slow-but-legit base call is NEVER spuriously cut', () => {
    const t = perCallTimeoutMs(Date.now() + 100_000); // only 100s left
    expect(t).toBeGreaterThanOrEqual(240_000);        // MIN_CALL_TIMEOUT_MS floor
    expect(t).toBeLessThanOrEqual(14 * 60 * 1000);
  });
  it('mid budget → capped BELOW the 14-min ceiling so a HUNG call aborts before the wall', () => {
    const remaining = 6 * 60 * 1000;
    const t = perCallTimeoutMs(Date.now() + remaining);
    expect(t).toBeLessThan(14 * 60 * 1000);   // tightened toward what's left
    expect(t).toBeLessThanOrEqual(remaining);  // never exceeds the remaining budget
  });
});

// ── extraction precision (Woodley), 2026-06-13 ──────────────────────────────────────────────────
// Bug 1: a rating decision that itemizes named conditions AND shows a "Combined evaluation: 90%" total
// must yield the NAMED conditions (grounded) and NEVER the combined line as a condition. These drive
// the real full-read pipeline (chunk → combined tool → ground → dispose) so the assertions cover
// grounding + the status↔quote gate, not just the raw coercer. The mock plays the model emitting what
// the hardened prompt instructs; grounding then proves each named row is verbatim on the page.
describe('SC condition capture — named conditions vs the combined total (Woodley bug 1)', () => {
  // One rating-decision page itemizing three named grants plus the combined roll-up — the Woodley shape.
  const RD_PAGE =
    'RATING DECISION\n' +
    'Other Specified Trauma or Stressor-Related Disorder ... 70 percent ... service connection granted\n' +
    'Tinnitus ... 10 percent ... service connection granted\n' +
    'Lumbar Strain ... 20 percent ... service connection granted\n' +
    'Combined evaluation: 90%';
  const rdDocs: BundleDocument[] = [
    { id: 'doc-rd', filename: 'rating-decision.pdf', pages: [{ pageNumber: 5, text: RD_PAGE }] },
  ];

  function rdResp() {
    return {
      usage: { input_tokens: 1200, output_tokens: 600 },
      stop_reason: 'end_turn',
      // What the hardened prompt instructs the model to emit: the THREE named grants, each grounded by
      // a verbatim quote on p.5; the "Combined evaluation: 90%" line is correctly emitted as NOTHING.
      content: [{ type: 'tool_use', input: { items: [
        { category: 'sc_condition', name: 'Other Specified Trauma or Stressor-Related Disorder', status: 'service_connected', ratingPct: 70, sourcePage: 5, sourceQuote: 'Other Specified Trauma or Stressor-Related Disorder ... 70 percent ... service connection granted', confidence: 0.95 },
        { category: 'sc_condition', name: 'Tinnitus', status: 'service_connected', ratingPct: 10, sourcePage: 5, sourceQuote: 'Tinnitus ... 10 percent ... service connection granted', confidence: 0.95 },
        { category: 'sc_condition', name: 'Lumbar Strain', status: 'service_connected', ratingPct: 20, sourcePage: 5, sourceQuote: 'Lumbar Strain ... 20 percent ... service connection granted', confidence: 0.95 },
      ] } }],
    };
  }

  it('captures EACH named SC condition by name+rating and does NOT emit the combined line as a condition', async () => {
    createMock.mockResolvedValue(rdResp());
    const result = await makeChartExtractor('sk-test').extract(rdDocs);

    const sc = result.items.filter((i) => i.category === 'sc_condition');
    const names = sc.map((i) => i.name);
    expect(names).toContain('Other Specified Trauma or Stressor-Related Disorder'); // the named SC anchor
    expect(names).toContain('Tinnitus');
    expect(names).toContain('Lumbar Strain');
    expect(sc).toHaveLength(3);
    // The combined total is not a condition — no row carries the combined % or the "combined"/"%" name.
    expect(names.some((n) => /combined/i.test(n) || /%|percent/i.test(n) || /^\s*service[- ]?connected\s*$/i.test(n))).toBe(false);
    // Each named grant kept its own rating (status↔quote gate passed — quotes say "service connection granted").
    const byName = Object.fromEntries(sc.map((i) => [i.name, i] as const));
    expect(byName['Other Specified Trauma or Stressor-Related Disorder']!.ratingPct).toBe(70);
    expect(byName['Other Specified Trauma or Stressor-Related Disorder']!.status).toBe('service_connected');
    expect(byName['Tinnitus']!.ratingPct).toBe(10);
    expect(byName['Lumbar Strain']!.ratingPct).toBe(20);
  });

  it('if a stray combined-line row DOES slip through the model, the named conditions still land (no regression on real grants)', async () => {
    // Defense-in-depth check: even with a bogus combined row in the model output, the named SC rows are
    // independent and survive grounding. (The combined row grounds too — the prompt is the primary
    // guard against it; this asserts the named anchors are never collateral damage.)
    createMock.mockResolvedValue({
      usage: { input_tokens: 1200, output_tokens: 600 },
      stop_reason: 'end_turn',
      content: [{ type: 'tool_use', input: { items: [
        ...rdResp().content[0]!.input.items,
        { category: 'sc_condition', name: 'Combined', status: 'service_connected', ratingPct: 90, sourcePage: 5, sourceQuote: 'Combined evaluation: 90%', confidence: 0.95 },
      ] } }],
    });
    const result = await makeChartExtractor('sk-test').extract(rdDocs);
    const names = result.items.filter((i) => i.category === 'sc_condition').map((i) => i.name);
    expect(names).toContain('Other Specified Trauma or Stressor-Related Disorder');
    expect(names).toContain('Tinnitus');
    expect(names).toContain('Lumbar Strain');
  });
});

// Bug 2: the full read records resolved/historical/duplicate problem lines as ACTIVE (Woodley: 147
// "active problems"). The hardened prompt instructs the model to emit only the currently-active dx;
// this drives the pipeline with that intended output and asserts the active ones land grounded, while
// the resolved / "history of" / duplicate lines are absent.
describe('active_problem precision — active vs resolved / h/o / duplicate (Woodley bug 2)', () => {
  const PL_PAGE =
    'Problem List\n' +
    'Hypertension (active)\n' +
    'Tobacco use disorder, resolved 2019\n' +
    'History of appendectomy\n' +
    'PTSD\n' +
    'Hypertension';   // duplicate of row 1
  const plDocs: BundleDocument[] = [
    { id: 'doc-pl', filename: 'problem-list.pdf', pages: [{ pageNumber: 20, text: PL_PAGE }] },
  ];

  it('records only the currently-active problems; resolved/"history of"/duplicate lines are not active', async () => {
    createMock.mockResolvedValue({
      usage: { input_tokens: 800, output_tokens: 300 },
      stop_reason: 'end_turn',
      // Per the hardened prompt: emit Hypertension ONCE and PTSD; drop the resolved tobacco line, the
      // "History of appendectomy" past mention, and the duplicate Hypertension.
      content: [{ type: 'tool_use', input: { items: [
        { category: 'active_problem', name: 'Hypertension', sourcePage: 20, sourceQuote: 'Hypertension (active)', confidence: 0.95 },
        { category: 'active_problem', name: 'PTSD', sourcePage: 20, sourceQuote: 'PTSD', confidence: 0.95 },
      ] } }],
    });
    const result = await makeChartExtractor('sk-test').extract(plDocs);
    const problems = result.items.filter((i) => i.category === 'active_problem').map((i) => i.name);
    expect(problems).toContain('Hypertension');
    expect(problems).toContain('PTSD');
    expect(problems).toHaveLength(2);                                   // no duplicate Hypertension
    expect(problems.some((n) => /tobacco/i.test(n))).toBe(false);       // resolved line dropped
    expect(problems.some((n) => /appendectomy|history of/i.test(n))).toBe(false); // h/o line dropped
  });

  it('de-dupes within the pipeline if the model still emits a duplicate active problem (grounding/dedup backstop)', async () => {
    createMock.mockResolvedValue({
      usage: { input_tokens: 800, output_tokens: 300 },
      stop_reason: 'end_turn',
      content: [{ type: 'tool_use', input: { items: [
        { category: 'active_problem', name: 'Hypertension', sourcePage: 20, sourceQuote: 'Hypertension (active)', confidence: 0.95 },
        { category: 'active_problem', name: 'Hypertension', sourcePage: 20, sourceQuote: 'Hypertension', confidence: 0.95 },
      ] } }],
    });
    const result = await makeChartExtractor('sk-test').extract(plDocs);
    expect(result.items.filter((i) => i.category === 'active_problem')).toHaveLength(1); // dedup key collapses
  });
});

// ── rolling concurrency pool (barrier → pool, Reckart CLM-84B137F353, 2026-07-12) ──────────────────
// The per-batch Promise.all barrier was replaced by a rolling pool that keeps up to CHUNK_CONCURRENCY
// chunks in flight and launches the next the instant any settles. These prove it is OUTPUT-NEUTRAL:
// (a) results are placed by chunk INDEX, not completion order; (b) concurrency never exceeds 8 and does
// reach 8 (true parallelism, not an accidental barrier-of-1); (c) the budget gate still degrades to
// complete_with_gaps with the correct uncoveredPages.
describe('rolling concurrency pool (output-neutral vs the barrier)', () => {
  // Each of N single-page docs → one chunk (chunkIndex = doc order). A marker in the page text lets the
  // mock key its response + delay to the chunk, so completion order can be forced to differ from index.
  function orderedDocs(n: number): BundleDocument[] {
    return Array.from({ length: n }, (_, k) => ({
      id: `ord-${k}`, filename: `f${k}.pdf`,
      pages: [{ pageNumber: 30, text: `active condition COND_INDEX_${k} present on exam` }],
    }));
  }
  function orderedResp(k: number) {
    return {
      usage: { input_tokens: 500, output_tokens: 200 },
      stop_reason: 'end_turn',
      content: [{ type: 'tool_use', input: { items: [
        { category: 'active_problem', name: `Cond ${k}`, sourcePage: 30, sourceQuote: `active condition COND_INDEX_${k} present`, confidence: 0.95 },
      ] } }],
    };
  }
  const idxOf = (params: unknown) => Number(JSON.stringify(params).match(/COND_INDEX_(\d+)/)![1]);

  it('(a) places results in CHUNK-INDEX order regardless of COMPLETION order', async () => {
    const n = 6; // one full wave (≤ CHUNK_CONCURRENCY): all run concurrently, resolve in REVERSE
    createMock.mockImplementation((params: unknown) => {
      const k = idxOf(params);
      return new Promise((res) => setTimeout(() => res(orderedResp(k)), (n - k) * 15)); // higher k first
    });
    const result = await makeChartExtractor('sk-test').extract(orderedDocs(n));
    const names = result.items.filter((i) => i.category === 'active_problem').map((i) => i.name);
    // Completion order was 5,4,3,2,1,0; index placement keeps items 0..5 in order. A completion-ordered
    // pool would emit them reversed.
    expect(names).toEqual(Array.from({ length: n }, (_, k) => `Cond ${k}`));
  });

  it('(b) never exceeds CHUNK_CONCURRENCY (8) in flight, and does reach it (true parallelism)', async () => {
    let live = 0, peak = 0;
    createMock.mockImplementation((params: unknown) => {
      const k = idxOf(params);
      live++; peak = Math.max(peak, live);
      return new Promise((res) => setTimeout(() => { live--; res(orderedResp(k)); }, 15));
    });
    await makeChartExtractor('sk-test').extract(orderedDocs(20)); // 20 chunks > 8
    expect(peak).toBe(8);                 // fills the pool — parallel, not a barrier-of-1
    expect(peak).toBeLessThanOrEqual(8);  // and NEVER exceeds the cap
  });

  it('(c) budget gate degrades to complete_with_gaps with correct uncoveredPages', async () => {
    process.env.CHART_EXTRACT_SELF_BUDGET_MS = '0'; // trip immediately after the first wave
    createMock.mockImplementation((params: unknown) => Promise.resolve(orderedResp(idxOf(params))));
    const result = await makeChartExtractor('sk-test').extract(orderedDocs(12)); // 12 chunks, 1 page each
    expect(result.chunksProcessed).toBe(8);          // first wave launched (exemption), then gate stopped
    expect(result.uncoveredPages).toBe(4);           // the 4 un-launched chunks' pages → complete_with_gaps
    expect(result.items.filter((i) => i.category === 'active_problem')).toHaveLength(8); // partial fully captured
    delete process.env.CHART_EXTRACT_SELF_BUDGET_MS;
  });
});
