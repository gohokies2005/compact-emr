import { describe, it, expect } from 'vitest';
import { planMerge, type ExistingChartRow } from '../chart-merge.js';
import type { FinalExtractedItem } from '../chart-extract-llm.js';

function item(over: Partial<FinalExtractedItem> = {}): FinalExtractedItem {
  return {
    category: 'sc_condition', name: 'Tinnitus', sourceDocumentId: 'd1', sourcePage: 1,
    sourceQuote: '10% rating for tinnitus', confidence: 0.95, disposition: 'autofill', needsReview: false,
    ...over,
  };
}

describe('planMerge (non-destructive)', () => {
  it('inserts an extracted item with no existing match', () => {
    const p = planMerge([], [item()]);
    expect(p.toInsert).toHaveLength(1);
  });

  it('NEVER touches a manual row of the same condition (immutable)', () => {
    const existing: ExistingChartRow[] = [{ category: 'sc_condition', name: 'Tinnitus', source: 'manual' }];
    const p = planMerge(existing, [item({ name: 'tinnitus' })]);
    expect(p.toInsert).toHaveLength(0);
    expect(p.skippedManual).toBe(1);
  });

  it('does not clobber a prior extracted row of the same condition', () => {
    const existing: ExistingChartRow[] = [{ category: 'sc_condition', name: 'Tinnitus', source: 'extracted' }];
    const p = planMerge(existing, [item()]);
    expect(p.toInsert).toHaveLength(0);
    expect(p.skippedPriorExtracted).toBe(1);
  });

  it('folds synonyms against a manual row (OSA vs Obstructive sleep apnea)', () => {
    const existing: ExistingChartRow[] = [{ category: 'sc_condition', name: 'Obstructive sleep apnea', source: 'manual' }];
    const p = planMerge(existing, [item({ name: 'OSA' })]);
    expect(p.toInsert).toHaveLength(0);
    expect(p.skippedManual).toBe(1);
  });

  it('dedups within the incoming set', () => {
    const p = planMerge([], [item({ name: 'Tinnitus' }), item({ name: 'tinnitus' })]);
    expect(p.toInsert).toHaveLength(1);
    expect(p.skippedDuplicate).toBe(1);
  });

  it('keys by category — same name in different categories are distinct', () => {
    const existing: ExistingChartRow[] = [{ category: 'active_problem', name: 'Tinnitus', source: 'manual' }];
    const p = planMerge(existing, [item({ category: 'sc_condition', name: 'Tinnitus' })]);
    expect(p.toInsert).toHaveLength(1); // SC tinnitus inserts; the manual one was a problem
  });
});
