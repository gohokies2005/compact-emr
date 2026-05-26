import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInternalWorkerRouter } from '../routes/internal-worker.js';
import { requireServicePrincipal, INTERNAL_WORKER_TOKEN_HEADER } from '../middleware/service-principal.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb, DocumentPageRecord, DoctorPackRecord } from '../services/db-types.js';

const TEST_TOKEN = 'phase7b-test-worker-token-must-be-16+chars';

function makeDb(initialDoctorPack: DoctorPackRecord | null = null, initialDocument: { id: string; caseId: string; s3Key: string } | null = null) {
  const pages = new Map<string, DocumentPageRecord>();
  let doctorPack: DoctorPackRecord | null = initialDoctorPack;
  const fileReadStatuses = new Map<string, { id: string; caseId: string; filePath: string; terminalStatus: string; attemptsJson: unknown[]; lastCheckedAt: Date; version: number }>();
  let nextFrsId = 1;

  const tx = {
    documentPage: {
      upsert: vi.fn(async (args: { where: { documentId_pageNumber: { documentId: string; pageNumber: number } }; create: Omit<DocumentPageRecord, 'id' | 'createdAt' | 'updatedAt'>; update: Partial<DocumentPageRecord> }) => {
        const key = `${args.where.documentId_pageNumber.documentId}#${args.where.documentId_pageNumber.pageNumber}`;
        const now = new Date();
        const existing = pages.get(key);
        const row: DocumentPageRecord = existing
          ? { ...existing, ...args.update, updatedAt: now } as DocumentPageRecord
          : { id: `DP-${pages.size + 1}`, ...args.create, createdAt: now, updatedAt: now } as DocumentPageRecord;
        pages.set(key, row);
        return row;
      }),
      findMany: vi.fn(async () => [...pages.values()]),
      findFirst: vi.fn(async () => null),
      create: vi.fn(),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    doctorPack: {
      findUnique: vi.fn(async () => doctorPack),
      findFirst: vi.fn(async () => doctorPack),
      findMany: vi.fn(async () => []),
      create: vi.fn(),
      update: vi.fn(async (args: { where: { id: string }; data: Partial<DoctorPackRecord> & { version?: { increment: number } } }) => {
        if (!doctorPack) throw new Error('no doctor pack');
        doctorPack = { ...doctorPack, ...args.data, version: typeof args.data.version === 'object' ? doctorPack.version + 1 : doctorPack.version } as DoctorPackRecord;
        return doctorPack;
      }),
    },
    activityLog: { create: vi.fn(async () => ({})) },
    // Mock the document delegate so the new tx.document.update path (architect QA finding #1)
    // doesn't crash on the page-count write. Also support findUnique for the closeout #3
    // read-attempt-failed route.
    document: {
      update: vi.fn(async (args: { where: { id: string }; data: { pageCount: number } }) => ({ id: args.where.id, pageCount: args.data.pageCount })),
      findUnique: vi.fn(async (args: { where: { id: string } }) => initialDocument && initialDocument.id === args.where.id ? initialDocument : null),
    },
    fileReadStatus: {
      findFirst: vi.fn(async (args: { where: { caseId: string; filePath: string } }) => {
        for (const r of fileReadStatuses.values()) {
          if (r.caseId === args.where.caseId && r.filePath === args.where.filePath) return r;
        }
        return null;
      }),
      create: vi.fn(async (args: { data: { caseId: string; filePath: string; terminalStatus: string; attemptsJson: unknown[]; lastCheckedAt: Date } }) => {
        const id = `FRS-${nextFrsId++}`;
        const row = { id, ...args.data, version: 1 };
        fileReadStatuses.set(id, row);
        return row;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Partial<{ terminalStatus: string; attemptsJson: unknown[]; lastCheckedAt: Date }> & { version?: { increment: number } } }) => {
        const cur = fileReadStatuses.get(args.where.id);
        if (!cur) throw new Error('missing FRS');
        const next = { ...cur, ...args.data, version: typeof args.data.version === 'object' ? cur.version + 1 : cur.version };
        fileReadStatuses.set(args.where.id, next as typeof cur);
        return next;
      }),
    },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn: (innerTx: typeof tx) => unknown) => fn(tx)) } as unknown as AppDb;
  return { db, pages, getDoctorPack: () => doctorPack, tx };
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/v1', requireServicePrincipal(), createInternalWorkerRouter(db));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
    return sendError(res, 500, 'internal_error', 'Unexpected server error.');
  });
  return app;
}

