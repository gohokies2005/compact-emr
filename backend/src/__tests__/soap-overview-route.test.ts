// SOAP-overview HTTP route — the one-brain QA fixes (2026-06-21, H1/H2/H3).
//
// These pin the ROUTE wiring (POST /cases/:id/soap-overview) that the service-level
// soap-overview-cache.test.ts can't reach:
//   H1 — the response carries the GROUNDED framing (grounded:true + routePickerFraming) so the FE headline
//        can match the Assessment; falls back to grounded:false when no plan grounds the note.
//   H2 — a null-plan request (route-picker ON, no warm plan) FIRES the off-request recompute exactly once
//        AND tells the cache NOT to persist this fallback note (noStore) so it can't mask the warming plan.
//   H3 — framing + planHash come from the ONE deriveAiViability return (plan.planHash), with NO second
//        case.findFirst for the hash (the race the original code had).
//
// The service modules are mocked so this exercises the route's branching without the SDK / a real DB.
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb, Role } from '../services/db-types.js';

interface MockUser { readonly sub: string; readonly roles: Role[]; }
let mockUser: MockUser | undefined;

vi.mock('../auth/roles', () => ({
  requireRole:
    (allowed: readonly string[]) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const user = (req as express.Request & { user?: MockUser }).user;
      if (user === undefined) { res.status(401).json({ error: { code: 'unauthorized' } }); return; }
      if (!user.roles.some((r) => allowed.includes(r))) { res.status(403).json({ error: { code: 'forbidden' } }); return; }
      next();
    },
}));

// Service-layer mocks — controlled per test via the exported vi.fn handles. The route now reads the
// discriminated reliability STATE via getAiViabilityState (Ryan 2026-06-21, Zimmelman) rather than the
// null-collapsing deriveAiViability; the helpers below map the old per-test intent onto a state object.
const getAiViabilityState = vi.fn();
const aiRoutePickerEnabled = vi.fn(() => true);
/** Set the route's read state to a 'ready' plan (grounds the note). */
const stateReady = (p: Record<string, unknown>) => getAiViabilityState.mockResolvedValue({ status: 'ready', card: p });
/** Set the read state to cold 'none' (no plan) — the route fires the off-request recompute. */
const stateNone = () => getAiViabilityState.mockResolvedValue({ status: 'none' });
const fireRecomputeViability = vi.fn(async () => true);
// getOrBuildSoapNote echoes the opts so we can assert noStore + forceRegenerate, and reports back the ctx
// it was handed so we can assert the route set routePickerFraming authoritatively.
const getOrBuildSoapNote = vi.fn(async (_db: unknown, _caseId: string, ctx: unknown, opts: unknown) => ({
  data: { subjective: 's', objective: 'o', assessment: 'a', plan: 'p', confidence: 'moderate', action: 'draft', caveat: null },
  fingerprint: 'fp',
  stale: false,
  cached: false,
  __ctx: ctx,
  __opts: opts,
}));

vi.mock('../services/ai-viability.js', () => ({ getAiViabilityState, aiRoutePickerEnabled }));
vi.mock('../services/recompute-viability-trigger.js', () => ({ fireRecomputeViability }));
// soapNoteFingerprint + decideServeStored are stubbed so the route's serve-stored-first AND the new pollOnly
// ($0 status-check) branches are unit-controllable without renderContext/a real cache row.
const soapNoteFingerprint = vi.fn(() => 'fp');
const decideServeStored = vi.fn<(stored: unknown, fp: string) => { note: unknown; refresh: boolean } | null>(() => null);
const SOAP_NOTE_SCHEMA_VERSION = 28;
vi.mock('../services/soap-overview.js', () => ({ getOrBuildSoapNote, soapNoteFingerprint, decideServeStored, SOAP_NOTE_SCHEMA_VERSION }));
// The grounded path now assembles the SoapContext SERVER-SIDE via assembleSoapContextForCase (Zimmelman
// reliability fix 2026-06-22) so the sync read's fingerprint matches the async precompute's. Mock it (it has
// its own dedicated test) — it echoes back the framing it is handed so the H1 routePickerFraming assertions
// still hold, and it does NOT add a case.findFirst to the ROUTE's own count (the H3 race is about the route).
const assembleSoapContextForCase = vi.fn(async (_db: unknown, _caseId: string, rp: unknown) => ({
  claimedCondition: 'Obstructive sleep apnea', routePickerFraming: rp, chartDigest: 'DIGEST', scConditions: [], activeProblems: [], keyFacts: [], medications: [], coverageNote: null, veteranStatement: null,
}));
vi.mock('../services/soap-context-assembler.js', () => ({ assembleSoapContextForCase }));
// case-viability-stamp + chart-readiness are imported by the router for the GET path only; stub them so the
// module loads. (The POST path under test never calls them.)
const caseViabilityEnabled = vi.fn(() => false);
vi.mock('../services/case-viability-stamp.js', () => ({ caseViabilityEnabled, deriveCaseViabilityForCase: vi.fn(async () => null) }));
vi.mock('../services/chart-readiness.js', () => ({ loadReconciledChartReadiness: vi.fn(async () => null) }));

