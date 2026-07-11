import { describe, it, expect, vi, beforeEach } from 'vitest';

// DOCTOR_PACK_LLM_BULK (2026-07-11): the chunked Haiku bulk picker. Mock Bedrock so we test the
// batching / union / fail-safe logic deterministically (each mocked batch keeps its FIRST page, so the
// union is independent of the concurrency ordering).
vi.mock('../../advisory/bedrockClient.js', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, invokeAdvisory: vi.fn() };
});
import { invokeAdvisory } from '../../advisory/bedrockClient.js';
import { selectPagesLlmBulk, selectPagesLlm } from '../doctor-pack-page-llm.js';

const mockInvoke = vi.mocked(invokeAdvisory);

function pages(n: number): { pageNumber: number; text: string }[] {
  return Array.from({ length: n }, (_, i) => ({ pageNumber: i + 1, text: `page ${i + 1} body text here` }));
}
function firstPageOf(userContent: string): number | undefined {
  const m = userContent.match(/--- Page (\d+) ---/);
  return m ? Number(m[1]) : undefined;
}

beforeEach(() => { mockInvoke.mockReset(); });

describe('selectPagesLlmBulk — batching, union, fail-safe', () => {
  it('chunks 130 pages into 4 batches and UNIONs the kept pages (sorted, deduped)', async () => {
    mockInvoke.mockImplementation(async (_sys: string, uc: string) => {
      const first = firstPageOf(uc);
      const keep = first !== undefined ? [first] : [];
      const label = first === 1 ? 'Sleep study AHI 42' : '';
      return { text: JSON.stringify({ keep, label }), usage: { input_tokens: 100, output_tokens: 10 }, stopReason: 'end_turn', costUsd: 0.001 };
    });
    const out = await selectPagesLlmBulk({ docType: 'blue_button', claimedCondition: 'obstructive sleep apnea', pages: pages(130) });
    // 130 pages / 40 per batch → first pages 1, 41, 81, 121.
    expect(out.result).not.toBeNull();
    expect(out.result!.keptPageNumbers).toEqual([1, 41, 81, 121]);
    expect(mockInvoke).toHaveBeenCalledTimes(4);
    // Label = the first non-empty batch label; page refs are NOT taken from the model.
    expect(out.label).toBe('Sleep study AHI 42');
    expect(out.costUsd).toBeCloseTo(0.004, 6);
  });

  it('a per-batch FAILURE contributes nothing but never nukes the doc (still returns other batches)', async () => {
    mockInvoke.mockImplementation(async (_sys: string, uc: string) => {
      const first = firstPageOf(uc);
      if (first === 41) throw new Error('bedrock boom'); // non-throttle → this batch → null → contributes nothing
      return { text: JSON.stringify({ keep: first !== undefined ? [first] : [] }), usage: {}, stopReason: 'end_turn', costUsd: 0.001 };
    });
    const out = await selectPagesLlmBulk({ docType: 'blue_button', pages: pages(130) });
    expect(out.result).not.toBeNull();
    expect(out.result!.keptPageNumbers).toEqual([1, 81, 121]); // 41's batch dropped, others survive
  });

  it('ALL batches boilerplate (empty keep) ⇒ result null so the caller falls back to regex — but cost is still reported', async () => {
    mockInvoke.mockResolvedValue({ text: JSON.stringify({ keep: [] }), usage: {}, stopReason: 'end_turn', costUsd: 0.002 });
    const out = await selectPagesLlmBulk({ docType: 'blue_button', pages: pages(90) });
    expect(out.result).toBeNull();
    expect(out.costUsd).toBeGreaterThan(0); // billed-but-kept-nothing is still attributed (cost-visibility)
  });

  it('caps kept pages at 12 per bulk doc', async () => {
    // Each 40-page batch keeps its first 8 pages → 4 batches × up to 8 = many; capped to 12.
    mockInvoke.mockImplementation(async (_sys: string, uc: string) => {
      const nums = [...uc.matchAll(/--- Page (\d+) ---/g)].map((m) => Number(m[1])).slice(0, 8);
      return { text: JSON.stringify({ keep: nums }), usage: {}, stopReason: 'end_turn', costUsd: 0.001 };
    });
    const out = await selectPagesLlmBulk({ docType: 'blue_button', pages: pages(160) });
    expect(out.result).not.toBeNull();
    expect(out.result!.keptPageNumbers.length).toBeLessThanOrEqual(12);
  });

  it('strips any page reference the model puts in the label (page refs are code-generated, never model)', async () => {
    mockInvoke.mockImplementation(async (_sys: string, uc: string) => {
      const first = firstPageOf(uc);
      return { text: JSON.stringify({ keep: first !== undefined ? [first] : [], label: first === 1 ? 'VA denial p. 11' : '' }), usage: {}, stopReason: 'end_turn', costUsd: 0.001 };
    });
    const out = await selectPagesLlmBulk({ docType: 'blue_button', pages: pages(50) });
    expect(out.label).toBe('VA denial'); // "p. 11" stripped
  });

  it('skips the LLM entirely for a doc with fewer than 3 text pages', async () => {
    const out = await selectPagesLlmBulk({ docType: 'blue_button', pages: pages(2) });
    expect(out.result).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('tolerates prose-wrapped JSON from the model (Haiku wraps more than Opus)', async () => {
    mockInvoke.mockImplementation(async (_sys: string, uc: string) => {
      const first = firstPageOf(uc);
      return { text: `Sure! Here is my answer:\n{"keep": [${first}], "label": "OSA note"}\nHope that helps.`, usage: {}, stopReason: 'end_turn', costUsd: 0.001 };
    });
    const out = await selectPagesLlmBulk({ docType: 'blue_button', pages: pages(30) }); // single batch
    expect(out.result).not.toBeNull();
    expect(out.result!.keptPageNumbers).toEqual([1]);
    expect(out.label).toBe('OSA note');
  });
});

describe('selectPagesLlm — label + Haiku model (DOCTOR_PACK_LLM_BULK)', () => {
  it('surfaces the model note as a cover label AND runs on Haiku when haiku:true', async () => {
    mockInvoke.mockResolvedValue({ text: JSON.stringify({ keep: [1, 2], note: 'OSA diagnosis and plan' }), usage: {}, stopReason: 'end_turn', costUsd: 0.01 });
    const out = await selectPagesLlm({ docType: 'progress_notes', claimedCondition: 'osa', pages: pages(5), haiku: true });
    expect(out).not.toBeNull();
    expect(out!.label).toBe('OSA diagnosis and plan');
    expect(String((mockInvoke.mock.calls[0]![2] as { modelId?: string }).modelId)).toContain('haiku');
  });

  it('defaults to Opus (no modelId override) when haiku is absent — byte-identical to prior callers', async () => {
    mockInvoke.mockResolvedValue({ text: JSON.stringify({ keep: [1] }), usage: {}, stopReason: 'end_turn', costUsd: 0.05 });
    const out = await selectPagesLlm({ docType: 'progress_notes', pages: pages(5) });
    expect(out).not.toBeNull();
    expect((mockInvoke.mock.calls[0]![2] as { modelId?: string }).modelId).toBeUndefined();
  });
});
