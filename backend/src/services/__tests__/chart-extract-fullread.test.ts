import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Drive the full-read path's truncation handling through makeChartExtractor by mocking the Anthropic
// SDK. Architect flagged this branch as zero-coverage before the live Armand smoke — it is the exact
// buried-grant failure class (a single dense rating-decision page that overflows the token ceiling).

const createMock = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: (...args: unknown[]) => createMock(...args) };
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
