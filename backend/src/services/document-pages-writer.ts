import { classifyReadAttempt } from './chart-readiness.js';
import { maybeEnqueueChartExtract } from './chart-extract-trigger.js';
import { SERVICE_ACTORS } from './service-actors.js';
import type { AppDb } from './db-types.js';

export interface DocumentPageInput {
  readonly pageNumber: number;
  readonly text: string;
  readonly confidence: number | null;
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
      await tx.documentPage.upsert({
        where: { documentId_pageNumber: { documentId, pageNumber: page.pageNumber } },
        create: { documentId, pageNumber: page.pageNumber, text: page.text, confidence: page.confidence },
        update: { text: page.text, confidence: page.confidence, extractedAt: new Date() },
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
      const concatenatedText = pages.map((p) => p.text).join('\n');
      const outcome = classifyReadAttempt({ method: 'textract', extractedText: concatenatedText });

      const existing = await tx.fileReadStatus.findFirst({ where: { caseId: doc.caseId, filePath: doc.s3Key } });
      const newAttempt = {
        method: 'textract' as const,
        wordCount: outcome.wordCount,
        corruptedTokenRatio: outcome.corruptedTokenRatio,
        attemptedAt: now.toISOString(),
        note: outcome.succeeded ? `Textract read OK (${outcome.wordCount} words)` : `Textract read insufficient: ${outcome.reason}`,
      };
      const prior: readonly unknown[] = (existing?.attemptsJson as readonly unknown[] | undefined) ?? [];
      const attempts = [...prior, newAttempt];

      const terminalStatus =
        existing?.terminalStatus === 'manual_summary_provided'
          ? 'manual_summary_provided'
          : outcome.succeeded ? 'read' : 'manual_summary_required';

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

  return result;
}
