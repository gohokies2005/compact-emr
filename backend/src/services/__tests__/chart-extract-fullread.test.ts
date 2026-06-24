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
const { makeChartExtractor } = await import('../chart-extract-llm.js');
import type { BundleDocument } from '../chart-extractor.js';

// One single-page document (so splitChunkText can't split → forces the escalation/floor branch).
const QUOTE = 'service connection for ptsd is granted 70 percent';
const docs: BundleDocument[] = [
  { id: 'doc-rd', filename: 'rating.pdf', pages: [{ pageNumber: 19, text: `decision: ${QUOTE} (diagnostic code 9411)` }] },
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

beforeEach(() => { createMock.mockReset(); process.env.CHART_EXTRACT_FULLREAD = 'on'; });
afterEach(() => { delete process.env.CHART_EXTRACT_FULLREAD; });

describe('full-read truncation handling (single dense page)', () => {
  it('escalates max_tokens on an unsplittable truncation and recovers the items (truncated=0)', async () => {
    createMock
      .mockResolvedValueOnce(toolResp('max_tokens'))  // first pass truncates
      .mockResolvedValueOnce(toolResp('end_turn'));    // escalated re-run completes
    const result = await makeChartExtractor('sk-test').extract(docs);

    expect(createMock).toHaveBeenCalledTimes(2);
    // Second call used the escalated ceiling, not the base budget.
    expect((createMock.mock.calls[1]![0] as { max_tokens: number }).max_tokens).toBe(32_000);
    expect(result.fullRead).toBe(true);
    expect(result.truncatedWindows).toBe(0); // recovered → not counted as a loss
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.ratingPct).toBe(70);
  });

  it('counts a truncation at the FLOOR when even the escalated ceiling overflows (loud, not silent)', async () => {
    createMock.mockResolvedValue(toolResp('max_tokens')); // never completes
    const result = await makeChartExtractor('sk-test').extract(docs);

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
