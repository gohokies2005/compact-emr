import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChartReadinessRouter } from '../routes/chart-readiness.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb, CaseRecord, FileReadAttempt, FileReadStatusRecord, FileTerminalStatus, Role } from '../services/db-types.js';

interface MockUser { readonly sub: string; readonly roles: Role[]; }
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

function baseCase(): CaseRecord {
  const now = new Date('2026-05-26T00:00:00.000Z');
  return {
    id: 'CASE-1', veteranId: 'VET-1', claimedCondition: 'OSA', claimedConditions: ['OSA'], claimType: 'initial',
    previouslyDenied: false, priorDenialReason: null, priorDecisionDate: null,
    framingChoice: 'secondary', upstreamScCondition: 'PTSD', veteranStatement: null, inServiceEvent: null,
    status: 'records', cdsVerdict: 'not_yet_run', cdsOddsPct: null, cdsRationale: null,
    assignedPhysicianId: null, assignedRnId: null, refundEligible: false, currentVersion: 0,
    createdAt: now, updatedAt: now, version: 1,
  };
}

function makeDb(c: CaseRecord = baseCase()) {
  const fileRows = new Map<string, FileReadStatusRecord>();
  // Readiness rows whose chart Document was deleted — the document.findMany mock omits them, so the
  // routes' liveKeys reconcile must drop them from queue payloads (orphan never queues).
  const orphanedPaths = new Set<string>();
  let seq = 1;

  const tx = {
    case: {
      findFirst: vi.fn(async () => c),
      findUnique: vi.fn(async () => c),
      // Enrichment join (/rn/files-pending-manual): mirrors Prisma's select { id, claimedCondition,
      // veteran: { select: { firstName, lastName } } } for the single mock case.
      findMany: vi.fn(async (args: { where?: { id?: { in?: readonly string[] } } } = {}) => {
        const ids = args.where?.id?.in;
        if (ids !== undefined && !ids.includes(c.id)) return [];
        return [{ id: c.id, claimedCondition: c.claimedCondition, veteran: { firstName: 'Robert', lastName: 'Yorde' } }];
      }),
      count: vi.fn(), create: vi.fn(), update: vi.fn(),
    },
    activityLog: { create: vi.fn(async () => ({})) },
    // Reconciliation (chart-readiness route): every readiness row has a live document (unless marked
    // orphaned above), so nothing is filtered as orphaned — the existing block/ready assertions hold.
    // The id mirrors what Prisma returns for the route's { id, s3Key } select (documentId join,
    // CLM-BBFCB3F8CE fix 5).
    document: { findMany: vi.fn(async () => [...fileRows.values()].filter((r) => !orphanedPaths.has(r.filePath)).map((r) => ({ id: `DOC-${r.id}`, s3Key: r.filePath }))) },
    fileReadStatus: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => fileRows.get(args.where.id) ?? null),
      findFirst: vi.fn(async (args: { where?: { caseId?: string; filePath?: string; id?: string } }) => {
        for (const r of fileRows.values()) {
          if (args.where?.id !== undefined && r.id !== args.where.id) continue;
          if (args.where?.caseId !== undefined && r.caseId !== args.where.caseId) continue;
          if (args.where?.filePath !== undefined && r.filePath !== args.where.filePath) continue;
          return r;
        }
        return null;
      }),
      findMany: vi.fn(async (args: { where?: { caseId?: string; terminalStatus?: FileTerminalStatus | { in: readonly FileTerminalStatus[] } } } = {}) => {
        return [...fileRows.values()].filter((r) => {
          if (args.where?.caseId !== undefined && r.caseId !== args.where.caseId) return false;
          const ts = args.where?.terminalStatus;
          if (typeof ts === 'string' && r.terminalStatus !== ts) return false;
          if (typeof ts === 'object' && ts !== null && !ts.in.includes(r.terminalStatus)) return false;
          return true;
        });
      }),
      create: vi.fn(async (args: { data: Omit<FileReadStatusRecord, 'id' | 'createdAt' | 'updatedAt' | 'version'> }) => {
        const id = `FRS-${seq++}`;
        const now = new Date();
        const row: FileReadStatusRecord = { id, ...args.data, attemptsJson: args.data.attemptsJson as readonly FileReadAttempt[], createdAt: now, updatedAt: now, version: 1 };
        fileRows.set(id, row);
        return row;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Partial<FileReadStatusRecord> & { version?: { increment: number } } }) => {
        const current = fileRows.get(args.where.id);
        if (!current) throw new Error('missing file_read_status row in mock');
        const next: FileReadStatusRecord = {
          ...current,
          ...args.data,
          version: typeof args.data.version === 'object' ? current.version + 1 : current.version,
        } as FileReadStatusRecord;
        fileRows.set(args.where.id, next);
        return next;
      }),
      upsert: vi.fn(),
    },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn: (innerTx: typeof tx) => unknown) => fn(tx)) } as unknown as AppDb;
  return { db, fileRows, orphanedPaths, tx };
}

