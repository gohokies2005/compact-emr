import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChartReadinessRouter } from '../routes/chart-readiness.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb, CaseRecord, FileReadAttempt, FileReadStatusRecord, FileTerminalStatus, Role } from '../services/db-types.js';

interface MockUser { readonly sub: string; readonly roles: Role[]; }
let mockUser: MockUser | undefined;

// Mock the Opus gut-check so the cache test never hits a real model and we can count fires.
vi.mock('../services/sanity-impression.js', () => ({
  buildSanityImpression: vi.fn(async () => ({ impression: 'looks coherent', summary: 's', missed: [] })),
}));
import { buildSanityImpression } from '../services/sanity-impression.js';

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
    coverMemoSuppressed: false,
    coverMemoTextOverride: null,
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
    // GET /chart-readiness now derives the extraction phase too (Ryan 2026-06-13): no run on file =
    // 'extracting'/'ocr_in_progress' depending on OCR; the tests below only assert ready/blockingFiles.
    // findMany = the sticky-completion run list GET /chart-readiness reads (Ewell 2026-06-14); findFirst
    // = the single-run load GET /extraction-coverage still uses. Both default to "no runs".
    chartExtractionRun: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    // GET /extraction-coverage gained a per-page provenance query in the vision rebuild (#46,
    // chart-readiness.ts ~line 328): db.documentPage.findMany({ where: { document: { caseId } } }).
    // The mock predated that query, so the route hit `undefined.findMany` → 500 (4 red tests, 2026-06-17,
    // NOT a production bug — real Prisma has documentPage). Default to no per-page rows → the coverage
    // service falls back to file-level accounting, exactly what these assertions expect.
    documentPage: { findMany: vi.fn(async () => []) },
    // Stateful sanity-impression cache (cost-safety dedup test): an in-memory map keyed (caseId|stage).
    sanityImpression: (() => {
      const store = new Map<string, { inputHash: string; resultJson: unknown }>();
      const key = (w: { caseId_stage: { caseId: string; stage: string } }) => `${w.caseId_stage.caseId}|${w.caseId_stage.stage}`;
      return {
        findUnique: vi.fn(async (a: { where: { caseId_stage: { caseId: string; stage: string } } }) => store.get(key(a.where)) ?? null),
        upsert: vi.fn(async (a: { where: { caseId_stage: { caseId: string; stage: string } }; create: { inputHash: string; resultJson: unknown }; update: { inputHash: string; resultJson: unknown } }) => {
          const existing = store.get(key(a.where));
          store.set(key(a.where), { inputHash: a.update.inputHash, resultJson: a.update.resultJson });
          return existing ?? a.create;
        }),
      };
    })(),
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
// Symbol-soup garble (v2 signal, threshold 0.40): every word slot embeds symbols/digits → ratio ~1.0.
// (NOT the old hyphen-spaced "w-i-t-h" fixture — v2 correctly reads hyphenated text as clean words.)
const GARBLED = ('Pati$nt 4@ ol# p#esent kn$e p$in lim%ted m0t br0k3n ev!d#nce f@!led r@nge '.repeat(4));
const SHA = 'a'.repeat(64);

