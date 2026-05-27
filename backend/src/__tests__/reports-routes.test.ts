import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReportsRouter } from '../routes/reports.js';
import type { AppDb, Role } from '../services/db-types.js';

interface MockUser { readonly sub: string; readonly email?: string; readonly roles: Role[]; }
let mockUser: MockUser | undefined;

vi.mock('../auth/roles', () => ({
  requireRole:
    (allowed: readonly string[]) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const user = (req as express.Request & { user?: MockUser }).user;
      if (user === undefined) { res.status(401).json({ error: { code: 'unauthorized', message: 'Authentication required' } }); return; }
      if (!user.roles.some((r) => allowed.includes(r))) { res.status(403).json({ error: { code: 'forbidden', message: 'Forbidden' } }); return; }
      next();
    },
}));

interface CaseRow {
  id: string;
  claimedCondition: string;
  status: string;
  veteran: { firstName: string; lastName: string } | null;
  draftJobs: Array<{ costUsd: unknown }>;
}

function makeDb(cases: CaseRow[]) {
  const caseFindMany = vi.fn(async () => cases);
  const db = {
    case: { findMany: caseFindMany },
  } as unknown as AppDb;
  return { db, caseFindMany };
}

function buildApp(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request & { user?: MockUser }, _res, next) => { req.user = mockUser; next(); });
  app.use('/api/v1', createReportsRouter(db));
  return app;
}

const SAMPLE: CaseRow[] = [
  {
    id: 'CASE-1',
    claimedCondition: 'Obstructive Sleep Apnea',
    status: 'physician_review',
    veteran: { firstName: 'John', lastName: 'Doe' },
    draftJobs: [{ costUsd: 3.42 }, { costUsd: '1.58' }],
  },
  {
    id: 'CASE-2',
    claimedCondition: 'Tinnitus, secondary',
    status: 'drafting',
    veteran: { firstName: 'Jane', lastName: 'Smith' },
    draftJobs: [{ costUsd: null }],
  },
];

beforeEach(() => {
  mockUser = { sub: 'admin-sub', roles: ['admin'] };
});

describe('GET /api/v1/reports/costs', () => {
  it('returns per-case rows with summed cost and a grand total', async () => {
    const { db } = makeDb(SAMPLE);
    const res = await request(buildApp(db)).get('/api/v1/reports/costs');
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    const c1 = res.body.rows.find((r: { caseId: string }) => r.caseId === 'CASE-1');
    expect(c1).toMatchObject({
      veteranName: 'John Doe',
      claimedCondition: 'Obstructive Sleep Apnea',
      status: 'physician_review',
      draftCount: 2,
      costUsd: 5.0,
    });
    const c2 = res.body.rows.find((r: { caseId: string }) => r.caseId === 'CASE-2');
    expect(c2).toMatchObject({ draftCount: 1, costUsd: 0 });
    expect(res.body.totalCostUsd).toBe(5.0);
    expect(typeof res.body.from).toBe('string');
    expect(typeof res.body.to).toBe('string');
  });

  it('rejects non-admin roles', async () => {
    mockUser = { sub: 'ops-sub', roles: ['ops_staff'] };
    const { db } = makeDb(SAMPLE);
    const res = await request(buildApp(db)).get('/api/v1/reports/costs');
    expect(res.status).toBe(403);
  });

  it('400s on a malformed date param', async () => {
    const { db } = makeDb(SAMPLE);
    const res = await request(buildApp(db)).get('/api/v1/reports/costs?from=2026-13-99');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/reports/costs.csv', () => {
  it('returns a CSV attachment with header, rows and a TOTAL line', async () => {
    const { db } = makeDb(SAMPLE);
    const res = await request(buildApp(db)).get('/api/v1/reports/costs.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('drafting-costs.csv');
    const text = res.text;
    expect(text).toContain('Case ID,Veteran,Condition,Status,Draft Runs,Cost USD');
    expect(text).toContain('CASE-1');
    // Condition contains a comma -> must be quoted.
    expect(text).toContain('"Tinnitus, secondary"');
    expect(text).toMatch(/TOTAL,,,,,5\.00/);
  });
});
