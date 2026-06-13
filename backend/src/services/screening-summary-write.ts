/**
 * Writes the consolidated screening-summary as a plain-text file under the case's Documents (Ryan
 * 2026-06-13). The full-read extractor captures every PHQ-9/GAD-7/PCL-5/AUDIT-C with its date; rather
 * than clutter the chart with screen rows, they render to ONE file the RN/physician can open and the
 * drafter can scan for score-trend-vs-condition correlation. Self-contained S3 client + PHI bucket
 * (mirrors doctor-pack-generate) so the internal route needs no new deps.
 *
 * Idempotent: a stable s3Key (cases/<id>/<MARKER>) is upserted, so a re-extraction REFRESHES the file
 * rather than duplicating it. The key carries the SCREENING_SUMMARY_KEY_MARKER so the build-state +
 * trigger-hash exclude it (it's an OUTPUT, never an extraction input) — see chart-build-state.ts.
 */

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { formatScreeningSummary } from './screening-summary.js';
import { SCREENING_SUMMARY_KEY_MARKER } from './chart-build-state.js';
import { SERVICE_ACTORS } from './service-actors.js';
import type { ScreeningResult } from './chart-extract-llm.js';
import type { AppDb } from './db-types.js';

let cachedS3: S3Client | null = null;
function s3(): S3Client {
  if (cachedS3 === null) cachedS3 = new S3Client({ forcePathStyle: process.env['AWS_S3_FORCE_PATH_STYLE'] === 'true' });
  return cachedS3;
}

export function buildScreeningSummaryKey(caseId: string): string {
  const safe = caseId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `cases/${safe}/${SCREENING_SUMMARY_KEY_MARKER}`;
}

export interface ScreeningSummaryWriteResult {
  written: boolean;
  s3Key?: string;
  count?: number;
  reason?: string;
}

/**
 * Format + upload the screening summary and upsert its Document row. Returns {written:false} when
 * there are no screenings (nothing to write). PURE of the extraction — call AFTER the merge commits.
 */
export async function writeScreeningSummary(
  db: AppDb,
  caseId: string,
  screenings: readonly ScreeningResult[],
  runId: string,
): Promise<ScreeningSummaryWriteResult> {
  if (!screenings || screenings.length === 0) return { written: false, reason: 'no_screenings' };
  const bucket = process.env['PHI_BUCKET_NAME'];
  if (!bucket) return { written: false, reason: 'no_bucket' };

  const caseRow = await (db as unknown as {
    case: { findFirst: (a: { where: { id: string }; select: { veteranId: true; veteran: { select: { firstName: true; lastName: true } } } }) => Promise<{ veteranId: string; veteran: { firstName: string | null; lastName: string | null } | null } | null> };
  }).case.findFirst({ where: { id: caseId }, select: { veteranId: true, veteran: { select: { firstName: true, lastName: true } } } });
  if (caseRow === null) return { written: false, reason: 'case_not_found' };
  const v = caseRow.veteran;
  const veteranName = v ? [v.lastName, v.firstName].filter(Boolean).join(', ') || null : null;

  const text = formatScreeningSummary(screenings, {
    caseId,
    veteranName,
    runId,
    extractedAtIso: new Date().toISOString(),
  });
  if (text.length === 0) return { written: false, reason: 'empty_text' };

  const s3Key = buildScreeningSummaryKey(caseId);
  const body = Buffer.from(text, 'utf-8');
  await s3().send(new PutObjectCommand({
    Bucket: bucket, Key: s3Key, Body: body, ContentType: 'text/plain', ServerSideEncryption: 'aws:kms',
  }));

  // Upsert by the unique s3Key: a re-extraction refreshes the file's Document row (no duplicate).
  await (db as unknown as {
    document: { upsert: (a: { where: { s3Key: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => Promise<unknown> };
  }).document.upsert({
    where: { s3Key },
    create: {
      caseId, filename: 'Screening Summary.txt', sizeBytes: BigInt(body.length),
      contentType: 'text/plain', docTag: 'screening_summary', s3Key, uploadedBy: SERVICE_ACTORS.WORKER,
    },
    update: { sizeBytes: BigInt(body.length), version: { increment: 1 } },
  });

  return { written: true, s3Key, count: screenings.length };
}