const { createCaseViabilityRouter } = await import('../routes/case-viability.js');

const LEAD = {
  upstream: 'Allergic rhinitis', claimed: 'Obstructive sleep apnea',
  framing: 'OSA secondary to service-connected allergic rhinitis (causation)',
  cfr_basis: '38 CFR 3.310(a)', mechanism: 'Chronic nasal obstruction raises upper-airway collapsibility.',
  confidence: 'moderate', rationale: 'Granted rhinitis is the strongest grant-defensible anchor.',
  counterargument: 'Obesity is an alternative OSA driver.',
};
function plan(overrides: Record<string, unknown> = {}) {
  return { source: 'ai_route_picker', schemaVersion: 1, inputClaimed: 'Obstructive sleep apnea', viability: 'supportable', lead: LEAD, convergent: [], alternatives: [], excluded: [], missing: [], nuance: '', overall: '', planHash: 'PLANHASH-xyz', ...overrides };
}

function makeDb() {
  const caseFindFirst = vi.fn(async () => ({ id: 'CASE-1' }));
  const db = { case: { findFirst: caseFindFirst } } as unknown as AppDb;
  return { db, caseFindFirst };
}

/** A db whose soap_overviews delegate returns `row` from findUnique — for exercising the pollOnly / serve-
 *  stored-first branches (which read the persisted note). `caseRow` overrides the case read (e.g. to set
 *  status:'drafting' for the chip-freeze tests). */
function makeDbWithSoap(row: unknown, caseRow: unknown = { id: 'CASE-1' }) {
  const caseFindFirst = vi.fn(async () => caseRow);
  const soapFindUnique = vi.fn(async () => row);
  const db = { case: { findFirst: caseFindFirst }, soapOverview: { findUnique: soapFindUnique } } as unknown as AppDb;
  return { db, caseFindFirst, soapFindUnique };
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createCaseViabilityRouter(db));
  return app;
}

const POST = (db: AppDb, body: Record<string, unknown>) =>
  request(appFor(db)).post('/api/v1/cases/CASE-1/soap-overview').send(body);
const GET = (db: AppDb) => request(appFor(db)).get('/api/v1/cases/CASE-1/viability-card');
const COMPUTE = (db: AppDb) => request(appFor(db)).post('/api/v1/cases/CASE-1/viability-card/compute').send({});

