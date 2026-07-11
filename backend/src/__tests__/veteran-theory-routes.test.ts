import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AppDb, Role } from '../services/db-types.js';

// Mock the LLM module so the route test exercises WIRING only (flag gate, 404, passthrough, fail-open) —
// the model logic itself is covered by advisory/__tests__/veteran-theory-ai.test.ts.
const enabled = vi.fn();
const run = vi.fn();
vi.mock('../advisory/veteran-theory-ai.js', () => ({
  veteranTheoryAiEnabled: () => enabled(),
  runVeteranTheoryAi: (...a: unknown[]) => run(...a),
}));

const { createVeteranTheoryRouter } = await import('../routes/veteran-theory.js');

interface MockUser {
  sub: string;
  roles: Role[];
}
let mockUser: MockUser | undefined;

function makeDb(caseRow: Record<string, unknown> | null): AppDb {
  return {
    case: {
      findFirst: async () => caseRow,
    },
  } as unknown as AppDb;
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser;
    next();
  });
  app.use('/api/v1', createVeteranTheoryRouter(db));
  app.use((err: { status?: number; code?: string; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
  });
  return app;
}

describe('GET /cases/:id/veteran-theory', () => {
  beforeEach(() => {
    mockUser = { sub: 'DOC', roles: ['physician'] };
    enabled.mockReset();
    run.mockReset();
  });

  it('flag OFF → { data: null }, no case read, no model call', async () => {
    enabled.mockReturnValue(false);
    const res = await request(appFor(makeDb({ id: 'C1' }))).get('/api/v1/cases/C1/veteran-theory');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: null });
    expect(run).not.toHaveBeenCalled();
  });

  it('unknown case (flag on) → 404', async () => {
    enabled.mockReturnValue(true);
    const res = await request(appFor(makeDb(null))).get('/api/v1/cases/NOPE/veteran-theory');
    expect(res.status).toBe(404);
  });

  it('flag on + known case → passes the theory through as { data } and forwards claim+statement', async () => {
    enabled.mockReturnValue(true);
    run.mockResolvedValue({ theory: 'Veteran attributes depression to back pain.', framing: 'secondary', upstream: 'back pain', costUsd: 0.002 });
    const db = makeDb({ id: 'C1', claimedCondition: 'MDD', veteranStatement: 'my back and depression' });
    const res = await request(appFor(db)).get('/api/v1/cases/C1/veteran-theory');
    expect(res.status).toBe(200);
    expect(res.body.data.upstream).toBe('back pain');
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ caseId: 'C1', claimedCondition: 'MDD', veteranStatement: 'my back and depression' }));
  });

  it('model returns null → { data: null } (deterministic fallback client-side)', async () => {
    enabled.mockReturnValue(true);
    run.mockResolvedValue(null);
    const res = await request(appFor(makeDb({ id: 'C1', claimedCondition: 'MDD', veteranStatement: 'x' }))).get('/api/v1/cases/C1/veteran-theory');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: null });
  });

  it('model throws → { data: null } (route guard: a display value never 500s the panel)', async () => {
    enabled.mockReturnValue(true);
    run.mockImplementation(async () => {
      throw new Error('boom');
    });
    const res = await request(appFor(makeDb({ id: 'C1', claimedCondition: 'MDD', veteranStatement: 'x' }))).get('/api/v1/cases/C1/veteran-theory');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: null });
  });
});
