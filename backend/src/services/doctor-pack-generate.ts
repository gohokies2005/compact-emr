import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { HttpError } from '../http/errors.js';
import { evaluateChartReadiness, isEffectivelyRead } from './chart-readiness.js';
import { renderRecordTextPdf } from './record-text-render.js';
import {
  applyPackPageBudget,
  assembleDoctorPackManifest,
  DOCTOR_PACK_ENGINE_VERSION,
  PACK_PAGE_BUDGET,
  PACK_PAGE_TARGET,
  type BudgetEntry,
} from './doctor-pack.js';
import { classifyDocument, CLASSIFIER_VERSION_NUM } from './key-docs-classifier.js';
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

// Content-classifier feed contract (Chunk D, hoisted + exported for the reclassify-stale
// backfill route 2026-06-12): the classifier sees the first 2 OCR'd pages, each capped at
// 4000 chars. The backfill MUST feed stored rows the exact same way — a different slice could
// classify the same document differently than generation did and make the backfill lie.
export const CONTENT_HINT_CHARS_PER_PAGE = 4000;
export function buildContentHintText(
  pageRows: readonly { readonly pageNumber: number; readonly text: string }[],
): string {
  return pageRows
    .filter((p) => p.pageNumber <= 2)
    .map((p) => p.text.slice(0, CONTENT_HINT_CHARS_PER_PAGE))
    .join('\n');
}

// ====================== WAVE 2 (assessment 2026-06-12 §1b/1d/§3) helpers ======================

// §3 display labels: '<DocType human name> — <original filename>'. The human map mirrors the
// docType vocabulary in db-types.ts KeyDocType; 'unspecified' (and any unknown value) renders
// as just the filename — a made-up type name would be worse than none. Date extraction is
// deliberately NOT attempted (assessment: medium confidence; VA letters carry multiple dates).
export const DOC_TYPE_HUMAN_LABELS: Readonly<Record<string, string>> = {
  dd_214: 'DD-214',
  rating_decision: 'Rating decision',
  denial_letter: 'Denial letter',
  supplemental_decision: 'Supplemental decision',
  rated_disabilities_view: 'Rated disabilities',
  benefit_summary: 'Benefit summary',
  dbq: 'DBQ',
  c_and_p_exam: 'C&P exam',
  tera_memo: 'TERA memo',
  individual_exposure_summary: 'Exposure summary',
  nexus_letter_prior: 'Prior nexus letter',
  medical_opinion: 'Medical opinion',
  audiogram: 'Audiogram',
  sleep_study: 'Sleep study',
  pulmonary_function_test: 'Pulmonary function test',
  service_treatment_record_summary: 'Service treatment records',
  separation_exam: 'Separation exam',
  entrance_exam: 'Entrance exam',
  personnel_record: 'Personnel record',
  statement_in_support: 'Statement in support',
  lay_statement: 'Lay statement',
  buddy_statement: 'Buddy statement',
  blue_button: 'Blue Button dump',
  progress_notes: 'Clinical notes',
  imaging: 'Imaging / radiology',
  intake_summary: 'Intake summary',
};

// Human filename for display: prefer the Document's original filename; otherwise the S3 key's
// basename with the upload-time uuid prefix stripped (keys are `cases/<caseId>/<uuid>-<name>`).
export function displayFileName(filePath: string, filename?: string | null): string {
  if (typeof filename === 'string' && filename.length > 0) return filename;
  const base = filePath.split('/').pop() ?? filePath;
  return base.replace(/^[a-f0-9-]{36}-/, '');
}

export function keyDocDisplayLabel(docType: string, displayName: string): string {
  const human = DOC_TYPE_HUMAN_LABELS[docType];
  if (docType === 'unspecified' || human === undefined) return displayName;
  return `${human} — ${displayName}`;
}