describe('POST /cases/:id/soap-overview — one-brain QA (H1/H2/H3)', () => {
  beforeEach(() => {
    mockUser = { sub: 'U1', roles: ['ops_staff'] };
    getAiViabilityState.mockReset();
    aiRoutePickerEnabled.mockReset(); aiRoutePickerEnabled.mockReturnValue(true);
    fireRecomputeViability.mockReset(); fireRecomputeViability.mockResolvedValue(true);
    getOrBuildSoapNote.mockClear();
    caseViabilityEnabled.mockReset(); caseViabilityEnabled.mockReturnValue(true);
  });

  it('H1: a warm plan grounds the note — response carries grounded:true + routePickerFraming with the plan framing', async () => {
    stateReady(plan());
    const res = await POST(makeDb().db, { claimedCondition: 'Obstructive sleep apnea' });
    expect(res.status).toBe(200);
    expect(res.body.grounded).toBe(true);
    // The framing the FE will headline === the plan lead framing (the headline-matches-Assessment contract).
    expect(res.body.routePickerFraming.framing).toBe(LEAD.framing);
    expect(res.body.routePickerFraming.cfr_basis).toBe(LEAD.cfr_basis);
    // and it was injected authoritatively into the SOAP ctx (the FE-supplied theory cannot override it).
    expect(getOrBuildSoapNote).toHaveBeenCalledOnce();
    const ctx = getOrBuildSoapNote.mock.calls[0]![2] as { routePickerFraming?: { framing?: string } };
    expect(ctx.routePickerFraming?.framing).toBe(LEAD.framing);
    // grounded note persists (noStore false) — $0-on-reopen holds.
    const opts = getOrBuildSoapNote.mock.calls[0]![3] as { noStore?: boolean };
    expect(opts.noStore).toBe(false);
  });

  it('H3: framing + planHash come from the ONE deriveAiViability return; the route does NOT do a 2nd case.findFirst for the hash', async () => {
    stateReady(plan({ planHash: 'PLANHASH-fromreturn' }));
    const { db, caseFindFirst } = makeDb();
    const res = await POST(db, { claimedCondition: 'Obstructive sleep apnea' });
    expect(res.status).toBe(200);
    expect(res.body.routePickerFraming.planHash).toBe('PLANHASH-fromreturn');
    // Exactly ONE case.findFirst (the existence check at the top) — the old code did a 2nd findFirst for the
    // hash, the race H3 fixes. (deriveAiViability is mocked, so its own internal read isn't counted here.)
    expect(caseFindFirst).toHaveBeenCalledTimes(1);
  });

  it('H2: route-picker ON but NO warm plan → fires recompute once, serves ungrounded fallback, and tells the cache NOT to persist it (noStore)', async () => {
    stateNone(); // no warm persisted plan (cold)
    aiRoutePickerEnabled.mockReturnValue(true);
    const res = await POST(makeDb().db, { claimedCondition: 'Obstructive sleep apnea' });
    expect(res.status).toBe(200);
    expect(res.body.grounded).toBe(false);
    expect(res.body.routePickerFraming).toBeNull();
    expect(fireRecomputeViability).toHaveBeenCalledOnce(); // warm the plan off-request for the NEXT open
    const opts = getOrBuildSoapNote.mock.calls[0]![3] as { noStore?: boolean; forceRegenerate?: boolean };
    expect(opts.noStore).toBe(true); // do NOT persist the strategy fallback — it would mask the warming plan
    expect(opts.forceRegenerate).toBe(false);
  });

  it('H2: forceRegenerate with no warm plan STILL persists (the RN explicitly chose to spend + store)', async () => {
    stateNone();
    aiRoutePickerEnabled.mockReturnValue(true);
    await POST(makeDb().db, { claimedCondition: 'Obstructive sleep apnea', forceRegenerate: true });
    expect(fireRecomputeViability).toHaveBeenCalledOnce();
    const opts = getOrBuildSoapNote.mock.calls[0]![3] as { noStore?: boolean; forceRegenerate?: boolean };
    expect(opts.forceRegenerate).toBe(true);
    expect(opts.noStore).toBe(false); // forced regenerate persists despite the recompute fire
  });

  it('H2/H3: route-picker OFF + no plan → no recompute fired, ungrounded, note persists normally', async () => {
    stateNone();
    aiRoutePickerEnabled.mockReturnValue(false);
    const res = await POST(makeDb().db, { claimedCondition: 'Obstructive sleep apnea' });
    expect(res.body.grounded).toBe(false);
    expect(fireRecomputeViability).not.toHaveBeenCalled();
    const opts = getOrBuildSoapNote.mock.calls[0]![3] as { noStore?: boolean };
    expect(opts.noStore).toBe(false);
  });

  it('a wrong-condition plan does NOT ground (inputClaimed !== live claim) — and fires recompute to refresh', async () => {
    stateReady(plan({ inputClaimed: 'Tinnitus' })); // a ready plan, but for a DIFFERENT claimed condition
    const res = await POST(makeDb().db, { claimedCondition: 'Obstructive sleep apnea' });
    expect(res.body.grounded).toBe(false);
    expect(res.body.routePickerFraming).toBeNull();
    expect(fireRecomputeViability).toHaveBeenCalledOnce(); // stale-condition (ready-but-wrong-claim) → refire
  });
});

