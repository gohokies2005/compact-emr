// halt-explanation route tests (Dr. Kasky 2026-07-02). Mounts createHaltExplanationRouter on a bare express app
// with a fake db and mocked auth/framing/explainer, and asserts the paused-vs-not-paused gating + the role gate.
//   • paused (case status / operatorState / halted job) → explainHalt is called and its result is returned.
//   • NOT paused → { available:false } and explainHalt is NEVER called (no LLM spend).
//   • role gate: 401 without a user, 403 without an allowed role; 404 for a missing case.

import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb } from '../services/db-types.js';

interface MockUser { readonly sub: string; readonly roles: string[]; }
let mockUser: MockUser | undefined;

vi.mock('../auth/roles', () => ({
  requireRole:
    (allowed: readonly string[]) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const user = (req as unknown as { user?: MockUser }).user;
      if (user === undefined) { res.status(401).json({ error: { code: 'unauthorized', message: 'Authentication required' } }); return; }
      if (!user.roles.some((r) => allowed.includes(r))) { res.status(403).json({ error: { code: 'forbidden', message: 'Forbidden' } }); return; }
      next();
    },
}));

interface FramingShape {
  framing: string;
  upstreamScCondition: string | null;
  grantedScAnchors: Array<{ condition: string; ratingPct: number | null; status: string }>;
}
const deriveFramingMock = vi.fn(
  async (): Promise<FramingShape> => ({
    framing: 'direct',
    upstreamScCondition: 'PTSD',
    grantedScAnchors: [{ condition: 'PTSD', ratingPct: 70, status: 'service_connected' }],
  }),
);
vi.mock('../services/case-framing-stamp.js', () => ({ deriveCaseFramingForCase: (...a: unknown[]) => deriveFramingMock(...(a as [])) }));

const explainHaltMock = vi.fn();
vi.mock('../services/halt-explainer.js', () => ({ explainHalt: (...a: unknown[]) => explainHaltMock(...(a as [])) }));

const { createHaltExplanationRouter } = await import('../routes/halt-explanation.js');

interface CaseSeed {
  id?: string;
  veteranId?: string;
  status?: string;
  operatorState?: string | null;
  operatorMessage?: string | null;
  claimedCondition?: string;
}
function baseCase(over: CaseSeed = {}) {
  return {
    id: 'CASE-1', veteranId: 'VET-1', status: 'needs_rn_decision', operatorState: 'paused',
    operatorMessage: null, claimedCondition: 'Obstructive sleep apnea', ...over,
  };
}

function makeDb(opts: { caseRow?: unknown; job?: unknown } = {}) {
  const caseRow = opts.caseRow === undefined ? baseCase() : opts.caseRow;
  const job = opts.job ?? null;
  const db = {
    case: { findFirst: vi.fn(async () => caseRow) },
    draftJob: { findFirst: vi.fn(async () => job) },
    activeProblem: { findMany: vi.fn(async () => [{ problem: 'Obstructive sleep apnea' }, { problem: 'PTSD' }]) },
  } as unknown as AppDb;
  return db;
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as unknown as { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createHaltExplanationRouter(db));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
    return sendError(res, 500, 'internal_error', 'Unexpected server error.');
  });
  return app;
}

const EXPLANATION = { summary: 'Paused because the cause named is service-connected — this is really a secondary claim.', what_to_do: 'Set the framing to Secondary and point it at PTSD.', confidence: 'high' as const };

beforeEach(() => {
  mockUser = { sub: 'OPS', roles: ['ops_staff'] };
  deriveFramingMock.mockClear();
  explainHaltMock.mockReset();
  explainHaltMock.mockResolvedValue(EXPLANATION);
});

