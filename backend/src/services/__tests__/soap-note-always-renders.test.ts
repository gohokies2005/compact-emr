// NOTE-ALWAYS-RENDERS + DECISION-MATCHES-NOTE (Ryan 2026-06-22, Zimmelman "WHERE IS THE NOTE?").
//
// buildSoapNote used to return null on truncation / no tool input / missing fields / API error → the Overview
// showed a verdict but NO note. These tests pin the new contract:
//   1. A route-picker plan saying not_supportable → buildSoapNote returns a non-null EXPLANATORY note WITHOUT
//      an LLM call (the deterministic short-circuit), and its action === planViabilityToAction(viability) so
//      the decision matches the note (one-brain).
//   2. An API-construction failure → buildSoapNote returns a non-null fallback note, never null (the only null
//      is a genuinely-empty claimed condition).
//   3. getOrBuildSoapNote does NOT persist a TRANSIENT fallback note (so the next open retries the real model),
//      but DOES persist a not_supportable explanatory note (a stable conclusion) and a real model note.
//
// These avoid the Anthropic SDK by driving the deterministic paths + a spy `generate`.
import { describe, it, expect, vi } from 'vitest';
import {
  buildSoapNote,
  getOrBuildSoapNote,
  planViabilityToAction,
  SOAP_NOTE_SCHEMA_VERSION,
  type SoapContext,
  type SoapNote,
  type SoapOverviewCacheDb,
} from '../soap-overview.js';

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

type Viability = NonNullable<SoapContext['routePickerFraming']>['viability'];
const FRAMING = (viability: Viability): NonNullable<SoapContext['routePickerFraming']> => ({
  framing: 'GERD/Gastritis — direct service connection (in-service onset)',
  cfr_basis: '3.303', mechanism: 'In-service esophagitis documented in 1984 STR.',
  rationale: 'STR shows in-service diagnosis.', counterargument: 'Hiatal hernia is an alternative driver.',
  confidence: 'moderate', viability, planHash: 'PH-1',
});

describe('buildSoapNote — NEVER returns null except for an empty claim', () => {
  it('empty claimed condition → null (nothing to write about)', async () => {
    expect(await buildSoapNote({ claimedCondition: '' })).toBeNull();
    expect(await buildSoapNote({ claimedCondition: '   ' })).toBeNull();
  });

  it('route-picker plan = not_supportable → non-null EXPLANATORY note WITHOUT an LLM call, action=reject (decision matches note)', async () => {
    const ctx: SoapContext = { claimedCondition: 'GERD / Gastritis', routePickerFraming: FRAMING('not_supportable') };
    const note = await buildSoapNote(ctx);
    expect(note).not.toBeNull();
    // Herman fix (2026-06-23): a not_supportable verdict is a STABLE conclusion (no LLM prose to retry), so it
    // is fallback:FALSE — it persists ($0-on-reopen) and the FE does NOT wear the "couldn't be generated"
    // chrome over a confident verdict. (Was fallback:true → re-rendered + re-fired on every open.)
    expect(note!.fallback).toBe(false);
    // The note EXPLAINS why it's not supportable…
    expect(note!.assessment.toLowerCase()).toContain('not supportable');
    // …and the decision DERIVES from the plan viability (one-brain): not_supportable → reject.
    expect(note!.action).toBe('reject');
    expect(note!.action).toBe(planViabilityToAction('not_supportable'));
    expect(note!.plan.length).toBeGreaterThan(0);
  });

  it('a SUPPORTABLE plan with no API key still yields a non-null note (construction failure → explanatory, never blank)', async () => {
    // No ANTHROPIC key configured in this unit env → the Anthropic constructor path throws → buildSoapNote
    // returns an explanatory note grounded on the plan, NOT null. (If a key IS present the call may instead
    // succeed or time out; either way the contract is non-null — assert that.)
    const ctx: SoapContext = { claimedCondition: 'GERD / Gastritis', routePickerFraming: FRAMING('supportable') };
    const note = await buildSoapNote(ctx, { timeoutMs: 1 });
    expect(note).not.toBeNull();
    expect(note!.assessment.length).toBeGreaterThan(0);
    expect(note!.plan.length).toBeGreaterThan(0);
    // decision still matches the plan (supportable → draft).
    expect(note!.action).toBe(planViabilityToAction('supportable'));
  });
});