// ── pollOnly: the CHEAP auto-refresh status-check (Dr. Kasky 2026-06-29) ─────────────────────────────────────
// The card polls with pollOnly:true every ~15s while a provisional fallback brief is showing. It must be $0:
// serve the persisted real note the instant the precompute lands it, otherwise report generating:true WITHOUT
// ever running the model (getOrBuildSoapNote) or re-firing the recompute (the storm the chip-fix just closed).
describe('POST /cases/:id/soap-overview pollOnly — $0 status check, never bills, never re-fires', () => {
  beforeEach(() => {
    mockUser = { sub: 'U1', roles: ['ops_staff'] };
    getAiViabilityState.mockReset();
    aiRoutePickerEnabled.mockReset(); aiRoutePickerEnabled.mockReturnValue(true);
    fireRecomputeViability.mockReset(); fireRecomputeViability.mockResolvedValue(true);
    getOrBuildSoapNote.mockClear();
    caseViabilityEnabled.mockReset(); caseViabilityEnabled.mockReturnValue(true);
    soapNoteFingerprint.mockReset(); soapNoteFingerprint.mockReturnValue('fp');
    decideServeStored.mockReset(); decideServeStored.mockReturnValue(null);
  });

  it('still generating (no real stored note) → generating:true, NO model call, NO recompute fired', async () => {
    stateReady(plan()); // warm plan so the EARLIER block does not fire a recompute — isolates pollOnly
    decideServeStored.mockReturnValue(null); // precompute hasn't landed the real note yet
    const { db } = makeDbWithSoap(null);
    const res = await POST(db, { claimedCondition: 'Obstructive sleep apnea', pollOnly: true });
    expect(res.status).toBe(200);
    expect(res.body.generating).toBe(true);
    expect(res.body.data).toBeNull();
    expect(getOrBuildSoapNote).not.toHaveBeenCalled(); // the cost guard: NEVER bills Sonnet in the warming window
    expect(fireRecomputeViability).not.toHaveBeenCalled(); // the storm guard: never re-fires on a poll
  });

  it('precompute landed → serves the persisted real note for $0 (cached:true), generating:false, NO model call', async () => {
    stateReady(plan());
    const realNote = { subjective: 's', objective: 'o', assessment: 'a', plan: 'p', confidence: 'high', action: 'draft', fallback: false };
    decideServeStored.mockReturnValue({ note: realNote, refresh: false });
    const { db } = makeDbWithSoap({ inputHash: 'fp', schemaVersion: SOAP_NOTE_SCHEMA_VERSION, resultJson: realNote });
    const res = await POST(db, { claimedCondition: 'Obstructive sleep apnea', pollOnly: true });
    expect(res.status).toBe(200);
    expect(res.body.generating).toBe(false);
    expect(res.body.cached).toBe(true);
    expect(res.body.data).toMatchObject({ assessment: 'a', plan: 'p', fallback: false });
    expect(getOrBuildSoapNote).not.toHaveBeenCalled(); // a poll NEVER generates, even when it returns a note
    expect(fireRecomputeViability).not.toHaveBeenCalled();
  });

  it('DRIFTED stored note (refresh:true) → still generating, does NOT serve the stale note as final (Marcus Bennett 2026-06-29)', async () => {
    // The incomplete-extraction bug: a REAL (fallback:false) note was written while the chart was still being
    // analyzed; its prose hedges "…not fully extracted in the available pages". Once extraction completes, the
    // live ctx fingerprint drifts off that note (decideServeStored → refresh:true). The poll must NOT swap that
    // stale note in and disable itself — it must report generating:true and keep waiting for the refreshed note.
    stateReady(plan());
    const staleNote = { subjective: 's', objective: 'o', assessment: 'the content of those opinions is not fully extracted in the available pages', plan: 'p', confidence: 'low', action: 'get_records', fallback: false };
    decideServeStored.mockReturnValue({ note: staleNote, refresh: true }); // current-shape + non-fallback BUT fingerprint-drifted
    const { db } = makeDbWithSoap({ inputHash: 'OLD-fp', schemaVersion: SOAP_NOTE_SCHEMA_VERSION, resultJson: staleNote });
    const res = await POST(db, { claimedCondition: 'Obstructive sleep apnea', pollOnly: true });
    expect(res.status).toBe(200);
    expect(res.body.generating).toBe(true);
    expect(res.body.data).toBeNull();
    expect(getOrBuildSoapNote).not.toHaveBeenCalled(); // still $0
    expect(fireRecomputeViability).not.toHaveBeenCalled(); // pollOnly never re-fires (the normal open path does)
  });
});

