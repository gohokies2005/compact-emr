import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createStrategyPreviewRouter } from '../routes/strategy-preview.js';
import type { AppDb, Role } from '../services/db-types.js';

// Locks architect QA FIX-1: the route must filter scConditions to status='service_connected' before
// treating them as anchors — a PENDING/denied claim is not a valid anchor. This filter lives in the route
// (cdsEngine's anchor check is status-blind), so it needs a route-level test or it regresses silently.

interface MockUser { sub: string; roles: Role[] }
let mockUser: MockUser | undefined;

function makeDb(caseRow: unknown) {
  return { case: { findFirst: async () => caseRow } } as unknown as AppDb;
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createStrategyPreviewRouter(db));
  app.use((err: { status?: number; code?: string; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
  });
  return app;
}

function caseRow(scStatus: string) {
  return {
    claimType: 'secondary', claimedCondition: 'OSA', framingChoice: 'causation', upstreamScCondition: 'PTSD',
    inServiceEvent: null, veteranStatement: null,
    veteran: { scConditions: [{ condition: 'PTSD', status: scStatus }], activeProblems: [{ problem: 'OSA' }] },
  };
}

describe('strategy-preview route — anchor status filter (architect FIX-1)', () => {
  beforeEach(() => { mockUser = { sub: 'OPS', roles: ['ops_staff'] }; });

  it('a PENDING anchor is NOT a valid service-connected anchor -> Stop', async () => {
    const res = await request(appFor(makeDb(caseRow('pending')))).get('/api/v1/cases/CASE-1/strategy-preview');
    expect(res.status).toBe(200);
    expect(res.body.data.tier).toBe('Stop');
  });

  it('a GRANTED (service_connected) anchor -> Strong', async () => {
    const res = await request(appFor(makeDb(caseRow('service_connected')))).get('/api/v1/cases/CASE-1/strategy-preview');
    expect(res.status).toBe(200);
    expect(res.body.data.tier).toBe('Strong');
  });

  it('404 when the case is missing', async () => {
    const res = await request(appFor(makeDb(null))).get('/api/v1/cases/NOPE/strategy-preview');
    expect(res.status).toBe(404);
  });
});

describe('strategy-preview route — viability re-source (P1, 2026-06-11)', () => {
  beforeEach(() => { mockUser = { sub: 'OPS', roles: ['ops_staff'] }; });

  it('carries a viability block EVEN with EMR_CASE_VIABILITY_ENABLED unset (deriveCaseViabilityForCase is flag-free)', async () => {
    delete process.env['EMR_CASE_VIABILITY_ENABLED'];
    const res = await request(appFor(makeDb(caseRow('service_connected')))).get('/api/v1/cases/CASE-1/strategy-preview');
    expect(res.status).toBe(200);
    // OSA claimed + PTSD granted → the vendored resolver bands it strong; the full block rides the response.
    expect(res.body.data.viability).toBeTruthy();
    expect(res.body.data.viability.viability).toBe('strong');
    expect(typeof res.body.data.viability.why).toBe('string');
    // …and the strength criterion text is the engine's why (band wording), not a Board grant string.
    const strength = (res.body.data.criteria as Array<{ key: string; detail: string }>).find((c) => c.key === 'strength')!;
    expect(strength.detail).toBe(res.body.data.viability.why);
  });

  it('NO-BVA-STRING LOCK at the wire: the full response carries no n= / decided Board appeals / % / tier-word', async () => {
    const res = await request(appFor(makeDb(caseRow('service_connected')))).get('/api/v1/cases/CASE-1/strategy-preview');
    const wire = JSON.stringify(res.body);
    expect(wire).not.toMatch(/\bn=\d/);
    expect(wire).not.toMatch(/decided Board appeals/i);
    expect(wire).not.toMatch(/\d+(\.\d+)?%/);
    expect(wire).not.toMatch(/tier (high|moderate|low)/i);
  });

  it('Porter-shaped fixture: DIRECT claim + veteranStatement only → tier Thin (never Plausible) + amber event criterion', async () => {
    const porterRow = {
      claimType: 'direct', claimedCondition: 'Lumbar strain', framingChoice: null, upstreamScCondition: null,
      inServiceEvent: null, veteranStatement: 'My back has hurt since basic training in 2004',
      veteran: { scConditions: [], activeProblems: [{ problem: 'Lumbar strain' }] },
    };
    const res = await request(appFor(makeDb(porterRow))).get('/api/v1/cases/CASE-P/strategy-preview');
    expect(res.status).toBe(200);
    expect(res.body.data.tier).toBe('Thin');
    const ev = (res.body.data.criteria as Array<{ key: string; pass: boolean; tone?: string; detail: string }>).find((c) => c.key === 'anchor')!;
    expect(ev.pass).toBe(false);
    expect(ev.tone).toBe('amber');
    expect(ev.detail).toMatch(/not yet corroborated/i);
    // The statement still displays as the veteran's theory.
    expect(res.body.data.proposedMechanism).toBe('My back has hurt since basic training in 2004');
  });
});
