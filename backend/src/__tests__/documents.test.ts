import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createDocumentsRouter } from '../routes/documents.js';
import { authenticateJwt } from '../middleware/auth.js';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://signed.example/upload'),
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

  it('rejects presign when file exceeds 5 MB', async () => {
    const prisma = { case: { findFirst: vi.fn(async () => ({ id: 'CASE-1' })) } };
    await request(appFor(prisma)).post('/api/v1/veterans/VET-1/documents/presign').send({ caseId: 'CASE-1', filename: 'big.pdf', contentType: 'application/pdf', sizeBytes: 6 * 1024 * 1024 }).expect(400);
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

  it('requires admin role to delete documents', async () => {
    const prisma = { document: { findUnique: vi.fn() } };
    await request(appFor(prisma, 'ops_staff')).delete('/api/v1/documents/doc-1').expect(403);
  });
});