// ── SERVE-STORED stale flag (Ryan 2026-07-14, no-hard-refresh fix) ──────────────────────────────────────────
// The serve-stored-first branch used to hardcode stale:false even when decideServeStored reported the stored
// note's fingerprint had DRIFTED (decision.refresh) — so the FE's pollOnly auto-refresh never armed after an
// RN edit and the refreshed note needed a hard refresh. It must now report the drift honestly (stale:true),
// EXCEPT while status='drafting' (the drafter mutates the Case row constantly → artificial drift → reporting
// stale would spin the poll for the whole draft; the chip-freeze rule).
describe('POST /cases/:id/soap-overview serve-stored — honest stale flag (2026-07-14)', () => {
  const storedNote = { subjective: 's', objective: 'o', assessment: 'a', plan: 'p', confidence: 'high', action: 'draft', fallback: false };
  const storedRow = { inputHash: 'OLD-fp', schemaVersion: SOAP_NOTE_SCHEMA_VERSION, resultJson: storedNote };

  beforeEach(() => {
    mockUser = { sub: 'U1', roles: ['ops_staff'] };
    getAiViabilityState.mockReset();
    aiRoutePickerEnabled.mockReset(); aiRoutePickerEnabled.mockReturnValue(true);
    fireRecomputeViability.mockReset(); fireRecomputeViability.mockResolvedValue(true);
    getOrBuildSoapNote.mockClear();
    caseViabilityEnabled.mockReset(); caseViabilityEnabled.mockReturnValue(true);
    soapNoteFingerprint.mockReset(); soapNoteFingerprint.mockReturnValue('fp');
    decideServeStored.mockReset(); decideServeStored.mockReturnValue(null);
  });

  it('DRIFTED stored note (refresh:true) → serves the note WITH stale:true so the card arms its auto-refresh poll', async () => {
    stateReady(plan()); // grounded, non-drafting case
    decideServeStored.mockReturnValue({ note: storedNote, refresh: true });
    const { db } = makeDbWithSoap(storedRow);
    const res = await POST(db, { claimedCondition: 'Obstructive sleep apnea' });
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(true); // the FE poll gate — this was the hardcoded-false bug
    expect(res.body.data).toMatchObject({ assessment: 'a', plan: 'p' }); // the note is STILL served this open
    expect(res.body.cached).toBe(true);
    expect(fireRecomputeViability).toHaveBeenCalledOnce(); // the ONE background drift-refresh
    expect(getOrBuildSoapNote).not.toHaveBeenCalled(); // still $0 — no sync generate
  });

  it('CURRENT stored note (refresh:false) → stale:false (nothing owed, poll stays disarmed)', async () => {
    stateReady(plan());
    decideServeStored.mockReturnValue({ note: storedNote, refresh: false });
    const { db } = makeDbWithSoap({ ...storedRow, inputHash: 'fp' });
    const res = await POST(db, { claimedCondition: 'Obstructive sleep apnea' });
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(false);
    expect(fireRecomputeViability).not.toHaveBeenCalled();
  });

  it('DRAFTING FREEZE: a drifted note on a status=drafting case reports stale:false AND fires no recompute (never stale during drafting)', async () => {
    stateReady(plan());
    decideServeStored.mockReturnValue({ note: storedNote, refresh: true });
    const { db } = makeDbWithSoap(storedRow, { id: 'CASE-1', status: 'drafting' });
    const res = await POST(db, { claimedCondition: 'Obstructive sleep apnea' });
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(false); // drafter-mutated row drift is artificial — no poll spin-up
    expect(res.body.data).toMatchObject({ assessment: 'a' });
    expect(fireRecomputeViability).not.toHaveBeenCalled(); // the recompute-storm freeze holds
  });
});