// Seed a FileReadStatus row DIRECTLY into the mock store. The POST route can't create the
// retro-heal class (the CURRENT classifier would mark a 25-word attempt 'read'); these rows
// simulate classification under the OLD 40-word threshold — exactly the live false-positive set.
let seedSeq = 1;
function seedRow(fileRows: Map<string, FileReadStatusRecord>, overrides: Partial<FileReadStatusRecord>): FileReadStatusRecord {
  const now = new Date('2026-06-11T00:00:00.000Z');
  const row: FileReadStatusRecord = {
    id: `SEED-${seedSeq++}`,
    caseId: 'CASE-1',
    filePath: 'cases/CASE-1/uuid-file.pdf',
    fileSha256: 'a'.repeat(64),
    terminalStatus: 'manual_summary_required',
    attemptsJson: [],
    manualSummary: null,
    manualSummaryAt: null,
    manualSummaryBy: null,
    lastCheckedAt: now,
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...overrides,
  };
  fileRows.set(row.id, row);
  return row;
}

function appFor(db: AppDb) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, _res, next) => { if (mockUser) (req as express.Request & { user?: MockUser }).user = mockUser; next(); });
  app.use('/api/v1', createChartReadinessRouter(db));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
    return sendError(res, 500, 'internal_error', 'Unexpected server error.');
  });
  return app;
}

const CLEAN_TEXT = 'The veteran is a fifty year old male with documented right knee pain. He served on active duty from two thousand one to two thousand eight in the United States Army with a primary military occupational specialty in infantry. He reports gradual onset of symptoms during service with progression after separation. Imaging confirms degenerative changes in the right knee compartment.';
const GARBLED = ('Pati$nt is a 4@ year ol# male p#esent!ng w-i-t-h r!ght kn$e p$in and lim%ted r@nge of m0t!on '.repeat(4));
const SHA = 'a'.repeat(64);

