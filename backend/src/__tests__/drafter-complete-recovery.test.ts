import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrafterWorkerRouter } from '../routes/drafter.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb } from '../services/db-types.js';
import { DRAFT_JOB_WATCHER_SWEPT_MESSAGE } from '../services/draft-job-constants.js';

/**
 * Regression coverage for the late-artifact-recovery branch on
 * POST /api/v1/internal/drafter/jobs/:id/complete.
 *
 * The stuck-job watcher flips a stale DraftJob to state='failed' at the ~10-min mark BEFORE the
 * worker's SIGTERM handler POSTs /complete with the real S3 artifact keys it just uploaded. The
 * old terminal-state guard 409-rejected that body before the artifact-key write, so the keys
 * never landed and the RN's "Open as-is" / Open PDF affordance stayed dead even though the
 * partial v<N>.{txt,pdf} existed in S3. The fix MERGES incoming keys onto an already-terminal row
 * that has NULL artifact keys, while preserving 409 for genuine duplicates (terminal + has keys).
 */

interface DraftJobRow {
  id: string;
  caseId: string;
  version: number;
  state: string;
  artifactPdfS3Key: string | null;
  artifactTxtS3Key: string | null;
  artifactDocxS3Key: string | null;
  manifestSnapshot: unknown;
  gradeSidecarJson: unknown;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  lastHeartbeatAt: Date | null;
}

interface CaseRow {
  id: string;
  version: number;
  currentVersion: number | null;
  status: string;
  operatorState: string | null;
  operatorMessage: string | null;
  runComplete: boolean | null;
}

function makeDb(job: DraftJobRow, caseRow: CaseRow) {
  const tx = {
    draftJob: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => (args.where.id === job.id ? job : null)),
      update: vi.fn(async (args: { where: { id: string }; data: Partial<DraftJobRow> }) => {
        Object.assign(job, args.data);
        return job;
      }),
    },
    case: {
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const d = args.data;
        if (typeof d['version'] === 'object' && d['version'] !== null) {
          caseRow.version += (d['version'] as { increment: number }).increment;
        }
        for (const k of ['currentVersion', 'status', 'operatorState', 'operatorMessage', 'runComplete'] as const) {
          if (d[k] !== undefined) (caseRow as unknown as Record<string, unknown>)[k] = d[k];
        }
        return caseRow;
      }),
    },
    activityLog: { create: vi.fn(async (_args: { data: { action: string; [k: string]: unknown } }) => ({})) },
    // Unified-timeline mirror (LetterRevision) written on /complete — findFirst returns null
    // so the idempotent create path runs; create is a no-op for the test.
    letterRevision: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (_args: { data: Record<string, unknown> }) => ({})),
    },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn: (inner: typeof tx) => unknown) => fn(tx)) } as unknown as AppDb;
  return { db, tx, job, caseRow };
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/v1', createDrafterWorkerRouter(db));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
    return sendError(res, 500, 'internal_error', 'Unexpected server error.');
  });
  return app;
}

function jobRow(overrides: Partial<DraftJobRow> = {}): DraftJobRow {
  return {
    id: 'JOB-1',
    caseId: 'CASE-1',
    version: 15,
    state: 'running',
    artifactPdfS3Key: null,
    artifactTxtS3Key: null,
    artifactDocxS3Key: null,
    manifestSnapshot: null,
    gradeSidecarJson: null,
    errorMessage: null,
    startedAt: new Date('2026-05-28T00:00:00.000Z'),
    completedAt: null,
    lastHeartbeatAt: new Date('2026-05-28T00:00:00.000Z'),
    ...overrides,
  };
}

function caseRow(overrides: Partial<CaseRow> = {}): CaseRow {
  return {
    id: 'CASE-1',
    version: 17,
    currentVersion: 14,
    status: 'drafting',
    operatorState: null,
    operatorMessage: 'Draft failed: timed out and was swept by the watcher.',
    runComplete: false,
    ...overrides,
  };
}