// ── The reliability state plumbing (Ryan 2026-06-21, Zimmelman): the GET surfaces the discriminated state +
// fires the off-request recompute ONLY when cold ('none') — never on 'error' (the infinite-loop fix) — and a
// NEW synchronous compute endpoint owns its own window so the FIRST view grounds after a spinner. ──
describe('GET /viability-card + POST /viability-card/compute — reliability state (Zimmelman)', () => {
  beforeEach(() => {
    mockUser = { sub: 'U1', roles: ['ops_staff'] };
    getAiViabilityState.mockReset();
    aiRoutePickerEnabled.mockReset(); aiRoutePickerEnabled.mockReturnValue(true);
    fireRecomputeViability.mockReset(); fireRecomputeViability.mockResolvedValue(true);
    caseViabilityEnabled.mockReset(); caseViabilityEnabled.mockReturnValue(true);
  });

  it('GET cold (none) → aiViabilityState:none + fires the off-request recompute once', async () => {
    getAiViabilityState.mockResolvedValue({ status: 'none' });
    const res = await GET(makeDb().db);
    expect(res.status).toBe(200);
    expect(res.body.aiViabilityState.status).toBe('none');
    expect(res.body.aiViability).toBeNull();
    expect(fireRecomputeViability).toHaveBeenCalledOnce();
  });

  it('REGRESSION: GET on a FAILED plan (error) → aiViabilityState:error AND does NOT re-fire the recompute (the infinite-loop fix)', async () => {
    getAiViabilityState.mockResolvedValue({ status: 'error', error: 'The analysis timed out (the chart is large). Please retry.' });
    const res = await GET(makeDb().db);
    expect(res.status).toBe(200);
    expect(res.body.aiViabilityState.status).toBe('error');
    expect(res.body.aiViabilityState.error).toMatch(/timed out|retry/i);
    expect(fireRecomputeViability).not.toHaveBeenCalled(); // must NOT loop the same failing compute
  });

  it('GET computing → aiViabilityState:computing AND does NOT fire a second compute (one in flight)', async () => {
    getAiViabilityState.mockResolvedValue({ status: 'computing' });
    const res = await GET(makeDb().db);
    expect(res.body.aiViabilityState.status).toBe('computing');
    expect(fireRecomputeViability).not.toHaveBeenCalled();
  });

  it('GET ready → aiViabilityState:ready carries the plan card + the legacy aiViability field', async () => {
    getAiViabilityState.mockResolvedValue({ status: 'ready', card: plan() });
    const res = await GET(makeDb().db);
    expect(res.body.aiViabilityState.status).toBe('ready');
    expect(res.body.aiViabilityState.card.lead.framing).toBe(LEAD.framing);
    expect(res.body.aiViability).not.toBeNull();
    expect(fireRecomputeViability).not.toHaveBeenCalled();
  });

  it('POST /compute FIRES the long async recompute (off-request, 120s budget) and returns computing — NO inline LLM call (Zimmelman long-budget fix 2026-06-22)', async () => {
    // The endpoint no longer runs the picker INLINE (the 26s API-Gateway cap was the Zimmelman timeout). It
    // fires the off-request async recompute and returns 'computing'; the FE polls the GET for the result.
    const res = await COMPUTE(makeDb().db);
    expect(res.status).toBe(200);
    expect(res.body.aiViabilityState.status).toBe('computing');
    // it triggered the async path...
    expect(fireRecomputeViability).toHaveBeenCalledOnce();
    // ...and did NOT run an inline compute (getAiViabilityState compute:true) on the request path.
    expect(getAiViabilityState).not.toHaveBeenCalled();
  });

  it('POST /compute when the route-picker is OFF → returns off, fires no recompute', async () => {
    aiRoutePickerEnabled.mockReturnValue(false);
    const res = await COMPUTE(makeDb().db);
    expect(res.status).toBe(200);
    expect(res.body.aiViabilityState.status).toBe('off');
    expect(fireRecomputeViability).not.toHaveBeenCalled();
    expect(getAiViabilityState).not.toHaveBeenCalled();
  });

  it('POST /compute surfaces an honest error if the async dispatch FAILS — never a silent eternal spinner (no-dead-end, QA 2026-06-22)', async () => {
    fireRecomputeViability.mockResolvedValue(false); // dispatch failed open (IAM/throttle/missing fn name)
    const res = await COMPUTE(makeDb().db);
    expect(res.status).toBe(200);
    // The compute will NEVER run (no async invoke landed), so returning 'computing' would spin forever with no
    // work + no error. Surface 'error' + Retry instead. The async path stamps its OWN 'error' on a genuine
    // compute failure; this covers the dispatch-never-fired case.
    expect(res.body.aiViabilityState.status).toBe('error');
    expect(res.body.aiViabilityState.error).toMatch(/could not start the analysis/i);
    expect(fireRecomputeViability).toHaveBeenCalledOnce();
  });
});