const now = new Date('2026-05-26T00:00:00.000Z');

function sampleDoctorPack(overrides: Partial<DoctorPackRecord> = {}): DoctorPackRecord {
  return {
    id: 'DP-1',
    caseId: 'CASE-1',
    caseVersion: 1,
    state: 'queued',
    pdfS3Key: 'doctor-packs/CASE-1/v1/DP-1.pdf',
    pageCount: null,
    keyDocCount: 5,
    manifestJson: { entries: [], engineVersion: 'doctor-pack-1.0.0' },
    errorMessage: null,
    generatedAt: null,
    generatedBy: 'admin-sub',
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...overrides,
  };
}

beforeEach(() => {
  process.env['INTERNAL_WORKER_TOKEN'] = TEST_TOKEN;
});

describe('service-principal middleware', () => {
  it('rejects requests with no token (401)', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/internal/documents/DOC-1/pages').send({ pages: [] });
    expect(res.status).toBe(401);
  });

  it('rejects requests with wrong token (401)', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/internal/documents/DOC-1/pages').set(INTERNAL_WORKER_TOKEN_HEADER, 'wrong').send({ pages: [] });
    expect(res.status).toBe(401);
  });

  it('returns 503 when INTERNAL_WORKER_TOKEN is unset', async () => {
    delete process.env['INTERNAL_WORKER_TOKEN'];
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/internal/documents/DOC-1/pages').set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN).send({ pages: [] });
    expect(res.status).toBe(503);
  });
});

