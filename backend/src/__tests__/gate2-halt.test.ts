import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createDrafterWorkerRouter } from '../routes/drafter.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb } from '../services/db-types.js';

/**
 * Gate-2 pre-draft dx/event verification HALT — POST /api/v1/internal/drafter/jobs/:id/halt.
 *
 * The single most important invariant (architect): the halt sets DraftJob.state='halted' so the
 * stuck-job watcher (which scans `state IN ('queued','running')`) can NEVER resurrect the parked
 * case. We assert the resulting state falls outside that set, plus the parking + idempotency.
 */

interface JobRow { id: string; caseId: string; version: number; state: string; manifestSnapshot: unknown; errorMessage: string | null; failureClass: string | null; completedAt: Date | null; lastHeartbeatAt: Date | null; haltPayloadJson: unknown }
interface CaseR { id: string; version: number; status: string; operatorState: string | null; operatorMessage: string | null; runComplete: boolean | null }

function makeDb(job: JobRow, c: CaseR) {
  const draftDecisionCreate = vi.fn(async (_a: { data: Record<string, unknown> }) => ({}));
  const caseUpdate = vi.fn(async (a: { where: { id: string }; data: Record<string, unknown> }) => {
    const d = a.data;
    if (typeof d['version'] === 'object' && d['version'] !== null) c.version += (d['version'] as { increment: number }).increment;
    for (const k of ['status', 'operatorState', 'operatorMessage', 'runComplete'] as const) if (d[k] !== undefined) (c as unknown as Record<string, unknown>)[k] = d[k];
    return c;
  });
  const jobUpdate = vi.fn(async (a: { where: { id: string }; data: Partial<JobRow> }) => { Object.assign(job, a.data); return job; });
  const tx = {
    draftJob: { findUnique: vi.fn(async (a: { where: { id: string } }) => (a.where.id === job.id ? job : null)), update: jobUpdate },
    case: { update: caseUpdate },
    draftDecision: { create: draftDecisionCreate },
    activityLog: { create: vi.fn(async () => ({})) },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn: (inner: typeof tx) => unknown) => fn(tx)) } as unknown as AppDb;
  return { db, job, c, spies: { draftDecisionCreate, caseUpdate, jobUpdate } };
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createDrafterWorkerRouter(db));
  app.use((e: unknown, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
    if (isHttpError(e)) return sendError(res, e.status, e.code, e.message, e.details);
    return sendError(res, 500, 'internal_error', 'err');
  });
  return app;
}
const jobRow = (o: Partial<JobRow> = {}): JobRow => ({ id: 'JOB-1', caseId: 'CASE-1', version: 3, state: 'running', manifestSnapshot: null, errorMessage: null, failureClass: null, completedAt: null, lastHeartbeatAt: new Date('2026-06-01T00:00:00Z'), haltPayloadJson: null, ...o });
const caseR = (o: Partial<CaseR> = {}): CaseR => ({ id: 'CASE-1', version: 5, status: 'drafting', operatorState: null, operatorMessage: null, runComplete: true, ...o });
const haltBody = (o: Record<string, unknown> = {}) => ({ haltGate: 'dx_verification', reasonCode: 'dx_not_found', plainEnglish: 'No diagnosis of PTSD found in the records.', operatorState: 'needs_rn_decision', operatorMessage: 'No diagnosis of PTSD found in the records.', runComplete: false, ...o });

describe('Gate-2 halt receiver', () => {
  it('parks the case AND sets DraftJob.state=halted so the stuck-job watcher cannot resurrect it', async () => {
    const { db, job, c, spies } = makeDb(jobRow(), caseR());
    const res = await request(appFor(db)).post('/api/v1/internal/drafter/jobs/JOB-1/halt').send(haltBody()).expect(200);
    // watcher-immunity invariant: halted is OUTSIDE the watcher's state IN ('queued','running')
    expect(job.state).toBe('halted');
    expect(['queued', 'running']).not.toContain(job.state);
    expect(job.failureClass).toBe('needs_human');
    expect(job.completedAt).not.toBeNull();
    expect(c.status).toBe('needs_rn_decision');
    expect(c.operatorState).toBe('paused');
    expect(c.runComplete).toBe(false);
    expect(spies.draftDecisionCreate).toHaveBeenCalled(); // halt finding recorded in the chart log
    expect(res.body.data.case.status).toBe('needs_rn_decision');
  });

  it('routes a no-records halt to needs_records (RN gathers records)', async () => {
    const { db, c } = makeDb(jobRow(), caseR());
    await request(appFor(db)).post('/api/v1/internal/drafter/jobs/JOB-1/halt').send(haltBody({ reasonCode: 'no_records_text' })).expect(200);
    expect(c.status).toBe('needs_records');
  });

  it('is idempotent — a redelivered halt on an already-halted job is a no-op 200', async () => {
    const { db, spies } = makeDb(jobRow({ state: 'halted' }), caseR({ status: 'needs_rn_decision' }));
    const res = await request(appFor(db)).post('/api/v1/internal/drafter/jobs/JOB-1/halt').send(haltBody()).expect(200);
    expect(res.body.alreadyHalted).toBe(true);
    expect(spies.caseUpdate).not.toHaveBeenCalled(); // no second version bump / re-park
  });

  it('409s a halt on an already-completed (done) job', async () => {
    const { db } = makeDb(jobRow({ state: 'done' }), caseR());
    await request(appFor(db)).post('/api/v1/internal/drafter/jobs/JOB-1/halt').send(haltBody()).expect(409);
  });

  it('400s a halt with a bad reasonCode or missing plainEnglish', async () => {
    const { db } = makeDb(jobRow(), caseR());
    await request(appFor(db)).post('/api/v1/internal/drafter/jobs/JOB-1/halt').send(haltBody({ reasonCode: 'bogus' })).expect(400);
    const { db: db2 } = makeDb(jobRow(), caseR());
    await request(appFor(db2)).post('/api/v1/internal/drafter/jobs/JOB-1/halt').send({ reasonCode: 'dx_not_found' }).expect(400);
  });

  it('404s a halt for an unknown job', async () => {
    const { db } = makeDb(jobRow(), caseR());
    await request(appFor(db)).post('/api/v1/internal/drafter/jobs/NOPE/halt').send(haltBody()).expect(404);
  });
});
