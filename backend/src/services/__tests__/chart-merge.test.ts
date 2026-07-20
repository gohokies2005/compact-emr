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

  // ── Medication temporality (Ryan 2026-06-13) — the architect's load-bearing 🔴 case ──
  const med = (over: Partial<FinalExtractedItem>): FinalExtractedItem =>
    item({ category: 'active_medication', name: 'escitalopram', sourceQuote: 'escitalopram', ...over });

  it('a manual ACTIVE med does NOT block an extracted HISTORICAL occurrence (history is additive)', () => {
    const existing: ExistingChartRow[] = [{ category: 'active_medication', name: 'escitalopram', source: 'manual', medStatus: 'active' }];
    const p = planMerge(existing, [med({ medStatus: 'historical', lastSeenDate: '06/14/2015' })]);
    expect(p.toInsert).toHaveLength(1); // different status/year key → the 2015 history row inserts
    expect(p.skippedManual).toBe(0);
  });

  it('a manual ACTIVE med DOES block an extracted ACTIVE same-drug (manual wins, no dup)', () => {
    const existing: ExistingChartRow[] = [{ category: 'active_medication', name: 'escitalopram', source: 'manual', medStatus: 'active' }];
    const p = planMerge(existing, [med({ medStatus: 'active' })]);
    expect(p.toInsert).toHaveLength(0);
    expect(p.skippedManual).toBe(1);
  });

  it('collapses chunk-overlap copies (same drug+status+year) but keeps different years', () => {
    const p = planMerge([], [
      med({ medStatus: 'historical', lastSeenDate: '03/12/2015' }),
      med({ medStatus: 'historical', lastSeenDate: '2015' }),           // same year → dup
      med({ medStatus: 'historical', lastSeenDate: '06/14/2022' }),     // different year → distinct
    ]);
    expect(p.toInsert).toHaveLength(2);
    expect(p.skippedDuplicate).toBe(1);
  });

  // ── UPGRADE-ON-MERGE promotion (continuation-grant fix, Ryan 2026-07-19) ──
  // THE BRONCHITIS INCIDENT: a condition extracted earlier as `pending` is later GRANTED by a rating
  // decision. The grant row used to be skipped (skippedPriorExtracted), leaving the stale pending forever.
  describe('upgrade-on-merge: prior-extracted pending → service_connected on a later authoritative grant', () => {
    // An authoritative rating-decision grant for the incoming side.
    const grant = (over: Partial<FinalExtractedItem> = {}): FinalExtractedItem =>
      item({ name: 'chronic bronchitis', status: 'service_connected', ratingPct: 10, sourceAuthorityTier: 'va_decision', scStatusAuthoritative: true, ...over });

    it('PROMOTES an earlier extracted pending bronchitis when the rating-decision grant lands later', () => {
      const existing: ExistingChartRow[] = [{ category: 'sc_condition', name: 'chronic bronchitis', source: 'extracted', id: 'sc-1', status: 'pending' }];
      const p = planMerge(existing, [grant()]);
      expect(p.toInsert).toHaveLength(0);
      expect(p.skippedPriorExtracted).toBe(0);
      expect(p.toPromote).toHaveLength(1);
      expect(p.toPromote[0]!.target.id).toBe('sc-1');
      expect(p.toPromote[0]!.incoming.status).toBe('service_connected');
      expect(p.toPromote[0]!.incoming.ratingPct).toBe(10);
    });

    it('NEVER promotes a manual pending row (RN values immutable — still skippedManual)', () => {
      const existing: ExistingChartRow[] = [{ category: 'sc_condition', name: 'chronic bronchitis', source: 'manual', id: 'sc-1', status: 'pending' }];
      const p = planMerge(existing, [grant()]);
      expect(p.toPromote).toHaveLength(0);
      expect(p.skippedManual).toBe(1);
    });

    it('does NOT promote from a NON-authoritative source (clinical/veteran tier) — stays skipped', () => {
      const existing: ExistingChartRow[] = [{ category: 'sc_condition', name: 'chronic bronchitis', source: 'extracted', id: 'sc-1', status: 'pending' }];
      const p = planMerge(existing, [grant({ sourceAuthorityTier: 'clinical', scStatusAuthoritative: false })]);
      expect(p.toPromote).toHaveLength(0);
      expect(p.skippedPriorExtracted).toBe(1);
    });

    it('MONOTONIC UP ONLY: never demotes an existing service_connected row toward a lower incoming status', () => {
      const existing: ExistingChartRow[] = [{ category: 'sc_condition', name: 'chronic bronchitis', source: 'extracted', id: 'sc-1', status: 'service_connected' }];
      const p = planMerge(existing, [grant({ status: 'pending', scStatusAuthoritative: false })]);
      expect(p.toPromote).toHaveLength(0);
      expect(p.skippedPriorExtracted).toBe(1); // the already-SC row is untouched
    });

    it('promotes via the scStatusAuthoritative bit alone (no tier string)', () => {
      const existing: ExistingChartRow[] = [{ category: 'sc_condition', name: 'chronic bronchitis', source: 'extracted', id: 'sc-1', status: 'pending' }];
      const p = planMerge(existing, [grant({ sourceAuthorityTier: undefined, scStatusAuthoritative: true })]);
      expect(p.toPromote).toHaveLength(1);
    });
  });
});
