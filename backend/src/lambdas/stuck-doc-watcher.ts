import { PrismaClient, Prisma } from '@prisma/client';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SERVICE_ACTORS } from '../services/service-actors.js';
import { TERMINAL_READ_STATUSES, isScreeningSummaryKey } from '../services/chart-build-state.js';
import { classifyReadAttempt, nonWhitespaceCharCount } from '../services/chart-readiness.js';

/**
 * Stuck-DOCUMENT watcher (Ryan 2026-06-13: "no errors, no babysitting, no silent failures").
 *
 * A document reaches a TERMINAL file_read_status ('read' | 'manual_summary_required' |
 * 'manual_summary_provided') on every NORMAL path. But two real cases reached NO terminal row at all —
 * Woodley's .docx (uploaded before the native-docx reader shipped) and Lozano's 6MB PDF (Textract
 * completion SNS-dropped, no DLQ) — so deriveChartBuildState pinned the case in 'ocr_in_progress'
 * FOREVER, invisibly: no blocking file in the RN queue, no error, no alarm. The DraftJob + DoctorPack
 * watchers exist; this is the missing OCR analogue and the keystone of the never-stuck guarantee.
 *
 * "Stuck" = a Document with NO DocumentPage rows (a successful read writes pages + the read-status in
 * ONE txn, so no-pages ⟺ no successful read) AND no TERMINAL file_read_status row for (caseId, s3Key),
 * uploaded longer than STUCK_MS ago. Excludes the screening-summary output + _rendered/ letter outputs
 * (not OCR inputs). A row already at manual_summary_required IS terminal → NOT stuck (it's visible to
 * the RN already).
 *
 * Sweep policy — ONE re-fire, then flag (bounded; never an infinite re-fire loop, cf the doctor-pack
 * pypdf incident that republished for 14h):
 *   - no prior watcher re-fire → re-fire OCR once by invoking ocr-start with a synthetic ObjectCreated
 *     event (runs the identical start_handler path: native readers + the completion DLQ now exist, so
 *     Woodley/Lozano-class docs heal). Log 'ocr_refired_by_watcher'.
 *   - a prior re-fire older than REFIRE_GIVE_UP_MS AND still no terminal row → GIVE UP: write terminal
 *     'manual_summary_required' with an actionable note. Log 'ocr_swept_to_manual' (metric-filter alarm).
 *     Loud, RN-visible, overridable — never silent.
 *
 * Scheduled every 5 min from WorkersStack. No injected arg (the runtime passes the EVENT as the first
 * positional, which silently dead-ed the draft watcher for days — this shape can't hit that footgun).
 */

const STUCK_MS = 20 * 60 * 1000; // past the ocr-start async-retry window (~1-2 min) + a normal Textract job
const REFIRE_GIVE_UP_MS = 30 * 60 * 1000; // a re-fire this old that still didn't land a terminal row → flag manual
const BATCH_LIMIT = 50;
const RENDERED_MARKER = '/_rendered/';
const GIVE_UP_NOTE =
  'We could not automatically read this file after re-trying. Please open it and write a short summary, or ask the veteran for a clearer PDF.';

let cachedPrisma: PrismaClient | null = null;
function getPrisma(): PrismaClient {
  if (cachedPrisma === null) cachedPrisma = new PrismaClient();
  return cachedPrisma;
}
let cachedLambda: LambdaClient | null = null;
function getLambda(): LambdaClient {
  if (cachedLambda === null) cachedLambda = new LambdaClient({});
  return cachedLambda;
}

export interface StuckDocWatcherResult {
  ranAt: string;
  refired: number;
  sweptToManual: number;
  waiting: number;
  stamped: number;
  // FIX 4 (2026-06-14): rows healed by Phase 3 re-classify — a manual_summary_required row whose stored
  // pages PASS the (now-corrected) heuristic and flip to 'read' with NO re-OCR. Self-heals the false-garble
  // backlog after the corruptedTokenRatio fix deploys.
  reclassified: number;
  errors: number;
}

function detailsHasDocId(detailsJson: unknown, documentId: string): boolean {
  return (
    typeof detailsJson === 'object' &&
    detailsJson !== null &&
    (detailsJson as Record<string, unknown>)['documentId'] === documentId
  );
}

/** Re-trigger OCR by invoking ocr-start with a synthetic S3 ObjectCreated event (no S3 copy / KMS).
 *  start_handler runs unquote_plus on object.key, so encodeURIComponent round-trips the real key. */
