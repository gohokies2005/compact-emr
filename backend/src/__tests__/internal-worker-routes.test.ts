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
  const intakePages = new Map<string, { id: string; intakeS3Key: string; pageNumber: number; text: string; confidence: number | null; pageCount: number | null; readStatus: string | null; jobTag: string | null }>();
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
      // by-s3-key now returns hasPages (double-OCR guard, #8 v1) — count pages for the document.
      count: vi.fn(async (args: { where: { documentId: string } }) => {
        let n = 0;
        for (const r of pages.values()) { if ((r as { documentId?: string }).documentId === args.where.documentId) n += 1; }
        return n;
      }),
    },
    // #8 v2 parse-at-intake OCR cache.
    intakePage: {
      upsert: vi.fn(async (args: { where: { intakeS3Key_pageNumber: { intakeS3Key: string; pageNumber: number } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const k = `${args.where.intakeS3Key_pageNumber.intakeS3Key}#${args.where.intakeS3Key_pageNumber.pageNumber}`;
        const existing = intakePages.get(k);
        const row = existing
          ? { ...existing, ...args.update }
          : { id: `IP-${intakePages.size + 1}`, ...args.create } as typeof existing & { id: string };
        intakePages.set(k, row as NonNullable<typeof existing>);
        return row;
      }),
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        for (const r of intakePages.values()) {
          if (r.jobTag === args.where['jobTag'] && r.pageNumber === args.where['pageNumber']) return r;
        }
        return null;
      }),
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
      // by-s3-key route + C1 success-bridge both resolve the Document; key off s3Key here.
      findFirst: vi.fn(async (args: { where: { s3Key: string } }) => initialDocument && initialDocument.s3Key === args.where.s3Key ? initialDocument : null),
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
  return { db, pages, getDoctorPack: () => doctorPack, fileReadStatuses, tx };
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
    pdfS3Key: 'doctor-packs/CASE-1/v1/a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf',
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

  // C1 (audit 2026-05-27): a successful /pages call must ALSO register the file with the
  // chart-readiness gate via a file_read_status row — not only document_pages.
  it('creates a file_read_status row with terminalStatus=read on a clean OCR success', async () => {
    const { db, fileReadStatuses } = makeDb(null, { id: 'DOC-1', caseId: 'CASE-1', s3Key: 'cases/CASE-1/abc-records.pdf' });
    // A realistic clean medical page: well over 40 words, no garble.
    const cleanText = ('The veteran presents with chronic lower back pain following an in-service injury sustained during active duty. '
      + 'Physical examination reveals limited range of motion and tenderness over the lumbar paraspinal muscles. '
      + 'Imaging demonstrates degenerative disc disease at the L4 L5 level consistent with the reported mechanism of injury and onset.');
    const res = await request(appFor(db))
      .post('/api/v1/internal/documents/DOC-1/pages')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ pages: [{ pageNumber: 1, text: cleanText, confidence: 0.97 }], documentPageCount: 1 });
    expect(res.status).toBe(201);
    expect(res.body.data.readTerminalStatus).toBe('read');
    const rows = [...fileReadStatuses.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.caseId).toBe('CASE-1');
    expect(rows[0]?.filePath).toBe('cases/CASE-1/abc-records.pdf');
    expect(rows[0]?.terminalStatus).toBe('read');
  });

  it('lands manual_summary_required when a MULTI-PAGE OCR success returns only a tiny char sliver (choked big scan)', async () => {
    // CHAR floor (Ryan 2026-06-14): the big-scan guard now flags a >=2-page file with < 10 non-whitespace
    // chars (a genuine OCR choke), NOT merely "few words" — a multi-page file with a real sentence is
    // valid content. 8 chars on 5 pages = a choked scan; still surfaces for the RN.
    const { db, fileReadStatuses } = makeDb(null, { id: 'DOC-1', caseId: 'CASE-1', s3Key: 'cases/CASE-1/abc-short.pdf' });
    const res = await request(appFor(db))
      .post('/api/v1/internal/documents/DOC-1/pages')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ pages: [{ pageNumber: 1, text: 'abcd efg', confidence: 0.6 }], documentPageCount: 5 });
    expect(res.status).toBe(201);
    expect(res.body.data.readTerminalStatus).toBe('manual_summary_required');
    const rows = [...fileReadStatuses.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.terminalStatus).toBe('manual_summary_required');
  });

  it('ACCEPTS a 1-page file with few words as read (the size-aware "CPAP note" fix — Ryan 2026-06-13)', async () => {
    const { db, fileReadStatuses } = makeDb(null, { id: 'DOC-1', caseId: 'CASE-1', s3Key: 'cases/CASE-1/abc-cpap.pdf' });
    const res = await request(appFor(db))
      .post('/api/v1/internal/documents/DOC-1/pages')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ pages: [{ pageNumber: 1, text: 'CPAP', confidence: 0.9 }], documentPageCount: 1 });
    expect(res.status).toBe(201);
    expect(res.body.data.readTerminalStatus).toBe('read');
    const rows = [...fileReadStatuses.values()];
    expect(rows[0]?.terminalStatus).toBe('read');
  });

  it('lands manual_summary_required when OCR success returns garbled text', async () => {
    const { db, fileReadStatuses } = makeDb(null, { id: 'DOC-1', caseId: 'CASE-1', s3Key: 'cases/CASE-1/abc-garbled.pdf' });
    // 60+ tokens of symbol-soup garble (v2 signal): every word slot embeds symbols/digits => ratio ~1.0,
    // far above the 0.40 gate.
    const garbled = Array.from({ length: 60 }, () => 'th!s g@rbl#d c0nn3@ct r3c0rd p#esent kn$e').join(' ');
    const res = await request(appFor(db))
      .post('/api/v1/internal/documents/DOC-1/pages')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ pages: [{ pageNumber: 1, text: garbled, confidence: 0.4 }], documentPageCount: 1 });
    expect(res.status).toBe(201);
    expect(res.body.data.readTerminalStatus).toBe('manual_summary_required');
    const rows = [...fileReadStatuses.values()];
    expect(rows[0]?.terminalStatus).toBe('manual_summary_required');
  });

  // ── FIX 2 (2026-06-14): the LIVE Textract /pages writer must honor outcome.autoSkip ──────────
  // A genuinely empty <=1-page file is auto-skipped (NON-BLOCKING) — the writer used to ignore
  // autoSkip and dead-end every non-success to manual_summary_required, so the auto-skip was DEAD in
  // the live OCR path (only the /read-attempts route honored it).
  it('lands terminalStatus=auto_skipped when a 0-char <=1-page file flows through the /pages writer (live path)', async () => {
    const { db, fileReadStatuses } = makeDb(null, { id: 'DOC-1', caseId: 'CASE-1', s3Key: 'cases/CASE-1/abc-empty.pdf' });
    const res = await request(appFor(db))
      .post('/api/v1/internal/documents/DOC-1/pages')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      // 0 non-whitespace chars on a single page = a genuinely empty/invalid file → auto_skip.
      .send({ pages: [{ pageNumber: 1, text: '   \n ', confidence: null }], documentPageCount: 1 });
    expect(res.status).toBe(201);
    expect(res.body.data.readTerminalStatus).toBe('auto_skipped');
    const rows = [...fileReadStatuses.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.terminalStatus).toBe('auto_skipped');
  });

  it('still lands manual_summary_required for a 0-char MULTI-PAGE file (never auto-skips a real record)', async () => {
    // The data-loss guard: a substantial (>=2 page) file with 0 chars may be a REAL record we failed
    // to read — it must FLAG for manual review, NOT silently auto-skip. (autoSkip=false here.)
    const { db, fileReadStatuses } = makeDb(null, { id: 'DOC-1', caseId: 'CASE-1', s3Key: 'cases/CASE-1/abc-bigblank.pdf' });
    const res = await request(appFor(db))
      .post('/api/v1/internal/documents/DOC-1/pages')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ pages: [{ pageNumber: 1, text: '', confidence: null }], documentPageCount: 12 });
    expect(res.status).toBe(201);
    expect(res.body.data.readTerminalStatus).toBe('manual_summary_required');
    const rows = [...fileReadStatuses.values()];
    expect(rows[0]?.terminalStatus).toBe('manual_summary_required');
  });

  it('does not overwrite an RN manual_summary_provided clearance on OCR success', async () => {
    const { db, fileReadStatuses, tx } = makeDb(null, { id: 'DOC-1', caseId: 'CASE-1', s3Key: 'cases/CASE-1/abc-cleared.pdf' });
    // Seed a pre-existing provided clearance.
    await tx.fileReadStatus.create({
      data: { caseId: 'CASE-1', filePath: 'cases/CASE-1/abc-cleared.pdf', terminalStatus: 'manual_summary_provided', attemptsJson: [], lastCheckedAt: new Date() },
    });
    const cleanText = ('The veteran presents with chronic lower back pain following an in-service injury sustained during active duty. '
      + 'Physical examination reveals limited range of motion and tenderness over the lumbar paraspinal muscles consistently.');
    const res = await request(appFor(db))
      .post('/api/v1/internal/documents/DOC-1/pages')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ pages: [{ pageNumber: 1, text: cleanText, confidence: 0.95 }], documentPageCount: 1 });
    expect(res.status).toBe(201);
    expect(res.body.data.readTerminalStatus).toBe('manual_summary_provided');
    const rows = [...fileReadStatuses.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.terminalStatus).toBe('manual_summary_provided');
  });
});

