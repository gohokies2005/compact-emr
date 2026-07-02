import { classifyReadAttempt, nonWhitespaceCharCount } from './chart-readiness.js';
import { maybeEnqueueChartExtract } from './chart-extract-trigger.js';
import { fireDocumentTitle } from './document-title-trigger.js';
import { SERVICE_ACTORS } from './service-actors.js';
import type { AppDb } from './db-types.js';

// A file may only auto-skip as 'no medical content' when its TOTAL transcribed text is below this floor
// (a non-record image — a photo/selfie/scenery — yields ~0 chars). If the vision model flagged every
// page non-medical yet still transcribed substantive text, that contradiction defers to the normal
// classify path (flag for review) rather than silently dropping it. Mirrors the 10-char read floor.
const MIN_CHARS_FOR_NON_MEDICAL_SKIP = 10;

// Strip NUL bytes (U+0000) from extracted text. Postgres `text`/`varchar` columns CANNOT store 0x00
// ("invalid byte sequence for encoding UTF8: 0x00", SQLSTATE 22021) — a single NUL anywhere in a page's
// text rolls back the ENTIRE documentPage write, 500s the /pages callback, and (after SQS retries) dead-
// letters the OCR job, freezing the whole case at 0 pages read. Born-digital PDFs routinely carry stray
// NULs in their text layer (Apolito's 900-page Blue Button, 2026-06-18). Removing the control char loses
// nothing clinical. Also scrub other C0 control chars except tab/newline/CR, which Postgres also dislikes
// in some collations and which are never meaningful record content.
export function stripPgUnsafeChars(s: string): string {
  // Remove NUL and other C0 control chars EXCEPT tab/newline/CR. Postgres text columns cannot store
  // 0x00 (SQLSTATE 22021); a single NUL rolls back the whole page write. charCodeAt avoids a literal
  // control-char regex in source.
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20) out += s[i];
  }
  return out;
}

export interface DocumentPageInput {
  readonly pageNumber: number;
  readonly text: string;
  readonly confidence: number | null;
  // Per-page extraction provenance (vision rebuild 2026-06-16). Optional: callers that don't supply
  // them (Textract/native paths, legacy) leave them null. The vision path stamps coverage/handwriting
  // so the honest-coverage layer can count per-page truthfully.
  readonly extractionMethod?: string | null;
  readonly extractionCoverage?: string | null;
  readonly handwritingPresent?: boolean | null;
  // Per-page 'no medical content' verdict (vision model, Ryan 2026-06-18). TRUE only when the page is
  // affirmatively a non-record image (photo/selfie/scenery/screenshot/blank), NOT when it merely failed
  // to read. Default null/undefined on Textract/native/legacy paths. The file auto-skips ONLY when EVERY
  // page is true AND nothing substantive was transcribed (computed below), so one real page anywhere
  // keeps the whole file in the case.
  readonly noMedicalContent?: boolean | null;
}

export interface WriteDocumentPagesResult {
  readonly documentId: string;
  readonly caseId: string | null;
  readonly pagesUpserted: number;
  readonly documentPageCount: number | null;
  readonly readTerminalStatus?: string;
}

/**
 * Single-source side-effect for writing OCR pages onto a case Document. Extracted from
 * POST /internal/documents/:id/pages so the parse-at-intake assign path (#8 v2) can copy the
 * intake-time OCR text forward through the EXACT same path — pages upsert + Document.pageCount +
 * the file_read_status chart-readiness bridge + chart-extract enqueue — instead of inlining a
 * divergent copy. Idempotent: re-running overwrites identical rows. The page-write + readiness
 * bridge are one transaction; the chart-extract enqueue runs AFTER commit in a log-only catch so it
 * can never roll back the OCR write.
 */
