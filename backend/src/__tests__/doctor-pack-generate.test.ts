import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDoctorPackForCase } from '../services/doctor-pack-generate.js';
import { HttpError } from '../http/errors.js';

// Package 7 (2026-06-11): unit tests for the EXTRACTED Doctor Pack generate service — the
// single copy behind both POST /doctor-pack/generate ('manual') and the case status route's
// send-to-doctor auto-fire ('auto_send_to_doctor'). The two modes differ ONLY in the
// idempotency guard; these tests pin that contract:
//   - auto: skip (never throw) on queued/generating/ready at the CURRENT case version OR the
//     pre-transition version (manual-gen-then-send must not double-generate).
//   - manual: 409 on in-flight (queued/generating) at the current version; a READY pack does
//     NOT block — Regenerate keeps working.

vi.mock('../services/chart-summary-aggregator.js', () => ({
  aggregateChartSummary: vi.fn(async () => null),
}));

vi.mock('../services/doctor-pack-queue.js', () => ({
  publishDoctorPackQueued: vi.fn(async () => ({ skipped: true })),
}));

interface ExistingPack {
  readonly id: string;
  readonly caseId: string;
  readonly caseVersion: number;
  readonly state: string;
  readonly createdAt: Date;
}

// Emulates the delegate's where-clause semantics for the two query shapes the service issues:
// caseVersion as a number ('manual') and caseVersion: { in: [...] } ('auto'), state: { in: [...] }.
function packFindFirstFor(existingPacks: readonly ExistingPack[]) {
  return vi.fn(async (args: { where: { caseId: string; caseVersion: number | { in: number[] }; state: { in: string[] } } }) => {
    const w = args.where;
    const versions = typeof w.caseVersion === 'number' ? [w.caseVersion] : w.caseVersion.in;
    const states = w.state.in;
    return existingPacks.find(
      (p) => p.caseId === w.caseId && versions.includes(p.caseVersion) && states.includes(p.state),
    ) ?? null;
  });
}

interface MockDocument {
  readonly id: string;
  readonly s3Key: string;
  readonly pageCount: number | null;
  readonly docTag: string | null;
  readonly filename?: string | null;
  readonly contentType?: string | null;
  readonly uploadedAt?: Date | null;
}