describe('GET /internal/documents/by-s3-key', () => {
  it('resolves documentId + caseId by s3Key', async () => {
    const { db } = makeDb(null, { id: 'DOC-42', caseId: 'CASE-9', s3Key: 'cases/CASE-9/uuid-records.pdf' });
    const res = await request(appFor(db))
      .get('/api/v1/internal/documents/by-s3-key')
      .query({ key: 'cases/CASE-9/uuid-records.pdf' })
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN);
    expect(res.status).toBe(200);
    // hasPages=false when the document has no OCR pages yet (double-OCR guard, #8 v1).
    expect(res.body.data).toEqual({ documentId: 'DOC-42', caseId: 'CASE-9', s3Key: 'cases/CASE-9/uuid-records.pdf', hasPages: false });
  });

  it('returns hasPages=true once the document carries OCR pages (double-OCR guard)', async () => {
    const { db } = makeDb(null, { id: 'DOC-42', caseId: 'CASE-9', s3Key: 'cases/CASE-9/uuid-records.pdf' });
    // Seed a page via the /pages upsert so documentPage.count() > 0 for DOC-42.
    await request(appFor(db))
      .post('/api/v1/internal/documents/DOC-42/pages')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ pages: [{ pageNumber: 1, text: 'this document already has readable ocr text content present', confidence: 0.95 }], documentPageCount: 1 });
    const res = await request(appFor(db))
      .get('/api/v1/internal/documents/by-s3-key')
      .query({ key: 'cases/CASE-9/uuid-records.pdf' })
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.data.hasPages).toBe(true);
  });

  it('returns 404 when no document has that s3Key', async () => {
    const { db } = makeDb(null, { id: 'DOC-42', caseId: 'CASE-9', s3Key: 'cases/CASE-9/uuid-records.pdf' });
    const res = await request(appFor(db))
      .get('/api/v1/internal/documents/by-s3-key')
      .query({ key: 'cases/CASE-9/does-not-exist.pdf' })
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN);
    expect(res.status).toBe(404);
  });

  it('rejects a missing key query param (400)', async () => {
    const { db } = makeDb(null, { id: 'DOC-42', caseId: 'CASE-9', s3Key: 'cases/CASE-9/uuid-records.pdf' });
    const res = await request(appFor(db))
      .get('/api/v1/internal/documents/by-s3-key')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN);
    expect(res.status).toBe(400);
  });
});

