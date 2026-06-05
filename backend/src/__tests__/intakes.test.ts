import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createIntakesRouter } from '../routes/intakes.js';

function appFor(intake: unknown, deps: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as { user?: unknown }).user = { sub: 'u1', email: 'u@e.com', roles: ['ops_staff'] }; next(); });
  app.use('/api/v1', createIntakesRouter({ intake } as never, deps as never));
  return app;
}

describe('intakes pool API', () => {
  it('lists intakes filtered by status + search, newest first', async () => {
    const findMany = vi.fn(async () => [{ id: 'i1', status: 'ready' }]);
    const res = await request(appFor({ findMany })).get('/api/v1/intakes?status=ready&q=frank').expect(200);
    expect(res.body.data).toHaveLength(1);
    const arg = (findMany.mock.calls[0] as unknown as [{ where: { status?: string; OR?: unknown }; orderBy: unknown }])[0];
    expect(arg.where.status).toBe('ready');
    expect(arg.where.OR).toBeDefined();
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('404s on a missing intake detail', async () => {
    await request(appFor({ findUnique: vi.fn(async () => null) })).get('/api/v1/intakes/nope').expect(404);
  });

  it('returns detail with the file manifest (no s3 configured → no preview URLs)', async () => {
    const findUnique = vi.fn(async () => ({ id: 'i1', status: 'ready', fileManifestJson: [{ name: 'a.pdf', s3Key: 'intake/i1/a.pdf' }] }));
    const res = await request(appFor({ findUnique })).get('/api/v1/intakes/i1').expect(200);
    expect(res.body.data.files).toHaveLength(1);
    expect(res.body.data.files[0].previewUrl).toBeUndefined();
  });

  it('dismiss sets status=dismissed + reason (kept for audit)', async () => {
    const findUnique = vi.fn(async () => ({ id: 'i1' }));
    const update = vi.fn(async () => ({ id: 'i1', status: 'dismissed' }));
    await request(appFor({ findUnique, update })).post('/api/v1/intakes/i1/dismiss').send({ reason: 'dupe' }).expect(200);
    expect(update).toHaveBeenCalledWith({ where: { id: 'i1' }, data: { status: 'dismissed', dismissedReason: 'dupe' } });
  });

  it('retry resets to pending + increments retryCount (RN self-service)', async () => {
    const findUnique = vi.fn(async () => ({ id: 'i1', jotformFormId: 'f', jotformSubmissionId: 's', retryCount: 2 }));
    const update = vi.fn(async () => ({}));
    await request(appFor({ findUnique, update })).post('/api/v1/intakes/i1/retry').expect(200);
    expect(update).toHaveBeenCalledWith({ where: { id: 'i1' }, data: { status: 'pending', errorMessage: null, retryCount: 3 } });
  });
});

// ───────────────────────── ASSIGN (data-plane-sensitive) ─────────────────────────

function assignApp(db: unknown, s3send: (cmd: unknown) => Promise<unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as { user?: unknown }).user = { sub: 'rn-1', email: 'rn@e.com', roles: ['ops_staff'] }; next(); });
  app.use('/api/v1', createIntakesRouter(db as never, { s3: { send: s3send } as never, bucketName: 'phi-bucket' }));
  return app;
}

function readyIntake(manifest: unknown[]) {
  return { id: 'i1', status: 'ready', fileManifestJson: manifest };
}
function txWithExisting() {
  // existing veteran VET-1 + existing case CLM-1
  return async (fn: (tx: unknown) => unknown) => fn({
    veteran: { findUnique: async () => ({ id: 'VET-1' }), create: async () => ({ id: 'VET-NEW' }) },
    case: { findFirst: async () => ({ id: 'CLM-1', veteranId: 'VET-1' }), create: async () => ({ id: 'CLM-NEW' }) },
  });
}