describe('chart-readiness routes', () => {
  beforeEach(() => { mockUser = { sub: 'OPS-SUB', roles: ['ops_staff'] }; });

  it('POST read-attempt with clean native text marks file as read', async () => {
    const { db, fileRows } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/files/read-attempts').send({
      filePath: 'records/dd214.pdf', fileSha256: SHA, method: 'native_pdf_text', extractedText: CLEAN_TEXT,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.terminalStatus).toBe('read');
    expect([...fileRows.values()][0]?.terminalStatus).toBe('read');
  });

  it('POST read-attempt with garbled OCR text marks file as manual_summary_required', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/files/read-attempts').send({
      filePath: 'records/scan.pdf', fileSha256: SHA, method: 'tesseract_ocr', extractedText: GARBLED,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.terminalStatus).toBe('manual_summary_required');
  });

  it('POST read-attempt rejects unknown method with 400', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/files/read-attempts').send({
      filePath: 'records/x.pdf', fileSha256: SHA, method: 'magic_8_ball', extractedText: CLEAN_TEXT,
    });
    expect(res.status).toBe(400);
  });

  it('POST read-attempt rejects malformed sha256 with 400', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db)).post('/api/v1/cases/CASE-1/files/read-attempts').send({
      filePath: 'records/x.pdf', fileSha256: 'not-a-sha', method: 'native_pdf_text', extractedText: CLEAN_TEXT,
    });
    expect(res.status).toBe(400);
  });

  it('POST read-attempt returns 404 for missing case', async () => {
    const { db } = makeDb();
    (db.case.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await request(appFor(db)).post('/api/v1/cases/NOPE/files/read-attempts').send({
      filePath: 'records/x.pdf', fileSha256: SHA, method: 'native_pdf_text', extractedText: CLEAN_TEXT,
    });
    expect(res.status).toBe(404);
  });

  it('Re-running a successful attempt over a previously-failed file flips terminalStatus to read', async () => {
    const { db, fileRows } = makeDb();
    await request(appFor(db)).post('/api/v1/cases/CASE-1/files/read-attempts').send({
      filePath: 'records/scan.pdf', fileSha256: SHA, method: 'tesseract_ocr', extractedText: GARBLED,
    });
    expect([...fileRows.values()][0]?.terminalStatus).toBe('manual_summary_required');

    await request(appFor(db)).post('/api/v1/cases/CASE-1/files/read-attempts').send({
      filePath: 'records/scan.pdf', fileSha256: SHA, method: 'claude_vision', extractedText: CLEAN_TEXT,
    });
    expect([...fileRows.values()][0]?.terminalStatus).toBe('read');
    // Both attempts preserved in the audit trail.
    expect([...fileRows.values()][0]?.attemptsJson.length).toBe(2);
  });

  it('GET chart-readiness returns ready=true when no files', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/chart-readiness');
    expect(res.status).toBe(200);
    expect(res.body.data.ready).toBe(true);
  });

  it('GET chart-readiness returns ready=false when a file is blocking', async () => {
    const { db } = makeDb();
    await request(appFor(db)).post('/api/v1/cases/CASE-1/files/read-attempts').send({
      filePath: 'records/scan.pdf', fileSha256: SHA, method: 'tesseract_ocr', extractedText: GARBLED,
    });
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/chart-readiness');
    expect(res.body.data.ready).toBe(false);
    expect(res.body.data.blockingFiles).toHaveLength(1);
  });

  it('GET chart-readiness includes the matching documentId on each blocking file (clickable link join)', async () => {
    // CLM-BBFCB3F8CE fix 5 (2026-06-11): the Document row exists for every blocking file, but the
    // payload never carried its id — so the UI showed a dead filename instead of a clickable link.
    const { db } = makeDb();
    const post = await request(appFor(db)).post('/api/v1/cases/CASE-1/files/read-attempts').send({
      filePath: 'records/scan.pdf', fileSha256: SHA, method: 'tesseract_ocr', extractedText: GARBLED,
    });
    const fileReadStatusId = post.body.data.id as string;
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/chart-readiness');
    expect(res.status).toBe(200);
    expect(res.body.data.blockingFiles).toHaveLength(1);
    expect(res.body.data.blockingFiles[0].documentId).toBe(`DOC-${fileReadStatusId}`);
    // The readiness row id remains alongside (unchanged contract).
    expect(res.body.data.blockingFiles[0].fileReadStatusId).toBe(fileReadStatusId);
  });

  it('POST manual-summary rejects summaries shorter than 40 chars with 400', async () => {
    const { db } = makeDb();
    const post = await request(appFor(db)).post('/api/v1/cases/CASE-1/files/read-attempts').send({
      filePath: 'records/scan.pdf', fileSha256: SHA, method: 'tesseract_ocr', extractedText: GARBLED,
    });
    const fileId = post.body.data.id;
    const res = await request(appFor(db)).post(`/api/v1/cases/CASE-1/files/${fileId}/manual-summary`).send({ summary: 'too short' });
    expect(res.status).toBe(400);
  });

  it('POST manual-summary flips terminalStatus to manual_summary_provided and clears the block', async () => {
    const { db } = makeDb();
    const post = await request(appFor(db)).post('/api/v1/cases/CASE-1/files/read-attempts').send({
      filePath: 'records/scan.pdf', fileSha256: SHA, method: 'tesseract_ocr', extractedText: GARBLED,
    });
    const fileId = post.body.data.id;
    const summary = 'Rating decision dated 2024 confirming PTSD service connection at 70 percent. RN reviewed.';
    const res = await request(appFor(db)).post(`/api/v1/cases/CASE-1/files/${fileId}/manual-summary`).send({ summary });
    expect(res.status).toBe(200);
    expect(res.body.data.terminalStatus).toBe('manual_summary_provided');
    expect(res.body.data.manualSummary).toBe(summary);

    const readiness = await request(appFor(db)).get('/api/v1/cases/CASE-1/chart-readiness');
    expect(readiness.body.data.ready).toBe(true);
  });

  it('POST manual-summary conflicts (409) when file was already read by a machine', async () => {
    const { db } = makeDb();
    const post = await request(appFor(db)).post('/api/v1/cases/CASE-1/files/read-attempts').send({
      filePath: 'records/dd214.pdf', fileSha256: SHA, method: 'native_pdf_text', extractedText: CLEAN_TEXT,
    });
    const fileId = post.body.data.id;
    const summary = 'Rating decision dated 2024 confirming PTSD service connection at 70 percent. RN reviewed.';
    const res = await request(appFor(db)).post(`/api/v1/cases/CASE-1/files/${fileId}/manual-summary`).send({ summary });
    expect(res.status).toBe(409);
  });

  it('GET files-pending-manual lists only manual_summary_required rows', async () => {
    const { db } = makeDb();
    await request(appFor(db)).post('/api/v1/cases/CASE-1/files/read-attempts').send({
      filePath: 'records/clean.pdf', fileSha256: SHA, method: 'native_pdf_text', extractedText: CLEAN_TEXT,
    });
    await request(appFor(db)).post('/api/v1/cases/CASE-1/files/read-attempts').send({
      filePath: 'records/scan.pdf', fileSha256: SHA, method: 'tesseract_ocr', extractedText: GARBLED,
    });
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/files-pending-manual');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].filePath).toBe('records/scan.pdf');
  });
});

