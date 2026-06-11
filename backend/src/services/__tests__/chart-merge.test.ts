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

  // Keystone pkg 6 — the dedup guard over the richer normalizeName (CLM-A355D7A822 explosion).
  it('NAMED ACCEPTANCE: an existing manual "PTSD" row blocks an extracted "PTSD, chronic" insert', () => {
    const existing: ExistingChartRow[] = [{ category: 'sc_condition', name: 'PTSD', source: 'manual' }];
    const p = planMerge(existing, [item({ name: 'PTSD, chronic' })]);
    expect(p.toInsert).toHaveLength(0);
    expect(p.skippedManual).toBe(1); // the manual row always wins — no second row
  });

  it('the four CLM-A355D7A822 PTSD variants in ONE extraction batch collapse to a single insert + the honest compound', () => {
    const p = planMerge([], [
      item({ name: 'PTSD' }),
      item({ name: 'PTSD, chronic' }),
      item({ name: 'Posttraumatic stress disorder (PTSD)' }),
      item({ name: 'PTSD and anxiety' }), // compound = TWO conditions; stays its own row (decision (a))
    ]);
    expect(p.toInsert.map((i) => i.name)).toEqual(['PTSD', 'PTSD and anxiety']);
    expect(p.skippedDuplicate).toBe(2); // the chronic + parenthetical variants fold into the first
  });

  it('"PTSD and anxiety" dedups only against an identical compound, never against bare PTSD', () => {
    const existing: ExistingChartRow[] = [
      { category: 'sc_condition', name: 'PTSD', source: 'manual' },
      { category: 'sc_condition', name: 'PTSD and anxiety', source: 'manual' },
    ];
    const p = planMerge(existing, [item({ name: 'PTSD and anxiety' })]);
    expect(p.toInsert).toHaveLength(0);
    expect(p.skippedManual).toBe(1); // matched the compound row, not the bare-PTSD row
  });

  it('a prior-EXTRACTED "PTSD" row blocks a re-extracted "Posttraumatic stress disorder (PTSD)" (extracted-vs-existing)', () => {
    const existing: ExistingChartRow[] = [{ category: 'sc_condition', name: 'PTSD', source: 'extracted' }];
    const p = planMerge(existing, [item({ name: 'Posttraumatic stress disorder (PTSD)' })]);
    expect(p.toInsert).toHaveLength(0);
    expect(p.skippedPriorExtracted).toBe(1);
  });
});