describe('intakes assign', () => {
  it('attaches an allowed file (row-first then copy) and skips an unsupported one; marks assigned', async () => {
    const docCreate = vi.fn(async () => ({ id: 'doc-1' }));
    const docDelete = vi.fn(async () => ({}));
    const intakeUpdate = vi.fn(async () => ({}));
    const copy = vi.fn(async () => ({}));
    const db = {
      intake: { findUnique: async () => readyIntake([
        { name: 'rec.pdf', s3Key: 'intake/i1/rec.pdf', contentType: 'application/pdf', sizeBytes: 1000 },
        { name: 'photo.heic', s3Key: 'intake/i1/photo.heic', contentType: 'image/heic', sizeBytes: 1000 },
      ]), update: intakeUpdate },
      $transaction: txWithExisting(),
      document: { create: docCreate, delete: docDelete },
    };
    const res = await request(assignApp(db, copy)).post('/api/v1/intakes/i1/assign').send({ veteranId: 'VET-1', caseId: 'CLM-1' }).expect(200);
    expect(res.body.data.assigned).toBe(true);
    expect(res.body.data.attached).toHaveLength(1);
    expect(res.body.data.failed).toHaveLength(1); // the .heic
    expect(res.body.data.failed[0].reason).toContain('unsupported content-type');
    expect(docCreate).toHaveBeenCalledTimes(1); // only the pdf
    expect(copy).toHaveBeenCalledTimes(1);
    expect(intakeUpdate).toHaveBeenCalled();
    // row created BEFORE copy
    expect(docCreate.mock.invocationCallOrder[0]).toBeLessThan(copy.mock.invocationCallOrder[0]);
  });

  it('deletes the orphan Document row when the S3 copy fails', async () => {
    const docCreate = vi.fn(async () => ({ id: 'doc-1' }));
    const docDelete = vi.fn(async () => ({}));
    const intakeUpdate = vi.fn(async () => ({}));
    const copy = vi.fn(async () => { throw new Error('AccessDenied'); });
    const db = {
      intake: { findUnique: async () => readyIntake([{ name: 'rec.pdf', s3Key: 'intake/i1/rec.pdf', contentType: 'application/pdf', sizeBytes: 1000 }]), update: intakeUpdate },
      $transaction: txWithExisting(),
      document: { create: docCreate, delete: docDelete },
    };
    const res = await request(assignApp(db, copy)).post('/api/v1/intakes/i1/assign').send({ veteranId: 'VET-1', caseId: 'CLM-1' }).expect(200);
    expect(res.body.data.assigned).toBe(false);
    expect(res.body.data.attached).toHaveLength(0);
    expect(res.body.data.failed[0].reason).toContain('copy failed');
    expect(docDelete).toHaveBeenCalledWith({ where: { id: 'doc-1' } });
    expect(intakeUpdate).not.toHaveBeenCalled(); // nothing attached → not marked assigned
  });

  it('assigns a 0-file submission by creating the veteran + claim (no uploads needed)', async () => {
    // A Stage-1/2 submission frequently has no files — the deliverable is the veteran + claim. Assign
    // must succeed (not gray out / stay 'ready'), and mark the intake assigned so it leaves the pool.
    const intakeUpdate = vi.fn(async () => ({}));
    const docCreate = vi.fn(async () => ({ id: 'doc-x' }));
    const db = {
      intake: { findUnique: async () => readyIntake([]), update: intakeUpdate },
      $transaction: txWithExisting(),
      document: { create: docCreate, delete: vi.fn() },
    };
    const res = await request(assignApp(db, vi.fn(async () => ({})))).post('/api/v1/intakes/i1/assign').send({
      newVeteran: { id: 'MRN-0123456789', firstName: 'Jane', lastName: 'Doe', dob: '1980-01-01', email: 'jane@e.com' },
      newCase: { id: 'CLM-0123456789', claimedCondition: 'PTSD', claimType: 'initial' },
      fileS3Keys: [],
    }).expect(200);
    expect(res.body.data.assigned).toBe(true);
    expect(res.body.data.attached).toHaveLength(0);
    expect(docCreate).not.toHaveBeenCalled();
    expect(intakeUpdate).toHaveBeenCalled();
  });

  it('attaches an Intake Summary PDF rendered from the answers (Q&A reaches the chart, even with 0 files)', async () => {
    const docCreate = vi.fn(async () => ({ id: 'doc-s' }));
    const s3send = vi.fn(async () => ({}));
    const intakeUpdate = vi.fn(async () => ({}));
    const db = {
      intake: {
        findUnique: async () => ({
          id: 'i1', status: 'ready', fileManifestJson: [], submittedName: 'Marcus Justice',
          rawAnswersJson: {
            q1: { type: 'control_textbox', name: 's2_dob_s1', text: 'Date of Birth', answer: '08/13/1985' },
            q2: { type: 'control_textarea', name: 's2_why_s1', text: 'Why connected', answer: 'urinary symptoms since service' },
          },
        }),
        update: intakeUpdate,
      },
      $transaction: txWithExisting(),
      document: { create: docCreate, delete: vi.fn() },
    };
    const res = await request(assignApp(db, s3send)).post('/api/v1/intakes/i1/assign').send({ veteranId: 'VET-1', caseId: 'CLM-1' }).expect(200);
    const calls = docCreate.mock.calls as unknown as Array<[{ data: { filename: string; contentType: string } }]>;
    const summary = calls.find((c) => c[0].data.filename === 'Intake_Summary.pdf');
    expect(summary).toBeTruthy();
    expect(summary![0].data.contentType).toBe('application/pdf');
    expect(res.body.data.attached.some((a: { name: string }) => a.name === 'Intake_Summary.pdf')).toBe(true);
    expect(s3send).toHaveBeenCalled(); // PutObject of the PDF bytes
  });

  it('409s when the intake is not ready', async () => {
    const db = { intake: { findUnique: async () => ({ id: 'i1', status: 'pending' }) }, $transaction: txWithExisting(), document: { create: vi.fn(), delete: vi.fn() } };
    await request(assignApp(db, vi.fn(async () => ({})))).post('/api/v1/intakes/i1/assign').send({ veteranId: 'VET-1', caseId: 'CLM-1' }).expect(409);
  });

  it('400s when neither veteranId nor newVeteran is provided', async () => {
    const db = { intake: { findUnique: async () => readyIntake([]) }, $transaction: txWithExisting(), document: { create: vi.fn(), delete: vi.fn() } };
    await request(assignApp(db, vi.fn(async () => ({})))).post('/api/v1/intakes/i1/assign').send({ caseId: 'CLM-1' }).expect(400);
  });
});
