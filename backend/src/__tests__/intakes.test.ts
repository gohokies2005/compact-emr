import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { createIntakesRouter } from '../routes/intakes.js';
import { uploadReviewConversion } from '../services/google-ads-conversions.js';

// Mock the Google Ads conversion upload so the assign tests can assert call/no-call + that a failure is
// swallowed — WITHOUT hitting Secrets Manager / OAuth / Data Manager (#219).
vi.mock('../services/google-ads-conversions.js', () => ({
  uploadReviewConversion: vi.fn(async () => undefined),
}));
const mockUpload = vi.mocked(uploadReviewConversion);

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

// ───────────────────────── SUMMARY (lazy generate-if-missing) ─────────────────────────

// The summary endpoint PRESIGNS, which needs a real S3Client (the presigner reads client.config /
// middleware). Use a real client but override .send so we control HeadObject/PutObject responses.
function summaryApp(db: unknown, s3send: (cmd: unknown) => Promise<unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as { user?: unknown }).user = { sub: 'rn-1', email: 'rn@e.com', roles: ['ops_staff'] }; next(); });
  const s3 = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  (s3 as unknown as { send: (cmd: unknown) => Promise<unknown> }).send = s3send;
  app.use('/api/v1', createIntakesRouter(db as never, { s3: s3 as never, bucketName: 'phi-bucket' }));
  return app;
}
const READY_WITH_ANSWERS = {
  id: 'i1', status: 'ready', submittedName: 'Marcus Justice', submittedCondition: 'unspecified_genitourinary', submittedFormTitle: 'Stage 2',
  rawAnswersJson: {
    q1: { type: 'control_textbox', name: 's2_dob_s1', text: 'Date of Birth', answer: '08/13/1985' },
    q2: { type: 'control_textarea', name: 's2_why_s1', text: 'Why connected', answer: 'urinary symptoms since service' },
  },
};

// AWS SDK throws a NotFound-shaped error when HeadObject misses.
function notFound() { const e = new Error('NotFound'); (e as { name: string }).name = 'NotFound'; return e; }

