// SOAP-overview read-through cache (cost-safety 2026-06-21). Pins the fix for "the SOAP note re-loads
// every time I open a chart": a SECOND fetch with an UNCHANGED fingerprint serves the STORED note and does
// NOT invoke the model. The model runs only when the fingerprint changes OR the RN forces a regenerate.
//
// These exercise getOrBuildSoapNote with a fake soap_overviews delegate + a spy `generate`, so the cache
// logic is proven WITHOUT the Anthropic SDK or a real DB (no .env.local needed for this suite).
import { describe, it, expect, vi } from 'vitest';
import {
  getOrBuildSoapNote,
  soapNoteFingerprint,
  SOAP_NOTE_SCHEMA_VERSION,
  type SoapContext,
  type SoapNote,
  type SoapOverviewCacheDb,
} from '../soap-overview.js';

const CTX: SoapContext = {
  claimedCondition: 'Obstructive sleep apnea',
  theory: 'OSA secondary to service-connected sinusitis/rhinitis',
  scConditions: ['Allergic rhinitis 30%', 'Chronic sinusitis 10%'],
  keyFacts: [{ label: 'AHI', value: '32 (severe)' }],
  coverageNote: 'All records were reviewed.',
  engineVerdict: 'Draft (moderate confidence)',
};

const NOTE: SoapNote = {
  subjective: 'The veteran reports loud snoring and daytime fatigue beginning in service.',
  objective: 'OSA is confirmed on sleep study; service-connected rhinitis/sinusitis are on file. All records were reviewed.',
  assessment: 'Chronic upper-airway inflammation from the service-connected sinonasal disease is a recognized contributor to OSA under 38 CFR 3.310.',
  plan: 'Draft the nexus letter on the secondary theory.',
  confidence: 'moderate',
  action: 'draft',
  caveat: null,
};

/** A fake soap_overviews delegate over an in-memory store. */
function fakeDb(initial?: { inputHash: string; schemaVersion: number; resultJson: unknown }): {
  db: SoapOverviewCacheDb; row: () => typeof initial | undefined; upserts: () => number;
} {
  let row = initial;
  let upserts = 0;
  const db: SoapOverviewCacheDb = {
    soapOverview: {
      findUnique: vi.fn(async () => row ?? null),
      upsert: vi.fn(async (a) => {
        upserts += 1;
        const d = (row ? a.update : a.create) as { inputHash: string; schemaVersion: number; resultJson: unknown };
        row = { inputHash: d.inputHash, schemaVersion: d.schemaVersion, resultJson: d.resultJson };
        return row;
      }),
    },
  };
  return { db, row: () => row, upserts: () => upserts };
}

describe('getOrBuildSoapNote — read-through cache', () => {
  it('FIRST open with an empty cache generates once and persists', async () => {
    const generate = vi.fn(async () => NOTE);
    const { db, row, upserts } = fakeDb();
    const res = await getOrBuildSoapNote(db, 'case-1', CTX, { generate });
    expect(generate).toHaveBeenCalledOnce();
    expect(res.data).toEqual(NOTE);
    expect(res.cached).toBe(false);
    expect(res.stale).toBe(false);
    expect(upserts()).toBe(1);
    expect(row()?.inputHash).toBe(soapNoteFingerprint(CTX));
  });

  it('SECOND open with an UNCHANGED fingerprint SERVES THE STORED note and does NOT invoke the model', async () => {
    const stored = { inputHash: soapNoteFingerprint(CTX), schemaVersion: SOAP_NOTE_SCHEMA_VERSION, resultJson: NOTE };
    const generate = vi.fn(async () => NOTE);
    const { db, upserts } = fakeDb(stored);
    const res = await getOrBuildSoapNote(db, 'case-1', CTX, { generate });
    expect(generate).not.toHaveBeenCalled(); // the whole point: no LLM call on re-open
    expect(res.data).toEqual(NOTE);
    expect(res.cached).toBe(true);
    expect(res.stale).toBe(false);
    expect(upserts()).toBe(0); // no write on a clean hit
  });

  it('a CHANGED fingerprint (new info) serves the STALE stored note WITHOUT auto-spending', async () => {
    const stored = { inputHash: 'OLD-fingerprint', schemaVersion: SOAP_NOTE_SCHEMA_VERSION, resultJson: NOTE };
    const generate = vi.fn(async () => NOTE);
    const { db } = fakeDb(stored);
    const res = await getOrBuildSoapNote(db, 'case-1', { ...CTX, keyFacts: [{ label: 'AHI', value: '41 (severe)' }] }, { generate });
    expect(generate).not.toHaveBeenCalled(); // honest staleness, never a silent auto-fire
    expect(res.data).toEqual(NOTE);
    expect(res.stale).toBe(true);
  });

  it('forceRegenerate ALWAYS calls the model and rewrites the stored note (the button)', async () => {
    const fresh: SoapNote = { ...NOTE, plan: 'Get the 2023 sleep study, then draft.' };
    const stored = { inputHash: soapNoteFingerprint(CTX), schemaVersion: SOAP_NOTE_SCHEMA_VERSION, resultJson: NOTE };
    const generate = vi.fn(async () => fresh);
    const { db, row, upserts } = fakeDb(stored);
    const res = await getOrBuildSoapNote(db, 'case-1', CTX, { generate, forceRegenerate: true });
    expect(generate).toHaveBeenCalledOnce();
    expect(res.data).toEqual(fresh);
    expect(res.cached).toBe(false);
    expect(upserts()).toBe(1);
    expect(row()?.resultJson).toEqual(fresh);
  });

  it('a STALE-SHAPE stored note (old schemaVersion) is ignored and regenerated, never mis-rendered', async () => {
    const stored = { inputHash: soapNoteFingerprint(CTX), schemaVersion: SOAP_NOTE_SCHEMA_VERSION - 1, resultJson: NOTE };
    const generate = vi.fn(async () => NOTE);
    const { db } = fakeDb(stored);
    const res = await getOrBuildSoapNote(db, 'case-1', CTX, { generate });
    expect(generate).toHaveBeenCalledOnce(); // old shape → recompute
    expect(res.stale).toBe(false);
  });

  it('fail-open: a cache-read error degrades to a direct generate, never throws', async () => {
    const generate = vi.fn(async () => NOTE);
    const db: SoapOverviewCacheDb = {
      soapOverview: {
        findUnique: vi.fn(async () => { throw new Error('db down'); }),
        upsert: vi.fn(async () => { throw new Error('db down'); }),
      },
    };
    const res = await getOrBuildSoapNote(db, 'case-1', CTX, { generate });
    expect(res.data).toEqual(NOTE); // still useful
    expect(generate).toHaveBeenCalledOnce();
  });

  it('fingerprint is identical for identical inputs and changes when grounding facts change', () => {
    expect(soapNoteFingerprint(CTX)).toBe(soapNoteFingerprint({ ...CTX }));
    expect(soapNoteFingerprint(CTX)).not.toBe(soapNoteFingerprint({ ...CTX, keyFacts: [{ label: 'AHI', value: '41' }] }));
  });
});
