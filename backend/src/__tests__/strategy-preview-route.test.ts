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
