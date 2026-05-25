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
    id: 'CASE-1', veteranId: 'VET-1', claimedCondition: 'OSA', claimType: 'initial',
    framingChoice: 'secondary', upstreamScCondition: 'PTSD', veteranStatement: null, inServiceEvent: null,
    status: 'records', cdsVerdict: 'not_yet_run', cdsOddsPct: null, cdsRationale: null,
    assignedPhysicianId: null, refundEligible: false, currentVersion: 0,
    createdAt: now, updatedAt: now, version: 1,
  };
}

function makeDb(c: CaseRecord = baseCase()) {
  const fileRows = new Map<string, FileReadStatusRecord>();
  let seq = 1;

  const tx = {
    case: { findFirst: vi.fn(async () => c), findUnique: vi.fn(async () => c), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
    activityLog: { create: vi.fn(async () => ({})) },
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
      findMany: vi.fn(async (args: { where?: { caseId?: string; terminalStatus?: FileTerminalStatus } } = {}) => {
        return [...fileRows.values()].filter((r) => {
          if (args.where?.caseId !== undefined && r.caseId !== args.where.caseId) return false;
          if (args.where?.terminalStatus !== undefined && r.terminalStatus !== args.where.terminalStatus) return false;
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
  return { db, fileRows, tx };
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
