import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDoctorPackRouter } from '../routes/doctor-pack.js';

// Chunk D (2026-06-11) route tests:
//   1. GET /cases/:id/doctor-pack/:packId/pdf-url — the new pack-PDF presign endpoint.
//   2. POST /cases/:id/doctor-pack/generate — content-aware classification end-to-end:
//      a Misc_N.pdf whose page text is a VA rating decision must produce a page-SELECTED
//      manifest entry (not the whole-doc fallback), with the budget fields stamped.

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://signed.example/doctor-pack.pdf'),
}));

vi.mock('../services/chart-summary-aggregator.js', () => ({
  aggregateChartSummary: vi.fn(async () => null),
}));

vi.mock('../services/doctor-pack-queue.js', () => ({
  publishDoctorPackQueued: vi.fn(async () => ({})),
}));

// Mock the Bedrock caller behind the page-picker (doctor-pack-page-llm.ts) so the classification
// test is deterministic in every environment. Without this, the test made a LIVE Opus call: it
// passed only where AWS credentials exist and failed in CI ("Region is missing" → fail-open →
// the regex fallback selects a WIDER range than the value-page assertion expects). The real
// selectPagesLlm parse/range logic still runs — only the network call is mocked.
const invokeAdvisory = vi.fn();
vi.mock('../advisory/bedrockClient.js', () => ({
  invokeAdvisory: (...args: unknown[]) => invokeAdvisory(...args),
}));

const READY_PACK = {
  id: 'pack-1',
  caseId: 'CASE-1',
  caseVersion: 3,
  state: 'ready',
  pdfS3Key: 'doctor-packs/CASE-1/v3/abc123-def.pdf',
  pageCount: 12,
  keyDocCount: 4,
  manifestJson: { entries: [], engineVersion: 'doctor-pack-1.0.0' },
  errorMessage: null,
  generatedAt: new Date('2026-06-11T00:00:00.000Z'),
  generatedBy: 'rn-1',
  createdAt: new Date('2026-06-11T00:00:00.000Z'),
  updatedAt: new Date('2026-06-11T00:00:00.000Z'),
  version: 1,
};

function appFor(
  prisma: unknown,
  opts: { role?: 'admin' | 'ops_staff' | 'physician'; s3Send?: (cmd: unknown) => Promise<unknown> } = {},
) {
  process.env.DOCTOR_PACKS_BUCKET_NAME = 'test-doctor-packs-bucket';
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    req.user = { sub: 'user-1', email: 'user@example.com', roles: [opts.role ?? 'ops_staff'] };
    next();
  });
  app.use(
    '/api/v1',
    createDoctorPackRouter(prisma as never, { s3: { send: (opts.s3Send ?? vi.fn(async () => ({}))) as never } as never }),
  );
  // Mirror the server's error envelope enough for assertions ({ error: { code, message } }).
  app.use((err: { status?: number; code?: string; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: { code: err.code ?? 'internal_error', message: err.message ?? 'error' } });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DOCTOR_PACKS_BUCKET_NAME = 'test-doctor-packs-bucket';
});

describe('GET /cases/:id/doctor-pack/:packId/pdf-url (Chunk D presign)', () => {
  it('returns a presigned URL for a ready pack (physician role allowed)', async () => {
    const prisma = { doctorPack: { findFirst: vi.fn(async () => READY_PACK) } };
    const res = await request(appFor(prisma, { role: 'physician' }))
      .get('/api/v1/cases/CASE-1/doctor-pack/pack-1/pdf-url')
      .expect(200);
    expect(res.body.data.url).toBe('https://signed.example/doctor-pack.pdf');
    expect(res.body.data.ttlSeconds).toBe(300);
    expect(prisma.doctorPack.findFirst).toHaveBeenCalledWith({ where: { id: 'pack-1' } });
  });

  it('404s for an unknown pack', async () => {
    const prisma = { doctorPack: { findFirst: vi.fn(async () => null) } };
    const res = await request(appFor(prisma)).get('/api/v1/cases/CASE-1/doctor-pack/nope/pdf-url').expect(404);
    expect(res.body.error.message).toContain('not found');
  });

  it('404s when the pack belongs to a DIFFERENT case (cross-case guard)', async () => {
    const prisma = { doctorPack: { findFirst: vi.fn(async () => ({ ...READY_PACK, caseId: 'CASE-OTHER' })) } };
    await request(appFor(prisma)).get('/api/v1/cases/CASE-1/doctor-pack/pack-1/pdf-url').expect(404);
  });

  it('404s when the pack is not ready yet', async () => {
    const prisma = { doctorPack: { findFirst: vi.fn(async () => ({ ...READY_PACK, state: 'generating', pdfS3Key: null })) } };
    const res = await request(appFor(prisma)).get('/api/v1/cases/CASE-1/doctor-pack/pack-1/pdf-url').expect(404);
    expect(res.body.error.message).toContain('not ready');
  });

  it('404s when the PDF object is missing from S3 (HeadObject throws)', async () => {
    const prisma = { doctorPack: { findFirst: vi.fn(async () => READY_PACK) } };
    const s3Send = vi.fn(async () => { throw new Error('NoSuchKey'); });
    const res = await request(appFor(prisma, { s3Send })).get('/api/v1/cases/CASE-1/doctor-pack/pack-1/pdf-url').expect(404);
    expect(res.body.error.message).toContain('missing from storage');
  });

  it('503s when DOCTOR_PACKS_BUCKET_NAME is not configured', async () => {
    const prisma = { doctorPack: { findFirst: vi.fn(async () => READY_PACK) } };
    const app = appFor(prisma);
    delete process.env.DOCTOR_PACKS_BUCKET_NAME;
    await request(app).get('/api/v1/cases/CASE-1/doctor-pack/pack-1/pdf-url').expect(503);
  });
});

