import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import { currentActor } from '../services/request-actor.js';
import { evaluateChartReadiness } from '../services/chart-readiness.js';
import {
  assembleDoctorPackManifest,
  DOCTOR_PACK_ENGINE_VERSION,
} from '../services/doctor-pack.js';
import { classifyFile } from '../services/key-docs-classifier.js';
import { selectPages, type PageSelectorInputPage } from '../services/page-selector.js';
import { aggregateChartSummary } from '../services/chart-summary-aggregator.js';
import { publishDoctorPackQueued } from '../services/doctor-pack-queue.js';
import { isDoctorPackS3Key } from '../services/s3-key-safety.js';
import type { AppDb, DocumentPageRecord, KeyDocClassification, KeyDocType } from '../services/db-types.js';

// Path-traversal guard. The Doctor Pack PDF lives at a deterministic S3 key derived from the
// caseId + caseVersion + doctorPackId. We construct the key server-side and refuse to honor
// any client-supplied key. Task #107a (later) extracted the validator into a shared module
// so the worker-callback path (PATCH /internal/doctor-packs/:id) uses the same check.
function isSafeS3Key(s3Key: string): boolean {
  return isDoctorPackS3Key(s3Key);
}

function buildDoctorPackS3Key(caseId: string, caseVersion: number, doctorPackId: string): string {
  // caseId is constrained by the case-create validator (no slashes, no '..'); we still belt-and-
  // suspenders by rejecting anything outside the safe pattern after construction.
  const safeCaseId = caseId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const key = `doctor-packs/${safeCaseId}/v${caseVersion}/${doctorPackId}.pdf`;
  if (!isSafeS3Key(key)) {
    throw new HttpError(500, 'internal_error', 'Constructed Doctor Pack S3 key failed safety check.', { caseId, caseVersion, doctorPackId });
  }
  return key;
}

// Helper: fetch the full CaseRecord shape the cover-page aggregator needs. The list query
// used by `/generate` selects a narrower projection; re-fetch with the columns the
// aggregator's input type requires.
async function fetchCaseRowForCover(db: AppDb, caseId: string, veteranId: string) {
  const c = await db.case.findFirst({ where: { id: caseId } });
  if (c === null) {
    // Fall back to a minimal shape sourced from the route's prior lookup. Shouldn't happen in
    // practice because the route already verified the case exists; this is type-belt-and-suspenders.
    return {
      id: caseId,
      claimedCondition: '',
      claimType: 'initial' as const,
      framingChoice: null,
      upstreamScCondition: null,
      status: 'intake' as const,
      veteranId,
      cdsVerdict: 'not_yet_run' as const,
      cdsOddsPct: null,
      cdsRationale: null,
      veteranStatement: null,
      inServiceEvent: null,
    };
  }
  return {
    id: c.id,
    claimedCondition: c.claimedCondition,
    claimType: c.claimType,
    framingChoice: c.framingChoice,
    upstreamScCondition: c.upstreamScCondition,
    status: c.status,
    veteranId: c.veteranId,
    cdsVerdict: c.cdsVerdict,
    cdsOddsPct: c.cdsOddsPct,
    cdsRationale: c.cdsRationale,
    veteranStatement: c.veteranStatement,
    inServiceEvent: c.inServiceEvent,
  };
}

