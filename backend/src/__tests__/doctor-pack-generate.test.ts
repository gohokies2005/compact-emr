import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildVeteranStatementHeader,
  generateDoctorPackForCase,
  NO_LAY_STATEMENT_NOTE,
} from '../services/doctor-pack-generate.js';
import { publishDoctorPackQueued } from '../services/doctor-pack-queue.js';
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

// Hoisted (ROUND 2): shared by every describe below.
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

type ManifestShape = {
  entries: { filePath: string; docType: string; pageRanges: { from: number; to: number }[]; pageCount: number; displayLabel?: string }[];
  warnings?: string[];
  budgetTrim?: { trimNotes: string[] };
};

// ROUND 2 (F): the default chart carries a clinical note alongside the DD-214 so the canonical
// happy path passes the hard no-dx gate — a DD-214-only chart is now the GATE fixture, not the
// default. Tests asserting gate behavior pass their own documents.
const DEFAULT_CLINICAL_DOC: MockDocument = {
  id: 'doc-cl',
  s3Key: 'cases/CASE-1/cccc0000-Progress_Notes.pdf',
  pageCount: 1,
  docTag: null,
  filename: 'Progress_Notes.pdf',
  contentType: 'application/pdf',
};
const DEFAULT_DD214_DOC: MockDocument = { id: 'doc-1', s3Key: 'cases/CASE-1/aaaa1111-DD-214.pdf', pageCount: 3, docTag: null };
const DEFAULT_DOCS: readonly MockDocument[] = [DEFAULT_DD214_DOC, DEFAULT_CLINICAL_DOC];
const DEFAULT_PAGE_ROWS: readonly MockPageRow[] = [
  pageRow('doc-cl', 1, 'Assessment: obstructive sleep apnea, stable on current therapy.'),
];

