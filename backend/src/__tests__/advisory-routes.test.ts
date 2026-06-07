import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAdvisoryRouter, type AdvisoryRouterDeps } from '../routes/advisory.js';
import type { AppDb, Role } from '../services/db-types.js';

interface MockUser { sub: string; roles: Role[] }
let mockUser: MockUser | undefined;

const SLICE = { found: true, text: 'Claim: OSA', claimedCondition: 'OSA', conditions: ['OSA', 'PTSD'] };

function makeDb() {
  const created: Array<Record<string, unknown>> = [];
  const db = {
    advisoryQuery: {
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: 'q1', ...args.data };
      },
    },
  } as unknown as AppDb;
  return { db, created };
}

function appFor(db: AppDb, overrides: AdvisoryRouterDeps) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser;
    next();
  });
  app.use('/api/v1', createAdvisoryRouter(db, overrides));
  app.use((err: { status?: number; code?: string; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
  });
  return app;
}

const ok: AdvisoryRouterDeps = {
  buildChartSlice: async () => SLICE,
  invoke: async () => ({ text: 'GROUNDED ANSWER', costUsd: 0.03, stopReason: 'end_turn', usage: {} }),
  systemPrompt: 'SYS',
};

describe('advisory ask endpoint', () => {
  beforeEach(() => {
    mockUser = { sub: 'OPS', roles: ['ops_staff'] };
  });

  it('answers a question + logs it (status ok)', async () => {
    const { db, created } = makeDb();
    const res = await request(appFor(db, ok))
      .post('/api/v1/cases/CLM-1/advisory/ask')
      .send({ question: 'Is OSA secondary to PTSD viable?' });
    expect(res.status).toBe(200);
    expect(res.body.data.answer).toBe('GROUNDED ANSWER');
    expect(res.body.data.citations).toHaveLength(2);
    expect(created).toHaveLength(1);
    expect(created[0].status).toBe('ok');
    expect(created[0].view).toBe('rn_chart');
  });

  it('404 + logs refused when the case is not found', async () => {
    const { db, created } = makeDb();
    const res = await request(appFor(db, { ...ok, buildChartSlice: async () => null }))
      .post('/api/v1/cases/NOPE/advisory/ask')
      .send({ question: 'hi' });
    expect(res.status).toBe(404);
    expect(created[0].status).toBe('refused');
  });

  it('400 on an empty question', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db, ok)).post('/api/v1/cases/CLM-1/advisory/ask').send({ question: '   ' });
    expect(res.status).toBe(400);
  });

  it('physician view is logged as physician_chart', async () => {
    mockUser = { sub: 'DR', roles: ['physician'] };
    const { db, created } = makeDb();
    await request(appFor(db, ok)).post('/api/v1/cases/CLM-1/advisory/ask').send({ question: 'q' });
    expect(created[0].view).toBe('physician_chart');
  });

  it('403 for a role without access', async () => {
    mockUser = { sub: 'X', roles: ['intake_only' as Role] };
    const { db } = makeDb();
    const res = await request(appFor(db, ok)).post('/api/v1/cases/CLM-1/advisory/ask').send({ question: 'hi' });
    expect(res.status).toBe(403);
  });
});
