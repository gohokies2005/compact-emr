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
vi.mock('../services/soap-overview.js', () => ({ getOrBuildSoapNote }));
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

  it('POST /compute runs the SYNCHRONOUS compute (compute:true) and returns the resulting state', async () => {
    getAiViabilityState.mockResolvedValue({ status: 'ready', card: plan() });
    const res = await COMPUTE(makeDb().db);
    expect(res.status).toBe(200);
    expect(res.body.aiViabilityState.status).toBe('ready');
    // it asked for a real compute (not a read-only pass)
    const opts = getAiViabilityState.mock.calls[0]![2] as { compute?: boolean };
    expect(opts.compute).toBe(true);
  });

  it('POST /compute surfaces an honest error (NOT a fake verdict) when the compute fails', async () => {
    getAiViabilityState.mockResolvedValue({ status: 'error', error: 'The analysis service is busy. Please retry in a moment.' });
    const res = await COMPUTE(makeDb().db);
    expect(res.body.aiViabilityState.status).toBe('error');
    expect(res.body.aiViabilityState.error).toMatch(/busy|retry/i);
  });
});