describe('POST /internal/documents/:id/pages', () => {
  it('upserts pages and returns the count', async () => {
    const { db, pages } = makeDb();
    const res = await request(appFor(db))
      .post('/api/v1/internal/documents/DOC-1/pages')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({
        pages: [
          { pageNumber: 1, text: 'page one extracted text', confidence: 0.95 },
          { pageNumber: 2, text: 'page two extracted text', confidence: 0.91 },
        ],
        documentPageCount: 2,
      });
    expect(res.status).toBe(201);
    expect(res.body.data.pagesUpserted).toBe(2);
    expect(pages.size).toBe(2);
  });

  it('re-running upserts in place (idempotent)', async () => {
    const { db, pages } = makeDb();
    await request(appFor(db))
      .post('/api/v1/internal/documents/DOC-1/pages')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ pages: [{ pageNumber: 1, text: 'first attempt', confidence: 0.5 }] });
    await request(appFor(db))
      .post('/api/v1/internal/documents/DOC-1/pages')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ pages: [{ pageNumber: 1, text: 'second attempt better', confidence: 0.95 }] });
    expect(pages.size).toBe(1);
  });

  it('rejects empty pages array (400)', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db))
      .post('/api/v1/internal/documents/DOC-1/pages')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ pages: [] });
    expect(res.status).toBe(400);
  });

  it('rejects malformed pageNumber (400)', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db))
      .post('/api/v1/internal/documents/DOC-1/pages')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ pages: [{ pageNumber: 0, text: 'x', confidence: 0.9 }] });
    expect(res.status).toBe(400);
  });

  it('rejects oversized text (400)', async () => {
    const { db } = makeDb();
    const longText = 'a'.repeat(100_001);
    const res = await request(appFor(db))
      .post('/api/v1/internal/documents/DOC-1/pages')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ pages: [{ pageNumber: 1, text: longText, confidence: 0.9 }] });
    expect(res.status).toBe(400);
  });

  it('rejects > 2000 pages per request (400)', async () => {
    const { db } = makeDb();
    const tooMany = Array.from({ length: 2001 }, (_, i) => ({ pageNumber: i + 1, text: 'x', confidence: 0.9 }));
    const res = await request(appFor(db))
      .post('/api/v1/internal/documents/DOC-1/pages')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ pages: tooMany });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /internal/doctor-packs/:id', () => {
  it('transitions queued -> generating', async () => {
    const { db, getDoctorPack } = makeDb(sampleDoctorPack({ state: 'queued' }));
    const res = await request(appFor(db))
      .patch('/api/v1/internal/doctor-packs/DP-1')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ state: 'generating' });
    expect(res.status).toBe(200);
    expect(getDoctorPack()?.state).toBe('generating');
  });

  it('transitions generating -> ready with pdfS3Key', async () => {
    const { db, getDoctorPack } = makeDb(sampleDoctorPack({ state: 'generating' }));
    const res = await request(appFor(db))
      .patch('/api/v1/internal/doctor-packs/DP-1')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ state: 'ready', pdfS3Key: 'doctor-packs/CASE-1/v1/DP-1.pdf', pageCount: 14 });
    expect(res.status).toBe(200);
    expect(getDoctorPack()?.state).toBe('ready');
    expect(getDoctorPack()?.generatedAt).toBeTruthy();
    expect(getDoctorPack()?.pageCount).toBe(14);
  });

  it('rejects state=ready without pdfS3Key (400)', async () => {
    const { db } = makeDb(sampleDoctorPack({ state: 'generating' }));
    const res = await request(appFor(db))
      .patch('/api/v1/internal/doctor-packs/DP-1')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ state: 'ready' });
    expect(res.status).toBe(400);
  });

  it('rejects state=failed without errorMessage (400)', async () => {
    const { db } = makeDb(sampleDoctorPack({ state: 'generating' }));
    const res = await request(appFor(db))
      .patch('/api/v1/internal/doctor-packs/DP-1')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ state: 'failed' });
    expect(res.status).toBe(400);
  });

  it('rejects invalid forward transition queued -> ready (409)', async () => {
    const { db } = makeDb(sampleDoctorPack({ state: 'queued' }));
    const res = await request(appFor(db))
      .patch('/api/v1/internal/doctor-packs/DP-1')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ state: 'ready', pdfS3Key: 'x' });
    expect(res.status).toBe(409);
  });

  it('rejects transition from terminal state (409)', async () => {
    const { db } = makeDb(sampleDoctorPack({ state: 'ready' }));
    const res = await request(appFor(db))
      .patch('/api/v1/internal/doctor-packs/DP-1')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ state: 'generating' });
    expect(res.status).toBe(409);
  });

  it('returns 404 for missing doctor pack', async () => {
    const { db } = makeDb(null);
    const res = await request(appFor(db))
      .patch('/api/v1/internal/doctor-packs/NOPE')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ state: 'generating' });
    expect(res.status).toBe(404);
  });
});

describe('POST /internal/documents/:id/read-attempt-failed', () => {
  it('upserts a manual_summary_required FileReadStatus when Textract fails', async () => {
    const { db } = makeDb(null, { id: 'DOC-1', caseId: 'CASE-1', s3Key: 'records/garbled.pdf' });
    const res = await request(appFor(db))
      .post('/api/v1/internal/documents/DOC-1/read-attempt-failed')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ textractStatus: 'FAILED', jobId: 'tex-job-123', errorMessage: 'unsupported page format' });
    expect(res.status).toBe(201);
    expect(res.body.data.terminalStatus).toBe('manual_summary_required');
    expect(res.body.data.caseId).toBe('CASE-1');
    expect(res.body.data.filePath).toBe('records/garbled.pdf');
  });

  it('rejects missing textractStatus (400)', async () => {
    const { db } = makeDb(null, { id: 'DOC-1', caseId: 'CASE-1', s3Key: 'records/x.pdf' });
    const res = await request(appFor(db))
      .post('/api/v1/internal/documents/DOC-1/read-attempt-failed')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ jobId: 'tex-job-123' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when document does not exist', async () => {
    const { db } = makeDb(null, null);
    const res = await request(appFor(db))
      .post('/api/v1/internal/documents/MISSING/read-attempt-failed')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ textractStatus: 'FAILED', jobId: 'tex-job-123' });
    expect(res.status).toBe(404);
  });
});
