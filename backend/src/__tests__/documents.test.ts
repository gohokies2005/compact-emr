import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createDocumentsRouter } from '../routes/documents.js';
import { authenticateJwt } from '../middleware/auth.js';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://signed.example/upload'),
}));

// The reprocess route's force-extract reaches the SQS publisher — keep tests hermetic.
vi.mock('../services/chart-extract-queue.js', () => ({
  publishChartExtractQueued: vi.fn(async () => undefined),
}));

function appFor(prisma: unknown, role: 'admin' | 'ops_staff' | 'physician' = 'ops_staff') {
  process.env.AUTH_TEST_JWT_SECRET = 'test-secret';
  process.env.AUTH_TEST_ISSUER = 'compact-emr-tests';
  process.env.AUTH_TEST_AUDIENCE = 'compact-emr-tests';
  process.env.PHI_BUCKET_NAME = 'test-phi-bucket';
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    req.user = { sub: 'user-1', email: 'user@example.com', roles: [role] };
    next();
  });
  app.use('/api/v1', createDocumentsRouter({ prisma: prisma as never, s3: { send: vi.fn(async () => ({})) } as never, bucketName: 'test-phi-bucket' }));
  return app;
}

function unauthenticatedApp(prisma: unknown) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', authenticateJwt(), createDocumentsRouter({ prisma: prisma as never, s3: { send: vi.fn(async () => ({})) } as never, bucketName: 'test-phi-bucket' }));
  return app;
}

describe('document routes', () => {
  it('rejects unauthenticated requests before document handlers', async () => {
    const app = unauthenticatedApp({ document: { findMany: vi.fn() } });
    await request(app).get('/api/v1/veterans/VET-1/documents').expect(401);
  });

  it('lists documents for a veteran', async () => {
    const prisma = {
      document: { findMany: vi.fn(async () => [{ id: 'doc-1', caseId: 'CASE-1', filename: 'record.pdf', sizeBytes: BigInt(12), contentType: 'application/pdf', docTag: 'STR', s3Key: 'cases/CASE-1/a.pdf', uploadedAt: new Date(), uploadedBy: 'user-1', updatedAt: new Date(), version: 1 }]) },
    };
    const res = await request(appFor(prisma)).get('/api/v1/veterans/VET-1/documents').expect(200);
    expect(res.body.data[0].sizeBytes).toBe('12');
    expect(prisma.document.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { case: { veteranId: 'VET-1' } } }));
  });

  it('creates a 5-minute KMS-enforced presigned PUT URL', async () => {
    const prisma = { case: { findFirst: vi.fn(async () => ({ id: 'CASE-1' })) } };
    const res = await request(appFor(prisma)).post('/api/v1/veterans/VET-1/documents/presign').send({ caseId: 'CASE-1', filename: 'record.pdf', contentType: 'application/pdf', sizeBytes: 1024 }).expect(200);
    expect(res.body.data.uploadUrl).toContain('https://signed.example');
    expect(res.body.data.requiredHeaders['x-amz-server-side-encryption']).toBe('aws:kms');
  });

  it('rejects presign when file exceeds 50 MB', async () => {
    const prisma = { case: { findFirst: vi.fn(async () => ({ id: 'CASE-1' })) } };
    await request(appFor(prisma)).post('/api/v1/veterans/VET-1/documents/presign').send({ caseId: 'CASE-1', filename: 'big.pdf', contentType: 'application/pdf', sizeBytes: 51 * 1024 * 1024 }).expect(400);
  });

  it('records uploaded document metadata and activity log in one transaction', async () => {
    const tx = {
      document: { create: vi.fn(async () => ({ id: 'doc-1', caseId: 'CASE-1', filename: 'record.pdf', sizeBytes: BigInt(33), contentType: 'application/pdf', docTag: 'STR', s3Key: 'cases/CASE-1/record.pdf', uploadedAt: new Date(), uploadedBy: 'user-1', updatedAt: new Date(), version: 1 })) },
      activityLog: { create: vi.fn(async () => ({})) },
    };
    const prisma = { case: { findFirst: vi.fn(async () => ({ id: 'CASE-1' })) }, $transaction: vi.fn(async (fn) => fn(tx)) };
    const res = await request(appFor(prisma)).post('/api/v1/veterans/VET-1/documents').send({ caseId: 'CASE-1', filename: 'record.pdf', contentType: 'application/pdf', sizeBytes: 33, s3Key: 'cases/CASE-1/a1b2c3d4-e5f6-7890-abcd-ef1234567890-record.pdf', docTag: 'STR' }).expect(201);
    expect(res.body.data.id).toBe('doc-1');
    expect(tx.activityLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'document_created' }) }));
  });

  it('allows ops_staff to delete a document (RN self-service for a misupload)', async () => {
    // findUnique -> null so we don't need the full S3/tx flow; the point is the role gate passes
    // (ops_staff is now permitted), so the response is NOT a 403. (Ryan 2026-06-04.)
    const prisma = { document: { findUnique: vi.fn(async () => null) } };
    const res = await request(appFor(prisma, 'ops_staff')).delete('/api/v1/documents/doc-1');
    expect(res.status).not.toBe(403);
  });

  it('rejects a physician deleting documents', async () => {
    const prisma = { document: { findUnique: vi.fn() } };
    await request(appFor(prisma, 'physician')).delete('/api/v1/documents/doc-1').expect(403);
  });
});