describe('GET /cases/:id/halt-explanation', () => {
  it('returns the plain-language explanation when the case is paused (status needs_rn_decision)', async () => {
    const db = makeDb({ caseRow: baseCase({ status: 'needs_rn_decision', operatorState: null }) });
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/halt-explanation');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(EXPLANATION);
    expect(explainHaltMock).toHaveBeenCalledTimes(1);
    // The explainer was handed the framing + claim it needs.
    const arg = explainHaltMock.mock.calls[0][0];
    expect(arg.claimedCondition).toBe('Obstructive sleep apnea');
    expect(arg.framing.theory).toBe('direct');
    expect(arg.framing.upstream).toBe('PTSD');
    expect(arg.framing.cfr).toBe('38 CFR 3.303');
    expect(arg.grantedScConditions).toEqual([{ name: 'PTSD', ratingPct: 70 }]);
  });

  it('treats a HALTED latest draft job as paused even when case status is not a hold', async () => {
    const db = makeDb({
      caseRow: baseCase({ status: 'drafting', operatorState: null }),
      job: { state: 'halted', currentPhase: 'plan_validity', errorMessage: null, haltPayloadJson: { reasonCode: 'verify_error', plainEnglish: 'plan validity failed' } },
    });
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/halt-explanation');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(EXPLANATION);
    // The halt payload's plain-English reason is the rawReason fed to the explainer.
    expect(explainHaltMock.mock.calls[0][0].rawReason).toBe('plan validity failed');
    expect(explainHaltMock.mock.calls[0][0].phase).toBe('verify_error');
  });

  it('returns { available:false } and NEVER calls the LLM when the case is not paused', async () => {
    const db = makeDb({ caseRow: baseCase({ status: 'drafting', operatorState: null }), job: { state: 'running', currentPhase: 'draft', errorMessage: null, haltPayloadJson: null } });
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/halt-explanation');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ available: false });
    expect(explainHaltMock).not.toHaveBeenCalled();
  });

  it('returns { available:false } when the explainer fails open (null)', async () => {
    explainHaltMock.mockResolvedValue(null);
    // A distinct case id → a distinct cache key, so this fresh-compute path is not served the cached
    // success from an earlier test (the route's module-level cache keys on caseId + reason/framing hash).
    const db = makeDb({ caseRow: baseCase({ id: 'CASE-FAILOPEN' }) });
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-FAILOPEN/halt-explanation');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ available: false });
    expect(explainHaltMock).toHaveBeenCalledTimes(1);
  });

  describe('already_granted_match (deterministic, computed in the route)', () => {
    it('null when the claimed condition is NOT on the granted SC list', async () => {
      // default: claimed 'Obstructive sleep apnea', SC list ['PTSD'] → no match.
      const db = makeDb({ caseRow: baseCase({ id: 'CASE-NULLMATCH', status: 'needs_rn_decision', operatorState: null }) });
      await request(appFor(db)).get('/api/v1/cases/CASE-NULLMATCH/halt-explanation').expect(200);
      expect(explainHaltMock.mock.calls[0][0].alreadyGrantedMatch).toBeNull();
    });

    it('names the matching SC condition when the claimed condition is already granted', async () => {
      const db = makeDb({ caseRow: baseCase({ id: 'CASE-MATCH', claimedCondition: 'PTSD', status: 'needs_rn_decision', operatorState: null }) });
      await request(appFor(db)).get('/api/v1/cases/CASE-MATCH/halt-explanation').expect(200);
      expect(explainHaltMock.mock.calls[0][0].alreadyGrantedMatch).toBe('PTSD');
    });

    it('matches case-insensitively and ignores a parenthetical rating on the SC name', async () => {
      deriveFramingMock.mockResolvedValueOnce({
        framing: 'undetermined', upstreamScCondition: null,
        grantedScAnchors: [{ condition: 'Post-Traumatic Stress Disorder (70%)', ratingPct: 70, status: 'service_connected' }],
      });
      const db = makeDb({ caseRow: baseCase({ id: 'CASE-NORM', claimedCondition: 'post-traumatic stress disorder', status: 'needs_rn_decision', operatorState: null }) });
      await request(appFor(db)).get('/api/v1/cases/CASE-NORM/halt-explanation').expect(200);
      expect(explainHaltMock.mock.calls[0][0].alreadyGrantedMatch).toBe('Post-Traumatic Stress Disorder (70%)');
    });

    it('does NOT falsely match a substring (claimed "sleep apnea" vs SC "sleep apnea secondary to X")', async () => {
      deriveFramingMock.mockResolvedValueOnce({
        framing: 'secondary', upstreamScCondition: null,
        grantedScAnchors: [{ condition: 'Sleep apnea secondary to sinusitis', ratingPct: 50, status: 'service_connected' }],
      });
      const db = makeDb({ caseRow: baseCase({ id: 'CASE-SUBSTR', claimedCondition: 'Sleep apnea', status: 'needs_rn_decision', operatorState: null }) });
      await request(appFor(db)).get('/api/v1/cases/CASE-SUBSTR/halt-explanation').expect(200);
      expect(explainHaltMock.mock.calls[0][0].alreadyGrantedMatch).toBeNull();
    });
  });

  it('404 for a missing case', async () => {
    const db = makeDb({ caseRow: null });
    const res = await request(appFor(db)).get('/api/v1/cases/NOPE/halt-explanation');
    expect(res.status).toBe(404);
  });

  it('401 without a user', async () => {
    mockUser = undefined;
    const res = await request(appFor(makeDb())).get('/api/v1/cases/CASE-1/halt-explanation');
    expect(res.status).toBe(401);
  });

  it('403 for a role that is not admin/ops_staff/physician', async () => {
    mockUser = { sub: 'X', roles: ['veteran'] };
    const res = await request(appFor(makeDb())).get('/api/v1/cases/CASE-1/halt-explanation');
    expect(res.status).toBe(403);
  });
});