interface MockPageRow {
  readonly id: string;
  readonly documentId: string;
  readonly pageNumber: number;
  readonly text: string;
  readonly confidence: number | null;
  readonly extractedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function makeGenDb(
  opts: {
    existingPacks?: readonly ExistingPack[];
    caseVersion?: number;
    // WAVE 2: injectable document set + per-page OCR text rows.
    documents?: readonly MockDocument[];
    pageRows?: readonly MockPageRow[];
  } = {},
) {
  const caseVersion = opts.caseVersion ?? 6;
  const created: { data?: Record<string, unknown> } = {};
  const activityLogCreate = vi.fn(
    async (_args: { data: { action: string; detailsJson: { trigger?: string } & Record<string, unknown> } }) => ({}),
  );
  const doctorPackCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    created.data = args.data;
    return { ...args.data, createdAt: new Date(), updatedAt: new Date(), version: 1 };
  });
  const tx = {
    keyDoc: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      upsert: vi.fn(async (args: { create: Record<string, unknown> }) => ({ id: 'kd-1', ...args.create })),
    },
    doctorPack: { create: doctorPackCreate },
    activityLog: { create: activityLogCreate },
  };
  const db = {
    case: {
      findFirst: vi.fn(async () => ({
        id: 'CASE-1',
        veteranId: 'VET-1',
        version: caseVersion,
        claimedCondition: 'obstructive sleep apnea',
        claimType: 'initial',
        framingChoice: null,
        upstreamScCondition: null,
        status: 'physician_review',
        cdsVerdict: 'not_yet_run',
        cdsOddsPct: null,
        cdsRationale: null,
        veteranStatement: null,
        inServiceEvent: null,
        documents: opts.documents ?? [{ id: 'doc-1', s3Key: 'cases/CASE-1/aaaa1111-DD-214.pdf', pageCount: 3, docTag: null }],
      })),
    },
    doctorPack: { findFirst: packFindFirstFor(opts.existingPacks ?? []) },
    fileReadStatus: { findMany: vi.fn(async () => []) },
    keyDoc: { findMany: vi.fn(async () => []) },
    documentPage: { findMany: vi.fn(async () => opts.pageRows ?? []) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { db: db as never, tx, created, spies: { doctorPackCreate, activityLogCreate, packFindFirst: db.doctorPack.findFirst } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateDoctorPackForCase — auto_send_to_doctor trigger (Package 7)', () => {
  it('no existing pack: queues exactly ONE pack stamped with the current (post-transition) case version', async () => {
    const { db, created, spies } = makeGenDb({ caseVersion: 6 });
    const result = await generateDoctorPackForCase(db, {
      caseId: 'CASE-1',
      actorSub: 'RN-1',
      trigger: 'auto_send_to_doctor',
      priorCaseVersion: 5,
    });

    expect(result.outcome).toBe('queued');
    expect(spies.doctorPackCreate).toHaveBeenCalledTimes(1);
    expect(created.data?.caseVersion).toBe(6);
    expect(created.data?.state).toBe('queued');
    expect(created.data?.generatedBy).toBe('RN-1');
    // The audit row distinguishes the auto-fire from a manual Generate.
    const logArg = spies.activityLogCreate.mock.calls[0]?.[0];
    expect(logArg?.data.detailsJson.trigger).toBe('auto_send_to_doctor');
  });

  it('SKIPS (no create) when a ready pack exists at the current version — a re-fire does not duplicate', async () => {
    const { db, spies } = makeGenDb({
      caseVersion: 6,
      existingPacks: [{ id: 'pack-1', caseId: 'CASE-1', caseVersion: 6, state: 'ready', createdAt: new Date() }],
    });
    const result = await generateDoctorPackForCase(db, {
      caseId: 'CASE-1', actorSub: 'RN-1', trigger: 'auto_send_to_doctor', priorCaseVersion: 5,
    });

    expect(result.outcome).toBe('skipped');
    expect(result.outcome === 'skipped' && result.existingPackId).toBe('pack-1');
    expect(spies.doctorPackCreate).not.toHaveBeenCalled();
  });

  it('SKIPS when a ready pack exists at the PRE-transition version (RN generated manually, then clicked Send)', async () => {
    // The only mutation between priorCaseVersion (5) and the current version (6) is the status
    // flip itself, so the v5 pack reflects the identical chart — re-enqueueing would double-gen.
    const { db, spies } = makeGenDb({
      caseVersion: 6,
      existingPacks: [{ id: 'pack-v5', caseId: 'CASE-1', caseVersion: 5, state: 'ready', createdAt: new Date() }],
    });
    const result = await generateDoctorPackForCase(db, {
      caseId: 'CASE-1', actorSub: 'RN-1', trigger: 'auto_send_to_doctor', priorCaseVersion: 5,
    });

    expect(result.outcome).toBe('skipped');
    expect(result.outcome === 'skipped' && result.existingPackId).toBe('pack-v5');
    expect(spies.doctorPackCreate).not.toHaveBeenCalled();
  });

  it('SKIPS (does not throw) on an in-flight queued pack — auto mode never 409s', async () => {
    const { db, spies } = makeGenDb({
      caseVersion: 6,
      existingPacks: [{ id: 'pack-q', caseId: 'CASE-1', caseVersion: 6, state: 'queued', createdAt: new Date() }],
    });
    const result = await generateDoctorPackForCase(db, {
      caseId: 'CASE-1', actorSub: 'RN-1', trigger: 'auto_send_to_doctor', priorCaseVersion: 5,
    });

    expect(result.outcome).toBe('skipped');
    expect(spies.doctorPackCreate).not.toHaveBeenCalled();
  });

  it('a STALE pack (older version, not the prior one) does NOT block — new chart state regenerates', async () => {
    // Correction round-trip: pack from v2, case now at v6 (prior v5) — the chart/letter moved on.
    const { db, spies } = makeGenDb({
      caseVersion: 6,
      existingPacks: [{ id: 'pack-old', caseId: 'CASE-1', caseVersion: 2, state: 'ready', createdAt: new Date() }],
    });
    const result = await generateDoctorPackForCase(db, {
      caseId: 'CASE-1', actorSub: 'RN-1', trigger: 'auto_send_to_doctor', priorCaseVersion: 5,
    });

    expect(result.outcome).toBe('queued');
    expect(spies.doctorPackCreate).toHaveBeenCalledTimes(1);
  });
});

describe('generateDoctorPackForCase — manual trigger (pre-extraction contract preserved)', () => {
  it('throws 409 on an in-flight (queued) pack at the current version', async () => {
    const { db } = makeGenDb({
      caseVersion: 6,
      existingPacks: [{ id: 'pack-q', caseId: 'CASE-1', caseVersion: 6, state: 'queued', createdAt: new Date() }],
    });
    await expect(
      generateDoctorPackForCase(db, { caseId: 'CASE-1', actorSub: 'OPS-1', trigger: 'manual' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('a READY pack does NOT block manual generation (Regenerate must keep working)', async () => {
    const { db, spies, created } = makeGenDb({
      caseVersion: 6,
      existingPacks: [{ id: 'pack-r', caseId: 'CASE-1', caseVersion: 6, state: 'ready', createdAt: new Date() }],
    });
    const result = await generateDoctorPackForCase(db, { caseId: 'CASE-1', actorSub: 'OPS-1', trigger: 'manual' });

    expect(result.outcome).toBe('queued');
    expect(spies.doctorPackCreate).toHaveBeenCalledTimes(1);
    const logArg = spies.activityLogCreate.mock.calls[0]?.[0];
    expect(logArg?.data.detailsJson.trigger).toBe('manual');
    expect(created.data?.caseVersion).toBe(6);
  });

  it('404s on an unknown case', async () => {
    const { db } = makeGenDb();
    (db as unknown as { case: { findFirst: ReturnType<typeof vi.fn> } }).case.findFirst.mockResolvedValue(null);
    await expect(
      generateDoctorPackForCase(db, { caseId: 'NOPE', actorSub: 'OPS-1' }),
    ).rejects.toBeInstanceOf(HttpError);
  });
});

// ============================================================================================
// WAVE 2 (assessment 2026-06-12 §1b/1d/§3): non-PDF text→PDF rendering at manifest time,
// the soft no-clinical-dx warning, and manifest displayLabels.
// ============================================================================================

describe('generateDoctorPackForCase — WAVE 2', () => {
  const pageRow = (documentId: string, pageNumber: number, text: string): MockPageRow => ({
    id: `${documentId}-p${pageNumber}`,
    documentId,
    pageNumber,
    text,
    confidence: 0.99,
    extractedAt: new Date('2026-06-01T00:00:00.000Z'),
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
  });

  // A .txt psych note — THE Perez failure shape: the dx note the PCP refuses to sign without,
  // structurally unreachable by the PDF-only assembler until rendered.
  const TXT_DOC: MockDocument = {
    id: 'doc-2',
    s3Key: 'cases/CASE-1/bbbb2222-PsychNote.txt',
    pageCount: 2,
    docTag: null,
    filename: 'PsychNote.txt',
    contentType: 'text/plain',
    uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
  };
  const TXT_PAGES = [
    pageRow('doc-2', 1, 'Veteran reports persistent low mood and poor concentration since deployment.'),
    pageRow('doc-2', 2, 'Plan: continue current therapy and medication management. Return in 3 months.'),
  ];

  type ManifestShape = {
    entries: { filePath: string; docType: string; pageRanges: { from: number; to: number }[]; pageCount: number; displayLabel?: string }[];
    warnings?: string[];
    budgetTrim?: { trimNotes: string[] };
  };

  it('renders a non-PDF source to the derived records-bucket key and rewrites the manifest entry (1b)', async () => {
    const { db, tx, created } = makeGenDb({ caseVersion: 6, documents: [TXT_DOC], pageRows: TXT_PAGES });
    const s3Send = vi.fn(async (_cmd: unknown) => ({}));
    const result = await generateDoctorPackForCase(
      db,
      { caseId: 'CASE-1', actorSub: 'OPS-1', trigger: 'manual' },
      { s3: { send: s3Send }, recordsBucketName: 'phi-test-bucket' },
    );
    expect(result.outcome).toBe('queued');

    // Manifest entry points at the RENDERED key (zero handler.py contract change) with
    // pageRanges adjusted to the rendered page count.
    const manifest = created.data?.manifestJson as ManifestShape;
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]?.filePath).toBe('cases/CASE-1/_rendered/doc-2-v6.pdf');
    expect(manifest.entries[0]?.pageRanges).toEqual([{ from: 1, to: 2 }]);
    expect(manifest.entries[0]?.pageCount).toBe(2);
    // §3: unspecified docType → displayLabel is just the original filename.
    expect(manifest.entries[0]?.displayLabel).toBe('PsychNote.txt');
    expect(created.data?.pageCount).toBe(2);
    // No render-failure notes.
    expect(manifest.budgetTrim?.trimNotes ?? []).not.toContainEqual(expect.stringContaining('could not render'));

    // The upload went to the records bucket under the derived key as a real PDF.
    expect(s3Send).toHaveBeenCalledTimes(1);
    const putCmd = s3Send.mock.calls[0]?.[0] as unknown as { input: { Bucket: string; Key: string; ContentType: string; Body: Uint8Array } };
    expect(putCmd.input.Bucket).toBe('phi-test-bucket');
    expect(putCmd.input.Key).toBe('cases/CASE-1/_rendered/doc-2-v6.pdf');
    expect(putCmd.input.ContentType).toBe('application/pdf');
    expect(new TextDecoder().decode(putCmd.input.Body.slice(0, 5))).toBe('%PDF-');

    // KeyDoc rows keep the ORIGINAL filePath (the Document join + RN review UI contract).
    const upsert = tx.keyDoc.upsert.mock.calls[0]?.[0] as { create: Record<string, unknown> };
    expect(upsert.create.filePath).toBe('cases/CASE-1/bbbb2222-PsychNote.txt');
  });

  it('render/upload failure is fail-OPEN per entry: trimNote written, entry dropped, pack still queues (1b)', async () => {
    const { db, created } = makeGenDb({ caseVersion: 6, documents: [TXT_DOC], pageRows: TXT_PAGES });
    const s3Send = vi.fn(async () => {
      throw new Error('S3 unavailable');
    });
    const result = await generateDoctorPackForCase(
      db,
      { caseId: 'CASE-1', actorSub: 'OPS-1', trigger: 'manual' },
      { s3: { send: s3Send }, recordsBucketName: 'phi-test-bucket' },
    );

    expect(result.outcome).toBe('queued'); // never the whole pack
    const manifest = created.data?.manifestJson as ManifestShape;
    expect(manifest.entries).toHaveLength(0);
    expect(manifest.budgetTrim?.trimNotes).toContain('could not render PsychNote.txt');
  });

  it('a pack with ZERO clinical pages gets the NO_CLINICAL_DX_DOCUMENTATION warning + audit row (§1 soft gate)', async () => {
    // Default fixture: a lone DD-214 — service category, zero clinical (progress/C&P/DBQ) pages.
    const { db, created, spies } = makeGenDb({ caseVersion: 6 });
    await generateDoctorPackForCase(db, { caseId: 'CASE-1', actorSub: 'OPS-1', trigger: 'manual' });

    const manifest = created.data?.manifestJson as ManifestShape;
    expect(manifest.warnings).toEqual(['NO_CLINICAL_DX_DOCUMENTATION']);
    expect(spies.activityLogCreate).toHaveBeenCalledTimes(2);
    const second = spies.activityLogCreate.mock.calls[1]?.[0];
    expect(second?.data.action).toBe('doctor_pack_missing_clinical');
    expect(second?.data.detailsJson.warning).toBe('NO_CLINICAL_DX_DOCUMENTATION');
    // The queued log stays FIRST (existing assertions key on calls[0]).
    expect(spies.activityLogCreate.mock.calls[0]?.[0]?.data.action).toBe('doctor_pack_queued');
  });

  it('clinical pages present → NO warning, no extra audit row, and a human displayLabel on the entry (§1/§3)', async () => {
    const NOTES_DOC: MockDocument = {
      id: 'doc-3',
      s3Key: 'cases/CASE-1/cccc3333-Progress_Notes.pdf',
      pageCount: 2,
      docTag: null,
      filename: 'Progress_Notes.pdf',
      contentType: 'application/pdf',
    };
    const { db, created, spies } = makeGenDb({
      caseVersion: 6,
      documents: [NOTES_DOC],
      pageRows: [
        pageRow('doc-3', 1, 'Assessment: obstructive sleep apnea, stable on current therapy.'),
        pageRow('doc-3', 2, 'Routine administrative page with no relevant discussion.'),
      ],
    });
    await generateDoctorPackForCase(db, { caseId: 'CASE-1', actorSub: 'OPS-1', trigger: 'manual' });

    const manifest = created.data?.manifestJson as ManifestShape;
    expect(manifest.warnings).toBeUndefined();
    expect(spies.activityLogCreate).toHaveBeenCalledTimes(1);
    // The condition-matched progress-notes page made the pack, labeled for humans.
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]?.docType).toBe('progress_notes');
    expect(manifest.entries[0]?.pageRanges).toEqual([{ from: 1, to: 1 }]);
    expect(manifest.entries[0]?.displayLabel).toBe('Clinical notes — Progress_Notes.pdf');
  });
});