export function createDoctorPackRouter(db: AppDb): Router {
  const router = Router();

  /**
   * POST /api/v1/cases/:id/doctor-pack/generate
   *
   * Kicks off a Doctor Pack assembly. Three checks before queuing:
   *   1. Case exists.
   *   2. Chart-readiness gate is GREEN (OCR HARD-STOP — no Doctor Pack until every file is
   *      read or manual-summarized).
   *   3. The classified-files set is non-empty (no point assembling an empty pack).
   *
   * On success: writes one KeyDoc row per file (idempotent upsert on caseId+filePath), creates
   * a DoctorPack row in state='queued' with the manifest, returns the row to the caller.
   *
   * The actual PDF assembly is a downstream SQS-triggered Lambda worker (deployed via
   * workers-stack.ts as compact-emr-<env>-doctor-pack-assembler) that reads the manifest from
   * the SQS message body, pulls source PDFs from S3, extracts the manifest's page ranges,
   * concatenates, uploads to the computed s3 key, and PATCHes the row to state='ready' +
   * page_count.
   */
  router.post(
    '/cases/:id/doctor-pack/generate',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const actor = currentActor(req);
      const caseId = String(req.params.id);

      // Phase 7B-fix (architect REVIEW.md b99de30 finding #1): documents are case-scoped
      // (`Case.documents Document[]`), not veteran-scoped. The prior `db.veteran.findUnique`
      // call would have crashed at runtime because Veteran has no `documents` relation.
      // Delegate's `findFirst` returns CaseRecord without the include — cast through unknown
      // to expose the included documents array.
      const caseWithDocs = (await db.case.findFirst({
        where: { id: caseId },
        select: {
          id: true,
          veteranId: true,
          version: true,
          documents: {
            // H1 (audit 2026-05-27): `id` MUST be selected. classifiedFiles maps
            // documentId: d.id, and the page-selector queries document_pages by that id.
            // Omitting it made documentId undefined => allDocumentIds empty => page text
            // never loaded => page selection inert.
            select: { id: true, s3Key: true, pageCount: true },
            orderBy: { uploadedAt: 'asc' },
          },
        },
      })) as unknown as { id: string; veteranId: string; version: number; documents: readonly { id: string; s3Key: string; pageCount: number | null }[] } | null;
      if (caseWithDocs === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      const c = { id: caseWithDocs.id, veteranId: caseWithDocs.veteranId, version: caseWithDocs.version };

      // Architect REVIEW.md finding #2: preempt double-click-Generate with a 409 before the
       // partial-unique index would fire as a 500. Returns the in-flight row so the UI can
       // poll it instead of starting a new one.
      const inFlight = await db.doctorPack.findFirst({
        where: { caseId, caseVersion: caseWithDocs.version, state: { in: ['queued', 'generating'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (inFlight !== null) {
        throw new HttpError(409, 'conflict', 'A Doctor Pack assembly is already in flight for this case version.', {
          caseId,
          inFlightDoctorPackId: inFlight.id,
          state: inFlight.state,
        });
      }

      const readStatuses = await db.fileReadStatus.findMany({ where: { caseId } });
      const readiness = evaluateChartReadiness(readStatuses);
      if (!readiness.ready) {
        throw new HttpError(409, 'chart_not_ready', 'Cannot generate Doctor Pack until every file is read or has a manual summary.', {
          caseId,
          blockingFiles: readiness.blockingFiles,
          gateVersion: readiness.gateVersion,
        });
      }

      // Document.pageCount is populated by the OCR worker when Textract returns the page
      // total. Until the worker is shipped, page_count stays null and the assembler treats
      // null as "include from page 1 onward; worker discovers exact bound at extraction".
      // We also pull existing KeyDoc rows to preserve per-doc physician overrides + notes.
      const docList = caseWithDocs.documents as readonly { id: string; s3Key: string; pageCount: number | null }[];
      const existingKeyDocs = await db.keyDoc.findMany({ where: { caseId } });
      const existingByPath = new Map(existingKeyDocs.map((kd) => [kd.filePath, kd]));

      const classifiedFiles = docList
        .map((d) => {
          const readStatus = readStatuses.find((r) => r.filePath === d.s3Key);
          return {
            documentId: d.id,
            filePath: d.s3Key,
            fileSha256: readStatus?.fileSha256 ?? '',
            pageCount: d.pageCount ?? null,
          };
        })
        .filter((f) => f.filePath.length > 0);

      if (classifiedFiles.length === 0) {
        throw new HttpError(409, 'conflict', 'No documents on this case yet; upload records before generating a Doctor Pack.', { caseId });
      }

      // Phase 7B-revised Build 1: load per-page extracted text for each Document so the
      // page-selector can apply doc-type-aware rules. Until the OCR worker is shipped, the
      // documentPage delegate returns empty arrays — page-selector returns empty ranges
      // (forward-compatible: the assembler's old "whole document" path is unchanged when
      // page-selector returns []).
      const pagesByDocumentId = new Map<string, readonly DocumentPageRecord[]>();
      const allDocumentIds = classifiedFiles.map((f) => f.documentId).filter((id) => id.length > 0);
      if (allDocumentIds.length > 0) {
        const pageRows = await db.documentPage.findMany({
          where: { documentId: { in: allDocumentIds } },
          orderBy: [{ documentId: 'asc' }, { pageNumber: 'asc' }],
        });
        for (const row of pageRows) {
          const existing = pagesByDocumentId.get(row.documentId) ?? [];
          pagesByDocumentId.set(row.documentId, [...existing, row]);
        }
      }

      // Page-selector pass: for each classified file, decide which pages go in the pack.
      const perFileSelection = classifiedFiles.map((f) => {
        const cls = classifyFile(f.filePath);
        const pageRows = pagesByDocumentId.get(f.documentId) ?? [];
        const pagesInput: readonly PageSelectorInputPage[] = pageRows.map((p) => ({
          pageNumber: p.pageNumber,
          text: p.text,
          confidence: p.confidence,
        }));
        const existing = existingByPath.get(f.filePath);
        const selection = selectPages({
          filePath: f.filePath,
          docType: cls.docType,
          classification: cls.classification,
          pageCount: f.pageCount ?? pageRows.length ?? 0,
          pages: pagesInput,
          physicianIncludeAllPages: existing?.physicianIncludeAllPages ?? false,
        });
        return { file: f, classification: cls, selection };
      });

      // Assemble manifest: legacy whole-doc path for files with no per-page data; page-selected
      // for files with at least one DocumentPage row. The selection.pageRanges may be empty
      // (no_per_page_text_available) — the legacy assembler handles empty by including the
      // whole file at extraction time.
      const manifest = assembleDoctorPackManifest({ classifiedFiles, readStatuses });
      // Override the manifest entries' pageRanges with selector output when present.
      const refinedEntries = manifest.entries.map((entry) => {
        const sel = perFileSelection.find((s) => s.file.filePath === entry.filePath);
        if (!sel) return entry;
        const ranges = sel.selection.pageRanges;
        if (ranges.length === 0) return entry;
        const pageCount = ranges.reduce((sum, r) => sum + Math.max(0, r.to - r.from + 1), 0);
        return { ...entry, pageRanges: ranges, pageCount };
      });
      const refinedTotalPageCount = refinedEntries.reduce((sum, e) => sum + e.pageCount, 0);

      // Cover-page summary (architect plan: lives in DoctorPack.manifestJson.coverPage).
      const coverPage = await aggregateChartSummary({
        db,
        caseRow: await fetchCaseRowForCover(db, caseId, c.veteranId),
      });

      const result = await db.$transaction(async (tx) => {
        // Architect REVIEW.md b99de30 finding: the prior implementation did
        // `deleteMany({ where: { caseId } })` then `upsert`, which destroyed RN-authored
        // `notes` on every re-generation. Switch to per-row upsert WITHOUT wipe so notes
        // survive. Stale rows for files no longer on the case are removed by selective
        // deleteMany scoped to NOT IN the current file set.
        const currentFilePaths = classifiedFiles.map((f) => f.filePath);
        if (currentFilePaths.length > 0) {
          await tx.keyDoc.deleteMany({ where: { caseId, filePath: { notIn: currentFilePaths } } });
        }
        for (const sel of perFileSelection) {
          const f = sel.file;
          const cls = sel.classification;
          const refinedEntry = refinedEntries.find((e) => e.filePath === f.filePath);
          const existing = existingByPath.get(f.filePath);

          // Architect QA finding #1 (REVIEW.md 0cd4df0): durable RN acknowledgement.
          // If an RN previously cleared `needsRnReview` for this file (selectorAcknowledgedAt
          // is set), preserve that decision across regeneration. Otherwise use the fresh
          // selector verdict.
          // Architect QA Build 2 finding #2 (REVIEW.md 8344668): clear the ack when the
          // doc_type changes — the RN cleared the file under different semantics. A re-
          // classified file needs a fresh review.
          const docTypeChanged = existing !== undefined && existing.docType !== cls.docType;
          const needsRnReviewToWrite = existing?.selectorAcknowledgedAt && !docTypeChanged
            ? false
            : sel.selection.needsRnReview;

          await tx.keyDoc.upsert({
            where: { caseId_filePath: { caseId, filePath: f.filePath } },
            create: {
              caseId,
              filePath: f.filePath,
              fileSha256: f.fileSha256,
              classification: cls.classification,
              docType: cls.docType,
              importance: cls.importance,
              pageRanges: refinedEntry?.pageRanges ?? sel.selection.pageRanges,
              needsRnReview: sel.selection.needsRnReview,
              selectorVersion: sel.selection.selectorVersion,
              selectorRationale: sel.selection.selectorRationale,
            },
            update: {
              fileSha256: f.fileSha256,
              classification: cls.classification,
              docType: cls.docType,
              importance: cls.importance,
              pageRanges: refinedEntry?.pageRanges ?? sel.selection.pageRanges,
              needsRnReview: needsRnReviewToWrite,
              selectorVersion: sel.selection.selectorVersion,
              selectorRationale: sel.selection.selectorRationale,
              version: { increment: 1 },
              // When docType changes (classifier upgrade or content re-classification), wipe
              // the stale RN acknowledgement — the file means something different now.
              ...(docTypeChanged ? { selectorAcknowledgedAt: null, selectorAcknowledgedBy: null } : {}),
              // NOTE: `notes` and `physicianIncludeAllPages` are intentionally NOT in the
              // update payload — RN-authored notes + per-doc physician overrides survive
              // re-generation of the Doctor Pack manifest. RN acknowledgements survive too
              // except on docType change (above).
            },
          });
        }

        // Architect QA finding #2 (REVIEW.md 0f8b64a): generate the row id client-side so the
        // deterministic S3 key can be computed in the same single .create call — kills the
        // prior create + update double-write.
        const doctorPackId = randomUUID();
        const s3Key = buildDoctorPackS3Key(caseId, c.version, doctorPackId);
        const stamped = await tx.doctorPack.create({
          data: {
            id: doctorPackId,
            caseId,
            caseVersion: c.version,
            state: 'queued',
            pdfS3Key: s3Key,
            keyDocCount: refinedEntries.length,
            pageCount: refinedTotalPageCount,
            // Phase 7B-revised Build 1: manifestJson carries entries (with refined page ranges)
            // + cover-page summary (the chart-state snapshot the assembler renders as PDF page 1).
            // The page-selector's per-file rationale lives on each KeyDoc row (selectorRationale)
            // for audit replay; the cover page surfaces top-line state only.
            manifestJson: {
              entries: refinedEntries,
              engineVersion: DOCTOR_PACK_ENGINE_VERSION,
              ...(coverPage ? { coverPage } : {}),
            },
            generatedBy: actor.sub,
          },
        });

        await tx.activityLog.create({
          data: {
            actorUserId: actor.sub,
            action: 'doctor_pack_queued',
            caseId,
            ...(c.veteranId ? { veteranId: c.veteranId } : {}),
            // Architect QA finding (REVIEW.md 0cd4df0): write the POST-page-selection
            // counts in the activity log, not the pre-refinement whole-doc counts.
            detailsJson: {
              caseId,
              doctorPackId: stamped.id,
              keyDocCount: refinedEntries.length,
              pageCount: refinedTotalPageCount,
              aboveTarget: refinedTotalPageCount > 250,
              engineVersion: DOCTOR_PACK_ENGINE_VERSION,
              preRefinementKeyDocCount: manifest.keyDocCount,
              preRefinementPageCount: manifest.totalPageCount,
            },
          },
        });

        return stamped;
      });

      // Architect closeout #2: SQS publish to the Doctor Pack assembler worker queue.
      // Done OUTSIDE the transaction — if SQS fails, the row stays queued and the request
      // still succeeds (the row is the source of truth; a worker retry path can pick up
      // orphan queued rows later). In test mode this is a no-op (DOCTOR_PACK_QUEUE_URL unset).
      try {
        await publishDoctorPackQueued({
          doctorPackId: result.id,
          caseId,
          pdfS3Key: result.pdfS3Key ?? '',
          manifest: result.manifestJson,
        });
      } catch (sqsErr) {
        // Log but don't fail the request — the worker can be backfilled.
        console.warn('doctor-pack SQS publish failed (row queued; manual retry available):', sqsErr);
      }

      res.status(201).json({ data: result });
    }),
  );

  /**
   * GET /api/v1/cases/:id/doctor-pack/latest
   *
   * Returns the most recent DoctorPack row for the case (any state). Used by the UI to render
   * "Doctor Pack: generating | ready | failed" and the signed URL when ready.
   */
  router.get(
    '/cases/:id/doctor-pack/latest',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const row = await db.doctorPack.findFirst({
        where: { caseId },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ data: row });
    }),
  );

  /**
   * GET /api/v1/cases/:id/key-docs
   *
   * Returns the classified key-docs list for the case, importance descending. Used by the UI
   * to show "what's in the Doctor Pack" before / instead of opening the PDF.
   */
  router.get(
    '/cases/:id/key-docs',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const rows = await db.keyDoc.findMany({
        where: { caseId },
        orderBy: [{ importance: 'desc' }, { filePath: 'asc' }],
      });
      res.json({ data: rows });
    }),
  );

  /**
   * GET /api/v1/rn/key-docs-needing-review
   *
   * Closeout item #5: cross-case queue of KeyDocs the page-selector flagged for RN review
   * (needsRnReview=true). Oldest first (FIFO). Optional ?limit (default 50, max 200).
   * admin + ops_staff only. The RN page surfaces this alongside the manual-summary queue;
   * RNs ack via POST /api/v1/key-docs/:id/acknowledge.
   */
  router.get(
    '/rn/key-docs-needing-review',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const limitRaw = req.query['limit'];
      let limit = 50;
      if (typeof limitRaw === 'string') {
        const parsed = Number.parseInt(limitRaw, 10);
        if (Number.isInteger(parsed) && parsed > 0) limit = Math.min(parsed, 200);
      }
      const rows = await db.keyDoc.findMany({
        where: { needsRnReview: true },
        orderBy: { updatedAt: 'asc' },
      });
      res.json({ data: rows.slice(0, limit), total: rows.length });
    }),
  );

  /**
   * POST /api/v1/key-docs/:id/acknowledge
   *
   * Architect QA finding (REVIEW.md 0cd4df0, Build 1 follow-up): RN-durable clearance.
   * Marks a KeyDoc as RN-reviewed. Clears needsRnReview AND stamps selectorAcknowledgedAt
   * so the next /generate doesn't reset the flag. Body: optional `notes` (free text).
   */
  router.post(
    '/key-docs/:id/acknowledge',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const actor = currentActor(req);
      const id = String(req.params.id);
      const notesRaw = (req.body as { notes?: unknown })?.notes;
      const notesUpdate = typeof notesRaw === 'string' && notesRaw.trim().length > 0
        ? notesRaw.trim().slice(0, 2000)
        : undefined;

      const existing = await db.keyDoc.findUnique({ where: { id } });
      if (existing === null) throw new HttpError(404, 'not_found', 'KeyDoc not found', { keyDocId: id });

      const updated = await db.$transaction(async (tx) => {
        const row = await tx.keyDoc.update({
          where: { id },
          data: {
            needsRnReview: false,
            selectorAcknowledgedAt: new Date(),
            selectorAcknowledgedBy: actor.sub,
            version: { increment: 1 },
            ...(notesUpdate !== undefined ? { notes: notesUpdate } : {}),
          },
        });
        await tx.activityLog.create({
          data: {
            actorUserId: actor.sub,
            action: 'key_doc_rn_acknowledged',
            caseId: existing.caseId,
            detailsJson: { keyDocId: id, caseId: existing.caseId, filePath: existing.filePath },
          },
        });
        return row;
      });

      res.json({ data: updated });
    }),
  );

  return router;
}

export type { KeyDocType, KeyDocClassification };
