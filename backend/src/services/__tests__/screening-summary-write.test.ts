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
  const db = {
    case: { findFirst: vi.fn(async () => ({ veteranId: 'VET-1', veteran: { firstName: 'John', lastName: 'Doe' } })) },
    document: { upsert: vi.fn(async (a: { where: { s3Key: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => { upserts.push(a); return a.create; }) },
  } as unknown as AppDb;
  return { db, upserts };
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

  it('returns no_bucket when PHI_BUCKET_NAME is unset (never throws)', async () => {
    delete process.env.PHI_BUCKET_NAME;
    const { db } = makeDb();
    const r = await writeScreeningSummary(db, 'CLM-1', [screen('PHQ-9', '18', '2024-03-01')], 'RUN-1');
    expect(r.written).toBe(false);
    expect(r.reason).toBe('no_bucket');
  });
});