// Keystone 4b — POST /cases/:id/reprocess: re-OCR every doc lacking a terminal read status
// (shared CopyObject nudge) + force a chart re-extract via the salted triggerHash.
describe('POST /cases/:id/reprocess', () => {
  function appWithS3(prisma: unknown, role: 'admin' | 'ops_staff' | 'physician' = 'ops_staff') {
    const s3Send = vi.fn(async () => ({}));
    const app = express();
    app.use(express.json());
    app.use(async (req, _res, next) => {
      req.user = { sub: 'user-1', email: 'user@example.com', roles: [role] };
      next();
    });
    app.use('/api/v1', createDocumentsRouter({ prisma: prisma as never, s3: { send: s3Send } as never, bucketName: 'test-phi-bucket' }));
    return { app, s3Send };
  }

  function reprocessPrisma(over: { readStatuses?: { filePath: string; terminalStatus: string }[]; runCreateThrowsP2002?: boolean } = {}) {
    const runCreates: Record<string, unknown>[] = [];
    const activityCreates: Record<string, unknown>[] = [];
    const prisma = {
      case: { findFirst: vi.fn(async () => ({ id: 'CASE-1', veteranId: 'VET-1' })) },
      document: {
        findMany: vi.fn(async () => [
          { id: 'doc-terminal', s3Key: 'cases/CASE-1/a.pdf', contentType: 'application/pdf' },
          { id: 'doc-stuck', s3Key: 'cases/CASE-1/b.pdf', contentType: 'application/pdf' },
        ]),
      },
      fileReadStatus: {
        findMany: vi.fn(async () => over.readStatuses ?? [
          { filePath: 'cases/CASE-1/a.pdf', terminalStatus: 'read' },
          // b.pdf has NO terminal row — the orphan-race victim
        ]),
      },
      chartExtractionRun: {
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          if (over.runCreateThrowsP2002) { const err = new Error('unique'); (err as Error & { code?: string }).code = 'P2002'; throw err; }
          runCreates.push(args.data);
          return args.data;
        }),
        delete: vi.fn(async () => ({})),
      },
      activityLog: { create: vi.fn(async (args: { data: Record<string, unknown> }) => { activityCreates.push(args.data); return args.data; }) },
    };
    return { prisma, runCreates, activityCreates };
  }

  it('re-OCRs ONLY the doc lacking a terminal read status and reports the structured summary', async () => {
    const { prisma, activityCreates } = reprocessPrisma();
    const { app, s3Send } = appWithS3(prisma);
    const res = await request(app).post('/api/v1/cases/CASE-1/reprocess').expect(200);

    expect(res.body.data.reocrQueued).toBe(1); // b.pdf only — a.pdf is terminal
    expect(s3Send).toHaveBeenCalledTimes(1); // one CopyObject nudge
    // Not all docs terminal (b.pdf pending) → the force honestly waits for the natural trigger.
    expect(res.body.data.extractEnqueued).toBe(false);
    expect(res.body.data.extractReason).toBe('ocr_in_progress');
    expect(typeof res.body.data.requestId).toBe('string');
    expect(activityCreates[0]).toMatchObject({ action: 'case_reprocessed', caseId: 'CASE-1', veteranId: 'VET-1' });
  });

  it('all-terminal wedge: re-OCRs nothing but FORCE-enqueues a fresh salted run', async () => {
    const { prisma, runCreates } = reprocessPrisma({
      readStatuses: [
        { filePath: 'cases/CASE-1/a.pdf', terminalStatus: 'read' },
        { filePath: 'cases/CASE-1/b.pdf', terminalStatus: 'manual_summary_required' },
      ],
    });
    const { app, s3Send } = appWithS3(prisma);
    const res = await request(app).post('/api/v1/cases/CASE-1/reprocess').expect(200);

    expect(res.body.data.reocrQueued).toBe(0);
    expect(s3Send).not.toHaveBeenCalled();
    expect(res.body.data.extractEnqueued).toBe(true);
    // The salted hash carries the request id → `<sha256>:manual:<requestId>` (keystone 4b format).
    expect(String(runCreates[0]?.['triggerHash'])).toMatch(new RegExp(`^[0-9a-f]{64}:manual:${res.body.data.requestId}$`));
  });

  it('a P2002 on the salted insert reports already_enqueued, never a 500 (the mind-the-P2002 catch)', async () => {
    const { prisma } = reprocessPrisma({
      readStatuses: [
        { filePath: 'cases/CASE-1/a.pdf', terminalStatus: 'read' },
        { filePath: 'cases/CASE-1/b.pdf', terminalStatus: 'read' },
      ],
      runCreateThrowsP2002: true,
    });
    const { app } = appWithS3(prisma);
    const res = await request(app).post('/api/v1/cases/CASE-1/reprocess').expect(200);
    expect(res.body.data.extractEnqueued).toBe(false);
    expect(res.body.data.extractReason).toBe('already_enqueued');
  });

  it('404 on an unknown case', async () => {
    const prisma = { case: { findFirst: vi.fn(async () => null) } };
    const { app } = appWithS3(prisma);
    await request(app).post('/api/v1/cases/NOPE/reprocess').expect(404);
  });

  it('rejects a physician (admin/ops_staff only)', async () => {
    const { prisma } = reprocessPrisma();
    const { app } = appWithS3(prisma, 'physician');
    await request(app).post('/api/v1/cases/CASE-1/reprocess').expect(403);
  });
});