function completeBody(overrides: Record<string, unknown> = {}) {
  return {
    artifactPdfS3Key: 'drafter-artifacts/CASE-1/v15/v15.pdf',
    artifactTxtS3Key: 'drafter-artifacts/CASE-1/v15/v15.txt',
    artifactDocxS3Key: 'drafter-artifacts/CASE-1/v15/v15.docx',
    gradeSidecar: { probative_score: 7, grade: 'B', ship_recommendation: 'revise' },
    manifest: { phases: [] },
    operatorState: 'ready_with_notes',
    operatorMessage: 'Run did not complete (swept at SIGTERM). A partial letter is available — open as-is.',
    runComplete: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// HOTFIX 2026-06-20 regression: a FAILED drafter run (runComplete:false) wrote no letter, but the worker
// still sends the canonical txt key. The completion handler used to call resolveDocxKeyForMirror
// UNCONDITIONALLY → S3 GetObject on a never-written key → NoSuchKey → unhandled 500 → the failure callback
// itself failed → the SQS message redrove ~45m → the draft UI froze on step 1. Fix: only backfill/mirror on
// runComplete; resolveDocxKeyForMirror is non-fatal; no phantom LetterRevision for a failed run. This test
// injects a THROWING s3 to prove a failed run NEVER 500s on a missing artifact.
describe('POST /complete — FAILED run must never 500 on a missing artifact (drafting-freeze hotfix)', () => {
  function appWithThrowingS3(db: AppDb) {
    const noSuchKey = Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
    const s3 = { send: vi.fn(async () => { throw noSuchKey; }) } as unknown as import('@aws-sdk/client-s3').S3Client;
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/v1', createDrafterWorkerRouter(db, { s3, bucketName: 'phi-test' }));
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
      return sendError(res, 500, 'internal_error', 'Unexpected server error.');
    });
    return { app, s3 };
  }

  it('records state:failed, stays in drafting, returns 200, never touches S3, writes NO phantom revision', async () => {
    const { db, tx, job, caseRow: cr } = makeDb(jobRow({ state: 'running' }), caseRow({ status: 'drafting' }));
    const { app, s3 } = appWithThrowingS3(db);
    const res = await request(app)
      .post('/api/v1/internal/drafter/jobs/JOB-1/complete')
      .send({ ...completeBody({ runComplete: false }), artifactDocxS3Key: undefined });
    expect(res.status).toBe(200); // RED before the hotfix: 500 (NoSuchKey escaped resolveDocxKeyForMirror)
    expect(job.state).toBe('failed');
    expect(cr.status).toBe('drafting'); // failed run held for retry, not rn_review
    expect(s3.send).not.toHaveBeenCalled(); // runComplete gate → backfill skipped entirely
    expect(tx.letterRevision.create).not.toHaveBeenCalled(); // no phantom revision pointing at missing artifacts
  });
});