export async function writeDocumentPages(
  db: AppDb,
  documentId: string,
  pages: readonly DocumentPageInput[],
  documentPageCount: number | null,
): Promise<WriteDocumentPagesResult> {
  const now = new Date();

  const result = await db.$transaction(async (tx) => {
    for (const page of pages) {
      // Strip NUL/control chars before the Postgres write — a 0x00 anywhere in the text rolls back the
      // whole transaction (SQLSTATE 22021) and dead-letters the OCR job (Apolito Blue Button, 2026-06-18).
      const safeText = stripPgUnsafeChars(page.text);
      // Provenance is optional; coalesce undefined → null so it persists explicitly (and a re-OCR
      // through a path that DOES supply it overwrites a prior null).
      const prov = {
        extractionMethod: page.extractionMethod ?? null,
        extractionCoverage: page.extractionCoverage != null ? stripPgUnsafeChars(page.extractionCoverage) : null,
        handwritingPresent: page.handwritingPresent ?? null,
      };
      await tx.documentPage.upsert({
        where: { documentId_pageNumber: { documentId, pageNumber: page.pageNumber } },
        create: { documentId, pageNumber: page.pageNumber, text: safeText, confidence: page.confidence, ...prov },
        update: { text: safeText, confidence: page.confidence, extractedAt: new Date(), ...prov },
      });
    }

    if (documentPageCount !== null) {
      await (tx as unknown as { document: { update: (args: { where: { id: string }; data: { pageCount: number } }) => Promise<unknown> } }).document.update({
        where: { id: documentId },
        data: { pageCount: documentPageCount },
      });
    }

    // Bridge the OCR success into the chart-readiness gate (it reads file_read_status exclusively).
    // Resolve the document's caseId + s3Key, run the concatenated text through classifyReadAttempt so
    // a "successful" but garbled / too-few-words read still lands manual_summary_required (not a false
    // 'read'), and upsert file_read_status (caseId, s3Key) in the SAME transaction. Never overwrite an
    // RN's manual_summary_provided clearance.
    const doc = await (tx as unknown as {
      document: { findUnique: (args: { where: { id: string }; select?: Record<string, true> }) => Promise<{ id: string; caseId: string; s3Key: string } | null> };
    }).document.findUnique({ where: { id: documentId }, select: { id: true, caseId: true, s3Key: true } });

    let readStatus: { terminalStatus: string; wordCount: number; corruptedTokenRatio: number } | null = null;
    if (doc !== null) {
      const concatenatedText = pages.map((p) => stripPgUnsafeChars(p.text)).join('\n');
      // Size signal for the SIZE-AWARE word floor (classifyReadAttempt): prefer the reported page count,
      // fall back to the number of pages we actually wrote text for. A <=1-page file with any text is a
      // valid small file ("CPAP" note) and must not block. Persisted into the attempt so the retroactive
      // reconciliation can self-heal a previously-flagged small file. (Ryan 2026-06-13.)
      const docPages = documentPageCount ?? pages.length;
      // NON-MEDICAL auto-skip (Ryan 2026-06-18): every page affirmatively judged a non-record image by
      // the vision model AND nothing substantive transcribed → the file is junk (helicopter photos), not
      // an unread record, so it must not block the case. Both conditions are required: a single real page
      // (noMedicalContent !== true) or any substantive text keeps the file in the normal classify path
      // (the data-loss guard — never silently drop a record).
      const allNonMedical =
        pages.length > 0 &&
        pages.every((p) => p.noMedicalContent === true) &&
        nonWhitespaceCharCount(concatenatedText) < MIN_CHARS_FOR_NON_MEDICAL_SKIP;
      const outcome = classifyReadAttempt({ method: 'textract', extractedText: concatenatedText, pageCount: docPages, noMedicalContent: allNonMedical });

      const existing = await tx.fileReadStatus.findFirst({ where: { caseId: doc.caseId, filePath: doc.s3Key } });
      const newAttempt = {
        method: 'textract' as const,
        wordCount: outcome.wordCount,
        charCount: nonWhitespaceCharCount(concatenatedText),
        corruptedTokenRatio: outcome.corruptedTokenRatio,
        pageCount: docPages,
        attemptedAt: now.toISOString(),
        note: outcome.succeeded ? `Textract read OK (${outcome.wordCount} words)` : `Textract read insufficient: ${outcome.reason}`,
      };
      const prior: readonly unknown[] = (existing?.attemptsJson as readonly unknown[] | undefined) ?? [];
      const attempts = [...prior, newAttempt];

      // Terminal-status decision. An existing RN clearance ('manual_summary_provided') is NEVER
      // downgraded — it wins over everything, even a later successful re-read (this writer's original,
      // test-locked behavior; do NOT reorder it below 'succeeded'). Then:
      //   succeeded                                  -> 'read'
      //   auto-skip (genuinely empty <=1-page file)  -> 'auto_skipped' (NON-BLOCKING; no RN action)
      //   otherwise                                  -> 'manual_summary_required' (HALT until RN)
      // BUG (was, FIX 2 2026-06-14): this writer ignored outcome.autoSkip and dead-ended every
      // non-success to manual_summary_required, so a genuine 0-byte/empty file flowing through the
      // Textract /pages callback (the LIVE path) was NEVER auto-skipped in production — only the
      // /read-attempts route honored it. A substantive sliver / garbled / multi-page-empty read has
      // autoSkip=false and still lands manual_summary_required (the data-loss guard: never silently
      // drop a real record).
      const terminalStatus =
        existing?.terminalStatus === 'manual_summary_provided'
          ? 'manual_summary_provided'
          : outcome.succeeded
            ? 'read'
            : outcome.autoSkip === true
              ? 'auto_skipped'
              : 'manual_summary_required';

      if (existing) {
        await tx.fileReadStatus.update({
          where: { id: existing.id },
          data: { terminalStatus, attemptsJson: attempts, lastCheckedAt: now, version: { increment: 1 } },
        });
      } else {
        await tx.fileReadStatus.create({
          data: { caseId: doc.caseId, filePath: doc.s3Key, fileSha256: '', terminalStatus, attemptsJson: attempts, lastCheckedAt: now },
        });
      }
      readStatus = { terminalStatus, wordCount: outcome.wordCount, corruptedTokenRatio: outcome.corruptedTokenRatio };

      // FAIL-LOUD (FIX 5, 2026-06-14): the classify decision that PARKS a file (manual_summary_required)
      // was previously invisible outside the RN UI — a false-garble pile-up could grow silently. Emit one
      // structured CloudWatch line for every classification on this LIVE producer path so a regression in
      // the heuristic is visible in logs (a metric-filter alarm keys on reason='garbled' parks).
      console.log(JSON.stringify({
        msg: 'read_classified',
        caseId: doc.caseId,
        filePath: doc.s3Key,
        // Honest provenance for the tripwire: label the read by where it came from (QA nice-to-have) —
        // a vision-stamped page set is 'claude_vision', not 'textract'. (classifyReadAttempt ignores
        // method, so this is observability-only.)
        method: pages.some((p) => typeof p.extractionMethod === 'string' && p.extractionMethod.startsWith('vision')) ? 'claude_vision' : 'textract',
        terminalStatus,
        reason: outcome.reason,
        ratio: outcome.corruptedTokenRatio,
        chars: nonWhitespaceCharCount(concatenatedText),
        words: outcome.wordCount,
      }));
    }

    await tx.activityLog.create({
      data: {
        actorUserId: SERVICE_ACTORS.WORKER,
        action: 'document_pages_extracted',
        ...(doc !== null ? { caseId: doc.caseId } : {}),
        detailsJson: {
          documentId,
          pageCount: pages.length,
          ...(documentPageCount !== null && { documentPageCount }),
          ...(readStatus !== null && { readTerminalStatus: readStatus.terminalStatus, readWordCount: readStatus.wordCount }),
        },
      },
    });

    return {
      documentId,
      caseId: doc !== null ? doc.caseId : null,
      pagesUpserted: pages.length,
      documentPageCount,
      ...(readStatus !== null && { readTerminalStatus: readStatus.terminalStatus }),
    } as WriteDocumentPagesResult;
  }, { timeout: 30_000, maxWait: 10_000 });

  // Chart auto-extract trigger runs AFTER the page-write COMMITS, log-only so it can never roll back
  // the OCR write. Fires exactly once per (case, doc-set) once all docs are OCR-terminal.
  if (result.caseId !== null) {
    try {
      await maybeEnqueueChartExtract(db, result.caseId);
    } catch (err) {
      console.error(JSON.stringify({ msg: 'chart_extract_enqueue_failed', documentId, caseId: result.caseId, error: err instanceof Error ? err.message : String(err) }));
    }
  }

  // AI document titling — DISPATCHED OFF-REQUEST via async Lambda self-invoke (InvocationType:'Event',
  // see document-title-trigger.ts), mirroring the SOAP/viability recompute. The ~2s Haiku call must NOT
  // run inline: writeDocumentPages is called in a synchronous per-doc FOR-LOOP inside ONE intake-assign
  // API request (routes/intakes.ts), so N inline Haiku calls would risk the 29s API-Gateway cap. This
  // dispatch is a fast async 202 and fail-open (fireDocumentTitle never throws); the fresh invocation
  // runs generateAndPersistDocumentTitle on its own 120s budget. Idempotent (skips already-titled docs)
  // + killable via AI_DOC_TITLE_ENABLED=off (the trigger short-circuits when off). Only after pages
  // committed, so the async worker re-reads this doc's text.
  if (result.caseId !== null) {
    await fireDocumentTitle(documentId);
  }

  return result;
}
