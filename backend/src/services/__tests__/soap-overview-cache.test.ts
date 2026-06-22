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
  planViabilityToAction,
  __renderContextForTest,
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

// ── ONE-BRAIN GROUNDING CONTRACT (2026-06-21): the SOAP Assessment/Plan RENDER the persisted route-picker
// plan (Case.aiViabilityPlanJson.lead — the SAME brain the drafter pleads), NOT a re-picked theory. These
// pin: (1) the rendered context the model receives carries the plan's framing as AUTHORITATIVE and DROPS the
// free-text strategy strings; (2) a plan change (new planHash) invalidates the SOAP fingerprint; (3) the
// deterministic action map mirrors the plan's viability band; (4) a null plan falls back to strategy strings.
describe('SOAP one-brain grounding (route-picker plan is authoritative)', () => {
  const PLAN_FRAMING: NonNullable<SoapContext['routePickerFraming']> = {
    framing: 'OSA secondary to service-connected allergic rhinitis (causation)',
    cfr_basis: '38 CFR 3.310(a)',
    mechanism: 'Chronic nasal obstruction increases upper-airway resistance and collapsibility during sleep.',
    rationale: 'Granted rhinitis is the strongest grant-defensible upstream anchor on file.',
    counterargument: 'Obesity is an alternative OSA driver; address BMI in the letter.',
    confidence: 'moderate',
    viability: 'supportable',
    planHash: 'PLANHASH-aaa',
  };

  it('renderContext renders the route-picker framing as AUTHORITATIVE and DROPS the free-text strategy strings', () => {
    const grounded: SoapContext = { ...CTX, theory: 'WRONG strategy-preview theory', mechanism: 'WRONG strategy mechanism', routePickerFraming: PLAN_FRAMING };
    const rendered = __renderContextForTest(grounded);
    // The plan's framing/CFR/mechanism/counterargument are present and labeled as the DECIDED framing…
    expect(rendered).toContain('DECIDED FRAMING');
    expect(rendered).toContain(PLAN_FRAMING.framing);
    expect(rendered).toContain(PLAN_FRAMING.cfr_basis);
    expect(rendered).toContain(PLAN_FRAMING.mechanism);
    expect(rendered).toContain(PLAN_FRAMING.counterargument);
    // …and the FE-supplied strategy strings are NOT in the prompt (they cannot compete as a framing source).
    expect(rendered).not.toContain('WRONG strategy-preview theory');
    expect(rendered).not.toContain('WRONG strategy mechanism');
    // The plan IDENTITY (hash) is NOT shown to the model (it is a fingerprint input only).
    expect(rendered).not.toContain('PLANHASH-aaa');
  });

  it('ONE-BRAIN: the framing the SOAP grounds on === the plan lead framing (the headline contract)', () => {
    // Simulate the persisted plan the drafter pleads; the route maps lead.* → routePickerFraming.
    const planLead = { framing: PLAN_FRAMING.framing, cfr_basis: PLAN_FRAMING.cfr_basis, mechanism: PLAN_FRAMING.mechanism };
    const grounded: SoapContext = { ...CTX, routePickerFraming: PLAN_FRAMING };
    expect(grounded.routePickerFraming?.framing).toBe(planLead.framing);
    const rendered = __renderContextForTest(grounded);
    expect(rendered).toContain(planLead.framing);
    expect(rendered).toContain(planLead.cfr_basis);
    expect(rendered).toContain(planLead.mechanism);
  });

  it('falls back to the strategy strings when the plan is null (route-picker off / stale / wrong-condition)', () => {
    const fallback: SoapContext = { ...CTX, theory: 'strategy theory shown', mechanism: 'strategy mechanism shown', routePickerFraming: null };
    const rendered = __renderContextForTest(fallback);
    expect(rendered).not.toContain('DECIDED FRAMING');
    expect(rendered).toContain('strategy theory shown');
    expect(rendered).toContain('strategy mechanism shown');
  });

  it('fingerprint folds the plan IDENTITY: a new planHash invalidates the SOAP cache; an unchanged one is stable', () => {
    const a: SoapContext = { ...CTX, routePickerFraming: PLAN_FRAMING };
    const sameHash: SoapContext = { ...CTX, routePickerFraming: { ...PLAN_FRAMING } };
    const newHash: SoapContext = { ...CTX, routePickerFraming: { ...PLAN_FRAMING, planHash: 'PLANHASH-bbb' } };
    expect(soapNoteFingerprint(a)).toBe(soapNoteFingerprint(sameHash)); // unchanged plan → cache hit
    expect(soapNoteFingerprint(a)).not.toBe(soapNoteFingerprint(newHash)); // plan recompute → invalidate
    // A grounded note and an ungrounded (fallback) note for the same chart are DIFFERENT fingerprints.
    expect(soapNoteFingerprint(a)).not.toBe(soapNoteFingerprint({ ...CTX, routePickerFraming: null }));
  });

  it('the deterministic action map mirrors the plan viability band (no model free-choice drift)', () => {
    expect(planViabilityToAction('supportable')).toBe('draft');
    expect(planViabilityToAction('marginal')).toBe('physician_review');
    expect(planViabilityToAction('needs_physician_review')).toBe('physician_review');
    expect(planViabilityToAction('not_supportable')).toBe('reject');
  });

  it('$0-on-reopen still holds with a grounded plan: unchanged inputs + plan → stored served, no model call', async () => {
    const grounded: SoapContext = { ...CTX, routePickerFraming: PLAN_FRAMING };
    const stored = { inputHash: soapNoteFingerprint(grounded), schemaVersion: SOAP_NOTE_SCHEMA_VERSION, resultJson: NOTE };
    const generate = vi.fn(async () => NOTE);
    const { db, upserts } = fakeDb(stored);
    const res = await getOrBuildSoapNote(db, 'case-1', grounded, { generate });
    expect(generate).not.toHaveBeenCalled(); // unchanged plan + chart → $0 reopen
    expect(res.cached).toBe(true);
    expect(res.stale).toBe(false);
    expect(upserts()).toBe(0);
  });

  // H4 (2026-06-21): a grounded plan whose planHash is EMPTY (legacy/partial row: aiViabilityPlanHash null/''
  // while aiViabilityPlanJson is populated) must STILL invalidate the SOAP cache when the framing changes —
  // otherwise folding the empty hash makes old + new framing share the same `plan:` segment and the stale note
  // is served forever. We derive a CONTENT identity from framing+cfr_basis+mechanism so a framing change moves
  // the fingerprint AND an unchanged framing keeps it stable ($0-on-reopen still works).
  describe('H4 — empty planHash with a grounded plan falls back to a content identity', () => {
    const emptyHash = (over: Partial<NonNullable<SoapContext['routePickerFraming']>> = {}): SoapContext => ({
      ...CTX, routePickerFraming: { ...PLAN_FRAMING, planHash: '', ...over },
    });

    it('empty-planHash + SAME framing → SAME fingerprint ($0-on-reopen still holds)', () => {
      expect(soapNoteFingerprint(emptyHash())).toBe(soapNoteFingerprint(emptyHash()));
    });

    it('empty-planHash + CHANGED framing → DIFFERENT fingerprint (stale invalidates, never served forever)', () => {
      const a = emptyHash();
      const b = emptyHash({ framing: 'OSA secondary to a DIFFERENT anchor (causation)' });
      expect(soapNoteFingerprint(a)).not.toBe(soapNoteFingerprint(b));
      // and a changed CFR basis or mechanism also moves it.
      expect(soapNoteFingerprint(a)).not.toBe(soapNoteFingerprint(emptyHash({ cfr_basis: '38 CFR 3.310(b)' })));
      expect(soapNoteFingerprint(a)).not.toBe(soapNoteFingerprint(emptyHash({ mechanism: 'a wholly different mechanism' })));
    });

    it('empty-planHash + changed framing makes a stored note STALE (served, no auto-spend) — the live bug it fixes', async () => {
      const stored = { inputHash: soapNoteFingerprint(emptyHash()), schemaVersion: SOAP_NOTE_SCHEMA_VERSION, resultJson: NOTE };
      const generate = vi.fn(async () => NOTE);
      const { db } = fakeDb(stored);
      const res = await getOrBuildSoapNote(db, 'case-1', emptyHash({ framing: 'NEW framing, empty hash' }), { generate });
      expect(generate).not.toHaveBeenCalled(); // honest staleness, no silent re-bill
      expect(res.stale).toBe(true);
    });
  });

  it('a route-picker recompute (new planHash) makes the stored SOAP STALE, served without auto-spend', async () => {
    const grounded: SoapContext = { ...CTX, routePickerFraming: PLAN_FRAMING };
    // Stored note was written under the OLD planHash; the live plan now has a new hash → stale, no auto-fire.
    const stored = { inputHash: soapNoteFingerprint(grounded), schemaVersion: SOAP_NOTE_SCHEMA_VERSION, resultJson: NOTE };
    const generate = vi.fn(async () => NOTE);
    const { db } = fakeDb(stored);
    const recomputed: SoapContext = { ...CTX, routePickerFraming: { ...PLAN_FRAMING, planHash: 'PLANHASH-bbb', framing: 'NEW framing after recompute' } };
    const res = await getOrBuildSoapNote(db, 'case-1', recomputed, { generate });
    expect(generate).not.toHaveBeenCalled(); // honest staleness, never a silent re-bill
    expect(res.stale).toBe(true);
  });
});
