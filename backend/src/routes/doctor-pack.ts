import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import { currentActor } from '../services/request-actor.js';
import { evaluateChartReadiness } from '../services/chart-readiness.js';
import {
  applyPackPageBudget,
  assembleDoctorPackManifest,
  DOCTOR_PACK_ENGINE_VERSION,
  PACK_PAGE_BUDGET,
  PACK_PAGE_TARGET,
  type BudgetEntry,
} from '../services/doctor-pack.js';
import { classifyDocument } from '../services/key-docs-classifier.js';
import { selectPages, type PageSelectorInputPage } from '../services/page-selector.js';
import { aggregateChartSummary } from '../services/chart-summary-aggregator.js';
import { publishDoctorPackQueued } from '../services/doctor-pack-queue.js';
import { isDoctorPackS3Key } from '../services/s3-key-safety.js';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AppDb, DocumentPageRecord, KeyDocClassification, KeyDocType } from '../services/db-types.js';

// Chunk D (2026-06-11): presigned GET for the assembled pack PDF (mirrors the drafter
// artifact-pdf-url pattern). Client cached module-wide; injectable for tests.
let cachedS3Client: S3Client | null = null;
function getS3ForDoctorPacks(): S3Client {
  if (cachedS3Client !== null) return cachedS3Client;
  cachedS3Client = new S3Client({ forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true' });
  return cachedS3Client;
}
const DOCTOR_PACK_PDF_TTL_SECONDS = 5 * 60;

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

export function createDoctorPackRouter(db: AppDb, opts?: { s3?: Pick<S3Client, 'send'> }): Router {
  const router = Router();
  const s3ForPacks = (): Pick<S3Client, 'send'> => opts?.s3 ?? getS3ForDoctorPacks();

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
          // Chunk D: claimedCondition feeds the page-selector's progress-notes condition rule.
          claimedCondition: true,
          documents: {
            // H1 (audit 2026-05-27): `id` MUST be selected. classifiedFiles maps
            // documentId: d.id, and the page-selector queries document_pages by that id.
            // Omitting it made documentId undefined => allDocumentIds empty => page text
            // never loaded => page selection inert.
            // Chunk D: docTag is the uploader's explicit label - the human classification
            // override when set (currently null/'Other' for all uploads).
            select: { id: true, s3Key: true, pageCount: true, docTag: true },
            orderBy: { uploadedAt: 'asc' },
          },
        },
      })) as unknown as { id: string; veteranId: string; version: number; claimedCondition: string | null; documents: readonly { id: string; s3Key: string; pageCount: number | null; docTag: string | null }[] } | null;
      if (caseWithDocs === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
      const c = { id: caseWithDocs.id, veteranId: caseWithDocs.veteranId, version: caseWithDocs.version };
      const claimedCondition = caseWithDocs.claimedCondition ?? undefined;

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
      const docList = caseWithDocs.documents as readonly { id: string; s3Key: string; pageCount: number | null; docTag: string | null }[];
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
            docTag: d.docTag,
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
      // Chunk D (2026-06-11): classification is CONTENT-AWARE. Real uploads are named
      // Misc_1.pdf...Misc_12.pdf, so the prior classifyFile(f.filePath) classified EVERYTHING
      // 'unspecified' -> first-8-pages rule -> the entire VA-letter/statement/STR rule set in
      // page-selector.ts never ran. classifyDocument composes: docTag (human override) >
      // content text (first 2 OCR'd pages) > filename (legacy fallback).
      const CONTENT_HINT_CHARS_PER_PAGE = 4000;
      const perFileSelection = classifiedFiles.map((f) => {
        const pageRows = pagesByDocumentId.get(f.documentId) ?? [];
        const contentText = pageRows
          .filter((p) => p.pageNumber <= 2)
          .map((p) => p.text.slice(0, CONTENT_HINT_CHARS_PER_PAGE))
          .join('\n');
        const cls = classifyDocument({ filePath: f.filePath, docTag: f.docTag, contentText });
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
          ...(claimedCondition !== undefined ? { claimedCondition } : {}),
        });
        return { file: f, classification: cls, selection };
      });
      const clsByPath = new Map(perFileSelection.map((s) => [s.file.filePath, s.classification]));

      // Assemble manifest: legacy whole-doc path for files with no per-page data; page-selected
      // for files with at least one DocumentPage row. The selection.pageRanges may be empty
      // (no_per_page_text_available) — the legacy assembler handles empty by including the
      // whole file at extraction time. The content-aware classification is passed through so
      // the manifest's include/exclude tiers agree with the selector's docTypes.
      const manifest = assembleDoctorPackManifest({
        classifiedFiles: classifiedFiles.map((f) => ({ ...f, cls: clsByPath.get(f.filePath) })),
        readStatuses,
      });
      // Override the manifest entries' pageRanges with selector output when present.
      const refinedEntries = manifest.entries.map((entry) => {
        const sel = perFileSelection.find((s) => s.file.filePath === entry.filePath);
        if (!sel) return entry;
        const ranges = sel.selection.pageRanges;
        if (ranges.length === 0) return entry;
        const pageCount = ranges.reduce((sum, r) => sum + Math.max(0, r.to - r.from + 1), 0);
        return { ...entry, pageRanges: ranges, pageCount };
      });

      // Chunk D: APPEND selector-positive files the tier rules excluded from the manifest —
      // concretely progress_notes (bulk tier, excluded by selectKeyDocs) whose new condition/
      // recent-encounter rule selected actual pages. Only non-empty selections are appended:
      // an empty-ranged entry would make the assembler ship the WHOLE doc (handler.py H2).
      const manifestPaths = new Set(refinedEntries.map((e) => e.filePath));
      const readStatusByPath = new Map(readStatuses.map((r) => [r.filePath, r]));
      const appendedEntries = perFileSelection
        .filter((s) => !manifestPaths.has(s.file.filePath))
        .filter((s) => s.selection.pageRanges.length > 0)
        .filter((s) => readStatusByPath.get(s.file.filePath)?.terminalStatus !== 'manual_summary_required')
        .map((s) => ({
          filePath: s.file.filePath,
          docType: s.classification.docType,
          classification: s.classification.classification,
          pageRanges: s.selection.pageRanges,
          pageCount: s.selection.pageRanges.reduce((sum, r) => sum + Math.max(0, r.to - r.from + 1), 0),
        }));

      // Re-sort the combined set with the manifest's own comparator (tier > importance > path)
      // so appended bulk docs land last, then apply Ryan's pack page budget (10-15pp target,
      // hard trim at PACK_PAGE_BUDGET=20) deterministically.
      const tierOrder: Record<string, number> = { high_signal: 0, normal: 1, bulk: 2 };
      const combinedEntries: BudgetEntry[] = [...refinedEntries, ...appendedEntries]
        .map((e) => ({ ...e, importance: clsByPath.get(e.filePath)?.importance ?? 50 }))
        .sort((a, b) => {
          if (tierOrder[a.classification] !== tierOrder[b.classification]) {
            return (tierOrder[a.classification] ?? 1) - (tierOrder[b.classification] ?? 1);
          }
          if (a.importance !== b.importance) return b.importance - a.importance;
          return a.filePath.localeCompare(b.filePath);
        });
      const budget = applyPackPageBudget(combinedEntries, PACK_PAGE_BUDGET);
      const trimmedPaths = new Set(budget.trimmedFilePaths);
      // Strip the budget-only `importance` so manifestJson keeps the exact entry contract the
      // assembler + RN review UI already consume.
      const finalEntries = budget.entries.map(({ importance: _importance, ...entry }) => entry);
      const finalRangesByPath = new Map(finalEntries.map((e) => [e.filePath, e.pageRanges]));
      const refinedTotalPageCount = budget.postTrimPageCount;

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
          const existing = existingByPath.get(f.filePath);

          // Chunk D: the KeyDoc row reflects what's ACTUALLY in the pack post-budget. A file in
          // the final manifest carries its budgeted ranges; a file the budget dropped (or that
          // was never included) carries the selector's raw output so the RN review UI can still
          // show what the selector found.
          const wasTrimmed = trimmedPaths.has(f.filePath);
          const rangesToWrite = finalRangesByPath.get(f.filePath)
            ?? (wasTrimmed ? [] : sel.selection.pageRanges);
          const rationaleToWrite = wasTrimmed
            ? `${sel.selection.selectorRationale}; pack_page_budget(${PACK_PAGE_BUDGET}) trimmed this file`
            : sel.selection.selectorRationale;
          const freshNeedsRnReview = sel.selection.needsRnReview || wasTrimmed;

          // Architect QA finding #1 (REVIEW.md 0cd4df0): durable RN acknowledgement.
          // If an RN previously cleared `needsRnReview` for this file (selectorAcknowledgedAt
          // is set), preserve that decision across regeneration. Otherwise use the fresh
          // selector verdict. (The budget trim is deterministic — same inputs re-trim the same
          // way — so a prior ack stays meaningful across regenerations.)
          // Architect QA Build 2 finding #2 (REVIEW.md 8344668): clear the ack when the
          // doc_type changes — the RN cleared the file under different semantics. A re-
          // classified file needs a fresh review.
          const docTypeChanged = existing !== undefined && existing.docType !== cls.docType;
          const needsRnReviewToWrite = existing?.selectorAcknowledgedAt && !docTypeChanged
            ? false
            : freshNeedsRnReview;

          await tx.keyDoc.upsert({
            where: { caseId_filePath: { caseId, filePath: f.filePath } },
            create: {
              caseId,
              filePath: f.filePath,
              fileSha256: f.fileSha256,
              classification: cls.classification,
              docType: cls.docType,
              importance: cls.importance,
              pageRanges: rangesToWrite,
              needsRnReview: freshNeedsRnReview,
              selectorVersion: sel.selection.selectorVersion,
              selectorRationale: rationaleToWrite,
            },
            update: {
              fileSha256: f.fileSha256,
              classification: cls.classification,
              docType: cls.docType,
              importance: cls.importance,
              pageRanges: rangesToWrite,
              needsRnReview: needsRnReviewToWrite,
              selectorVersion: sel.selection.selectorVersion,
              selectorRationale: rationaleToWrite,
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
            keyDocCount: finalEntries.length,
            pageCount: refinedTotalPageCount,
            // Phase 7B-revised Build 1: manifestJson carries entries (with refined page ranges)
            // + cover-page summary (the chart-state snapshot the assembler renders as PDF page 1).
            // The page-selector's per-file rationale lives on each KeyDoc row (selectorRationale)
            // for audit replay; the cover page surfaces top-line state only.
            // Chunk D: budgetTrim records what the pack page budget removed (RN-visible audit).
            manifestJson: {
              entries: finalEntries,
              engineVersion: DOCTOR_PACK_ENGINE_VERSION,
              ...(coverPage ? { coverPage } : {}),
              ...(budget.trimmed
                ? {
                    budgetTrim: {
                      budget: PACK_PAGE_BUDGET,
                      preTrimPageCount: budget.preTrimPageCount,
                      postTrimPageCount: budget.postTrimPageCount,
                      trimNotes: budget.trimNotes,
                    },
                  }
                : {}),
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
              keyDocCount: finalEntries.length,
              pageCount: refinedTotalPageCount,
              // Chunk D re-key: aboveTarget stays the HARD compression flag (PACK_PAGE_TARGET=250,
              // worker may downsample); the curation budget is the separate budget* fields.
              aboveTarget: refinedTotalPageCount > PACK_PAGE_TARGET,
              budget: PACK_PAGE_BUDGET,
              budgetTrimmed: budget.trimmed,
              budgetPreTrimPageCount: budget.preTrimPageCount,
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
   * GET /api/v1/cases/:id/doctor-pack/:packId/pdf-url
   *
   * Chunk D (2026-06-11): 5-min presigned GET URL for the assembled Doctor Pack PDF. Mirrors
   * the letter-artifact presign (drafter.ts artifact-pdf-url). No prior route could serve the
   * pack — it lives in the SEPARATE doctorPacksBucket (DOCTOR_PACKS_BUCKET_NAME env; the API
   * Lambda already has the env + grantRead via api-stack.ts, unread until now).
   *
   * Access: same as the other doctor-pack GETs (admin / ops_staff / physician).
   * Validates: pack exists, belongs to the URL case, is ready with a pdfS3Key, key passes the
   * doctor-packs path validator; HeadObject confirms the object exists before signing.
   */
  router.get(
    '/cases/:id/doctor-pack/:packId/pdf-url',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const caseId = String(req.params.id);
      const packId = String(req.params.packId);

      const bucket = process.env['DOCTOR_PACKS_BUCKET_NAME'];
      if (typeof bucket !== 'string' || bucket.length === 0) {
        throw new HttpError(503, 'internal_error', 'DOCTOR_PACKS_BUCKET_NAME not configured');
      }

      const pack = await db.doctorPack.findFirst({ where: { id: packId } });
      if (pack === null || pack.caseId !== caseId) {
        throw new HttpError(404, 'not_found', 'Doctor Pack not found for this case', { caseId, packId });
      }
      if (pack.state !== 'ready' || typeof pack.pdfS3Key !== 'string' || pack.pdfS3Key.length === 0) {
        throw new HttpError(404, 'not_found', 'No Doctor Pack PDF exists yet (pack is not ready)', { caseId, packId, state: pack.state });
      }
      if (!isSafeS3Key(pack.pdfS3Key)) {
        throw new HttpError(500, 'internal_error', 'Stored Doctor Pack S3 key fails safety check', { caseId, packId });
      }

      const s3 = s3ForPacks();
      // Confirm the object exists before signing — a ready row whose PDF was lifecycle-deleted
      // should 404 cleanly, not hand back a URL that resolves to S3 NoSuchKey XML.
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: pack.pdfS3Key }));
      } catch {
        throw new HttpError(404, 'not_found', 'The Doctor Pack PDF object is missing from storage', { caseId, packId });
      }
      const url = await getSignedUrl(s3 as S3Client, new GetObjectCommand({ Bucket: bucket, Key: pack.pdfS3Key }), {
        expiresIn: DOCTOR_PACK_PDF_TTL_SECONDS,
      });
      const expiresAt = new Date(Date.now() + DOCTOR_PACK_PDF_TTL_SECONDS * 1000).toISOString();

      res.json({ data: { url, expiresAt, ttlSeconds: DOCTOR_PACK_PDF_TTL_SECONDS } });
    }),
  );

  /**
   * GET /api/v1/cases/:id/key-docs
   *
   * Returns the classified key-docs list for the case, importance descending. Used by the UI
   * to show "what's in the Doctor Pack" before / instead of opening the PDF.
   * Chunk D: each row is enriched with `docPageCount` (the source Document's total pages,
   * joined on s3Key) so the panel can render "3 of 25 pages".
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
      const docs = (await db.document.findMany({
        where: { caseId },
        select: { s3Key: true, pageCount: true, filename: true },
      })) as unknown as readonly { s3Key: string; pageCount: number | null; filename: string }[];
      const docByKey = new Map(docs.map((d) => [d.s3Key, d]));
      const enriched = rows.map((r) => ({
        ...r,
        docPageCount: docByKey.get(r.filePath)?.pageCount ?? null,
        filename: docByKey.get(r.filePath)?.filename ?? null,
      }));
      res.json({ data: enriched });
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