describe('POST /cases/:id/doctor-pack/generate — content-aware classification (Chunk D)', () => {
  const RATING_PAGE_1 = 'Department of Veterans Affairs\n\nWe have made a decision on your claim for compensation received on March 12, 2024.';
  const RATING_PAGE_2 = 'REASONS FOR DECISION\n\nEntitlement to service connection for obstructive sleep apnea is established with an evaluation of 50 percent.';
  const BOILERPLATE_PAGE = 'How to appeal this decision. Your rights to appellate review are described here. You may file a Notice of Disagreement using VA Form 9.';

  function generatePrisma() {
    const created: { data?: Record<string, unknown> } = {};
    const tx = {
      keyDoc: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        upsert: vi.fn(async (args: { create: Record<string, unknown> }) => ({ id: 'kd-1', ...args.create })),
      },
      doctorPack: {
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          created.data = args.data;
          return { ...args.data };
        }),
      },
      activityLog: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      case: {
        findFirst: vi.fn(async () => ({
          id: 'CASE-1',
          veteranId: 'VET-1',
          version: 3,
          claimedCondition: 'obstructive sleep apnea',
          claimType: 'initial',
          framingChoice: null,
          upstreamScCondition: null,
          status: 'records_review',
          cdsVerdict: 'not_yet_run',
          cdsOddsPct: null,
          cdsRationale: null,
          veteranStatement: null,
          inServiceEvent: null,
          documents: [{ id: 'doc-1', s3Key: 'cases/CASE-1/aaaa1111-Misc_1.pdf', pageCount: 3, docTag: 'Other' }],
        })),
      },
      doctorPack: { findFirst: vi.fn(async () => null) },
      fileReadStatus: { findMany: vi.fn(async () => []) },
      keyDoc: { findMany: vi.fn(async () => []) },
      documentPage: {
        findMany: vi.fn(async () => [
          { id: 'p1', documentId: 'doc-1', pageNumber: 1, text: RATING_PAGE_1, confidence: 0.99, extractedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
          { id: 'p2', documentId: 'doc-1', pageNumber: 2, text: RATING_PAGE_2, confidence: 0.99, extractedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
          { id: 'p3', documentId: 'doc-1', pageNumber: 3, text: BOILERPLATE_PAGE, confidence: 0.99, extractedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
        ]),
      },
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    return { prisma, tx, created };
  }

  it('classifies Misc_1.pdf as rating_decision from PAGE TEXT and page-selects (no whole-doc fallback)', async () => {
    // The selection Opus makes on this fixture: keep ONLY the substantive decision page (2), drop
    // the VA cover (1) and appeal boilerplate (3). Pinned so the assertion is env-independent.
    invokeAdvisory.mockResolvedValue({
      text: '{"keep":[2],"note":"decision reasons page"}',
      usage: { input_tokens: 100, output_tokens: 20 },
      stopReason: 'end_turn',
      costUsd: 0.01,
    });
    const { prisma, tx, created } = generatePrisma();
    await request(appFor(prisma)).post('/api/v1/cases/CASE-1/doctor-pack/generate').send({}).expect(201);

    // KeyDoc row: content classification won over the meaningless filename.
    const upsert = tx.keyDoc.upsert.mock.calls[0]?.[0] as { create: Record<string, unknown> };
    expect(upsert.create.docType).toBe('rating_decision');
    expect(upsert.create.classification).toBe('high_signal');

    // Manifest entry: the page-picker now targets the SUBSTANTIVE decision page — page 2
    // ("REASONS FOR DECISION ... service connection ... established 50 percent") — and drops
    // BOTH the content-light VA cover (page 1, "we made a decision on your claim received ...")
    // AND the appeal-boilerplate (page 3). The granted condition + rating are preserved; only
    // non-substantive pages are trimmed (2026-06-26 page-picker value-page targeting).
    const manifest = created.data?.manifestJson as { entries: { filePath: string; docType: string; pageRanges: unknown }[] };
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]?.docType).toBe('rating_decision');
    expect(manifest.entries[0]?.pageRanges).toEqual([{ from: 2, to: 2 }]);
    expect(created.data?.pageCount).toBe(1);
  });

  it('physician role cannot generate (POST stays admin/ops_staff — D-2 decision)', async () => {
    const { prisma } = generatePrisma();
    await request(appFor(prisma, { role: 'physician' })).post('/api/v1/cases/CASE-1/doctor-pack/generate').send({}).expect(403);
  });
});

