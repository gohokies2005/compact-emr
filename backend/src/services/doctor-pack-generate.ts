import { randomUUID } from 'node:crypto';
import { HttpError } from '../http/errors.js';
import { evaluateChartReadiness, isEffectivelyRead } from './chart-readiness.js';
import {
  applyPackPageBudget,
  assembleDoctorPackManifest,
  DOCTOR_PACK_ENGINE_VERSION,
  PACK_PAGE_BUDGET,
  PACK_PAGE_TARGET,
  type BudgetEntry,
} from './doctor-pack.js';
import { classifyDocument } from './key-docs-classifier.js';
import { selectPages, type PageSelectorInputPage } from './page-selector.js';
import { aggregateChartSummary } from './chart-summary-aggregator.js';
import { publishDoctorPackQueued } from './doctor-pack-queue.js';
import { isDoctorPackS3Key } from './s3-key-safety.js';
import type { AppDb, DoctorPackRecord, DocumentPageRecord } from './db-types.js';

/**
 * Package 7 (2026-06-11): the Doctor Pack generate body, EXTRACTED from
 * POST /api/v1/cases/:id/doctor-pack/generate (routes/doctor-pack.ts) so the case
 * status-transition route (rn_review/drafting -> physician_review) and the manual generate
 * endpoint run ONE copy — no HTTP self-call. The route is now a thin wrapper.
 *
 * Two trigger modes, differing ONLY in the idempotency guard:
 *   - 'manual' (POST /generate, the default): an in-flight pack (queued/generating at the
 *     current case version) throws a 409 HttpError — exactly the pre-extraction contract.
 *     A READY pack does NOT block: Regenerate must keep working.
 *   - 'auto_send_to_doctor' (the status-route hook): NEVER throws a conflict. Skips (returns
 *     outcome 'skipped') when a pack in queued/generating/ready exists at the CURRENT case
 *     version OR at `priorCaseVersion` (the version immediately before the status transition
 *     bumped it). The only mutation between those two versions IS the status flip itself, so a
 *     pack the RN generated manually just before clicking "Send to doctor" reflects the
 *     identical chart — re-enqueueing it would be the double-gen the guard exists to prevent.
 *     A genuinely new letter/chart state (docs uploaded, correction round-trip, ...) advances
 *     the version past both keys and generates fresh.
 *
 * Everything else (readiness gate, classification, page selection, budget, manifest, KeyDoc
 * upserts, DoctorPack row, activity log, SQS publish) is byte-equivalent to the route body it
 * came from. SQS publish stays OUTSIDE the transaction: if it fails the row stays 'queued' and
 * the request still succeeds (the row is the source of truth; the stuck-pack watcher backstops).
 */

// Path-traversal guard. The Doctor Pack PDF lives at a deterministic S3 key derived from the
// caseId + caseVersion + doctorPackId. We construct the key server-side and refuse to honor
// any client-supplied key (shared validator: s3-key-safety.ts).
function buildDoctorPackS3Key(caseId: string, caseVersion: number, doctorPackId: string): string {
  // caseId is constrained by the case-create validator (no slashes, no '..'); we still belt-and-
  // suspenders by rejecting anything outside the safe pattern after construction.
  const safeCaseId = caseId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const key = `doctor-packs/${safeCaseId}/v${caseVersion}/${doctorPackId}.pdf`;
  if (!isDoctorPackS3Key(key)) {
    throw new HttpError(500, 'internal_error', 'Constructed Doctor Pack S3 key failed safety check.', { caseId, caseVersion, doctorPackId });
  }
  return key;
}

// Helper: fetch the full CaseRecord shape the cover-page aggregator needs. The generate query
// selects a narrower projection; re-fetch with the columns the aggregator's input type requires.
async function fetchCaseRowForCover(db: AppDb, caseId: string, veteranId: string) {
  const c = await db.case.findFirst({ where: { id: caseId } });
  if (c === null) {
    // Fall back to a minimal shape sourced from the prior lookup. Shouldn't happen in practice
    // because the caller already verified the case exists; this is type-belt-and-suspenders.
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

export interface GenerateDoctorPackParams {
  readonly caseId: string;
  // Stamped as DoctorPack.generatedBy + the activity-log actor. For the auto trigger this is
  // the RN who clicked "Send to doctor" (the status route's authenticated user).
  readonly actorSub: string;
  readonly trigger?: 'manual' | 'auto_send_to_doctor';
  // Auto trigger only: the case version immediately BEFORE the status transition bumped it.
  readonly priorCaseVersion?: number;
}

export type GenerateDoctorPackResult =
  | { readonly outcome: 'queued'; readonly pack: DoctorPackRecord }
  | {
      readonly outcome: 'skipped';
      readonly existingPackId: string;
      readonly existingState: DoctorPackRecord['state'];
      readonly existingCaseVersion: number;
    };

export async function generateDoctorPackForCase(
  db: AppDb,
  params: GenerateDoctorPackParams,
): Promise<GenerateDoctorPackResult> {
  const { caseId, actorSub } = params;
  const trigger = params.trigger ?? 'manual';

  // Phase 7B-fix (architect REVIEW.md b99de30 finding #1): documents are case-scoped
  // (`Case.documents Document[]`), not veteran-scoped. Delegate's `findFirst` returns
  // CaseRecord without the include — cast through unknown to expose the included documents.
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

  if (trigger === 'auto_send_to_doctor') {
    // Auto-gen idempotency (Package 7): skip when a pack for the CURRENT chart state already
    // exists — queued/generating (in flight) or ready — keyed on the post-transition case
    // version AND the pre-transition version (see module doc comment). Skip, never 409: the
    // status transition already committed and must not be made to look failed.
    const currentVersions =
      params.priorCaseVersion !== undefined && params.priorCaseVersion !== caseWithDocs.version
        ? [caseWithDocs.version, params.priorCaseVersion]
        : [caseWithDocs.version];
    const existingPack = await db.doctorPack.findFirst({
      where: { caseId, caseVersion: { in: currentVersions }, state: { in: ['queued', 'generating', 'ready'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (existingPack !== null) {
      return {
        outcome: 'skipped',
        existingPackId: existingPack.id,
        existingState: existingPack.state,
        existingCaseVersion: existingPack.caseVersion,
      };
    }
  } else {
    // Architect REVIEW.md finding #2: preempt double-click-Generate with a 409 before the
    // partial-unique index would fire as a 500. Returns the in-flight row so the UI can
    // poll it instead of starting a new one. (A READY pack does NOT block — Regenerate.)
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
  // Package 7 (H-tail): the read-status screen here is the SHARED isEffectivelyRead predicate
  // (was a raw terminalStatus !== 'manual_summary_required' check) so a retro-healed file is
  // appendable and an invalid-summary row is not — same consolidation as selectKeyDocs.
  const manifestPaths = new Set(refinedEntries.map((e) => e.filePath));
  const readStatusByPath = new Map(readStatuses.map((r) => [r.filePath, r]));
  const appendedEntries = perFileSelection
    .filter((s) => !manifestPaths.has(s.file.filePath))
    .filter((s) => s.selection.pageRanges.length > 0)
    .filter((s) => {
      const rs = readStatusByPath.get(s.file.filePath);
      return rs === undefined || isEffectivelyRead(rs);
    })
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
        generatedBy: actorSub,
      },
    });

    await tx.activityLog.create({
      data: {
        actorUserId: actorSub,
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
          // Package 7: distinguishes the send-to-doctor auto-fire from a manual Generate.
          trigger,
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

  return { outcome: 'queued', pack: result };
}