// ── Package 1 (H)+(J), 2026-06-11: both pending queues derive from the evaluator ──────────────
// The raw terminalStatus reads made 15/16 queue rows false positives: rows classified under the
// OLD 40-word threshold (now healed by evaluateChartReadiness) and generated intake summaries
// still queued. Both routes now share isEffectivelyRead + the liveKeys reconcile, so the queue
// agrees with GET /chart-readiness — a healed/reconciled file NEVER appears.
describe('files-pending-manual queues (evaluator-derived + enriched)', () => {
  beforeEach(() => { mockUser = { sub: 'OPS-SUB', roles: ['ops_staff'] }; });

  const UUID = '123e4567-e89b-42d3-a456-426614174000';

  function seedQueueScenario(fileRows: Map<string, FileReadStatusRecord>) {
    // (1) HEALED: stored manual_summary_required under the old 40-word gate, but the recorded
    //     attempt passes CURRENT thresholds (25 words >= 20, ratio 0.0) — must be ABSENT.
    const healed = seedRow(fileRows, {
      filePath: `cases/CASE-1/${UUID}-Thomas_OSA_Misc_3.png`,
      attemptsJson: [{ method: 'textract', wordCount: 25, corruptedTokenRatio: 0.0, attemptedAt: '2026-06-10T00:00:00Z', note: 'too-few-words (25 < 40)' }],
    });
    // (2) INTAKE SUMMARY: our own generated PDF — always valid, must be ABSENT.
    const intake = seedRow(fileRows, {
      filePath: `cases/CASE-1/${UUID}-Intake_Summary.pdf`,
      attemptsJson: [{ method: 'native_pdf_text', wordCount: 5, corruptedTokenRatio: 0.0, attemptedAt: '2026-06-10T00:00:00Z', note: 'too-few-words (5 < 20)' }],
    });
    // (3) GENUINELY GARBLED jpg: fails current thresholds — must REMAIN PRESENT.
    const garbled = seedRow(fileRows, {
      filePath: `cases/CASE-1/${UUID}-Sleep_Study_Photo.jpg`,
      attemptsJson: [{ method: 'tesseract_ocr', wordCount: 120, corruptedTokenRatio: 0.21, attemptedAt: '2026-06-10T00:00:00Z', note: 'garbled (corrupted-token-ratio=0.210 > 0.08)' }],
    });
    return { healed, intake, garbled };
  }

  it('live-regression lock (per-case route): healed + intake-summary rows ABSENT, garbled row PRESENT', async () => {
    const { db, fileRows } = makeDb();
    const { garbled } = seedQueueScenario(fileRows);
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/files-pending-manual');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(garbled.id);
    expect(res.body.data[0].filePath).toBe(garbled.filePath);
  });

  it('live-regression lock (cross-case /rn route): healed + intake-summary rows ABSENT, garbled PRESENT, total = post-filter count', async () => {
    const { db, fileRows } = makeDb();
    const { garbled } = seedQueueScenario(fileRows);
    const res = await request(appFor(db)).get('/api/v1/rn/files-pending-manual');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(garbled.id);
    expect(res.body.total).toBe(1);
  });

  it('/rn rows are enriched with veteranName, claimedCondition, documentId, and the abbreviated fileName', async () => {
    const { db, fileRows } = makeDb();
    const { garbled } = seedQueueScenario(fileRows);
    const res = await request(appFor(db)).get('/api/v1/rn/files-pending-manual');
    expect(res.status).toBe(200);
    const row = res.body.data[0];
    expect(row.veteranName).toBe('Yorde, Robert');
    expect(row.claimedCondition).toBe('OSA');
    expect(row.documentId).toBe(`DOC-${garbled.id}`);
    // fileName = basename minus the uuid- prefix (the human filename, not the raw S3 key).
    expect(row.fileName).toBe('Sleep_Study_Photo.jpg');
  });

  it('per-case rows also carry documentId + fileName (clickable link parity)', async () => {
    const { db, fileRows } = makeDb();
    const { garbled } = seedQueueScenario(fileRows);
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/files-pending-manual');
    expect(res.body.data[0].documentId).toBe(`DOC-${garbled.id}`);
    expect(res.body.data[0].fileName).toBe('Sleep_Study_Photo.jpg');
  });

  it('a manual_summary_provided row with an INVALID summary still queues (defense-in-depth parity with the gate)', async () => {
    const { db, fileRows } = makeDb();
    const bogus = seedRow(fileRows, {
      filePath: `cases/CASE-1/${UUID}-Denial_Letter.pdf`,
      terminalStatus: 'manual_summary_provided',
      manualSummary: 'too short',
      attemptsJson: [{ method: 'tesseract_ocr', wordCount: 6, corruptedTokenRatio: 0.0, attemptedAt: '2026-06-10T00:00:00Z', note: 'too-few-words (6 < 20)' }],
    });
    const rn = await request(appFor(db)).get('/api/v1/rn/files-pending-manual');
    expect(rn.body.data.map((r: { id: string }) => r.id)).toContain(bogus.id);
    const perCase = await request(appFor(db)).get('/api/v1/cases/CASE-1/files-pending-manual');
    expect(perCase.body.data.map((r: { id: string }) => r.id)).toContain(bogus.id);
  });

  it('an orphaned readiness row (no live chart Document) never queues — same reconcile as GET /chart-readiness', async () => {
    const { db, fileRows, orphanedPaths } = makeDb();
    const { garbled } = seedQueueScenario(fileRows);
    orphanedPaths.add(garbled.filePath);
    const rn = await request(appFor(db)).get('/api/v1/rn/files-pending-manual');
    expect(rn.body.data).toHaveLength(0);
    expect(rn.body.total).toBe(0);
    const perCase = await request(appFor(db)).get('/api/v1/cases/CASE-1/files-pending-manual');
    expect(perCase.body.data).toHaveLength(0);
  });

  it('?limit bounds data but total still reports the full post-filter count', async () => {
    const { db, fileRows } = makeDb();
    for (let i = 0; i < 3; i++) {
      seedRow(fileRows, {
        filePath: `cases/CASE-1/${UUID}-garbled_${i}.jpg`,
        attemptsJson: [{ method: 'tesseract_ocr', wordCount: 120, corruptedTokenRatio: 0.21, attemptedAt: '2026-06-10T00:00:00Z', note: 'garbled' }],
      });
    }
    const res = await request(appFor(db)).get('/api/v1/rn/files-pending-manual?limit=2');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(3);
  });
});