// Items 3+4 (2026-06-11): both key-docs GET endpoints enrich rows via the shared
// s3Key → { filename, documentId, pageCount } helper (Document.s3Key is @unique).
describe('key-docs enrichment (shared helper)', () => {
  const KEY_DOC_ROW = {
    id: 'kd-1',
    caseId: 'CASE-1',
    filePath: 'cases/CASE-1/aaaa1111-Misc_1.pdf',
    docType: 'unspecified',
    classification: 'normal',
    importance: 40,
    pageRanges: [{ from: 1, to: 3 }],
    needsRnReview: true,
    selectorRationale: 'unspecified_large_doc_first_8',
    updatedAt: new Date('2026-06-11T00:00:00.000Z'),
    version: 1,
  };
  const DOCUMENT_ROW = { id: 'doc-1', s3Key: 'cases/CASE-1/aaaa1111-Misc_1.pdf', filename: 'Misc_1.pdf', pageCount: 25 };

  it('GET /cases/:id/key-docs returns filename + documentId + docPageCount (Item 4)', async () => {
    const prisma = {
      keyDoc: { findMany: vi.fn(async () => [KEY_DOC_ROW]) },
      document: { findMany: vi.fn(async () => [DOCUMENT_ROW]) },
    };
    const res = await request(appFor(prisma)).get('/api/v1/cases/CASE-1/key-docs').expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].filename).toBe('Misc_1.pdf');
    expect(res.body.data[0].documentId).toBe('doc-1');
    expect(res.body.data[0].docPageCount).toBe(25);
    // The join queries by the rows' s3Keys (unique), not by caseId.
    expect(prisma.document.findMany).toHaveBeenCalledWith({
      where: { s3Key: { in: ['cases/CASE-1/aaaa1111-Misc_1.pdf'] } },
      select: { id: true, s3Key: true, filename: true, pageCount: true },
    });
  });

  // REMOVED (C7 lifecycle, 2026-06-13): GET /rn/key-docs-needing-review tests — the endpoint
  // was deleted with the vestigial RN "Confirm pack pages" review tab. The /cases/:id/key-docs
  // enrichment tests below stay (that endpoint feeds the live Doctor Pack panel).

  // ── WAVE 2 (assessment 2026-06-12 §3): displayLabel = '<DocType human name> — <original
  // filename>'; 'unspecified' → just the filename. Emitted by BOTH key-docs GET endpoints. ──

  it('GET /cases/:id/key-docs emits displayLabel "<Human type> — <filename>" for known docTypes', async () => {
    const prisma = {
      keyDoc: { findMany: vi.fn(async () => [{ ...KEY_DOC_ROW, docType: 'rating_decision' }]) },
      document: { findMany: vi.fn(async () => [DOCUMENT_ROW]) },
    };
    const res = await request(appFor(prisma)).get('/api/v1/cases/CASE-1/key-docs').expect(200);
    expect(res.body.data[0].displayLabel).toBe('Rating decision — Misc_1.pdf');
  });

  it('GET /cases/:id/key-docs: unspecified docType displayLabel is JUST the filename (no made-up type)', async () => {
    const prisma = {
      keyDoc: { findMany: vi.fn(async () => [KEY_DOC_ROW]) }, // docType 'unspecified'
      document: { findMany: vi.fn(async () => [DOCUMENT_ROW]) },
    };
    const res = await request(appFor(prisma)).get('/api/v1/cases/CASE-1/key-docs').expect(200);
    expect(res.body.data[0].displayLabel).toBe('Misc_1.pdf');
  });

});