describe('chart-readiness routes', () => {
  beforeEach(() => { mockUser = { sub: 'OPS-SUB', roles: ['ops_staff'] }; });

  describe('POST /cases/:id/sanity-impression — Opus cache dedup (cost-safety 2026-06-18)', () => {
    // POST-DRAFT only (the surviving check). The pre-draft second brain is retired (Ryan #68/#72, 2026-06-25).
    const draftText = 'This is a drafted nexus letter. '.repeat(20); // >=200 chars so it's a real post-draft context
    const body = { stage: 'post_draft', claimedCondition: 'OSA', theory: 'secondary to PTSD', scConditions: ['PTSD 70%'], keyFacts: ['CPAP in chart'], draftText };
    it('an identical re-fire is served from cache — Opus runs ONCE, not on every page open', async () => {
      vi.mocked(buildSanityImpression).mockClear();
      const { db } = makeDb();
      const app = appFor(db);
      const r1 = await request(app).post('/api/v1/cases/CASE-1/sanity-impression').send(body).expect(200);
      const r2 = await request(app).post('/api/v1/cases/CASE-1/sanity-impression').send(body).expect(200);
      expect(buildSanityImpression).toHaveBeenCalledTimes(1); // 2nd call hit the cache → no Opus spend
      expect(r2.body.data).toEqual(r1.body.data);
    });
    it('recomputes (Opus runs again) when the inputs actually change', async () => {
      vi.mocked(buildSanityImpression).mockClear();
      const { db } = makeDb();
      const app = appFor(db);
      await request(app).post('/api/v1/cases/CASE-1/sanity-impression').send(body).expect(200);
      await request(app).post('/api/v1/cases/CASE-1/sanity-impression').send({ ...body, theory: 'DIFFERENT theory' }).expect(200);
      expect(buildSanityImpression).toHaveBeenCalledTimes(2); // changed inputs → fresh Opus call (correct)
    });
  });

  describe('POST /cases/:id/sanity-impression — pre-draft second brain RETIRED (one-brain, Ryan #68/#72)', () => {
    it('refuses stage=pre_draft at the seam: returns {data:null} and NEVER fires the Opus call', async () => {
      vi.mocked(buildSanityImpression).mockClear();
      const { db } = makeDb();
      const app = appFor(db);
      const r = await request(app)
        .post('/api/v1/cases/CASE-1/sanity-impression')
        .send({ stage: 'pre_draft', claimedCondition: 'OSA', theory: 'secondary to PTSD' })
        .expect(200);
      expect(r.body.data).toBeNull();
      expect(buildSanityImpression).not.toHaveBeenCalled(); // the divergent pre-draft brain never runs
    });
    it('refuses a missing/absent stage (defaults are NOT pre_draft-evaluated): returns {data:null}, no Opus call', async () => {
      vi.mocked(buildSanityImpression).mockClear();
      const { db } = makeDb();
      const app = appFor(db);
      const r = await request(app)
        .post('/api/v1/cases/CASE-1/sanity-impression')
        .send({ claimedCondition: 'OSA', theory: 'secondary to PTSD' })
        .expect(200);
      expect(r.body.data).toBeNull();
      expect(buildSanityImpression).not.toHaveBeenCalled();
    });
  });

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
    // (2) INTAKE SUMMARY that READ OK: our own generated PDF, terminalStatus 'read' — must be
    //     ABSENT. (P0-1 consistency sweep fixes, 2026-06-14: the intake-summary short-circuit now
    //     applies ONLY when the file actually read — a FAILED uploaded intake-summary surfaces, see
    //     the dedicated failed-intake case below. A genuinely-read generated summary still passes.)
    const intake = seedRow(fileRows, {
      terminalStatus: 'read',
      filePath: `cases/CASE-1/${UUID}-Intake_Summary.pdf`,
      attemptsJson: [{ method: 'native_pdf_text', wordCount: 12, corruptedTokenRatio: 0.0, attemptedAt: '2026-06-10T00:00:00Z', note: 'read' }],
    });
    // (3) GENUINELY GARBLED jpg: fails current thresholds — must REMAIN PRESENT.
    const garbled = seedRow(fileRows, {
      filePath: `cases/CASE-1/${UUID}-Sleep_Study_Photo.jpg`,
      attemptsJson: [{ method: 'tesseract_ocr', wordCount: 120, corruptedTokenRatio: 0.55, attemptedAt: '2026-06-10T00:00:00Z', note: 'garbled (corrupted-token-ratio=0.550 > 0.40)' }],
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

  it('P0-1: a FAILED uploaded intake-summary (manual_summary_required) NOW SURFACES in both queues (no longer masked)', async () => {
    const { db, fileRows } = makeDb();
    // A veteran-UPLOADED "<Last>_Intake_Summary.pdf" that failed OCR + the Claude rescue. The old
    // mask hid it from the RN while the drafter still refused on it (undraftable + invisible).
    const failedIntake = seedRow(fileRows, {
      filePath: `cases/CASE-1/${UUID}-Lozano_Intake_Summary.pdf`,
      attemptsJson: [{ method: 'native_pdf_text', wordCount: 1, charCount: 5, corruptedTokenRatio: 0.0, attemptedAt: '2026-06-10T00:00:00Z', note: 'too-few-words (5 chars < 10)' }],
    });
    const rn = await request(appFor(db)).get('/api/v1/rn/files-pending-manual');
    expect(rn.body.data.map((r: { id: string }) => r.id)).toContain(failedIntake.id);
    const perCase = await request(appFor(db)).get('/api/v1/cases/CASE-1/files-pending-manual');
    expect(perCase.body.data.map((r: { id: string }) => r.id)).toContain(failedIntake.id);
  });

  it('a manual_summary_provided row with an INVALID summary still queues (defense-in-depth parity with the gate)', async () => {
    const { db, fileRows } = makeDb();
    const bogus = seedRow(fileRows, {
      filePath: `cases/CASE-1/${UUID}-Denial_Letter.pdf`,
      terminalStatus: 'manual_summary_provided',
      manualSummary: 'too short',
      attemptsJson: [{ method: 'tesseract_ocr', wordCount: 1, charCount: 6, corruptedTokenRatio: 0.0, attemptedAt: '2026-06-10T00:00:00Z', note: 'too-few-words (6 chars < 10)' }],
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
        attemptsJson: [{ method: 'tesseract_ocr', wordCount: 120, corruptedTokenRatio: 0.55, attemptedAt: '2026-06-10T00:00:00Z', note: 'garbled' }],
      });
    }
    const res = await request(appFor(db)).get('/api/v1/rn/files-pending-manual?limit=2');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(3);
  });

  // ===================== GET /cases/:id/extraction-coverage =====================
  // Transparency report (Ryan 2026-06-14). Mirrors the chart-readiness auth + data loads; the
  // service is unit-tested separately, so these assert the WIRING (document select with pageCount +
  // contentType, the chartExtractionRun load, the documentId join on file-level gaps).

  // The route selects { id, s3Key, filename, contentType, pageCount } — the shared makeDb document
  // mock only returns { id, s3Key }. Override it per-test so coverage sees real page counts.
  function withCoverageDocs(db: AppDb, docs: readonly { id: string; s3Key: string; filename?: string; contentType?: string | null; pageCount?: number | null }[]): void {
    (db.document.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      docs.map((d) => ({ id: d.id, s3Key: d.s3Key, filename: d.filename ?? 'file.pdf', contentType: d.contentType ?? null, pageCount: d.pageCount ?? null })),
    );
  }

  it('GET extraction-coverage reports 100% for a clean fully-read chart', async () => {
    const { db, fileRows } = makeDb();
    seedRow(fileRows, { id: 'R1', filePath: 'cases/CASE-1/k1.pdf', terminalStatus: 'read' });
    seedRow(fileRows, { id: 'R2', filePath: 'cases/CASE-1/k2.pdf', terminalStatus: 'read' });
    withCoverageDocs(db, [
      { id: 'D1', s3Key: 'cases/CASE-1/k1.pdf', pageCount: 5 },
      { id: 'D2', s3Key: 'cases/CASE-1/k2.pdf', pageCount: 7 },
    ]);
    (db as unknown as { chartExtractionRun: { findFirst: ReturnType<typeof vi.fn> } }).chartExtractionRun.findFirst.mockResolvedValue({ status: 'complete', resultJson: { gaps: { uncoveredPages: 0, truncatedWindows: 0 } } });

    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/extraction-coverage');
    expect(res.status).toBe(200);
    expect(res.body.data.coveragePct).toBe(100);
    expect(res.body.data.totalPages).toBe(12);
    expect(res.body.data.extractedPages).toBe(12);
    expect(res.body.data.gaps).toHaveLength(0);
    expect(res.body.data.status).toBe('complete');
  });

  it('GET extraction-coverage surfaces an unread image gap with documentId + isImage', async () => {
    const { db, fileRows } = makeDb();
    seedRow(fileRows, { id: 'R1', filePath: 'cases/CASE-1/k1.pdf', terminalStatus: 'read' });
    seedRow(fileRows, { id: 'R2', filePath: 'cases/CASE-1/photo.jpg', terminalStatus: 'manual_summary_required' });
    withCoverageDocs(db, [
      { id: 'D1', s3Key: 'cases/CASE-1/k1.pdf', pageCount: 5 },
      { id: 'DI', s3Key: 'cases/CASE-1/photo.jpg', filename: 'photo.jpg', contentType: 'image/jpeg', pageCount: 1 },
    ]);
    (db as unknown as { chartExtractionRun: { findFirst: ReturnType<typeof vi.fn> } }).chartExtractionRun.findFirst.mockResolvedValue({ status: 'complete_with_gaps', resultJson: { gaps: { uncoveredPages: 0, truncatedWindows: 0 } } });

    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/extraction-coverage');
    expect(res.status).toBe(200);
    expect(res.body.data.gaps).toHaveLength(1);
    expect(res.body.data.gaps[0].documentId).toBe('DI');
    expect(res.body.data.gaps[0].isImage).toBe(true);
    expect(res.body.data.gaps[0].reason).toBe('unreadable_image');
    expect(res.body.data.gaps[0].fileName).toBe('photo.jpg');
    expect(res.body.data.coveragePct).toBe(83);
  });

  it('GET extraction-coverage folds a truncated run into a truncated_dense gap', async () => {
    const { db, fileRows } = makeDb();
    seedRow(fileRows, { id: 'R1', filePath: 'cases/CASE-1/k1.pdf', terminalStatus: 'read' });
    withCoverageDocs(db, [{ id: 'D1', s3Key: 'cases/CASE-1/k1.pdf', pageCount: 40 }]);
    (db as unknown as { chartExtractionRun: { findFirst: ReturnType<typeof vi.fn> } }).chartExtractionRun.findFirst.mockResolvedValue({ status: 'complete_with_gaps', resultJson: { gaps: { uncoveredPages: 0, truncatedWindows: 2 } } });

    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/extraction-coverage');
    expect(res.body.data.gaps).toHaveLength(1);
    expect(res.body.data.gaps[0].reason).toBe('truncated_dense');
    expect(res.body.data.gaps[0].documentId).toBeNull();
    expect(res.body.data.status).toBe('complete_with_gaps');
  });

  it('GET extraction-coverage requires auth (401 without a user)', async () => {
    const { db } = makeDb();
    mockUser = undefined;
    const res = await request(appFor(db)).get('/api/v1/cases/CASE-1/extraction-coverage');
    expect(res.status).toBe(401);
  });
});
