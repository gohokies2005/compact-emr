// BRIDGE-ANCHOR PREREQ (2026-06-16) — chartFactsPresent.dx_constellation emitter.
// The presumptive bridge-anchor pathway (drafter window's FRN half) needs the veteran's PRESENT
// diagnoses to find a PACT-presumptive intermediate dx (G2). buildDxConstellation supplies that from
// the problem list as RAW labels (the vendored assessBridgePathways canonicalizes + drops granted).
import { describe, it, expect } from 'vitest';
import { buildDxConstellation } from '../services/case-viability-stamp.js';
import type { AppDb } from '../services/db-types.js';

function fakeDb(row: unknown): AppDb {
  return { case: { findFirst: async () => row } } as unknown as AppDb;
}

describe('buildDxConstellation (bridge-anchor prereq)', () => {
  it('returns the present-diagnosis problem list as raw labels', async () => {
    const db = fakeDb({
      veteran: { activeProblems: [{ problem: 'Chronic sinusitis' }, { problem: 'Obstructive sleep apnea' }] },
    });
    expect(await buildDxConstellation(db, 'c1')).toEqual(['Chronic sinusitis', 'Obstructive sleep apnea']);
  });

  it('dedups case-insensitively, trims, and drops empty/whitespace labels', async () => {
    const db = fakeDb({
      veteran: {
        activeProblems: [
          { problem: '  Chronic Rhinitis ' },
          { problem: 'chronic rhinitis' }, // dup (case-insensitive)
          { problem: '' },
          { problem: '   ' },
          { problem: 'Asthma' },
        ],
      },
    });
    expect(await buildDxConstellation(db, 'c1')).toEqual(['Chronic Rhinitis', 'Asthma']);
  });

  it('null veteran → [] (fail-soft, never throws)', async () => {
    expect(await buildDxConstellation(fakeDb({ veteran: null }), 'c1')).toEqual([]);
  });

  it('missing case row → []', async () => {
    expect(await buildDxConstellation(fakeDb(null), 'c1')).toEqual([]);
  });

  it('a DB throw fails open to [] (the secondary axis still stands)', async () => {
    const db = { case: { findFirst: async () => { throw new Error('db down'); } } } as unknown as AppDb;
    expect(await buildDxConstellation(db, 'c1')).toEqual([]);
  });
});
