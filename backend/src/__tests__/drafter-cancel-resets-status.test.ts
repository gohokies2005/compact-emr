import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrafterClientRouter } from '../routes/drafter.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb, Role } from '../services/db-types.js';

/**
 * Bug 1 (2026-06-29): POST /cases/:id/draft-jobs/:jobId/cancel flipped the DraftJob terminal but NEVER
 * reset Case.status, so a cancelled case read "Drafting" in the Cases list forever with no in-flight
 * job. The cancel must ALSO take the case OFF 'drafting' (→ needs_rn_decision / operatorState 'paused'),
 * mirroring the stuck-job-watcher's terminal-case write, while leaving redraft (POST /draft) available
 * because the newest DraftJob is now terminal (the in-flight gate keys on newest-job state).
 */

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

interface JobRow { id: string; caseId: string; state: string; failureClass: string | null; completedAt: Date | null; errorMessage: string | null }
interface CaseRow { id: string; status: string; operatorState: string | null; operatorMessage: string | null; runComplete: boolean | null; version: number }

function makeDb(job: JobRow, c: CaseRow) {
  const jobUpdate = vi.fn(async (a: { where: { id: string }; data: Partial<JobRow> }) => { Object.assign(job, a.data); return { ...job }; });
  const caseUpdate = vi.fn(async (a: { where: { id: string }; data: Record<string, unknown> }) => {
    const d = a.data;
    if (typeof d['version'] === 'object' && d['version'] !== null) c.version += (d['version'] as { increment: number }).increment;
    for (const k of ['status', 'operatorState', 'operatorMessage', 'runComplete'] as const) {
      if (d[k] !== undefined) (c as unknown as Record<string, unknown>)[k] = d[k] as never;
    }
    return c;
  });
  const logCreate = vi.fn(async () => ({}));
  const tx = {
    draftJob: { update: jobUpdate },
    case: { update: caseUpdate },
    activityLog: { create: logCreate },
  };
  const db = {
    draftJob: { findUnique: vi.fn(async (a: { where: { id: string } }) => (a.where.id === job.id ? job : null)) },
    $transaction: vi.fn(async (fn: (inner: typeof tx) => unknown) => fn(tx)),
  } as unknown as AppDb;
  return { db, job, c, spies: { jobUpdate, caseUpdate, logCreate } };
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createDrafterClientRouter(db));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
    return sendError(res, 500, 'internal_error', 'Unexpected server error.');
  });
  return app;
}

const jobRow = (o: Partial<JobRow> = {}): JobRow => ({ id: 'JOB-1', caseId: 'CASE-1', state: 'running', failureClass: null, completedAt: null, errorMessage: null, ...o });
const caseRow = (o: Partial<CaseRow> = {}): CaseRow => ({ id: 'CASE-1', status: 'drafting', operatorState: null, operatorMessage: null, runComplete: true, version: 7, ...o });

describe('POST /cases/:id/draft-jobs/:jobId/cancel — Bug 1 (takes the case off drafting)', () => {
  beforeEach(() => { mockUser = { sub: 'OPS-SUB', roles: ['ops_staff'] }; });

  it('flips the job terminal AND moves the case off drafting → needs_rn_decision/paused', async () => {
    const { db, job, c } = makeDb(jobRow(), caseRow({ status: 'drafting', version: 7 }));
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/draft-jobs/JOB-1/cancel').send({}).expect(200);

    expect(res.body.cancelled).toBe(true);
    // Job terminal
    expect(job.state).toBe('failed');
    // Case OFF 'drafting' — the list-symptom fix
    expect(c.status).not.toBe('drafting');
    expect(c.status).toBe('needs_rn_decision');
    expect(c.operatorState).toBe('paused');
    expect(c.runComplete).toBe(false);
    expect(typeof c.operatorMessage).toBe('string');
    expect(c.version).toBe(8); // bumped so the poll UI refetches
  });

  it('is idempotent on an already-terminal job — does NOT re-touch the case', async () => {
    const { db, c, spies } = makeDb(jobRow({ state: 'failed' }), caseRow({ status: 'rn_review' }));
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/draft-jobs/JOB-1/cancel').send({}).expect(200);
    expect(res.body.alreadyTerminal).toBe(true);
    expect(spies.caseUpdate).not.toHaveBeenCalled();
    expect(c.status).toBe('rn_review'); // untouched
  });

  it('404s when the job does not exist (no case mutation)', async () => {
    const { db, spies } = makeDb(jobRow(), caseRow());
    await request(appFor(db)).post('/api/v1/cases/CASE-1/draft-jobs/NOPE/cancel').send({}).expect(404);
    expect(spies.caseUpdate).not.toHaveBeenCalled();
  });
});