describe('getOrBuildSoapNote — fallback-note persistence policy', () => {
  const CTX: SoapContext = { claimedCondition: 'GERD / Gastritis', routePickerFraming: FRAMING('supportable') };
  const realNote: SoapNote = { subjective: 's', objective: 'o', assessment: 'a', plan: 'p', confidence: 'moderate', action: 'draft', caveat: null, fallback: false };
  const transientFallback: SoapNote = { ...realNote, fallback: true };

  it('a TRANSIENT fallback note (supportable plan, model failed) is served but NOT persisted (next open retries)', async () => {
    const { db, upserts } = fakeDb();
    const res = await getOrBuildSoapNote(db, 'CASE-1', CTX, { generate: async () => transientFallback });
    expect(res.data?.fallback).toBe(true); // served for THIS open (card never blank)
    expect(upserts()).toBe(0); // but NOT persisted — the next open recomputes / the async precompute lands
  });

  it('a REAL model note (fallback:false) IS persisted ($0-on-reopen holds)', async () => {
    const { db, upserts } = fakeDb();
    await getOrBuildSoapNote(db, 'CASE-1', CTX, { generate: async () => realNote });
    expect(upserts()).toBe(1);
  });

  it('a NOT-SUPPORTABLE explanatory note (stable conclusion, fallback:false) IS persisted', async () => {
    // The REAL buildExplanatoryNote now stamps a not_supportable note fallback:FALSE (stable verdict). Drive
    // the real generator (no spy) so this pins the integrated contract, not a hand-built shape.
    const ctx: SoapContext = { claimedCondition: 'GERD / Gastritis', routePickerFraming: FRAMING('not_supportable') };
    const { db, upserts } = fakeDb();
    const res = await getOrBuildSoapNote(db, 'CASE-1', ctx);
    expect(res.data?.fallback).toBe(false); // stable verdict, not a transient failure
    expect(res.data?.action).toBe('reject');
    expect(upserts()).toBe(1); // not_supportable is a stable verdict — persist it, don't churn
  });

  // HERMAN CLM-E9FEC31D99 REGRESSION (2026-06-23). The production bug: a not_supportable note re-rendered the
  // brief "couldn't be generated" fallback on EVERY open and never healed, because the sync read computed an
  // UNGROUNDED ctx (routePickerFraming null — the live chart inputHash had drifted from the persisted plan
  // hash, so the plan read returned 'none'), and the OLD persistence guard required
  // routePickerFraming?.viability !== 'not_supportable'. With routePickerFraming null, viability was undefined,
  // so a not_supportable note (still fallback:true under the old code) was treated as TRANSIENT and never
  // persisted → re-render + re-fire forever. After the fix: buildExplanatoryNote('not_supportable') is
  // fallback:false regardless of grounding, so it persists on the ungrounded sync path too. ($0 next open.)
  it('a not_supportable note persists on the UNGROUNDED sync path (no routePickerFraming) — the Herman never-heals bug', async () => {
    // Ungrounded ctx: no routePickerFraming (the sync-read state when the plan hash has drifted). The
    // deterministic not_supportable note comes from the `reason` branch, not a grounding plan.
    const explanatory: SoapNote = { ...realNote, action: 'reject', fallback: false };
    const ungroundedCtx: SoapContext = { claimedCondition: 'Ckd', engineNextAction: 'Do not draft as filed.' };
    const { db, upserts } = fakeDb();
    const res = await getOrBuildSoapNote(db, 'CASE-1', ungroundedCtx, { generate: async () => explanatory });
    expect(res.data?.fallback).toBe(false);
    expect(upserts()).toBe(1); // persisted even though ungrounded → next open is a $0 cache hit, no re-fire
  });

  it('schema version is current (sanity)', () => {
    expect(SOAP_NOTE_SCHEMA_VERSION).toBeGreaterThanOrEqual(25);
  });
});