function makeGenDb(
  opts: {
    existingPacks?: readonly ExistingPack[];
    caseVersion?: number;
    // WAVE 2: injectable document set + per-page OCR text rows.
    documents?: readonly MockDocument[];
    pageRows?: readonly MockPageRow[];
    // ROUND 2 (C): the lay-statement source field + the intake date its header carries.
    veteranStatement?: string | null;
    caseCreatedAt?: Date;
    // doctor-pack grounded pages, 2026-06-13 (PR-2): extracted, page-grounded chart rows. Each
    // injected as a sc_conditions row with source='extracted' + sourceDocumentId/sourcePage so the
    // back-map (doctor-pack-grounded-pages.ts) maps it to a page. Only consulted when the
    // DOCTOR_PACK_GROUNDED_PAGES flag is on (else the delegates are never called).
    groundedScRows?: readonly { sourceDocumentId: string; sourcePage: number; sourceQuote: string }[];
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
        veteranStatement: opts.veteranStatement ?? null,
        inServiceEvent: null,
        createdAt: opts.caseCreatedAt ?? new Date('2026-02-01T00:00:00.000Z'),
        documents: opts.documents ?? DEFAULT_DOCS,
      })),
    },
    doctorPack: { findFirst: packFindFirstFor(opts.existingPacks ?? []) },
    fileReadStatus: { findMany: vi.fn(async () => []) },
    keyDoc: { findMany: vi.fn(async () => []) },
    documentPage: { findMany: vi.fn(async () => opts.pageRows ?? DEFAULT_PAGE_ROWS) },
    // doctor-pack grounded pages, 2026-06-13 (PR-2): the three provenance delegates the back-map
    // reads. Injected SC rows carry source='extracted'; problems/meds default empty here.
    scCondition: {
      findMany: vi.fn(async () =>
        (opts.groundedScRows ?? []).map((r) => ({ source: 'extracted', sourceDocumentId: r.sourceDocumentId, sourcePage: r.sourcePage, sourceQuote: r.sourceQuote, confidence: null })),
      ),
    },
    activeProblem: { findMany: vi.fn(async () => []) },
    activeMedication: { findMany: vi.fn(async () => []) },
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
    // pageRanges adjusted to the rendered page count. (The cover index — entry #1 since
    // ROUND 2 D, ungated since Ryan's 2026-06-12 no-hard-gate call — precedes it.)
    const manifest = created.data?.manifestJson as ManifestShape;
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries[0]?.docType).toBe('cover_index');
    expect(manifest.entries[1]?.filePath).toBe('cases/CASE-1/_rendered/doc-2-v6.pdf');
    expect(manifest.entries[1]?.pageRanges).toEqual([{ from: 1, to: 2 }]);
    expect(manifest.entries[1]?.pageCount).toBe(2);
    // §3: unspecified docType → displayLabel is just the original filename.
    expect(manifest.entries[1]?.displayLabel).toBe('PsychNote.txt');
    expect(created.data?.pageCount).toBe(2 + (manifest.entries[0]?.pageCount ?? 0));
    // No render-failure notes.
    expect(manifest.budgetTrim?.trimNotes ?? []).not.toContainEqual(expect.stringContaining('could not render'));

    // The upload went to the records bucket under the derived key as a real PDF (the second
    // upload is the cover index).
    expect(s3Send).toHaveBeenCalledTimes(2);
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

  it('a pack with ZERO clinical pages STILL queues + assembles (Ryan 2026-06-12: NO hard gate) — warning + audit row drive the calm panel notice', async () => {
    // The fixture: a lone DD-214 — service category, zero clinical (progress/C&P/DBQ) pages.
    const { db, created, spies } = makeGenDb({
      caseVersion: 6,
      documents: [DEFAULT_DD214_DOC],
      pageRows: [],
      veteranStatement: 'My back has hurt since 2009.', // renders normally — nothing is held back
    });
    const s3Send = vi.fn(async () => ({}));
    const result = await generateDoctorPackForCase(
      db,
      { caseId: 'CASE-1', actorSub: 'OPS-1', trigger: 'manual' },
      { s3: { send: s3Send }, recordsBucketName: 'phi-test-bucket' },
    );

    // The pack generates and enqueues exactly like any other — never 'failed', never held.
    expect(result.outcome).toBe('queued');
    expect(created.data?.state).toBe('queued');
    expect(created.data?.errorMessage).toBeUndefined();
    expect(vi.mocked(publishDoctorPackQueued)).toHaveBeenCalledTimes(1);
    // Statement + cover render as usual (uploads happened).
    expect(s3Send).toHaveBeenCalled();

    // The §1 warning + audit-row trail is the ONLY signal — the panel keys its calm notice on it.
    const manifest = created.data?.manifestJson as ManifestShape;
    expect(manifest.warnings).toEqual(['NO_CLINICAL_DX_DOCUMENTATION']);
    const second = spies.activityLogCreate.mock.calls[1]?.[0];
    expect(second?.data.action).toBe('doctor_pack_missing_clinical');
    expect(second?.data.detailsJson.warning).toBe('NO_CLINICAL_DX_DOCUMENTATION');
    // The queued log stays FIRST (existing assertions key on calls[0]).
    expect(spies.activityLogCreate.mock.calls[0]?.[0]?.data.action).toBe('doctor_pack_queued');
  });

  it('ROUND 2 (F positive control): a clinical-bearing pack still queues AND publishes to SQS', async () => {
    const { db, created } = makeGenDb({ caseVersion: 6 }); // default fixture carries the clinical note
    await generateDoctorPackForCase(db, { caseId: 'CASE-1', actorSub: 'OPS-1', trigger: 'manual' });
    expect(created.data?.state).toBe('queued');
    expect(created.data?.errorMessage).toBeUndefined();
    expect(vi.mocked(publishDoctorPackQueued)).toHaveBeenCalledTimes(1);
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

// ============================================================================================
// ROUND 2 (backlog §"Doctor-pack round 2" A/C/D/E — PCP re-review 2026-06-12). F lives above
// with the gate it replaced.
// ============================================================================================

describe('generateDoctorPackForCase — ROUND 2', () => {
  it('A: the same content uploaded under two filenames ships ONCE, keeps the earliest upload, and records the omission', async () => {
    const text = 'Assessment: obstructive sleep apnea. Plan: continue CPAP therapy nightly.';
    const { db, created, tx } = makeGenDb({
      caseVersion: 6,
      documents: [
        { id: 'doc-a', s3Key: 'cases/CASE-1/aaaa0000-Progress_Notes.pdf', pageCount: 1, docTag: null, filename: 'Progress_Notes.pdf', contentType: 'application/pdf' },
        { id: 'doc-b', s3Key: 'cases/CASE-1/bbbb0000-Progress_Notes_copy.pdf', pageCount: 1, docTag: null, filename: 'Progress_Notes_copy.pdf', contentType: 'application/pdf' },
      ],
      pageRows: [pageRow('doc-a', 1, text), pageRow('doc-b', 1, text)],
    });
    await generateDoctorPackForCase(db, { caseId: 'CASE-1', actorSub: 'OPS-1', trigger: 'manual' });

    const manifest = created.data?.manifestJson as ManifestShape;
    const notesEntries = manifest.entries.filter((e) => e.docType === 'progress_notes');
    expect(notesEntries).toHaveLength(1);
    expect(notesEntries[0]?.filePath).toBe('cases/CASE-1/aaaa0000-Progress_Notes.pdf');
    expect(manifest.budgetTrim?.trimNotes).toContain(
      'Progress_Notes_copy.pdf: duplicate of Progress_Notes.pdf (identical content) — omitted',
    );

    // The duplicate KEEPS its KeyDoc row (the RN doc list stays complete) with the why.
    const dupUpsert = tx.keyDoc.upsert.mock.calls
      .map((call) => (call[0] as { create: Record<string, unknown> }).create)
      .find((c) => String(c.filePath).endsWith('Progress_Notes_copy.pdf'));
    expect(dupUpsert).toBeDefined();
    expect(String(dupUpsert?.selectorRationale)).toContain('duplicate of Progress_Notes.pdf');
  });

  it('C: veteranStatement renders into a one-page LAY entry at the derived key with the intake provenance header', async () => {
    const { db, created } = makeGenDb({
      caseVersion: 6,
      veteranStatement: 'My sleep problems began after my PTSD worsened in 2015.',
      caseCreatedAt: new Date('2026-03-15T12:00:00.000Z'),
    });
    const s3Send = vi.fn(async (_cmd: unknown) => ({}));
    await generateDoctorPackForCase(
      db,
      { caseId: 'CASE-1', actorSub: 'OPS-1', trigger: 'manual' },
      { s3: { send: s3Send }, recordsBucketName: 'phi-test-bucket' },
    );

    const manifest = created.data?.manifestJson as ManifestShape;
    const statement = manifest.entries.find((e) => e.docType === 'lay_statement');
    expect(statement).toBeDefined();
    expect(statement?.filePath).toBe('cases/CASE-1/_rendered/veteran-statement-v6.pdf');
    expect(statement?.displayLabel).toBe('Veteran statement (from intake)');
    expect(statement?.pageRanges).toEqual([{ from: 1, to: 1 }]);
    // No "missing statement" note on a case that HAS one.
    expect(manifest.budgetTrim?.trimNotes ?? []).not.toContain(NO_LAY_STATEMENT_NOTE);

    // Uploaded as a real PDF to the records bucket at the derived key.
    const keys = s3Send.mock.calls.map((call) => (call[0] as { input: { Key: string } }).input.Key);
    expect(keys).toContain('cases/CASE-1/_rendered/veteran-statement-v6.pdf');
  });

  it('C: the provenance header carries the intake date verbatim (exact wording pinned)', () => {
    expect(buildVeteranStatementHeader(new Date('2026-03-15T12:00:00.000Z'))).toBe(
      "Veteran's statement as submitted at intake on 2026-03-15",
    );
    expect(buildVeteranStatementHeader(null)).toBe(
      "Veteran's statement as submitted at intake on an unknown date",
    );
  });

  it('C: an EMPTY veteranStatement becomes the "No lay statement on file" Not-included note', async () => {
    const { db, created } = makeGenDb({ caseVersion: 6, veteranStatement: '   ' });
    await generateDoctorPackForCase(db, { caseId: 'CASE-1', actorSub: 'OPS-1', trigger: 'manual' });
    const manifest = created.data?.manifestJson as ManifestShape;
    expect(manifest.entries.some((e) => e.docType === 'lay_statement')).toBe(false);
    expect(manifest.budgetTrim?.trimNotes).toContain(NO_LAY_STATEMENT_NOTE);
  });

  it('D/E: the cover index is manifest entry #1 and the rest are medicine-first ordered (clinical → lay → denial → service)', async () => {
    const { db, created } = makeGenDb({
      caseVersion: 6,
      veteranStatement: 'My sleep problems began after my PTSD worsened in 2015.',
      documents: [
        { id: 'doc-dd', s3Key: 'cases/CASE-1/eeee0000-DD-214.pdf', pageCount: 1, docTag: null, filename: 'DD-214.pdf', contentType: 'application/pdf' },
        // A denial for a DIFFERENT condition (the PCP's non-obvious-inclusion case).
        { id: 'doc-dn', s3Key: 'cases/CASE-1/dddd0000-Hip_Denial.pdf', pageCount: 2, docTag: null, filename: 'Hip_Denial.pdf', contentType: 'application/pdf' },
        DEFAULT_CLINICAL_DOC,
      ],
      pageRows: [
        pageRow('doc-dd', 1, 'Certificate of Release or Discharge from Active Duty. DD Form 214.'),
        // Denial-only phrasing: the classifier checks rating-decision openers ("we have made a
        // decision on your claim" / "reasons for decision") FIRST, so this page must carry the
        // denial patterns alone to classify denial_letter.
        pageRow('doc-dn', 1, 'Entitlement to service connection for right hip strain is denied. We have denied your claim for the right hip.'),
        pageRow('doc-dn', 2, 'The evidence considered does not show the right hip strain began in service. Service connection for the right hip is denied.'),
        ...DEFAULT_PAGE_ROWS,
      ],
    });
    const s3Send = vi.fn(async (_cmd: unknown) => ({}));
    await generateDoctorPackForCase(
      db,
      { caseId: 'CASE-1', actorSub: 'OPS-1', trigger: 'manual' },
      { s3: { send: s3Send }, recordsBucketName: 'phi-test-bucket' },
    );

    const manifest = created.data?.manifestJson as ManifestShape;
    expect(manifest.entries[0]?.docType).toBe('cover_index');
    expect(manifest.entries[0]?.displayLabel).toBe('Cover index');
    expect(manifest.entries[0]?.filePath).toBe('cases/CASE-1/_rendered/cover-index-v6.pdf');
    expect(manifest.entries.map((e) => e.docType)).toEqual([
      'cover_index',
      'progress_notes', // clinical first (the dx note)
      'lay_statement', // veteran statement
      'denial_letter', // denial narrative
      'dd_214', // service
    ]);

    // Cover + statement both uploaded; the row's pageCount includes them.
    const keys = s3Send.mock.calls.map((call) => (call[0] as { input: { Key: string } }).input.Key);
    expect(keys).toContain('cases/CASE-1/_rendered/cover-index-v6.pdf');
    expect(keys).toContain('cases/CASE-1/_rendered/veteran-statement-v6.pdf');
    const totalPages = manifest.entries.reduce((sum, e) => sum + e.pageCount, 0);
    expect(created.data?.pageCount).toBe(totalPages);
  });
});

// ============================================================================================
// doctor-pack grounded pages, 2026-06-13 (PR-2, DARK): the grounded-page layer behind
// DOCTOR_PACK_GROUNDED_PAGES. Flag ON ⇒ a Blue Button page that grounded an extracted SC fact is
// pulled even though the BB as a whole stays excluded. Flag OFF ⇒ unchanged (BB contributes
// nothing). Uses the existing pack-test rig (makeGenDb + injectable S3).
// ============================================================================================
describe('generateDoctorPackForCase — grounded-page layer (PR-2, flag-gated)', () => {
  // A large Blue Button dump (hard-excluded by the selector) whose pages 412 + 870 grounded the
  // PTSD grant + a med. 900 pages so both grounded pages are in range and it is NOT a small-BB.
  const BB_DOC: MockDocument = {
    id: 'doc-bb',
    s3Key: 'cases/CASE-1/cccc3333-Blue_Button_VA.pdf',
    pageCount: 900,
    docTag: null,
    filename: 'Blue_Button_VA.pdf',
    contentType: 'application/pdf',
  };
  const BB_PAGES = [
    pageRow('doc-bb', 412, 'Rating decision: PTSD evaluated as 70 percent service-connected.'),
    pageRow('doc-bb', 870, 'Active medications: prazosin 2mg nightly.'),
  ];
  const GROUNDED = [
    { sourceDocumentId: 'doc-bb', sourcePage: 412, sourceQuote: 'PTSD 70% service-connected' },
    { sourceDocumentId: 'doc-bb', sourcePage: 870, sourceQuote: 'prazosin 2mg nightly' },
  ];

  const ORIGINAL_FLAG = process.env['DOCTOR_PACK_GROUNDED_PAGES'];
  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env['DOCTOR_PACK_GROUNDED_PAGES'];
    else process.env['DOCTOR_PACK_GROUNDED_PAGES'] = ORIGINAL_FLAG;
  });

  it('flag ON: a Blue Button doc whose grounded facts cite pages [412, 870] includes exactly those pages', async () => {
    process.env['DOCTOR_PACK_GROUNDED_PAGES'] = 'on';
    const { db, created } = makeGenDb({
      caseVersion: 6,
      documents: [BB_DOC],
      pageRows: BB_PAGES,
      groundedScRows: GROUNDED,
    });
    const s3Send = vi.fn(async () => ({}));
    const result = await generateDoctorPackForCase(
      db,
      { caseId: 'CASE-1', actorSub: 'OPS-1', trigger: 'manual' },
      { s3: { send: s3Send }, recordsBucketName: 'phi-test-bucket' },
    );
    expect(result.outcome).toBe('queued');
    const manifest = created.data?.manifestJson as ManifestShape;
    const bbEntry = manifest.entries.find((e) => e.filePath === 'cases/CASE-1/cccc3333-Blue_Button_VA.pdf');
    expect(bbEntry).toBeDefined();
    // The BB-as-a-whole stays excluded; ONLY the two grounded pages are pulled.
    expect(bbEntry?.pageRanges).toEqual([{ from: 412, to: 412 }, { from: 870, to: 870 }]);
  });

  it('flag OFF: the same Blue Button doc contributes NOTHING (byte-identical to today)', async () => {
    delete process.env['DOCTOR_PACK_GROUNDED_PAGES'];
    const { db, created } = makeGenDb({
      caseVersion: 6,
      documents: [BB_DOC],
      pageRows: BB_PAGES,
      groundedScRows: GROUNDED, // present but never read (flag off)
    });
    const s3Send = vi.fn(async () => ({}));
    const result = await generateDoctorPackForCase(
      db,
      { caseId: 'CASE-1', actorSub: 'OPS-1', trigger: 'manual' },
      { s3: { send: s3Send }, recordsBucketName: 'phi-test-bucket' },
    );
    expect(result.outcome).toBe('queued');
    const manifest = created.data?.manifestJson as ManifestShape;
    const bbEntry = manifest.entries.find((e) => e.filePath === 'cases/CASE-1/cccc3333-Blue_Button_VA.pdf');
    expect(bbEntry).toBeUndefined();
  });

  it('flag OFF: the grounded delegates are never queried (the back-map is not even called)', async () => {
    delete process.env['DOCTOR_PACK_GROUNDED_PAGES'];
    const { db } = makeGenDb({ caseVersion: 6, documents: [BB_DOC], pageRows: BB_PAGES, groundedScRows: GROUNDED });
    const scFindMany = (db as unknown as { scCondition: { findMany: ReturnType<typeof vi.fn> } }).scCondition.findMany;
    await generateDoctorPackForCase(
      db,
      { caseId: 'CASE-1', actorSub: 'OPS-1', trigger: 'manual' },
      { s3: { send: vi.fn(async () => ({})) }, recordsBucketName: 'phi-test-bucket' },
    );
    expect(scFindMany).not.toHaveBeenCalled();
  });
});