describe('parse-at-intake (#8 v2) intake OCR endpoints', () => {
  const KEY = 'intake/INTAKE-1/records.pdf';
  it('ocr-start records the jobTag placeholder, then by-job-tag/pages resolves + upserts as read', async () => {
    const { db } = makeDb();
    const start = await request(appFor(db))
      .post('/api/v1/internal/intakes/ocr-start')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ intakeS3Key: KEY, jobTag: 'abc123' });
    expect(start.status).toBe(201);

    const pagesRes = await request(appFor(db))
      .post('/api/v1/internal/intakes/by-job-tag/pages')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ jobTag: 'abc123', pages: [{ pageNumber: 1, text: 'The veteran presented to the clinic with chronic lower back pain that began during active duty service and has progressively worsened over the years since separation, with documented imaging findings of degenerative disc disease at multiple lumbar levels confirmed by the treating physician on examination today.', confidence: 0.96 }], documentPageCount: 1 });
    expect(pagesRes.status).toBe(201);
    expect(pagesRes.body.data.intakeS3Key).toBe(KEY);
    expect(pagesRes.body.data.readStatus).toBe('read');
  });

  // FIX 2 (2026-06-14): the LIVE intake by-job-tag/pages writer must honor autoSkip too.
  it('by-job-tag/pages lands readStatus=auto_skipped for a 0-char <=1-page intake file', async () => {
    const { db } = makeDb();
    await request(appFor(db))
      .post('/api/v1/internal/intakes/ocr-start')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ intakeS3Key: KEY, jobTag: 'empty-job' });
    const res = await request(appFor(db))
      .post('/api/v1/internal/intakes/by-job-tag/pages')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ jobTag: 'empty-job', pages: [{ pageNumber: 1, text: '  ', confidence: null }], documentPageCount: 1 });
    expect(res.status).toBe(201);
    expect(res.body.data.readStatus).toBe('auto_skipped');
  });

  it('by-job-tag/pages returns 404 for an unknown jobTag', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db))
      .post('/api/v1/internal/intakes/by-job-tag/pages')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ jobTag: 'never-recorded', pages: [{ pageNumber: 1, text: 'some words here for the page', confidence: 0.9 }], documentPageCount: 1 });
    expect(res.status).toBe(404);
  });

  it('ocr-start rejects a missing intakeS3Key (400)', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db))
      .post('/api/v1/internal/intakes/ocr-start')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ jobTag: 'abc123' });
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
      .send({ state: 'ready', pdfS3Key: 'doctor-packs/CASE-1/v1/a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf', pageCount: 14 });
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
      // Valid-shape pdfS3Key so the transition check fires, not the path-traversal guard.
      .send({ state: 'ready', pdfS3Key: 'doctor-packs/CASE-1/v1/a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf' });
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

  // Task #107a regression: path-traversal in pdfS3Key body.
  it('rejects pdfS3Key with path-traversal (400)', async () => {
    const { db } = makeDb(sampleDoctorPack({ state: 'generating' }));
    const res = await request(appFor(db))
      .patch('/api/v1/internal/doctor-packs/DP-1')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ state: 'ready', pdfS3Key: 'doctor-packs/../etc/passwd.pdf' });
    expect(res.status).toBe(400);
  });

  // Task #107a regression: wrong-prefix pdfS3Key body.
  it('rejects pdfS3Key outside the doctor-packs/ subtree (400)', async () => {
    const { db } = makeDb(sampleDoctorPack({ state: 'generating' }));
    const res = await request(appFor(db))
      .patch('/api/v1/internal/doctor-packs/DP-1')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ state: 'ready', pdfS3Key: 'records/CASE-1/something.pdf' });
    expect(res.status).toBe(400);
  });

  // Task #107a regression: confirm-only / no-redirect.
  it('rejects pdfS3Key that differs from the server-computed value (409)', async () => {
    const { db } = makeDb(sampleDoctorPack({ state: 'generating', pdfS3Key: 'doctor-packs/CASE-1/v1/a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf' }));
    const res = await request(appFor(db))
      .patch('/api/v1/internal/doctor-packs/DP-1')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      // Valid pattern but different from existing — worker can't redirect the row.
      .send({ state: 'ready', pdfS3Key: 'doctor-packs/CASE-1/v1/ffffffff-ffff-ffff-ffff-ffffffffffff.pdf' });
    expect(res.status).toBe(409);
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