// §1b non-PDF detection: filename extension OR the stored Document.contentType (mime). Either
// signal marks the source as needing text→PDF rendering — the Python assembler is PDF-only and
// silently skips anything else (the Perez psych-note failure).
const NON_PDF_EXTENSIONS = /\.(txt|rtf|doc|docx)$/i;
const NON_PDF_MIME_TYPES: ReadonlySet<string> = new Set([
  'text/plain',
  'text/rtf',
  'application/rtf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
export function isNonPdfSource(
  filePath: string,
  filename: string | null | undefined,
  contentType: string | null | undefined,
): boolean {
  if (NON_PDF_EXTENSIONS.test(filePath)) return true;
  if (typeof filename === 'string' && NON_PDF_EXTENSIONS.test(filename)) return true;
  const mime = typeof contentType === 'string' ? contentType.split(';')[0]?.trim().toLowerCase() : undefined;
  return mime !== undefined && mime.length > 0 && NON_PDF_MIME_TYPES.has(mime);
}

// §1 soft no-dx gate: the clinical category — the pages the PCP "refuses to sign without".
// Mirrors CATEGORY_BY_DOC_TYPE's 'clinical' bucket in services/doctor-pack.ts (progress_notes /
// c_and_p_exam / dbq). The HARD ship-block comes after the PCP re-review proves selection
// quality; for now the pack still ships, loudly flagged.
// blue_button: small exports contribute pages ONLY via the condition-keyed branch (Perez
// 2026-06-12 — the dx note was a 6pp My-HealtheVet text export), so their kept pages count.
export const CLINICAL_DX_DOC_TYPES: ReadonlySet<string> = new Set(['progress_notes', 'c_and_p_exam', 'dbq', 'blue_button']);
export const NO_CLINICAL_DX_WARNING = 'NO_CLINICAL_DX_DOCUMENTATION';

// Rendered-artifact uploads go to the RECORDS bucket (PHI_BUCKET_NAME — the same bucket the
// assembler's _records_bucket() reads manifest entries from) under a key DERIVED from the
// source layout: cases/<caseId>/_rendered/<documentId>-v<caseVersion>.pdf. Chosen over a
// per-entry bucket field precisely so handler.py needs ZERO contract change. Deterministic
// bytes (record-text-render) + deterministic key = idempotent, overwrite-safe.
export interface DoctorPackGenerateDeps {
  readonly s3?: { send(command: unknown): Promise<unknown> };
  readonly recordsBucketName?: string;
}
let cachedRecordsS3: S3Client | null = null;
function defaultRecordsS3(): S3Client {
  if (cachedRecordsS3 !== null) return cachedRecordsS3;
  cachedRecordsS3 = new S3Client({ forcePathStyle: process.env['AWS_S3_FORCE_PATH_STYLE'] === 'true' });
  return cachedRecordsS3;
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
  // WAVE 2: injectable S3 for the non-PDF → rendered-PDF uploads. Callers that never hit a
  // non-PDF source never touch S3 (the client is created lazily, per render).
  deps?: DoctorPackGenerateDeps,
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
        // WAVE 2 (§1b/§3): filename + contentType feed non-PDF detection + display labels;
        // uploadedAt feeds the rendered-PDF provenance header ('source uploaded <date>').
        select: { id: true, s3Key: true, pageCount: true, docTag: true, filename: true, contentType: true, uploadedAt: true },
        orderBy: { uploadedAt: 'asc' },
      },
    },
  })) as unknown as { id: string; veteranId: string; version: number; claimedCondition: string | null; documents: readonly { id: string; s3Key: string; pageCount: number | null; docTag: string | null; filename?: string | null; contentType?: string | null; uploadedAt?: Date | string | null }[] } | null;
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
  const docList = caseWithDocs.documents as readonly { id: string; s3Key: string; pageCount: number | null; docTag: string | null; filename?: string | null; contentType?: string | null; uploadedAt?: Date | string | null }[];
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
  const perFileSelection = classifiedFiles.map((f) => {
    const pageRows = pagesByDocumentId.get(f.documentId) ?? [];
    const contentText = buildContentHintText(pageRows);
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

  // ===== WAVE 2 (assessment 2026-06-12 §1b/1d/§3): label, render non-PDF sources, no-dx gate =====
  const docMetaByPath = new Map(docList.map((d) => [d.s3Key, d]));

  // §3: stamp displayLabel BEFORE the render swap so the label always carries the ORIGINAL
  // filename (the rendered artifact's provenance header declares the conversion separately).
  // Additive manifest field — the assembler tolerates absence on legacy rows.
  const labeledEntries = finalEntries.map((entry) => {
    const meta = docMetaByPath.get(entry.filePath);
    return { ...entry, displayLabel: keyDocDisplayLabel(entry.docType, displayFileName(entry.filePath, meta?.filename ?? null)) };
  });

  // §1b: render each non-PDF source's SELECTED pages to a real PDF in the records bucket and
  // point the manifest entry at the rendered key. Fail-OPEN per entry: a render/upload error
  // logs, drops THAT entry into trimNotes ('could not render <filename>'), and the pack keeps
  // assembling — never the whole pack. (KeyDoc rows are untouched: they keep the ORIGINAL
  // filePath + selector ranges so the RN review UI and the Document join keep working.)
  const renderNotes: string[] = [];
  const packEntries: Array<(typeof labeledEntries)[number]> = [];
  for (const entry of labeledEntries) {
    const meta = docMetaByPath.get(entry.filePath);
    if (meta === undefined || !isNonPdfSource(entry.filePath, meta.filename ?? null, meta.contentType ?? null)) {
      packEntries.push(entry);
      continue;
    }
    const displayName = displayFileName(entry.filePath, meta.filename ?? null);
    try {
      const pageRows = pagesByDocumentId.get(meta.id) ?? [];
      // Whole-doc passthrough entries (empty pageRanges) render ALL available page text —
      // mirroring the assembler's "empty ranges = whole document" contract (handler.py H2).
      const selectedRows = entry.pageRanges.length === 0
        ? pageRows
        : pageRows.filter((p) => entry.pageRanges.some((r) => p.pageNumber >= r.from && p.pageNumber <= r.to));
      if (selectedRows.length === 0) throw new Error('no extracted page text available to render');
      const uploadedAtRaw = meta.uploadedAt ?? null;
      const rendered = await renderRecordTextPdf({
        originalFilename: displayName,
        sourceUploadedAt: uploadedAtRaw !== null ? new Date(uploadedAtRaw) : null,
        pages: selectedRows.map((p) => ({ sourcePageNumber: p.pageNumber, text: p.text })),
      });
      // Derived RECORDS-bucket key — zero handler.py contract change (it fetches every entry
      // from _records_bucket()). Deterministic + overwrite-safe: same text → same bytes.
      const renderedKey = `cases/${caseId}/_rendered/${meta.id}-v${c.version}.pdf`;
      const bucket = deps?.recordsBucketName ?? process.env['PHI_BUCKET_NAME'];
      if (typeof bucket !== 'string' || bucket.length === 0) {
        throw new Error('PHI_BUCKET_NAME (records bucket) not configured for rendered-record upload');
      }
      const s3 = deps?.s3 ?? defaultRecordsS3();
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: renderedKey, Body: rendered.bytes, ContentType: 'application/pdf' }));
      packEntries.push({
        ...entry,
        filePath: renderedKey,
        pageRanges: [{ from: 1, to: rendered.pageCount }],
        pageCount: rendered.pageCount,
      });
    } catch (renderErr) {
      console.warn(`doctor-pack: could not render non-PDF source ${displayName} (entry dropped, pack continues):`, renderErr);
      renderNotes.push(`could not render ${displayName}`);
    }
  }
  const packTrimNotes = [...budget.trimNotes, ...renderNotes];
  const refinedTotalPageCount = packEntries.reduce((sum, e) => sum + e.pageCount, 0);

  // §1 soft no-dx gate: did the clinical category (progress_notes / c_and_p_exam / dbq)
  // contribute ZERO pages to the final manifest? Whole-doc passthrough clinical entries
  // (pageCount 0, empty ranges) count as contributing — the assembler ships the whole file.
  const clinicalPageContribution = packEntries
    .filter((e) => CLINICAL_DX_DOC_TYPES.has(e.docType))
    .reduce((sum, e) => sum + (e.pageRanges.length === 0 ? Math.max(1, e.pageCount) : e.pageCount), 0);
  const missingClinical = clinicalPageContribution === 0;

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

      // Assessment 2026-06-12 §2: stamp the classifier-code version that produced this row's
      // docType/classification. Rows stamped below CLASSIFIER_VERSION_NUM (or at the column
      // default 0 = legacy) are what POST /rn/key-docs/reclassify-stale backfills after a
      // classifier upgrade — without the stamp, stale misclassifications are indistinguishable
      // from fresh ones and sit in the RN queue forever.
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
          classifierVersion: CLASSIFIER_VERSION_NUM,
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
          classifierVersion: CLASSIFIER_VERSION_NUM,
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
        keyDocCount: packEntries.length,
        pageCount: refinedTotalPageCount,
        // Phase 7B-revised Build 1: manifestJson carries entries (with refined page ranges)
        // + cover-page summary (the chart-state snapshot the assembler renders as PDF page 1).
        // The page-selector's per-file rationale lives on each KeyDoc row (selectorRationale)
        // for audit replay; the cover page surfaces top-line state only.
        // Chunk D: budgetTrim records what the pack page budget removed (RN-visible audit).
        // WAVE 2: entries carry displayLabel; render failures append to trimNotes (the
        // budgetTrim block now also appears when only render notes exist); warnings carries
        // the §1 no-clinical-dx flag the panel surfaces as the amber banner.
        manifestJson: {
          entries: packEntries,
          engineVersion: DOCTOR_PACK_ENGINE_VERSION,
          ...(coverPage ? { coverPage } : {}),
          ...(missingClinical ? { warnings: [NO_CLINICAL_DX_WARNING] } : {}),
          ...(budget.trimmed || renderNotes.length > 0
            ? {
                budgetTrim: {
                  budget: PACK_PAGE_BUDGET,
                  preTrimPageCount: budget.preTrimPageCount,
                  postTrimPageCount: budget.postTrimPageCount,
                  trimNotes: packTrimNotes,
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
          keyDocCount: packEntries.length,
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

    // WAVE 2 (§1 soft gate): a pack with ZERO clinical-dx pages is loudly flagged — manifest
    // warning (panel banner) + its own audit row. The hard no-dx-no-ship park comes after the
    // PCP re-review proves selection quality.
    if (missingClinical) {
      await tx.activityLog.create({
        data: {
          actorUserId: actorSub,
          action: 'doctor_pack_missing_clinical',
          caseId,
          ...(c.veteranId ? { veteranId: c.veteranId } : {}),
          detailsJson: {
            caseId,
            doctorPackId: stamped.id,
            warning: NO_CLINICAL_DX_WARNING,
            claimedCondition: claimedCondition ?? null,
            keyDocCount: packEntries.length,
            pageCount: refinedTotalPageCount,
          },
        },
      });
    }

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