describe('intakes summary (generate-if-missing)', () => {
  it('GENERATES the summary on a cache MISS (Head 404 → render → PutObject) and returns a presigned URL', async () => {
    const sent: string[] = [];
    const s3send = vi.fn(async (cmd: unknown) => {
      const ctor = (cmd as { constructor: { name: string } }).constructor.name;
      sent.push(ctor);
      if (ctor === 'HeadObjectCommand') throw notFound(); // miss → render
      return {};
    });
    const db = { intake: { findUnique: async () => READY_WITH_ANSWERS } };
    const res = await request(summaryApp(db, s3send)).get('/api/v1/intakes/i1/summary').expect(200);
    expect(sent).toContain('HeadObjectCommand'); // checked the cache
    expect(sent).toContain('PutObjectCommand');  // rendered + stored
    expect(res.body.data.generated).toBe(true);
    expect(res.body.data.contentType).toBe('application/pdf');
    expect(typeof res.body.data.previewUrl).toBe('string');
  });

  it('SERVES from cache on a HIT (Head succeeds → no PutObject, just presign)', async () => {
    const sent: string[] = [];
    const s3send = vi.fn(async (cmd: unknown) => { sent.push((cmd as { constructor: { name: string } }).constructor.name); return {}; });
    const db = { intake: { findUnique: async () => READY_WITH_ANSWERS } };
    const res = await request(summaryApp(db, s3send)).get('/api/v1/intakes/i1/summary').expect(200);
    expect(sent).toContain('HeadObjectCommand');
    expect(sent).not.toContain('PutObjectCommand'); // cache hit → no regeneration
    expect(res.body.data.generated).toBe(false);
    expect(typeof res.body.data.previewUrl).toBe('string');
  });

  it('uses an intake-scoped key OUTSIDE cases/ so the summary never counts as a record', async () => {
    let putKey = '';
    const s3send = vi.fn(async (cmd: unknown) => {
      const c = cmd as { constructor: { name: string }; input?: { Key?: string } };
      if (c.constructor.name === 'HeadObjectCommand') throw notFound();
      if (c.constructor.name === 'PutObjectCommand') putKey = c.input?.Key ?? '';
      return {};
    });
    const db = { intake: { findUnique: async () => READY_WITH_ANSWERS } };
    await request(summaryApp(db, s3send)).get('/api/v1/intakes/i1/summary').expect(200);
    expect(putKey).toBe('intake-summaries/i1.pdf');
    expect(putKey.startsWith('cases/')).toBe(false);
  });

  it('404s when the intake does not exist', async () => {
    const db = { intake: { findUnique: async () => null } };
    await request(summaryApp(db, vi.fn(async () => ({})))).get('/api/v1/intakes/nope/summary').expect(404);
  });

  it('422s when the intake has no captured answers to summarize', async () => {
    const db = { intake: { findUnique: async () => ({ id: 'i1', status: 'ready', rawAnswersJson: null }) } };
    const s3send = vi.fn(async (cmd: unknown) => { if ((cmd as { constructor: { name: string } }).constructor.name === 'HeadObjectCommand') throw notFound(); return {}; });
    await request(summaryApp(db, s3send)).get('/api/v1/intakes/i1/summary').expect(422);
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
      document: { create: docCreate, delete: docDelete, findFirst: vi.fn().mockResolvedValue(null) },
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
      document: { create: docCreate, delete: docDelete, findFirst: vi.fn().mockResolvedValue(null) },
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
      document: { create: docCreate, delete: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
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
      document: { create: docCreate, delete: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    };
    const res = await request(assignApp(db, s3send)).post('/api/v1/intakes/i1/assign').send({ veteranId: 'VET-1', caseId: 'CLM-1' }).expect(200);
    const calls = docCreate.mock.calls as unknown as Array<[{ data: { filename: string; contentType: string; s3Key: string } }]>;
    const summary = calls.find((c) => c[0].data.filename === 'Intake_Summary.pdf');
    expect(summary).toBeTruthy();
    expect(summary![0].data.contentType).toBe('application/pdf');
    // Deterministic per-intake key with the load-bearing reserved suffix (2026-07-14 idempotency fix):
    // cases/<caseId>/<intakeId>-Intake_Summary.pdf — cases.ts / chart-readiness.ts / key-docs-classifier.ts
    // all anchor on the '-Intake_Summary.pdf' suffix.
    expect(summary![0].data.s3Key).toBe('cases/CLM-1/i1-Intake_Summary.pdf');
    expect(res.body.data.attached.some((a: { name: string }) => a.name === 'Intake_Summary.pdf')).toBe(true);
    expect(s3send).toHaveBeenCalled(); // PutObject of the PDF bytes
  });

  it('does NOT mint a second Intake_Summary.pdf when one already exists (hash-drift idempotency, s3Key-suffix guard)', async () => {
    // Dick/Mittge stuck-gate, 2026-06-26: a duplicate Intake_Summary.pdf drifted the chart-build
    // trigger hash → readiness wedged on 'extracting'. The mint must be skipped when one exists.
    // Since 2026-07-14 the guard matches the IMMUTABLE s3Key suffix, not filename equality.
    const docCreate = vi.fn(async () => ({ id: 'doc-s' }));
    const docFindFirst = vi.fn(async () => ({ id: 'existing-summary' }));
    const s3send = vi.fn(async () => ({}));
    const intakeUpdate = vi.fn(async () => ({}));
    const db = {
      intake: {
        findUnique: async () => ({
          id: 'i1', status: 'ready', fileManifestJson: [], submittedName: 'Marcus Justice',
          rawAnswersJson: { q1: { type: 'control_textbox', name: 's2_dob_s1', text: 'Date of Birth', answer: '08/13/1985' } },
        }),
        update: intakeUpdate,
      },
      $transaction: txWithExisting(),
      // A generated summary ALREADY exists on this case → the mint must be skipped.
      document: { create: docCreate, delete: vi.fn(), findFirst: docFindFirst },
    };
    const res = await request(assignApp(db, s3send)).post('/api/v1/intakes/i1/assign').send({ veteranId: 'VET-1', caseId: 'CLM-1' }).expect(200);
    // The guard queries by caseId + the reserved immutable s3Key suffix (NOT filename equality).
    expect(docFindFirst).toHaveBeenCalledWith({
      where: { caseId: 'CLM-1', s3Key: { endsWith: '-Intake_Summary.pdf' } },
      select: { id: true },
    });
    const calls = docCreate.mock.calls as unknown as Array<[{ data: { filename: string } }]>;
    expect(calls.find((c) => c[0].data.filename === 'Intake_Summary.pdf')).toBeFalsy(); // NO second mint
    expect(res.body.data.attached.some((a: { name: string }) => a.name === 'Intake_Summary.pdf')).toBe(false);
    expect(res.body.data.assigned).toBe(true); // still assigns
  });

  it('does NOT re-mint when the AI titler RENAMED the existing summary (filename changed, s3Key intact)', async () => {
    // The dup-mint incident (×2-4 on 7 cases incl. paid): aiDocumentTitle renamed the summary's
    // filename, defeating the old filename==='Intake_Summary.pdf' guard. Emulate a DB whose only
    // summary row has a titler-renamed filename but the immutable generated s3Key: the suffix guard
    // must still find it. (A filename-equality query against this store returns null → would re-mint.)
    const existingDocs = [{ id: 'doc-old', caseId: 'CLM-1', filename: 'Justice_intake-summary.pdf', s3Key: 'cases/CLM-1/i0-Intake_Summary.pdf' }];
    const docFindFirst = vi.fn(async (args: { where: { caseId?: string; filename?: string; s3Key?: { endsWith?: string } } }) => {
      const w = args?.where ?? {};
      return existingDocs.find((d) =>
        (w.caseId === undefined || d.caseId === w.caseId)
        && (w.filename === undefined || d.filename === w.filename)
        && (w.s3Key?.endsWith === undefined || d.s3Key.endsWith(w.s3Key.endsWith)),
      ) ?? null;
    });
    const docCreate = vi.fn(async () => ({ id: 'doc-s' }));
    const db = {
      intake: {
        findUnique: async () => ({
          id: 'i1', status: 'ready', fileManifestJson: [], submittedName: 'Marcus Justice',
          rawAnswersJson: { q1: { type: 'control_textbox', name: 's2_dob_s1', text: 'Date of Birth', answer: '08/13/1985' } },
        }),
        update: vi.fn(async () => ({})),
      },
      $transaction: txWithExisting(),
      document: { create: docCreate, delete: vi.fn(), findFirst: docFindFirst },
    };
    const res = await request(assignApp(db, vi.fn(async () => ({})))).post('/api/v1/intakes/i1/assign').send({ veteranId: 'VET-1', caseId: 'CLM-1' }).expect(200);
    const calls = docCreate.mock.calls as unknown as Array<[{ data: { filename: string } }]>;
    expect(calls.find((c) => c[0].data.filename === 'Intake_Summary.pdf')).toBeFalsy(); // renamed summary still blocks the re-mint
    expect(res.body.data.assigned).toBe(true);
  });

  it('refuses a JUNK claim label (--EYES-- separator) at case create — persists empty + logs the refusal', async () => {
    // Greene incident: a Jotform dropdown separator row reached Case.claimedCondition verbatim. The
    // Tier-A deterministic guard blanks it (required column → '') and drops junk from the array.
    const caseCreate = vi.fn(async () => ({ id: 'CLM-0123456789' }));
    const tx = async (fn: (t: unknown) => unknown) => fn({
      veteran: { findUnique: async () => ({ id: 'VET-1' }), create: async () => ({ id: 'VET-NEW' }) },
      case: { findFirst: async () => null, create: caseCreate },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = {
        intake: { findUnique: async () => readyIntake([]), update: vi.fn(async () => ({})) },
        $transaction: tx,
        document: { create: vi.fn(async () => ({ id: 'doc-x' })), delete: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
      };
      const res = await request(assignApp(db, vi.fn(async () => ({})))).post('/api/v1/intakes/i1/assign').send({
        veteranId: 'VET-1',
        newCase: { id: 'CLM-0123456789', claimedCondition: '--EYES--', claimType: 'initial' },
      }).expect(200);
      expect(res.body.data.assigned).toBe(true); // the guard never blocks the assign itself
      expect(caseCreate).toHaveBeenCalledTimes(1);
      const data = (caseCreate.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
      expect(data['claimedCondition']).toBe(''); // junk refused; required column persisted empty-safe
      expect(data['claimedConditions']).toEqual([]); // junk dropped from the array too
      expect(data['claimedConditionSource']).toBe('intake');
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('claim_label_junk_refused'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('a REAL claim label passes the junk guard untouched', async () => {
    const caseCreate = vi.fn(async () => ({ id: 'CLM-0123456789' }));
    const tx = async (fn: (t: unknown) => unknown) => fn({
      veteran: { findUnique: async () => ({ id: 'VET-1' }), create: async () => ({ id: 'VET-NEW' }) },
      case: { findFirst: async () => null, create: caseCreate },
    });
    const db = {
      intake: { findUnique: async () => readyIntake([]), update: vi.fn(async () => ({})) },
      $transaction: tx,
      document: { create: vi.fn(async () => ({ id: 'doc-x' })), delete: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    };
    await request(assignApp(db, vi.fn(async () => ({})))).post('/api/v1/intakes/i1/assign').send({
      veteranId: 'VET-1',
      newCase: { id: 'CLM-0123456789', claimedCondition: 'Foot Dysfunction', claimType: 'initial' },
    }).expect(200);
    const data = (caseCreate.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data['claimedCondition']).toBe('Foot Dysfunction');
    expect(data['claimedConditions']).toEqual(['Foot Dysfunction']);
  });

  it('409s when the intake is not ready', async () => {
    const db = { intake: { findUnique: async () => ({ id: 'i1', status: 'pending' }) }, $transaction: txWithExisting(), document: { create: vi.fn(), delete: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) } };
    await request(assignApp(db, vi.fn(async () => ({})))).post('/api/v1/intakes/i1/assign').send({ veteranId: 'VET-1', caseId: 'CLM-1' }).expect(409);
  });

  it('400s when neither veteranId nor newVeteran is provided', async () => {
    const db = { intake: { findUnique: async () => readyIntake([]) }, $transaction: txWithExisting(), document: { create: vi.fn(), delete: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) } };
    await request(assignApp(db, vi.fn(async () => ({})))).post('/api/v1/intakes/i1/assign').send({ caseId: 'CLM-1' }).expect(400);
  });
});

// ───────────────────────── GOOGLE ADS LEAD CONVERSION (#219) ─────────────────────────

const PAID_FORM_ID = '261180463266153';      // first-time $50 intake
const RETURNING_NOFEE_FORM_ID = '261495407772061'; // returning, no fee — NOT a paid lead

function readyIntakeForm(formId: string | undefined, manifest: unknown[] = []) {
  return { id: 'i1', status: 'ready', jotformFormId: formId, fileManifestJson: manifest };
}

describe('intakes assign — Google Ads lead conversion', () => {
  beforeEach(() => { mockUpload.mockClear(); mockUpload.mockResolvedValue(undefined); });

  it('fires uploadReviewConversion ONCE with the new caseId when a PAID first-time intake is assigned', async () => {
    const db = {
      intake: { findUnique: async () => readyIntakeForm(PAID_FORM_ID, []), update: vi.fn(async () => ({})) },
      $transaction: txWithExisting(),
      document: { create: vi.fn(async () => ({ id: 'doc' })), delete: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    };
    await request(assignApp(db, vi.fn(async () => ({})))).post('/api/v1/intakes/i1/assign').send({ veteranId: 'VET-1', caseId: 'CLM-1' }).expect(200);
    expect(mockUpload).toHaveBeenCalledTimes(1);
    const [, caseIdArg, paidAtArg] = mockUpload.mock.calls[0] as unknown as [unknown, string, Date];
    expect(caseIdArg).toBe('CLM-1');
    expect(paidAtArg).toBeInstanceOf(Date);
  });

  it('still completes the assign (200) when the conversion upload THROWS — never rethrows', async () => {
    mockUpload.mockRejectedValueOnce(new Error('Data Manager API 503: upstream down'));
    const db = {
      intake: { findUnique: async () => readyIntakeForm(PAID_FORM_ID, []), update: vi.fn(async () => ({})) },
      $transaction: txWithExisting(),
      document: { create: vi.fn(async () => ({ id: 'doc' })), delete: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    };
    const res = await request(assignApp(db, vi.fn(async () => ({})))).post('/api/v1/intakes/i1/assign').send({ veteranId: 'VET-1', caseId: 'CLM-1' }).expect(200);
    expect(res.body.data.assigned).toBe(true); // intake processing completed despite the Google Ads error
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire for a returning no-fee intake (not a paid lead)', async () => {
    const db = {
      intake: { findUnique: async () => readyIntakeForm(RETURNING_NOFEE_FORM_ID, []), update: vi.fn(async () => ({})) },
      $transaction: txWithExisting(),
      document: { create: vi.fn(async () => ({ id: 'doc' })), delete: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    };
    await request(assignApp(db, vi.fn(async () => ({})))).post('/api/v1/intakes/i1/assign').send({ veteranId: 'VET-1', caseId: 'CLM-1' }).expect(200);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('does NOT fire for an intake with no/unknown form id', async () => {
    const db = {
      intake: { findUnique: async () => readyIntakeForm(undefined, []), update: vi.fn(async () => ({})) },
      $transaction: txWithExisting(),
      document: { create: vi.fn(async () => ({ id: 'doc' })), delete: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    };
    await request(assignApp(db, vi.fn(async () => ({})))).post('/api/v1/intakes/i1/assign').send({ veteranId: 'VET-1', caseId: 'CLM-1' }).expect(200);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('does NOT fire (and 409s) when the intake is already assigned — dedupe via the ready→assigned gate', async () => {
    // A worker reprocess / repeat-assign cannot double-report: the endpoint only runs from status==='ready'.
    const db = {
      intake: { findUnique: async () => ({ id: 'i1', status: 'assigned', jotformFormId: PAID_FORM_ID }), update: vi.fn(async () => ({})) },
      $transaction: txWithExisting(),
      document: { create: vi.fn(), delete: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    };
    await request(assignApp(db, vi.fn(async () => ({})))).post('/api/v1/intakes/i1/assign').send({ veteranId: 'VET-1', caseId: 'CLM-1' }).expect(409);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('does NOT fire for a PAID intake when nothing assigns (markAssigned false: existing case, all copies fail)', async () => {
    // markAssigned is false only when real files were selected but EVERY copy failed on an EXISTING
    // veteran+case. No assignedCaseId transition → no conversion.
    const db = {
      intake: { findUnique: async () => readyIntakeForm(PAID_FORM_ID, [{ name: 'rec.pdf', s3Key: 'intake/i1/rec.pdf', contentType: 'application/pdf', sizeBytes: 1000 }]), update: vi.fn(async () => ({})) },
      $transaction: txWithExisting(),
      document: { create: vi.fn(async () => ({ id: 'doc' })), delete: vi.fn(async () => ({})), findFirst: vi.fn().mockResolvedValue(null) },
    };
    const copyFails = vi.fn(async () => { throw new Error('AccessDenied'); });
    const res = await request(assignApp(db, copyFails)).post('/api/v1/intakes/i1/assign').send({ veteranId: 'VET-1', caseId: 'CLM-1' }).expect(200);
    expect(res.body.data.assigned).toBe(false);
    expect(mockUpload).not.toHaveBeenCalled();
  });
});
