// Keystone pkg 6 — the autofill-ON guard test the plan names: with CHART_AUTOFILL='on' and the
// normalizeName dedup guard, a re-extract of a case that already has "PTSD" inserts 0 new sc rows
// (the variant explosion can no longer land once the flag is flipped).
import { afterEach, describe, it, expect, vi } from 'vitest';
import { applyExtractionMerge } from '../chart-merge-apply.js';
import type { FinalExtractedItem } from '../chart-extract-llm.js';
import type { AppDb } from '../db-types.js';

function item(name: string): FinalExtractedItem {
  return {
    category: 'sc_condition', name, sourceDocumentId: 'd1', sourcePage: 1,
    sourceQuote: `service connected for ${name}`, confidence: 0.95, disposition: 'autofill', needsReview: false,
  };
}

function makeDb(existingScRows: { condition: string; source: string }[]) {
  const scCreates: Record<string, unknown>[] = [];
  const runUpdates: Record<string, unknown>[] = [];
  const tx = {
    scCondition: { create: vi.fn(async (a: { data: Record<string, unknown> }) => { scCreates.push(a.data); return a.data; }) },
    activeProblem: { create: vi.fn(async () => ({})) },
    activeMedication: { create: vi.fn(async () => ({})) },
    chartExtractionRun: { update: vi.fn(async (a: { data: Record<string, unknown> }) => { runUpdates.push(a.data); return a.data; }) },
  };
  const db = {
    scCondition: { findMany: vi.fn(async () => existingScRows) },
    activeProblem: { findMany: vi.fn(async () => []) },
    activeMedication: { findMany: vi.fn(async () => []) },
    chartExtractionRun: tx.chartExtractionRun,
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as AppDb;
  return { db, scCreates, runUpdates };
}

afterEach(() => { delete process.env['CHART_AUTOFILL']; });

describe('applyExtractionMerge — autofill ON + dedup guard (keystone pkg 6)', () => {
  it('NAMED ACCEPTANCE: a re-extract against an existing "PTSD" row inserts ZERO new sc rows', async () => {
    process.env['CHART_AUTOFILL'] = 'on';
    const { db, scCreates } = makeDb([{ condition: 'PTSD', source: 'extracted' }]);
    const result = await applyExtractionMerge(db, {
      caseId: 'C-1', veteranId: 'VET-1', runId: 'RUN-1',
      items: [item('PTSD, chronic'), item('Posttraumatic stress disorder (PTSD)')],
    });
    expect(result.autofill).toBe(true);
    expect(result.written).toBe(0);
    expect(scCreates).toHaveLength(0);
    expect(result.skippedPriorExtracted + result.skippedDuplicate).toBe(2);
  });

  it('a MANUAL "PTSD" row blocks the variant insert (manual rows always win)', async () => {
    process.env['CHART_AUTOFILL'] = 'on';
    const { db, scCreates } = makeDb([{ condition: 'PTSD', source: 'manual' }]);
    const result = await applyExtractionMerge(db, {
      caseId: 'C-1', veteranId: 'VET-1', runId: 'RUN-1', items: [item('PTSD, chronic')],
    });
    expect(result.written).toBe(0);
    expect(result.skippedManual).toBe(1);
    expect(scCreates).toHaveLength(0);
  });

  it('the variant explosion within ONE run lands as a single row (+ the honest compound)', async () => {
    process.env['CHART_AUTOFILL'] = 'on';
    const { db, scCreates } = makeDb([]);
    const result = await applyExtractionMerge(db, {
      caseId: 'C-1', veteranId: 'VET-1', runId: 'RUN-1',
      items: [item('PTSD'), item('PTSD, chronic'), item('Posttraumatic stress disorder (PTSD)'), item('PTSD and anxiety')],
    });
    expect(result.written).toBe(2); // one canonical PTSD + the compound (decision (a))
    expect(scCreates.map((c) => c['condition'])).toEqual(['PTSD', 'PTSD and anxiety']);
    expect(result.skippedDuplicate).toBe(2);
  });

  it('shadow mode (flag off) still writes nothing — the flip is the only activation', async () => {
    const { db, scCreates } = makeDb([]);
    const result = await applyExtractionMerge(db, {
      caseId: 'C-1', veteranId: 'VET-1', runId: 'RUN-1', items: [item('PTSD')],
    });
    expect(result.autofill).toBe(false);
    expect(result.written).toBe(0);
    expect(scCreates).toHaveLength(0);
  });
});

// ── Medication temporality through the writer (Ryan 2026-06-13). The merge must persist medStatus +
// dates and keep the active-vs-history timeline; a manual active row protects only the active copy. ──
type ExistingMed = { drugName: string; source: string; medStatus: string | null; startDate: string | null; lastSeenDate: string | null };
function medItem(over: Partial<FinalExtractedItem>): FinalExtractedItem {
  return { category: 'active_medication', name: 'escitalopram', sourceDocumentId: 'd1', sourcePage: 5, sourceQuote: 'escitalopram', confidence: 0.95, disposition: 'autofill', needsReview: false, ...over };
}
function makeMedDb(existingMeds: ExistingMed[]) {
  const medCreates: Record<string, unknown>[] = [];
  const tx = {
    scCondition: { create: vi.fn(async () => ({})) },
    activeProblem: { create: vi.fn(async () => ({})) },
    activeMedication: { create: vi.fn(async (a: { data: Record<string, unknown> }) => { medCreates.push(a.data); return a.data; }) },
    chartExtractionRun: { update: vi.fn(async (a: { data: Record<string, unknown> }) => a.data) },
  };
  const db = {
    scCondition: { findMany: vi.fn(async () => []) },
    activeProblem: { findMany: vi.fn(async () => []) },
    activeMedication: { findMany: vi.fn(async () => existingMeds) },
    chartExtractionRun: tx.chartExtractionRun,
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as AppDb;
  return { db, medCreates };
}

describe('applyExtractionMerge — medication temporality', () => {
  it('writes the same drug as TWO rows (active 2022 + historical 2015) with medStatus + dates persisted', async () => {
    process.env['CHART_AUTOFILL'] = 'on';
    const { db, medCreates } = makeMedDb([]);
    const result = await applyExtractionMerge(db, {
      caseId: 'C-1', veteranId: 'VET-1', runId: 'RUN-1',
      items: [
        medItem({ medStatus: 'active', startDate: '01/05/2022', dose: '20 mg' }),
        medItem({ medStatus: 'historical', lastSeenDate: '03/12/2015' }),
      ],
    });
    expect(result.written).toBe(2);
    expect(medCreates.map((m) => m['medStatus'])).toEqual(['active', 'historical']);
    expect(medCreates[0]).toMatchObject({ medStatus: 'active', startDate: '01/05/2022' });
    expect(medCreates[1]).toMatchObject({ medStatus: 'historical', lastSeenDate: '03/12/2015' });
  });

  it('a MANUAL active med blocks the extracted ACTIVE copy but NOT a historical 2015 occurrence', async () => {
    process.env['CHART_AUTOFILL'] = 'on';
    const { db, medCreates } = makeMedDb([{ drugName: 'escitalopram', source: 'manual', medStatus: 'active', startDate: null, lastSeenDate: null }]);
    const result = await applyExtractionMerge(db, {
      caseId: 'C-1', veteranId: 'VET-1', runId: 'RUN-1',
      items: [medItem({ medStatus: 'active' }), medItem({ medStatus: 'historical', lastSeenDate: '06/14/2015' })],
    });
    expect(result.skippedManual).toBe(1); // active copy blocked by the manual row
    expect(result.written).toBe(1);       // historical 2015 still inserts (additive)
    expect(medCreates).toHaveLength(1);
    expect(medCreates[0]).toMatchObject({ medStatus: 'historical', lastSeenDate: '06/14/2015' });
  });
});
