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