async function refireOcr(bucket: string, s3Key: string): Promise<void> {
  const functionName = process.env['OCR_START_FUNCTION_NAME'];
  if (!functionName) throw new Error('OCR_START_FUNCTION_NAME is required for the stuck-doc re-fire');
  const event = { detail: { bucket: { name: bucket }, object: { key: encodeURIComponent(s3Key) } } };
  await getLambda().send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event', // async — don't block the sweep on the OCR run
      Payload: Buffer.from(JSON.stringify(event)),
    }),
  );
}

export interface WatcherDeps {
  prisma: PrismaClient;
  invokeOcr: (bucket: string, s3Key: string) => Promise<void>;
}

/** Footgun guard: EventBridge invokes handler(event) — the event must NEVER be mistaken for deps (that
 *  silently dead-ed the draft watcher for days). Trust an injected arg ONLY if it carries our deps
 *  shape; otherwise (incl. when the EventBridge event is passed) fall back to the real clients. */
function resolveDeps(injected?: unknown): WatcherDeps {
  if (injected && typeof injected === 'object' && 'prisma' in injected && 'invokeOcr' in injected) {
    return injected as WatcherDeps;
  }
  return { prisma: getPrisma(), invokeOcr: refireOcr };
}

export async function handler(injected?: unknown): Promise<StuckDocWatcherResult> {
  const now = new Date();
  const boundary = new Date(now.getTime() - STUCK_MS);
  const { prisma, invokeOcr } = resolveDeps(injected);
  const bucket = process.env['RECORDS_BUCKET'] ?? '';

  let refired = 0;
  let sweptToManual = 0;
  let waiting = 0;
  let stamped = 0;
  let reclassified = 0;
  let errors = 0;

  // Candidates: Documents with NO DocumentPage rows (no successful read), old enough to be stuck. Most
  // docs HAVE pages, so this is a tight set. We anti-join FileReadStatus in code (no FK between the two).
  const candidates = await prisma.document.findMany({
    where: { uploadedAt: { lt: boundary }, pages: { none: {} } },
    take: BATCH_LIMIT,
    select: { id: true, caseId: true, s3Key: true, uploadedAt: true },
  });

  for (const doc of candidates) {
    try {
      if (isScreeningSummaryKey(doc.s3Key) || doc.s3Key.includes(RENDERED_MARKER)) continue; // not an OCR input

      const frs = await prisma.fileReadStatus.findFirst({ where: { caseId: doc.caseId, filePath: doc.s3Key } });
      if (frs && TERMINAL_READ_STATUSES.has(frs.terminalStatus)) continue; // already terminal (e.g. flagged) — not stuck

      // Prior watcher re-fires for THIS document (re-fires are rare → filter detailsJson.documentId in JS).
      const priorRefireLogs = await prisma.activityLog.findMany({
        where: { caseId: doc.caseId, action: 'ocr_refired_by_watcher' },
        orderBy: { ts: 'asc' },
        take: 20,
      });
      const firstRefire = priorRefireLogs.find((l) => detailsHasDocId(l.detailsJson, doc.id));

      if (!firstRefire) {
        // First encounter → re-fire OCR exactly once.
        await invokeOcr(bucket, doc.s3Key);
        await prisma.activityLog.create({
          data: {
            actorUserId: SERVICE_ACTORS.STUCK_JOB_WATCHER,
            caseId: doc.caseId,
            action: 'ocr_refired_by_watcher',
            detailsJson: { documentId: doc.id, s3Key: doc.s3Key, uploadedAt: doc.uploadedAt.toISOString(), stuckThresholdMin: STUCK_MS / 60000 },
          },
        });
        refired += 1;
        console.log(JSON.stringify({ msg: 'stuck-doc-watcher: re-fired OCR', documentId: doc.id, caseId: doc.caseId, s3Key: doc.s3Key }));
        continue;
      }

      // A prior re-fire exists. If it's old enough and the doc STILL has no terminal row → give up to manual.
      if (now.getTime() - firstRefire.ts.getTime() > REFIRE_GIVE_UP_MS) {
        if (frs && frs.terminalStatus === 'manual_summary_provided') continue; // never clobber the RN's clearance
        const newAttempt = {
          method: 'textract' as const,
          wordCount: 0,
          corruptedTokenRatio: 0,
          pageCount: null,
          attemptedAt: now.toISOString(),
          note: 'auto-OCR timed out after a watcher re-fire — summarize manually',
        };
        if (frs) {
          const prior: readonly unknown[] = Array.isArray(frs.attemptsJson) ? (frs.attemptsJson as readonly unknown[]) : [];
          await prisma.fileReadStatus.update({
            where: { id: frs.id },
            data: { terminalStatus: 'manual_summary_required', attemptsJson: [...prior, newAttempt] as unknown as Prisma.InputJsonValue, lastCheckedAt: now, version: { increment: 1 } },
          });
        } else {
          await prisma.fileReadStatus.create({
            data: { caseId: doc.caseId, filePath: doc.s3Key, fileSha256: '', terminalStatus: 'manual_summary_required', attemptsJson: [newAttempt] as unknown as Prisma.InputJsonValue, lastCheckedAt: now },
          });
        }
        await prisma.activityLog.create({
          data: {
            actorUserId: SERVICE_ACTORS.STUCK_JOB_WATCHER,
            caseId: doc.caseId,
            action: 'ocr_swept_to_manual',
            detailsJson: { documentId: doc.id, s3Key: doc.s3Key, refiredAt: firstRefire.ts.toISOString(), note: GIVE_UP_NOTE },
          },
        });
        sweptToManual += 1;
        console.log(JSON.stringify({ msg: 'stuck-doc-watcher: swept to manual after re-fire timed out', documentId: doc.id, caseId: doc.caseId, s3Key: doc.s3Key }));
        continue;
      }

      // Re-fired recently — give the re-fire time to complete before deciding.
      waiting += 1;
    } catch (err) {
      errors += 1;
      console.error(
        JSON.stringify({
          msg: 'stuck-doc-watcher: sweep failed for document',
          documentId: doc.id,
          caseId: doc.caseId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  // ===== Phase 2: text-but-no-status docs (post-intake / import landed pages without a read-status) =====
  // A doc with extracted pages but NO terminal file_read_status keeps the case in ocr_in_progress, and the
  // no-pages candidate query above CANNOT see it (it HAS pages). The text is already there — don't re-OCR;
  // CLASSIFY the existing pages and write the missing status. Reaches a case via a post-intake upload or a
  // bulk import/migration that wrote pages without going through document-pages-writer. (Ryan 2026-06-13:
  // post-intake docs are real and must work — Woodley's GERD .docx case.) No FK between Document and
  // FileReadStatus, so a parameterized raw NOT-EXISTS SELECT is the bounded way to find "pages, no status".
  const orphanPaged = await prisma.$queryRaw<Array<{ id: string; case_id: string; s3_key: string }>>`
    SELECT d.id, d.case_id, d.s3_key
    FROM documents d
    WHERE d.uploaded_at < ${boundary}
      AND EXISTS (SELECT 1 FROM document_pages p WHERE p.document_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM file_read_status f WHERE f.case_id = d.case_id AND f.file_path = d.s3_key)
    LIMIT ${BATCH_LIMIT}
  `;
  for (const d of orphanPaged) {
    try {
      if (isScreeningSummaryKey(d.s3_key) || d.s3_key.includes(RENDERED_MARKER)) continue; // not an OCR input
      const pageRows = await prisma.documentPage.findMany({ where: { documentId: d.id }, orderBy: { pageNumber: 'asc' }, select: { text: true } });
      const text = pageRows.map((p) => p.text ?? '').join('\n');
      const outcome = classifyReadAttempt({ method: 'textract', extractedText: text, pageCount: pageRows.length });
      const terminalStatus = outcome.succeeded ? 'read' : 'manual_summary_required';
      const attempt = {
        method: 'textract' as const,
        wordCount: outcome.wordCount,
        charCount: nonWhitespaceCharCount(text),
        corruptedTokenRatio: outcome.corruptedTokenRatio,
        pageCount: pageRows.length,
        attemptedAt: now.toISOString(),
        note: `watcher classified existing pages — ${outcome.succeeded ? 'read OK' : outcome.reason}`,
      };
      await prisma.fileReadStatus.create({
        data: { caseId: d.case_id, filePath: d.s3_key, fileSha256: '', terminalStatus, attemptsJson: [attempt] as unknown as Prisma.InputJsonValue, lastCheckedAt: now },
      });
      await prisma.activityLog.create({
        data: { actorUserId: SERVICE_ACTORS.STUCK_JOB_WATCHER, caseId: d.case_id, action: 'ocr_classified_orphan_pages', detailsJson: { documentId: d.id, s3Key: d.s3_key, terminalStatus, wordCount: outcome.wordCount } },
      });
      stamped += 1;
      console.log(JSON.stringify({ msg: 'stuck-doc-watcher: stamped orphan-paged doc', documentId: d.id, caseId: d.case_id, terminalStatus }));
    } catch (err) {
      errors += 1;
      console.error(JSON.stringify({ msg: 'stuck-doc-watcher: stamp orphan-paged doc failed', documentId: d.id, caseId: d.case_id, error: err instanceof Error ? err.message : String(err) }));
    }
  }

  // ===== Phase 3: re-classify false-garble manual_summary_required rows (FIX 4, 2026-06-14) =====
  // The corruptedTokenRatio fix narrowed the garble heuristic, but terminalStatus is written ONCE at
  // classification time, so rows already parked at 'manual_summary_required' under the OLD over-broad
  // heuristic stay parked forever. The retroactive heal in chart-readiness (lastAttemptPassesCurrentThresholds)
  // can't save a FALSE-GARBLE row — it short-circuits on the stored corruptedTokenRatio > 0.08. Phase 2
  // above can't reach these either: it requires NOT EXISTS file_read_status, and these DO have a row.
  //
  // So: scan rows still at 'manual_summary_required' that HAVE document pages, RE-RUN classifyReadAttempt
  // on the stored page text (NO re-OCR), and if it NOW succeeds, flip to 'read'. Bounded by BATCH_LIMIT.
  // Guards: only 'manual_summary_required' is touched (never an RN's manual_summary_provided, never an
  // already-good 'read'/'auto_skipped'); the row only HEALS (we never re-park a row that still fails —
  // it is already correctly parked + RN-visible). The whole class self-heals within one sweep cycle.
  const stuckGarbleRows = await prisma.fileReadStatus.findMany({
    where: { terminalStatus: 'manual_summary_required' },
    take: BATCH_LIMIT,
    select: { id: true, caseId: true, filePath: true, attemptsJson: true },
  });
  for (const frs of stuckGarbleRows) {
    try {
      if (isScreeningSummaryKey(frs.filePath) || frs.filePath.includes(RENDERED_MARKER)) continue;
      // Find the matching Document (same s3Key) so we can read its stored pages — no FK between the tables.
      const doc = await prisma.document.findFirst({ where: { caseId: frs.caseId, s3Key: frs.filePath }, select: { id: true } });
      if (doc === null) continue; // orphan readiness row (reconciled away by the GET route) — leave it
      const pageRows = await prisma.documentPage.findMany({ where: { documentId: doc.id }, orderBy: { pageNumber: 'asc' }, select: { text: true } });
      if (pageRows.length === 0) continue; // no stored text to re-judge — Phase 1/2 own the no-pages case
      const text = pageRows.map((p) => p.text ?? '').join('\n');
      const outcome = classifyReadAttempt({ method: 'textract', extractedText: text, pageCount: pageRows.length });
      if (!outcome.succeeded) continue; // still genuinely fails the (corrected) heuristic — correctly parked

      const prior: readonly unknown[] = Array.isArray(frs.attemptsJson) ? (frs.attemptsJson as readonly unknown[]) : [];
      const attempt = {
        method: 'textract' as const,
        wordCount: outcome.wordCount,
        charCount: nonWhitespaceCharCount(text),
        corruptedTokenRatio: outcome.corruptedTokenRatio,
        pageCount: pageRows.length,
        attemptedAt: now.toISOString(),
        note: 'watcher re-classified stored pages under corrected heuristic — read OK (no re-OCR)',
      };
      await prisma.fileReadStatus.update({
        where: { id: frs.id },
        data: { terminalStatus: 'read', attemptsJson: [...prior, attempt] as unknown as Prisma.InputJsonValue, lastCheckedAt: now, version: { increment: 1 } },
      });
      await prisma.activityLog.create({
        data: { actorUserId: SERVICE_ACTORS.STUCK_JOB_WATCHER, caseId: frs.caseId, action: 'ocr_reclassified_to_read', detailsJson: { documentId: doc.id, s3Key: frs.filePath, wordCount: outcome.wordCount, ratio: outcome.corruptedTokenRatio } },
      });
      reclassified += 1;
      console.log(JSON.stringify({ msg: 'stuck-doc-watcher: re-classified false-garble row to read', documentId: doc.id, caseId: frs.caseId, s3Key: frs.filePath, ratio: outcome.corruptedTokenRatio }));
    } catch (err) {
      errors += 1;
      console.error(JSON.stringify({ msg: 'stuck-doc-watcher: re-classify failed', fileReadStatusId: frs.id, caseId: frs.caseId, error: err instanceof Error ? err.message : String(err) }));
    }
  }

  const summary: StuckDocWatcherResult = { ranAt: now.toISOString(), refired, sweptToManual, waiting, stamped, reclassified, errors };
  console.log(JSON.stringify({ msg: 'stuck-doc-watcher: summary', ...summary }));
  return summary;
}
