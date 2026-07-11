import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sendSpy = vi.fn(async () => ({}));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { send = sendSpy; },
  PutObjectCommand: class { constructor(public readonly input: Record<string, unknown>) {} },
}));

const { writeScreeningSummary, buildScreeningSummaryKey } = await import('../screening-summary-write.js');
import type { ScreeningResult } from '../chart-extract-llm.js';
import type { AppDb } from '../db-types.js';

function screen(instrument: string, score: string, date: string | null): ScreeningResult {
  return { instrument, score, date, sourceDocumentId: 'd', sourcePage: 7, sourceQuote: `${instrument} ${score}`, confidence: 0.9 };
}

function makeDb() {
  const upserts: { where: { s3Key: string }; create: Record<string, unknown>; update: Record<string, unknown> }[] = [];
  const pageCreates: { data: Record<string, unknown> }[] = [];
  const pageDeletes: { where: { documentId: string } }[] = [];
  const db = {
    case: { findFirst: vi.fn(async () => ({ veteranId: 'VET-1', veteran: { firstName: 'John', lastName: 'Doe' } })) },
    // Upsert returns the row (with its id) — the writer attaches the summary page to doc.id.
    document: { upsert: vi.fn(async (a: { where: { s3Key: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => { upserts.push(a); return { id: 'DOC-1', ...a.create }; }) },
    documentPage: {
      deleteMany: vi.fn(async (a: { where: { documentId: string } }) => { pageDeletes.push(a); return { count: 0 }; }),
      create: vi.fn(async (a: { data: Record<string, unknown> }) => { pageCreates.push(a); return a.data; }),
    },
  } as unknown as AppDb;
  return { db, upserts, pageCreates, pageDeletes };
}

beforeEach(() => { sendSpy.mockClear(); process.env.PHI_BUCKET_NAME = 'test-bucket'; });
afterEach(() => { delete process.env.PHI_BUCKET_NAME; });

describe('writeScreeningSummary', () => {
  it('no-ops on empty screenings (nothing to write)', async () => {
    const { db } = makeDb();
    const r = await writeScreeningSummary(db, 'CLM-1', [], 'RUN-1');
    expect(r.written).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('writes the file to S3 + upserts the Document with the stable key + screening_summary tag', async () => {
    const { db, upserts } = makeDb();
    const r = await writeScreeningSummary(db, 'CLM-1', [screen('PHQ-9', '18', '2024-03-01'), screen('GAD-7', '12', '2024-03-01')], 'RUN-1');
    expect(r.written).toBe(true);
    expect(r.count).toBe(2);
    // S3 put fired, to the stable key (so re-extraction REFRESHES, not duplicates).
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(r.s3Key).toBe(buildScreeningSummaryKey('CLM-1'));
    expect(r.s3Key!.endsWith('00000000-screening-summary.txt')).toBe(true);
    // Document upsert keyed on the s3Key, tagged screening_summary, text/plain.
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.where.s3Key).toBe(r.s3Key);
    expect(upserts[0]!.create).toMatchObject({ caseId: 'CLM-1', docTag: 'screening_summary', contentType: 'text/plain' });
  });

  // Ryan 2026-07-10: the summary was generated but NEVER parsed — it had ZERO DocumentPage rows, so the
  // chart digest + drafter (both read Document.pages[].text) saw nothing. The writer must persist the
  // summary TEXT as a DocumentPage so the screenings actually reach the digest/gates + the drafter.
  it('persists the summary text as a DocumentPage so the digest + drafter can read it (idempotent refresh)', async () => {
    const { db, pageCreates, pageDeletes } = makeDb();
    const r = await writeScreeningSummary(db, 'CLM-1', [screen('PHQ-9', '18', '2024-03-01'), screen('GAD-7', '12', '2024-03-01')], 'RUN-1');
    expect(r.written).toBe(true);
    // Stale pages cleared first (a re-extraction refreshes, never duplicates), then ONE page written.
    expect(pageDeletes).toHaveLength(1);
    expect(pageDeletes[0]!.where.documentId).toBe('DOC-1');
    expect(pageCreates).toHaveLength(1);
    expect(pageCreates[0]!.data).toMatchObject({ documentId: 'DOC-1', pageNumber: 1 });
    // The page text carries the actual screening results (what the drafter/gates will now see).
    const pageText = String(pageCreates[0]!.data['text'] ?? '');
    expect(pageText).toContain('PHQ-9');
    expect(pageText).toContain('GAD-7');
    expect(pageText).toContain('SCREENING SUMMARY');
  });

  it('returns no_bucket when PHI_BUCKET_NAME is unset (never throws)', async () => {
    delete process.env.PHI_BUCKET_NAME;
    const { db } = makeDb();
    const r = await writeScreeningSummary(db, 'CLM-1', [screen('PHQ-9', '18', '2024-03-01')], 'RUN-1');
    expect(r.written).toBe(false);
    expect(r.reason).toBe('no_bucket');
  });
});
