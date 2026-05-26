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
import type { AppDb, DoctorPackManifestEntry, KeyDocClassification, KeyDocType } from '../services/db-types.js';

// Path-traversal guard. The Doctor Pack PDF lives at a deterministic S3 key derived from the
// caseId + caseVersion + doctorPackId. We construct the key server-side and refuse to honor
// any client-supplied key. This closes the security hole flagged in Task #107.
function isSafeS3Key(s3Key: string): boolean {
  if (typeof s3Key !== 'string') return false;
  if (s3Key.includes('..')) return false;
  if (s3Key.startsWith('/')) return false;
  return /^doctor-packs\/[a-zA-Z0-9_-]+\/v\d+\/[a-f0-9-]+\.pdf$/.test(s3Key);
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
   * The actual PDF assembly is a downstream Lambda worker that polls for queued rows, pulls
   * source PDFs from S3, extracts the manifest's page ranges, concatenates, uploads to the
   * computed s3 key, and PATCHes the row to state='ready' + page_count. Not in this commit;
   * the worker is part of Phase 7A (OCR + Doctor Pack workers ship together).
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
            select: { s3Key: true, pageCount: true },
            orderBy: { uploadedAt: 'asc' },
          },
        },
      })) as unknown as { id: string; veteranId: string; version: number; documents: readonly { s3Key: string; pageCount: number | null }[] } | null;
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

      // Document.pageCount is populated by the ingest worker when Textract returns the page
      // total. Until the worker is shipped, page_count stays null and the assembler treats
      // null as "include from page 1 onward; worker discovers exact bound at extraction".
      const docList = caseWithDocs.documents;
      const classifiedFiles = docList
        .map((d) => {
          const readStatus = readStatuses.find((r) => r.filePath === d.s3Key);
          return {
            filePath: d.s3Key,
            fileSha256: readStatus?.fileSha256 ?? '',
            pageCount: d.pageCount ?? null,
          };
        })
        .filter((f) => f.filePath.length > 0);

      if (classifiedFiles.length === 0) {
        throw new HttpError(409, 'conflict', 'No documents on this case yet; upload records before generating a Doctor Pack.', { caseId });
      }

      const manifest = assembleDoctorPackManifest({ classifiedFiles, readStatuses });

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
        for (const f of classifiedFiles) {
          const cls = classifyFile(f.filePath);
          const manifestEntry: DoctorPackManifestEntry | undefined = manifest.entries.find((e) => e.filePath === f.filePath);
          await tx.keyDoc.upsert({
            where: { caseId_filePath: { caseId, filePath: f.filePath } },
            create: {
              caseId,
              filePath: f.filePath,
              fileSha256: f.fileSha256,
              classification: cls.classification,
              docType: cls.docType,
              importance: cls.importance,
              pageRanges: manifestEntry?.pageRanges ?? [],
            },
            update: {
              fileSha256: f.fileSha256,
              classification: cls.classification,
              docType: cls.docType,
              importance: cls.importance,
              pageRanges: manifestEntry?.pageRanges ?? [],
              version: { increment: 1 },
              // NOTE: `notes` is intentionally NOT in the update payload — RN-authored notes
              // survive re-generation of the Doctor Pack manifest.
            },
          });
        }

        const doctorPackRow = await tx.doctorPack.create({
          data: {
            caseId,
            caseVersion: c.version,
            state: 'queued',
            keyDocCount: manifest.keyDocCount,
            pageCount: manifest.totalPageCount,
            manifestJson: { entries: manifest.entries, engineVersion: DOCTOR_PACK_ENGINE_VERSION },
            generatedBy: actor.sub,
          },
        });

        // Stamp the deterministic S3 key now that we have the row id. The worker reads this
        // field, not a client-supplied path, when it uploads the assembled PDF.
        const s3Key = buildDoctorPackS3Key(caseId, c.version, doctorPackRow.id);
        const stamped = await tx.doctorPack.update({
          where: { id: doctorPackRow.id },
          data: { pdfS3Key: s3Key, version: { increment: 1 } },
        });

        await tx.activityLog.create({
          data: {
            actorUserId: actor.sub,
            action: 'doctor_pack_queued',
            caseId,
            ...(c.veteranId ? { veteranId: c.veteranId } : {}),
            detailsJson: {
              caseId,
              doctorPackId: stamped.id,
              keyDocCount: manifest.keyDocCount,
              pageCount: manifest.totalPageCount,
              aboveTarget: manifest.aboveTarget,
              engineVersion: DOCTOR_PACK_ENGINE_VERSION,
            },
          },
        });

        return stamped;
      });

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

  return router;
}

export type { KeyDocType, KeyDocClassification };