describe('POST /internal/drafter/jobs/:id/complete — late-artifact recovery', () => {
  it('merges artifact keys onto a watcher-swept failed job with NULL keys (200, no version bump)', async () => {
    const { db, tx, job, caseRow: cr } = makeDb(
      jobRow({ state: 'failed', completedAt: new Date('2026-05-28T00:10:00.000Z') }),
      caseRow(),
    );
    const caseVersionBefore = cr.version;

    const res = await request(appFor(db))
      .post('/api/v1/internal/drafter/jobs/JOB-1/complete')
      .send(completeBody());

    expect(res.status).toBe(200);
    expect(res.body.recovered).toBe(true);
    // Artifact keys now on the row → "Open as-is" works.
    expect(job.artifactPdfS3Key).toBe('drafter-artifacts/CASE-1/v15/v15.pdf');
    expect(job.artifactTxtS3Key).toBe('drafter-artifacts/CASE-1/v15/v15.txt');
    expect(job.artifactDocxS3Key).toBe('drafter-artifacts/CASE-1/v15/v15.docx');
    // State stays terminal 'failed' — recovery is not a second terminal transition.
    expect(job.state).toBe('failed');
    // The watcher already settled case version/currentVersion/status — recovery must NOT touch them.
    expect(cr.version).toBe(caseVersionBefore);
    expect(cr.currentVersion).toBe(14);
    expect(cr.status).toBe('drafting');
    // Operator message updated so the RN sees the "partial letter, open as-is" guidance.
    expect(cr.operatorMessage).toContain('open as-is');
    // An audit row is written for the recovery.
    expect(tx.activityLog.create).toHaveBeenCalledTimes(1);
    expect(tx.activityLog.create.mock.calls[0]?.[0]?.data?.action).toBe('draft_job_artifacts_recovered');
  });

  it('rejects a genuine duplicate terminal callback (terminal + already has artifacts → 409)', async () => {
    const { db, tx } = makeDb(
      jobRow({
        state: 'done',
        artifactPdfS3Key: 'drafter-artifacts/CASE-1/v15/v15.pdf',
        artifactTxtS3Key: 'drafter-artifacts/CASE-1/v15/v15.txt',
        completedAt: new Date('2026-05-28T00:08:00.000Z'),
      }),
      caseRow({ status: 'physician_review' }),
    );

    const res = await request(appFor(db))
      .post('/api/v1/internal/drafter/jobs/JOB-1/complete')
      .send(completeBody({ runComplete: true, operatorState: 'ready', gradeSidecar: { probative_score: 9, grade: 'A', ship_recommendation: 'ship' } }));

    expect(res.status).toBe(409);
    expect(tx.activityLog.create).not.toHaveBeenCalled();
  });

  it('completes a non-terminal running job normally (200, bumps case version, ship → rn_review, NOT auto-routed to the doctor)', async () => {
    const { db, job, caseRow: cr } = makeDb(jobRow({ state: 'running' }), caseRow());
    const caseVersionBefore = cr.version;

    const res = await request(appFor(db))
      .post('/api/v1/internal/drafter/jobs/JOB-1/complete')
      .send(completeBody({ runComplete: true, operatorState: 'ready', gradeSidecar: { probative_score: 9, grade: 'A', ship_recommendation: 'ship' } }));

    expect(res.status).toBe(200);
    expect(res.body.recovered).toBeUndefined();
    expect(job.state).toBe('done');
    expect(cr.version).toBe(caseVersionBefore + 1);
    // A completed draft now waits in rn_review for the RN to send it to the doctor — even when the
    // grader says "ship". No auto-route to physician_review. (Ryan 2026-06-04.)
    expect(cr.status).toBe('rn_review');
  });

  it('RESURRECTS a watcher-swept job that posts a REAL completed letter (advances currentVersion → letter surfaces)', async () => {
    const { db, tx, job, caseRow: cr } = makeDb(
      jobRow({ state: 'failed', errorMessage: DRAFT_JOB_WATCHER_SWEPT_MESSAGE, completedAt: new Date('2026-05-28T00:10:00.000Z') }),
      caseRow({ status: 'drafting', currentVersion: 14, operatorState: 'paused' }),
    );
    const caseVersionBefore = cr.version;

    const res = await request(appFor(db))
      .post('/api/v1/internal/drafter/jobs/JOB-1/complete')
      .send(completeBody({ runComplete: true, operatorState: 'ready', gradeSidecar: { probative_score: 9, grade: 'A', ship_recommendation: 'ship' } }));

    expect(res.status).toBe(200);
    expect(res.body.resurrected).toBe(true);
    expect(job.state).toBe('done');
    expect(job.artifactPdfS3Key).toBe('drafter-artifacts/CASE-1/v15/v15.pdf');
    expect(job.errorMessage).toBeNull();
    // THE FIX: currentVersion advances to the job's version so resolveCurrent() reaches the letter.
    expect(cr.currentVersion).toBe(15);
    expect(cr.status).toBe('rn_review');
    expect(cr.runComplete).toBe(true);
    expect(cr.version).toBe(caseVersionBefore + 1);
    expect(tx.letterRevision.create).toHaveBeenCalledTimes(1);
    expect(tx.activityLog.create.mock.calls[0]?.[0]?.data?.action).toBe('draft_job_resurrected');
  });

  it('RESURRECTS a swept job that already merged PARTIAL artifacts + a mutated errorMessage when a REAL letter arrives (CLM-A355D7A822 race)', async () => {
    // Real incident: the FIRST run's SIGTERM uploaded a PARTIAL letter, so the late-artifact-recovery
    // branch had already merged both artifact keys onto the swept 'failed' row AND overwritten
    // errorMessage. The SQS-redelivered run then posted the REAL completed v2 letter. The OLD guards
    // 409'd it (row has artifacts) and would not have matched on errorMessage — so the case stayed in
    // 'drafting'/paused and OpsHeldPanel never cleared. A 'failed' row must be supersedable by a real
    // completion even with partial artifacts present and errorMessage no longer the watcher string.
    const { db, tx, job, caseRow: cr } = makeDb(
      jobRow({
        state: 'failed',
        errorMessage: 'Run did not complete (swept at SIGTERM). A partial letter is available — open as-is.',
        artifactPdfS3Key: 'drafter-artifacts/CASE-1/v15/partial.pdf',
        artifactTxtS3Key: 'drafter-artifacts/CASE-1/v15/partial.txt',
        completedAt: new Date('2026-05-28T00:10:00.000Z'),
      }),
      caseRow({ status: 'drafting', currentVersion: 14, operatorState: 'paused' }),
    );
    const caseVersionBefore = cr.version;

    const res = await request(appFor(db))
      .post('/api/v1/internal/drafter/jobs/JOB-1/complete')
      .send(completeBody({ runComplete: true, operatorState: 'ready', gradeSidecar: { probative_score: 8, grade: 'B+', ship_recommendation: 'ship' } }));

    expect(res.status).toBe(200);
    expect(res.body.resurrected).toBe(true);
    expect(job.state).toBe('done');
    // The real completed artifacts overwrite the partial ones.
    expect(job.artifactPdfS3Key).toBe('drafter-artifacts/CASE-1/v15/v15.pdf');
    expect(job.errorMessage).toBeNull();
    expect(cr.currentVersion).toBe(15);
    expect(cr.status).toBe('rn_review');
    expect(cr.runComplete).toBe(true);
    expect(cr.version).toBe(caseVersionBefore + 1);
    expect(tx.activityLog.create.mock.calls[0]?.[0]?.data?.action).toBe('draft_job_resurrected');
  });

  it('still 409s a genuine completed-run duplicate (state=done + artifacts) — NOT eligible for resurrect', async () => {
    // Regression guard for the reordered logic: only 'failed' rows are supersedable. A real prior
    // completion (state='done') with artifacts is a true duplicate and must still be rejected.
    const { db, tx } = makeDb(
      jobRow({
        state: 'done',
        artifactPdfS3Key: 'drafter-artifacts/CASE-1/v15/v15.pdf',
        artifactTxtS3Key: 'drafter-artifacts/CASE-1/v15/v15.txt',
        completedAt: new Date('2026-05-28T00:08:00.000Z'),
      }),
      caseRow({ status: 'rn_review' }),
    );

    const res = await request(appFor(db))
      .post('/api/v1/internal/drafter/jobs/JOB-1/complete')
      .send(completeBody({ runComplete: true, operatorState: 'ready', gradeSidecar: { probative_score: 9, grade: 'A', ship_recommendation: 'ship' } }));

    expect(res.status).toBe(409);
    expect(tx.activityLog.create).not.toHaveBeenCalled();
  });

  it('does NOT resurrect a watcher-swept job whose /complete is NOT a real completion (runComplete=false → merge only)', async () => {
    const { job, caseRow: cr, db } = makeDb(
      jobRow({ state: 'failed', errorMessage: DRAFT_JOB_WATCHER_SWEPT_MESSAGE, completedAt: new Date('2026-05-28T00:10:00.000Z') }),
      caseRow({ status: 'drafting', currentVersion: 14 }),
    );
    const res = await request(appFor(db))
      .post('/api/v1/internal/drafter/jobs/JOB-1/complete')
      .send(completeBody({ runComplete: false }));
    expect(res.status).toBe(200);
    expect(res.body.recovered).toBe(true); // merge path, not resurrect
    expect(res.body.resurrected).toBeUndefined();
    expect(job.state).toBe('failed');
    expect(cr.currentVersion).toBe(14); // NOT advanced
  });

  it('returns 404 for an unknown job', async () => {
    const { db } = makeDb(jobRow(), caseRow());
    const res = await request(appFor(db))
      .post('/api/v1/internal/drafter/jobs/NOPE/complete')
      .send(completeBody());
    expect(res.status).toBe(404);
  });
});
