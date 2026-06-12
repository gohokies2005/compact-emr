import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Bedrock caller so these tests never hit the network. invokeAdvisory returns
// { text, usage, stopReason, costUsd } — we control `text` per test.
const invokeAdvisory = vi.fn();
vi.mock('../advisory/bedrockClient.js', () => ({
  invokeAdvisory: (...args: unknown[]) => invokeAdvisory(...args),
}));

import { selectPagesLlm, shouldUseLlmPicker } from '../services/doctor-pack-page-llm.js';

function pages(n: number): { pageNumber: number; text: string }[] {
  return Array.from({ length: n }, (_, i) => ({ pageNumber: i + 1, text: `page ${i + 1} body text here` }));
}
function llmReturns(text: string, costUsd = 0.01) {
  invokeAdvisory.mockResolvedValueOnce({ text, usage: { input_tokens: 100, output_tokens: 20 }, stopReason: 'end_turn', costUsd });
}

describe('doctor-pack page LLM picker', () => {
  beforeEach(() => invokeAdvisory.mockReset());

  it('shouldUseLlmPicker gates on size (>=3, <=60 text pages)', () => {
    expect(shouldUseLlmPicker(2)).toBe(false); // too small — nothing to pick
    expect(shouldUseLlmPicker(3)).toBe(true);
    expect(shouldUseLlmPicker(60)).toBe(true);
    expect(shouldUseLlmPicker(61)).toBe(false); // oversized — falls back to regex
  });

  it('parses the keep-list into page ranges and reports cost', async () => {
    llmReturns('{"keep":[3,4,5,9],"note":"decision + reasons"}', 0.0123);
    const res = await selectPagesLlm({ docType: 'rating_decision', pages: pages(10) });
    expect(res).not.toBeNull();
    expect(res!.keptPageNumbers).toEqual([3, 4, 5, 9]);
    expect(res!.pageRanges).toEqual([{ from: 3, to: 5 }, { from: 9, to: 9 }]);
    expect(res!.costUsd).toBe(0.0123);
  });

  it('drops the boilerplate pages the model did not keep (the live bug: pay/commissary pages 1-2)', async () => {
    // Model keeps only the substantive decision pages, NOT the pay/commissary boilerplate on 1-2.
    llmReturns('{"keep":[6,7,8]}');
    const res = await selectPagesLlm({ docType: 'rating_decision', claimedCondition: 'sleep apnea', pages: pages(10) });
    expect(res!.keptPageNumbers).toEqual([6, 7, 8]);
    expect(res!.keptPageNumbers).not.toContain(1);
    expect(res!.keptPageNumbers).not.toContain(2);
  });

  it('tolerates markdown fences / stray prose around the JSON', async () => {
    llmReturns('Here is the selection:\n```json\n{"keep":[2,3]}\n```\n');
    const res = await selectPagesLlm({ docType: 'c_and_p_exam', pages: pages(5) });
    expect(res!.keptPageNumbers).toEqual([2, 3]);
  });

  it('returns null (→ caller falls back to regex) on unparseable output', async () => {
    llmReturns('I could not produce JSON for this document.');
    const res = await selectPagesLlm({ docType: 'rating_decision', pages: pages(10) });
    expect(res).toBeNull();
  });

  it('returns null on an empty keep-list — never silently drops the whole decision', async () => {
    llmReturns('{"keep":[]}');
    const res = await selectPagesLlm({ docType: 'rating_decision', pages: pages(10) });
    expect(res).toBeNull();
  });

  it('ignores hallucinated page numbers outside the document', async () => {
    llmReturns('{"keep":[2,3,999]}');
    const res = await selectPagesLlm({ docType: 'denial_letter', pages: pages(5) });
    expect(res!.keptPageNumbers).toEqual([2, 3]); // 999 dropped
  });

  it('returns null (no LLM call) for too-small docs', async () => {
    const res = await selectPagesLlm({ docType: 'rating_decision', pages: pages(2) });
    expect(res).toBeNull();
    expect(invokeAdvisory).not.toHaveBeenCalled();
  });

  it('never throws — a Bedrock error returns null for the regex fallback', async () => {
    invokeAdvisory.mockRejectedValueOnce(new Error('AccessDeniedException'));
    const res = await selectPagesLlm({ docType: 'rating_decision', pages: pages(10) });
    expect(res).toBeNull();
  });

  it('sends temperature 0 for deterministic selection across regenerations', async () => {
    llmReturns('{"keep":[1,2,3]}');
    await selectPagesLlm({ docType: 'rating_decision', pages: pages(5) });
    const opts = invokeAdvisory.mock.calls[0]![2] as { temperature?: number };
    expect(opts.temperature).toBe(0);
  });
});
