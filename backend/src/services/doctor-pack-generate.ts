import { createHash, randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { HttpError } from '../http/errors.js';
import { evaluateChartReadiness, isEffectivelyRead } from './chart-readiness.js';
import { renderRecordTextPdf, previewRecordTextLayout, previewRecordTextLineRects } from './record-text-render.js';
import {
  applyPackPageBudget,
  assembleDoctorPackManifest,
  buildCategoryAssertionLines,
  categoryFloorsEnabled,
  computeDroppedCategoryWarnings,
  DOCTOR_PACK_ENGINE_VERSION,
  effectivePackPageBudget,
  expectedStudyForCondition,
  PACK_PAGE_TARGET,
  packCategoryOf,
  type BudgetEntry,
  type ExpectedStudy,
  type PackCategory,
} from './doctor-pack.js';
import { classifyDocument, CLASSIFIER_VERSION_NUM } from './key-docs-classifier.js';
import { selectPages, unionGroundedPagesIntoResult, type PageSelectorInputPage, type PageSelectorResult } from './page-selector.js';
import { selectPagesLlm, shouldUseLlmPicker, PAGE_LLM_VERSION } from './doctor-pack-page-llm.js';
// doctor-pack grounded pages, 2026-06-13 (PR-2): facts→pages back-map.
import {
  chartFactCategoryByDocument,
  groundedSourcePagesForCase,
  type ChartFactCategory,
  type ChartFactCategoryDb,
  type GroundedPage,
  type GroundedPagesDb,
} from './doctor-pack-grounded-pages.js';
import { aggregateChartSummary } from './chart-summary-aggregator.js';
import { publishDoctorPackQueued } from './doctor-pack-queue.js';
import { isDoctorPackS3Key } from './s3-key-safety.js';
import { isScreeningSummaryKey } from './chart-build-state.js';
import type { AppDb, DoctorPackManifestEntry, DoctorPackRecord, DocumentPageRecord, KeyDocPageRange } from './db-types.js';

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

// Content-classifier feed contract (Chunk D, hoisted + exported for the reclassify-stale backfill
// route 2026-06-12). WHOLE-DOC widening (ai-sme spec 2026-06-26): the classifier now sees the first
// 8 OCR'd pages (was 2), each capped at 1500 chars (was 4000) — same ~12k-char budget but spread
// across more of the document, so a doc whose decisive content is past page 2 (a study buried in a
// Misc bundle, a dx note on page 5) classifies correctly. The backfill MUST feed stored rows the
// exact same way (it imports THESE symbols) — a different slice could classify the same document
// differently than generation did and make the backfill lie.
export const CONTENT_HINT_CHARS_PER_PAGE = 1500;
const CONTENT_HINT_MAX_PAGES = 8;
export function buildContentHintText(
  pageRows: readonly { readonly pageNumber: number; readonly text: string }[],
): string {
  return pageRows
    .filter((p) => p.pageNumber <= CONTENT_HINT_MAX_PAGES)
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

// ================= ROUND 2 (backlog §"Doctor-pack round 2" A–E,
// PCP re-review 2026-06-12 — verdict USABLE-WITH-CHART-CHECKS; these reach SIGNABLE) =================
// NOTE (Ryan 2026-06-12): NO hard no-dx gate. A pack with zero clinical pages still generates
// and delivers; the panel shows a calm notice keyed on NO_CLINICAL_DX_WARNING instead.

// C. The Not-included note when the case has no veteranStatement.
export const NO_LAY_STATEMENT_NOTE = 'No lay statement on file';

/** C. Provenance header for the rendered intake-statement page (exact wording per spec). */
export function buildVeteranStatementHeader(caseCreatedAt: Date | null | undefined): string {
  const date =
    caseCreatedAt instanceof Date && !Number.isNaN(caseCreatedAt.getTime())
      ? caseCreatedAt.toISOString().slice(0, 10)
      : 'an unknown date';
  return `Veteran's statement as submitted at intake on ${date}`;
}

// A. Content-hash dedup. The live failure: the same MHV export uploaded under two filenames
// produced 16 duplicate pages (Misc_6=Misc_8, Misc_9=Misc_10). Two content signals, either of
// which establishes identity:
//   - the file-byte sha256 the OCR pipeline stamped on FileReadStatus (same bytes ⇒ same sha);
//   - a text fingerprint over the OCR'd page text (catches re-exports whose bytes differ but
//     whose content is identical). Normalized (whitespace-collapsed, lowercased) so trivial
//     extraction jitter doesn't defeat it.
export function computeTextFingerprint(
  pageRows: readonly { readonly pageNumber: number; readonly text: string }[],
): string | null {
  const normalized = pageRows
    .map((p) => p.text.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter((t) => t.length > 0)
    .join('\n');
  if (normalized.length === 0) return null;
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export interface DedupCandidate {
  readonly filePath: string;
  readonly displayName: string;
  // Byte sha from FileReadStatus ('' when no read-status row carries one).
  readonly fileSha256: string;
  readonly textFingerprint: string | null;
  readonly docType: string;
  readonly importance: number;
  // Position in the upload-ordered document list — the earliest-upload tiebreak.
  readonly uploadIndex: number;
}

export interface DedupResult {
  // Dropped path -> kept path.
  readonly duplicateOf: ReadonlyMap<string, string>;
  // One Not-included note per dropped doc ('X: duplicate of Y …').
  readonly notes: readonly string[];
}

/**
 * Group candidate documents that share a content identity (byte sha OR text fingerprint) and
 * keep exactly ONE per group: prefer the better-classified docType (anything beats
 * 'unspecified'), then higher classifier importance, then earliest upload. Deterministic.
 */
export function dedupPackDocuments(candidates: readonly DedupCandidate[]): DedupResult {
  // Union-find over candidate indexes, keyed by shared content keys.
  const parent = candidates.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    let cur = i;
    while (parent[cur] !== root) {
      const next = parent[cur]!;
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const byKey = new Map<string, number>();
  candidates.forEach((c, i) => {
    const keys: string[] = [];
    if (c.fileSha256.length > 0) keys.push(`sha:${c.fileSha256}`);
    if (c.textFingerprint !== null) keys.push(`text:${c.textFingerprint}`);
    for (const key of keys) {
      const seen = byKey.get(key);
      if (seen === undefined) byKey.set(key, i);
      else union(i, seen);
    }
  });
  const groups = new Map<number, DedupCandidate[]>();
  candidates.forEach((c, i) => {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(c);
    groups.set(root, list);
  });
  const duplicateOf = new Map<string, string>();
  const notes: string[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ranked = [...group].sort((a, b) => {
      const aUnspec = a.docType === 'unspecified' ? 1 : 0;
      const bUnspec = b.docType === 'unspecified' ? 1 : 0;
      if (aUnspec !== bUnspec) return aUnspec - bUnspec;
      if (a.importance !== b.importance) return b.importance - a.importance;
      if (a.uploadIndex !== b.uploadIndex) return a.uploadIndex - b.uploadIndex;
      return a.filePath.localeCompare(b.filePath);
    });
    const kept = ranked[0]!;
    for (const dup of ranked.slice(1)) {
      duplicateOf.set(dup.filePath, kept.filePath);
      notes.push(`${dup.displayName}: duplicate of ${kept.displayName} (identical content) — omitted`);
    }
  }
  return { duplicateOf, notes };
}

// D/E. Medicine-first manifest order (Ryan/PCP: the doctor reads dx note FIRST). The cover
// index is prepended separately; everything else sorts by this category rank, then classifier
// importance desc, then path — fully deterministic.
export const PACK_CATEGORY_ORDER: Readonly<Record<PackCategory, number>> = {
  clinical: 0,
  lay: 1,
  denial: 2,
  sc_proof: 3,
  tests: 4,
  service: 5,
  other: 6,
};

export function orderPackEntriesMedicineFirst<T>(
  entries: readonly T[],
  // DOCTOR_PACK_CATEGORY_FLOORS: the key may return an explicit packCategory (the chart-fact
  // override) — honored over the docType→category map. Absent ⇒ category derives from docType, so a
  // caller that never sets it is byte-identical to before.
  key: (e: T) => { docType: DoctorPackManifestEntry['docType']; importance: number; filePath: string; packCategory?: PackCategory },
): T[] {
  return [...entries].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    const ca = PACK_CATEGORY_ORDER[ka.packCategory ?? packCategoryOf(ka.docType)];
    const cb = PACK_CATEGORY_ORDER[kb.packCategory ?? packCategoryOf(kb.docType)];
    if (ca !== cb) return ca - cb;
    if (ka.importance !== kb.importance) return kb.importance - ka.importance;
    return ka.filePath.localeCompare(kb.filePath);
  });
}

// D. Cover-index WHY lines — plain English per category. The PCP's named non-obvious case: a
// denial-category doc whose condition is NOT the claimed condition is in the pack to show what
// the nexus must NOT lean on.
export function coverWhyLine(category: PackCategory, mentionsClaimedCondition: boolean): string {
  switch (category) {
    case 'clinical':
      return 'Clinical documentation of the claimed condition — read first.';
    case 'lay':
      return "The veteran's own account and timeline.";
    case 'denial':
      return mentionsClaimedCondition
        ? "The VA's stated reasons for denying the claimed condition — the letter must answer these."
        : 'Denial of a DIFFERENT condition — shows it is NOT service-connected; the nexus must not lean on it.';
    case 'sc_proof':
      return 'Proof of the service-connected condition(s) the theory builds on.';
    case 'tests':
      return 'Objective test results supporting current severity.';
    case 'service':
      return 'Service verification.';
    case 'other':
      return 'Supporting record.';
  }
}

// ====================== DOCTOR_PACK_LINKED_COVER (2026-06-27) ======================
// Calm clickable table-of-contents cover. Friendly, FILENAME-FREE labels for the cover TOC — NEVER
// a filename, NEVER a docType code. Unknown/unspecified docTypes derive a calm label from the pack
// category. Deliberately distinct from keyDocDisplayLabel/DOC_TYPE_HUMAN_LABELS, which the RN review
// UI keeps using (those carry the original filename on purpose). cover_index has no friendly label
// (it is the cover itself, never listed in its own contents).
const COVER_FRIENDLY_BY_DOCTYPE: Readonly<Record<string, string>> = {
  dd_214: 'DD-214 (service record)',
  progress_notes: 'Office visit note',
  blue_button: 'Office visit note',
  sleep_study: 'Sleep study',
  rating_decision: 'VA rating decision',
  denial_letter: 'VA denial',
  supplemental_decision: 'VA denial',
  benefit_summary: 'VA benefit summary',
  rated_disabilities_view: 'VA benefit summary',
  c_and_p_exam: 'C&P exam',
  dbq: 'DBQ exam',
  lay_statement: "Veteran's statement",
  statement_in_support: "Veteran's statement",
  buddy_statement: 'Buddy statement',
  audiogram: 'Hearing test',
  pulmonary_function_test: 'Lung function test',
};
const COVER_FRIENDLY_BY_CATEGORY: Readonly<Record<PackCategory, string>> = {
  clinical: 'Clinical record',
  sc_proof: 'Service-connection proof',
  denial: 'VA denial',
  tests: 'Test result',
  service: 'Service record',
  lay: "Veteran's statement",
  other: 'Supporting record',
};
export function coverFriendlyLabel(docType: string, category: PackCategory): string {
  const direct = COVER_FRIENDLY_BY_DOCTYPE[docType];
  if (direct !== undefined) return direct;
  return COVER_FRIENDLY_BY_CATEGORY[category] ?? 'Supporting record';
}

// Calm section headers + display order for the linked cover. The five named must-have buckets show
// even when empty (with a calm "Not found in chart" / "None on file" line, folding the old
// categoryAssertions checklist); service/other show only when populated.
const COVER_SECTION_HEADER: Readonly<Record<PackCategory, string>> = {
  clinical: 'CLINICAL',
  sc_proof: 'SERVICE-CONNECTION PROOF',
  denial: 'PRIOR DENIAL',
  tests: 'DEFINING STUDY',
  lay: 'LAY EVIDENCE',
  service: 'SERVICE RECORDS',
  other: 'OTHER RECORDS',
};
const COVER_SECTION_ORDER: readonly PackCategory[] = ['clinical', 'sc_proof', 'denial', 'tests', 'lay', 'service', 'other'];
const COVER_MUSTHAVE_EMPTY: Partial<Record<PackCategory, string>> = {
  clinical: 'Not found in chart',
  sc_proof: 'Not found in chart',
  tests: 'Not found in chart',
  denial: 'None on file',
  lay: 'None on file',
};

// Plain-language theory line for the cover title block (prose, not the raw framingChoice enum).
export function plainTheoryLine(framingChoice: string | null, claimType: string | null, upstream: string | null): string {
  const up = (upstream ?? '').trim();
  if (up.length > 0) return `Secondary to service-connected ${up}`;
  const f = (framingChoice ?? claimType ?? '').trim();
  if (f.length === 0) return 'not set';
  return f.charAt(0).toUpperCase() + f.slice(1).replace(/_/g, ' ');
}

function formatScSnapshot(list: readonly { condition: string; ratingPct: number | null }[]): string {
  if (list.length === 0) return 'none recorded';
  const shown = list.slice(0, 4).map((s) => (s.ratingPct !== null && s.ratingPct !== undefined ? `${s.condition} ${s.ratingPct}%` : s.condition));
  const extra = list.length - shown.length;
  return shown.join(' · ') + (extra > 0 ? ` +${extra} more` : '');
}
function formatProblemSnapshot(list: readonly string[]): string {
  if (list.length === 0) return 'none recorded';
  const shown = list.slice(0, 6);
  const extra = list.length - shown.length;
  return shown.join(' · ') + (extra > 0 ? ` +${extra} more` : '');
}
// Shorten coverWhyLine to a calm fragment: first clause, no trailing period, capped length.
function shortCoverWhy(why: string): string {
  let s = (why.split('—')[0] ?? why).split(';')[0] ?? why;
  s = s.replace(/\.$/, '').trim();
  const CAP = 52;
  if (s.length > CAP) s = `${s.slice(0, CAP - 1).trimEnd()}…`;
  return s;
}
// Compose ONE content row, kept short enough to render on a single line (so the cover's page count —
// and therefore the printed page numbers — is independent of label/why length): friendly label —
// why, a calm dotted leader, then the single page ref.
function composeCoverRow(friendly: string, why: string, pageRef: number | undefined): string {
  const left = `  ${friendly} — ${why}`;
  const LEFT_CAP = 64;
  const leftTrunc = left.length > LEFT_CAP ? `${left.slice(0, LEFT_CAP - 1).trimEnd()}…` : left;
  const pr = pageRef !== undefined ? `p. ${pageRef}` : 'p. -';
  const dotCount = Math.max(3, 74 - leftTrunc.length - pr.length);
  return `${leftTrunc} ${'.'.repeat(dotCount)} ${pr}`;
}

// Same condition matcher shape the page-selector uses (full phrase OR any distinctive token
// >= 5 chars) — local copy because page-selector edits are kill-list-only this round.
export function textMentionsCondition(text: string, claimedCondition: string | undefined): boolean {
  const phrase = (claimedCondition ?? '').trim().toLowerCase();
  if (phrase.length < 3) return false;
  const lower = text.toLowerCase();
  if (lower.includes(phrase)) return true;
  return phrase
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 5)
    .some((t) => lower.includes(t));
}

// D. Backend-side humanization for the cover page's Not-included list: swap a leading
// '<filePath>: …' for the document's display name; drop whole-doc-passthrough bookkeeping
// notes (they are not omissions). The PANEL keeps its own humanizer for the manifest's raw
// trimNotes — this one only feeds the rendered cover page.
export function humanizeTrimNotes(
  notes: readonly string[],
  displayNameByPath: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  for (const note of notes) {
    if (note.includes('whole-doc passthrough')) continue;
    const idx = note.indexOf(': ');
    if (idx > 0) {
      const display = displayNameByPath.get(note.slice(0, idx));
      if (display !== undefined) {
        out.push(`${display}: ${note.slice(idx + 2)}`);
        continue;
      }
    }
    out.push(note);
  }
  return out;
}

export interface CoverIndexEntryInput {
  readonly displayLabel: string;
  readonly category: PackCategory;
  readonly pageRanges: readonly KeyDocPageRange[];
  readonly mentionsClaimedCondition: boolean;
  // doctor-pack grounded pages PR-3, 2026-06-13 (POLICY B): one short "why" line PER PINNED PAGE in
  // this entry that survived the budget — built from the grounding fact's kind + source quote (e.g.
  // "p412: rating decision granting condition - 'PTSD 70% service-connected'"). Empty/absent unless
  // DOCTOR_PACK_GROUNDED_PAGES is on AND the entry has surviving pinned pages → flag-off cover text
  // is byte-identical. FRN style: plain hyphen separators, straight quotes (no em dashes / smart
  // quotes) for the new lines.
  readonly pinnedWhyLines?: readonly string[];
  // DOCTOR_PACK_LINKED_COVER (2026-06-27): the manifest entry's docType (for the friendly label) and
  // the predicted 1-indexed page in the FINAL assembled pack where this document starts (printed as
  // "p. N"). Absent on the legacy flag-off cover. friendlyLabel, when supplied, overrides the
  // docType→label derivation.
  readonly docType?: DoctorPackManifestEntry['docType'];
  readonly friendlyLabel?: string;
  readonly assembledStartPage?: number;
}

// DOCTOR_PACK_LINKED_COVER (2026-06-27): buildCoverIndexLines returns the cover's text lines AND
// (linked-cover mode only) one descriptor per content document row — the index of its line in
// `lines` (so the caller can map it to a rendered rectangle for a PDF link) plus its manifest-entries
// index, category, and rendered label.
export interface CoverIndexBuild {
  readonly lines: string[];
  readonly contentRows?: readonly {
    readonly entriesIndex: number;
    readonly sourceLineIndex: number;
    readonly category: PackCategory;
    readonly label: string;
  }[];
}

// DOCTOR_PACK_LINKED_COVER (2026-06-27): the TS→Python link-map contract. TS owns the cover-page
// rectangles (computed from the deterministic record-text-render layout); the Python assembler owns
// the merged-pack page offsets (entry_start_page) and stamps a PDF link cover-rect → entry start
// page + a 2-level outline. entryIndex is the MANIFEST entry index (cover is entry #0). rect is
// [x0,y0,x1,y1] in PDF user space (origin bottom-left). Travels on manifestJson.coverLinkMap.
interface CoverLinkMapEntry {
  readonly entryIndex: number;
  readonly coverPageIndex: number;
  readonly rect: readonly number[];
  readonly category: string;
  readonly categoryLabel: string;
  readonly label: string;
}

// doctor-pack grounded pages PR-3, 2026-06-13 (POLICY B): the per-pinned-page cover "why" line.
// Built from the back-map's factKind + the representative source quote so the physician sees WHY a
// page was force-included from an otherwise-excluded bulk doc (the rating-grant page out of a
// 900-page Blue Button dump). FRN-style: concise, plain hyphen, straight quotes, no em dashes.
const PINNED_FACT_KIND_PHRASE: Readonly<Record<GroundedPage['factKind'], string>> = {
  sc_condition: 'service-connected condition grant',
  screening: 'objective test / screening result',
  active_problem: 'active problem / diagnosis',
  active_medication: 'active medication',
};
export function coverPinnedWhyLine(page: number, factKind: GroundedPage['factKind'], sourceQuote: string): string {
  const phrase = PINNED_FACT_KIND_PHRASE[factKind] ?? 'chart fact';
  const quote = (sourceQuote ?? '').replace(/\s+/g, ' ').trim();
  const quotePart = quote.length > 0 ? ` - "${quote}"` : '';
  return `p${page}: ${phrase}${quotePart}`;
}

/** D. The cover-index page body (line-per-line; rendered via record-text-render). Pure. */
export function buildCoverIndexLines(input: {
  readonly caseId: string;
  readonly claimedCondition?: string;
  readonly claimType?: string | null;
  readonly framingChoice?: string | null;
  readonly upstreamScCondition?: string | null;
  readonly entries: readonly CoverIndexEntryInput[];
  readonly notIncluded: readonly string[];
  // DOCTOR_PACK_CATEGORY_FLOORS (2026-06-26): the 5-line coverage checklist (built by
  // doctor-pack.ts buildCategoryAssertionLines). Absent/empty ⇒ no checklist block ⇒ cover body is
  // byte-identical to the pre-flag cover.
  readonly categoryAssertions?: readonly string[];
  // DOCTOR_PACK_LINKED_COVER (2026-06-27): when true, emit the calm clickable-TOC layout (title +
  // case snapshot + grouped contents) and return contentRows. Absent/false ⇒ byte-identical to the
  // legacy cover.
  readonly linkedCover?: boolean;
  readonly veteranName?: string;
  readonly serviceConnected?: readonly { condition: string; ratingPct: number | null }[];
  readonly activeProblems?: readonly string[];
}): CoverIndexBuild {
  if (input.linkedCover === true) return buildLinkedCoverLines(input);
  const lines: string[] = [];
  lines.push(`Case ${input.caseId} — claimed condition: ${input.claimedCondition ?? 'not recorded'}`);
  const framing = input.framingChoice ?? input.claimType ?? 'not set';
  const upstream = input.upstreamScCondition
    ? ` — upstream service-connected condition: ${input.upstreamScCondition}`
    : '';
  lines.push(`Theory: ${framing}${upstream}`);
  if (input.categoryAssertions && input.categoryAssertions.length > 0) {
    lines.push('');
    lines.push('Coverage checklist:');
    for (const a of input.categoryAssertions) lines.push(`- ${a}`);
  }
  lines.push('');
  lines.push('Included documents:');
  input.entries.forEach((e, i) => {
    const pages =
      e.pageRanges.length === 0
        ? 'all pages'
        : e.pageRanges.map((r) => (r.from === r.to ? `p${r.from}` : `p${r.from}-${r.to}`)).join(', ');
    lines.push(`${i + 1}. ${e.displayLabel} — ${pages} — ${coverWhyLine(e.category, e.mentionsClaimedCondition)}`);
    // doctor-pack grounded pages PR-3, 2026-06-13 (POLICY B): annotate each surviving PINNED page
    // with its grounding "why" line, indented under the entry. Absent unless the flag is on AND the
    // entry has pinned survivors → flag-off cover text is byte-identical.
    for (const why of e.pinnedWhyLines ?? []) {
      lines.push(`   pinned ${why}`);
    }
  });
  lines.push('');
  lines.push('Not included:');
  if (input.notIncluded.length === 0) lines.push('(nothing was omitted)');
  else for (const note of input.notIncluded) lines.push(`- ${note}`);
  return { lines };
}

// DOCTOR_PACK_LINKED_COVER (2026-06-27): the calm clickable table-of-contents cover. A short title
// block + 2-3 line case snapshot at the top, then contents grouped by the five evidence categories
// with calm section headers; each document row is `<friendly label> — <short why> ... p. <N>` with
// ONE page ref (the predicted assembled start page). No filenames, no page-range soup, no pinned
// dump. contentRows records which `lines` index each document row lands on so the caller can map it
// to a rendered rectangle for a PDF link.
function buildLinkedCoverLines(input: {
  readonly caseId: string;
  readonly claimedCondition?: string;
  readonly claimType?: string | null;
  readonly framingChoice?: string | null;
  readonly upstreamScCondition?: string | null;
  readonly entries: readonly CoverIndexEntryInput[];
  readonly notIncluded: readonly string[];
  readonly veteranName?: string;
  readonly serviceConnected?: readonly { condition: string; ratingPct: number | null }[];
  readonly activeProblems?: readonly string[];
}): CoverIndexBuild {
  const lines: string[] = [];
  const contentRows: { entriesIndex: number; sourceLineIndex: number; category: PackCategory; label: string }[] = [];

  // Title block.
  lines.push('Doctor Pack');
  const vet = (input.veteranName ?? '').trim();
  lines.push(vet.length > 0 ? `${vet} · ${input.caseId}` : `Case ${input.caseId}`);
  lines.push(`Claimed: ${input.claimedCondition ?? 'not recorded'}`);
  lines.push(`Theory: ${plainTheoryLine(input.framingChoice ?? null, input.claimType ?? null, input.upstreamScCondition ?? null)}`);

  // Case snapshot (2-3 calm lines).
  lines.push('');
  lines.push('Case snapshot');
  lines.push(`Service-connected: ${formatScSnapshot(input.serviceConnected ?? [])}`);
  lines.push(`Active problems: ${formatProblemSnapshot(input.activeProblems ?? [])}`);

  // Contents, grouped by category.
  lines.push('');
  lines.push('Contents');
  const byCat = new Map<PackCategory, { e: CoverIndexEntryInput; idx: number }[]>();
  input.entries.forEach((e, idx) => {
    const list = byCat.get(e.category) ?? [];
    list.push({ e, idx });
    byCat.set(e.category, list);
  });
  for (const cat of COVER_SECTION_ORDER) {
    const rows = byCat.get(cat) ?? [];
    // service/other are hidden when empty; the five named must-have buckets always show.
    if (rows.length === 0 && !(cat in COVER_MUSTHAVE_EMPTY)) continue;
    lines.push('');
    lines.push(COVER_SECTION_HEADER[cat]);
    if (rows.length === 0) {
      lines.push(`  ${COVER_MUSTHAVE_EMPTY[cat]}`);
      continue;
    }
    for (const { e, idx } of rows) {
      const friendly = e.friendlyLabel ?? coverFriendlyLabel(e.docType ?? 'unspecified', e.category);
      const why = shortCoverWhy(coverWhyLine(e.category, e.mentionsClaimedCondition));
      const pageRef = e.assembledStartPage ?? (e.pageRanges.length > 0 ? e.pageRanges[0]!.from : undefined);
      contentRows.push({ entriesIndex: idx, sourceLineIndex: lines.length, category: e.category, label: friendly });
      lines.push(composeCoverRow(friendly, why, pageRef));
    }
  }

  // Not included — ONE calm line (count + brief), not the per-note list.
  lines.push('');
  const n = input.notIncluded.length;
  if (n > 0) {
    lines.push(`Not included: ${n} ${n === 1 ? 'record' : 'records'} (omitted as duplicate or lower-priority — see the record list).`);
  } else {
    lines.push('Not included: nothing was omitted.');
  }

  return { lines, contentRows };
}

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
  readonly trigger?: 'manual' | 'auto_send_to_doctor' | 'auto_chart_parsed';
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
      // ROUND 2: veteranStatement + createdAt feed the rendered lay-statement page (C);
      // claimType/framingChoice/upstreamScCondition feed the cover index's theory line (D).
      veteranStatement: true,
      createdAt: true,
      claimType: true,
      framingChoice: true,
      upstreamScCondition: true,
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
  })) as unknown as { id: string; veteranId: string; version: number; claimedCondition: string | null; veteranStatement?: string | null; createdAt?: Date | string | null; claimType?: string | null; framingChoice?: string | null; upstreamScCondition?: string | null; documents: readonly { id: string; s3Key: string; pageCount: number | null; docTag: string | null; filename?: string | null; contentType?: string | null; uploadedAt?: Date | string | null }[] } | null;
  if (caseWithDocs === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId });
  const c = { id: caseWithDocs.id, veteranId: caseWithDocs.veteranId, version: caseWithDocs.version };
  const claimedCondition = caseWithDocs.claimedCondition ?? undefined;

  if (trigger === 'auto_send_to_doctor' || trigger === 'auto_chart_parsed') {
    // Auto-gen idempotency (Package 7 send-to-doctor + Ryan 2026-06-12 chart-parsed): skip when a
    // pack for the CURRENT chart state already exists — queued/generating (in flight) or ready —
    // keyed on the post-transition case
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
  // Exclude the synthetic screening-summary Document — a 0-page OUTPUT of extraction, never a
  // doctor-pack source page (matches chart-extract-docs.ts:31 and the chart-build-state inputs
  // filter). Filtered in JS, not a Prisma `{ not }` where-clause: Prisma's `not` drops NULL-docTag
  // rows, which would silently exclude every untagged document. Belt-and-suspenders on both the
  // docTag and the s3Key marker. (consistency sweep fixes, 2026-06-14 — last forgotten exclusion gate.)
  const docList = (caseWithDocs.documents as readonly { id: string; s3Key: string; pageCount: number | null; docTag: string | null; filename?: string | null; contentType?: string | null; uploadedAt?: Date | string | null }[])
    .filter((d) => d.docTag !== 'screening_summary' && !isScreeningSummaryKey(d.s3Key));
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
  // AI picker scope (Ryan 2026-06-12): the multi-page record types where VA benefit boilerplate
  // hides and per-page selection matters. Always-include small docs (DD-214, intake summary, lay
  // statements) and bulk blue_button exports are NOT in this set — they keep their deterministic
  // shortcuts (no LLM cost, no boilerplate risk).
  const LLM_PICKER_DOCTYPES = new Set<string>([
    'rating_decision', 'denial_letter', 'supplemental_decision', 'c_and_p_exam', 'dbq',
    'imaging', 'sleep_study', 'personnel_record', 'service_treatment_record_summary',
    'benefit_summary', 'unspecified', 'progress_notes',
    // 2026-06-26: the other objective-study docTypes also hide their decisive page among
    // boilerplate (audiogram thresholds, PFT spirometry tables) — let the picker rank them.
    'audiogram', 'pulmonary_function_test',
  ]);

  // doctor-pack grounded pages, 2026-06-13 (PR-2, DARK): pull the EXACT source pages that grounded
  // an extracted chart fact (the rating-grant page, the AHI page, the med-list page) and UNION them
  // into each document's selected page set — so a 1,000-page Blue Button dump still contributes the
  // one page that grounded a granted condition. Gated behind DOCTOR_PACK_GROUNDED_PAGES === 'on'
  // (mirrors the CHART_EXTRACT_FULLREAD dark-launch discipline). Flag OFF ⇒ empty map ⇒ selectPages
  // receives no groundedPages ⇒ byte-identical to today. The back-map is a $0 pure read (no LLM).
  const groundedPagesEnabled = process.env['DOCTOR_PACK_GROUNDED_PAGES'] === 'on';
  const groundedByDocumentId: Map<string, GroundedPage[]> = groundedPagesEnabled
    ? await groundedSourcePagesForCase(db as unknown as GroundedPagesDb, caseId)
    : new Map();

  // ── DOCTOR_PACK_CATEGORY_FLOORS (2026-06-26, dark): wider 30-page budget + per-category floors +
  // chart-fact category override + defining-study force-include + cover coverage checklist. Flag OFF
  // ⇒ every derived value below is empty/null and the effective budget is 15 ⇒ byte-identical to
  // today. The override back-map is a $0 pure read (no LLM), fail-open.
  const categoryFloorsOn = categoryFloorsEnabled();
  const packBudget = effectivePackPageBudget(); // 15 (flag off) | 30 (flag on)
  const chartFactCategoryByDoc: Map<string, ChartFactCategory> = categoryFloorsOn
    ? await chartFactCategoryByDocument(db as unknown as ChartFactCategoryDb, caseId)
    : new Map();
  const expectedStudy: ExpectedStudy | null = categoryFloorsOn
    ? expectedStudyForCondition(claimedCondition)
    : null;

  let packPickerCostUsd = 0;
  const perFileSelection = await Promise.all(classifiedFiles.map(async (f) => {
    const pageRows = pagesByDocumentId.get(f.documentId) ?? [];
    const contentText = buildContentHintText(pageRows);
    const cls = classifyDocument({ filePath: f.filePath, docTag: f.docTag, contentText });
    const pagesInput: readonly PageSelectorInputPage[] = pageRows.map((p) => ({
      pageNumber: p.pageNumber,
      text: p.text,
      confidence: p.confidence,
    }));
    const existing = existingByPath.get(f.filePath);
    const physicianOverride = existing?.physicianIncludeAllPages ?? false;
    // PR-2 (DARK): the grounded pages for THIS document (empty unless the flag is on). Passed into
    // selectPages so the union (incl. the blue_button hard-exclude override) happens in one place;
    // the LLM-picker branch bypasses selectPages, so it gets the same union applied explicitly.
    const groundedPages = (groundedByDocumentId.get(f.documentId) ?? []).map((g) => g.page);
    const pickerPageCount = f.pageCount ?? pageRows.length ?? 0;
    // Deterministic regex selector — the fail-safe. Used directly for non-LLM docTypes, and as the
    // fallback whenever the LLM picker is unavailable / errors / returns nothing usable.
    const runRegex = (): PageSelectorResult => selectPages({
      filePath: f.filePath,
      docType: cls.docType,
      classification: cls.classification,
      pageCount: pickerPageCount,
      pages: pagesInput,
      physicianIncludeAllPages: physicianOverride,
      ...(claimedCondition !== undefined ? { claimedCondition } : {}),
      ...(groundedPages.length > 0 ? { groundedPages } : {}),
      // DOCTOR_PACK_CATEGORY_FLOORS (2026-06-27, Fix C): A&P-preferred clinical narrowing for the
      // regex selector (the LLM picker already favors the A&P). Flag OFF ⇒ prop absent ⇒
      // byte-identical. This is exactly the path narrowOutOfLlmScope (~L764) routes bulk Blue Button
      // clinical to, so the flag-ON A&P narrowing reaches the high-volume case.
      ...(categoryFloorsOn ? { preferAssessmentPlan: true } : {}),
    });
    let selection: PageSelectorResult;
    const textPageCount = pagesInput.filter((p) => (p.text ?? '').trim().length > 0).length;
    // doctor-pack grounded pages PR-4, 2026-06-13 (CODE ONLY, flag-gated): narrow the LLM page-
    // picker's effective scope. Now the back-map DETERMINISTICALLY owns the high-yield pages of
    // bulk dumps (the rating-grant page, the AHI page, the med-list page get unioned in for $0),
    // the LLM picker should no longer spend tokens RANKING bulk-classified docs — every page it
    // would keep there is either already pinned by the back-map or low-value bulk boilerplate. So
    // when the flag is on we route bulk-classified docs (and blue_button explicitly) straight to
    // the deterministic regex selector (which still applies the grounded-page union). Per-call cost
    // drops: a bulk doc that previously paid for an LLM ranking pass now pays $0. Flag OFF ⇒ this
    // predicate is false ⇒ the picker dispatch is byte-identical to PR-2/PR-3.
    const narrowOutOfLlmScope =
      groundedPagesEnabled && (cls.classification === 'bulk' || cls.docType === 'blue_button');
    if (!physicianOverride && !narrowOutOfLlmScope && LLM_PICKER_DOCTYPES.has(cls.docType) && shouldUseLlmPicker(textPageCount)) {
      const llm = await selectPagesLlm({
        docType: cls.docType,
        pages: pagesInput,
        ...(claimedCondition !== undefined ? { claimedCondition } : {}),
      });
      if (llm !== null) {
        packPickerCostUsd += llm.costUsd;
        const llmResult: PageSelectorResult = { pageRanges: llm.pageRanges, selectorRationale: llm.rationale, needsRnReview: false, selectorVersion: PAGE_LLM_VERSION };
        // PR-2: union grounded pages into the LLM picker's output too (it never saw them). When the
        // flag is off groundedPages is empty ⇒ this is the unchanged llmResult.
        selection = unionGroundedPagesIntoResult(llmResult, pickerPageCount, groundedPages);
      } else {
        selection = runRegex();
      }
    } else {
      selection = runRegex();
    }
    return { file: f, classification: cls, selection };
  }));
  if (packPickerCostUsd > 0) {
    console.log(JSON.stringify({ msg: 'doctor_pack_page_picker_cost', costUsd: Math.round(packPickerCostUsd * 10000) / 10000 }));
  }
  const clsByPath = new Map(perFileSelection.map((s) => [s.file.filePath, s.classification]));

  // DOCTOR_PACK_CATEGORY_FLOORS (2026-06-26): raise the progress_notes importance floor so a
  // content-classified clinical note clears the NORMAL_INCLUSION_THRESHOLD (50) and the budget's
  // importance-rank tiebreak — the dx note must not lose its slot to boilerplate. Flag OFF ⇒
  // clsByPathAdjusted === clsByPath ⇒ byte-identical.
  const PROGRESS_NOTES_IMPORTANCE_FLOOR = 55;
  const clsByPathAdjusted = categoryFloorsOn
    ? new Map(
        [...clsByPath].map(([path, cls]) =>
          cls.docType === 'progress_notes'
            ? [path, { ...cls, importance: Math.max(cls.importance, PROGRESS_NOTES_IMPORTANCE_FLOOR) }]
            : [path, cls],
        ),
      )
    : clsByPath;

  // ROUND 2 (A): content-hash dedup BEFORE selection-results enter the manifest/budget. The
  // KeyDoc upsert loop still writes a row for EVERY file (the RN doc list stays complete; the
  // duplicate's rationale says why it's not in the pack), but duplicates never consume budget.
  const docMetaByPath = new Map(docList.map((d) => [d.s3Key, d]));
  const displayNameByPath = new Map(docList.map((d) => [d.s3Key, displayFileName(d.s3Key, d.filename ?? null)]));
  const uploadIndexByPath = new Map(docList.map((d, i) => [d.s3Key, i]));
  const dedup = dedupPackDocuments(
    perFileSelection.map((s) => ({
      filePath: s.file.filePath,
      displayName: displayNameByPath.get(s.file.filePath) ?? s.file.filePath,
      fileSha256: s.file.fileSha256,
      textFingerprint: computeTextFingerprint(pagesByDocumentId.get(docMetaByPath.get(s.file.filePath)?.id ?? '') ?? []),
      docType: s.classification.docType,
      importance: s.classification.importance,
      uploadIndex: uploadIndexByPath.get(s.file.filePath) ?? Number.MAX_SAFE_INTEGER,
    })),
  );
  const duplicatePaths = new Set(dedup.duplicateOf.keys());

  // Assemble manifest: legacy whole-doc path for files with no per-page data; page-selected
  // for files with at least one DocumentPage row. The selection.pageRanges may be empty
  // (no_per_page_text_available) — the legacy assembler handles empty by including the
  // whole file at extraction time. The content-aware classification is passed through so
  // the manifest's include/exclude tiers agree with the selector's docTypes.
  const manifest = assembleDoctorPackManifest({
    classifiedFiles: classifiedFiles
      .filter((f) => !duplicatePaths.has(f.filePath))
      .map((f) => ({ ...f, cls: clsByPathAdjusted.get(f.filePath) })),
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
    // ROUND 2 (A): duplicates never enter the pack via the append path either.
    .filter((s) => !duplicatePaths.has(s.file.filePath))
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

  // Re-sort the combined set with the manifest's own comparator (tier > importance > path) so
  // appended bulk docs land last. doctor-pack grounded pages, 2026-06-13 (E2): the page BUDGET
  // no longer runs here. It used to trim THIS (PDF-only) set, after which the rendered non-PDF
  // pages, the veteran statement, and (PR-2) the grounded pages were APPENDED — escaping the
  // budget entirely, so a "15-page" pack shipped 25+. The budget now runs ONCE, LAST, over the
  // COMPLETE post-render/post-statement set (the cover index is the only exemption — it is added
  // on top afterward). So here we only ORDER + carry the full selector ranges forward; the trim
  // happens at applyPackPageBudget(orderedBudgetEntries) below.
  const tierOrder: Record<string, number> = { high_signal: 0, normal: 1, bulk: 2 };
  const combinedEntries: BudgetEntry[] = [...refinedEntries, ...appendedEntries]
    .map((e) => ({ ...e, importance: clsByPathAdjusted.get(e.filePath)?.importance ?? 50 }))
    .sort((a, b) => {
      if (tierOrder[a.classification] !== tierOrder[b.classification]) {
        return (tierOrder[a.classification] ?? 1) - (tierOrder[b.classification] ?? 1);
      }
      if (a.importance !== b.importance) return b.importance - a.importance;
      return a.filePath.localeCompare(b.filePath);
    });
  // Strip the budget-only `importance` so manifestJson keeps the exact entry contract the
  // assembler + RN review UI already consume. No trim yet — full selector ranges flow into render.
  const finalEntries = combinedEntries.map(({ importance: _importance, ...entry }) => entry);

  // ===== WAVE 2 (assessment 2026-06-12 §1b/1d/§3) + ROUND 2 (C/D/E/F): label, render, gate =====

  // §3: stamp displayLabel BEFORE the render swap so the label always carries the ORIGINAL
  // filename (the rendered artifact's provenance header declares the conversion separately).
  // Additive manifest field — the assembler tolerates absence on legacy rows.
  const labeledEntries = finalEntries.map((entry) => {
    const meta = docMetaByPath.get(entry.filePath);
    return { ...entry, displayLabel: keyDocDisplayLabel(entry.docType, displayFileName(entry.filePath, meta?.filename ?? null)) };
  });

  // Shared rendered-artifact upload (non-PDF sources, the lay-statement page, the cover index).
  // Derived RECORDS-bucket keys — zero handler.py contract change (it fetches every entry from
  // _records_bucket()). Deterministic bytes + deterministic key = idempotent, overwrite-safe.
  const uploadRenderedPdf = async (key: string, bytes: Uint8Array): Promise<void> => {
    const bucket = deps?.recordsBucketName ?? process.env['PHI_BUCKET_NAME'];
    if (typeof bucket !== 'string' || bucket.length === 0) {
      throw new Error('PHI_BUCKET_NAME (records bucket) not configured for rendered-record upload');
    }
    const s3 = deps?.s3 ?? defaultRecordsS3();
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: 'application/pdf' }));
  };

  // §1b: render each non-PDF source's SELECTED pages to a real PDF in the records bucket and
  // point the manifest entry at the rendered key. Fail-OPEN per entry: a render/upload error
  // logs, drops THAT entry into trimNotes ('could not render <filename>'), and the pack keeps
  // assembling — never the whole pack. (KeyDoc rows are untouched: they keep the ORIGINAL
  // filePath + selector ranges so the RN review UI and the Document join keep working.)
  // ROUND 2: each surviving entry carries side-channel meta (importance for the medicine-first
  // sort, mentionsClaimedCondition for the cover index's WHY line) keyed to the entry itself so
  // the rendered-key swap can't orphan it.
  type LabeledEntry = DoctorPackManifestEntry & { readonly displayLabel: string };
  interface PackEntryMeta {
    readonly entry: LabeledEntry;
    readonly importance: number;
    readonly mentionsClaimedCondition: boolean;
    // doctor-pack grounded pages, 2026-06-13 (E2): the ORIGINAL source filePath (the KeyDoc key).
    // For a non-PDF source whose entry.filePath was swapped to a rendered `_rendered/...` key, this
    // stays the original document path so the LATE budget's per-entry trim can be mapped back to
    // its KeyDoc row. Rendered-only entries (veteran statement, cover) have no KeyDoc row → null.
    readonly originalFilePath: string | null;
    // doctor-pack grounded pages, 2026-06-13 (E2): the document's available page-text count. For a
    // whole-doc passthrough entry (empty pageRanges + null Document.pageCount) this is what makes
    // it TRIMMABLE — the budget previously saw pageCount 0 and shipped the whole PDF. null when
    // unknown (no per-page OCR) — the budget keeps the legacy whole-doc passthrough for those.
    readonly availablePageCount: number | null;
  }
  const renderNotes: string[] = [];
  const packEntryMetas: PackEntryMeta[] = [];
  for (const entry of labeledEntries) {
    const meta = docMetaByPath.get(entry.filePath);
    const importance = clsByPathAdjusted.get(entry.filePath)?.importance ?? 50;
    const docText = (pagesByDocumentId.get(meta?.id ?? '') ?? []).map((p) => p.text).join('\n');
    const mentionsClaimedCondition = textMentionsCondition(docText, claimedCondition);
    const availablePageCount = meta !== undefined ? (pagesByDocumentId.get(meta.id ?? '') ?? []).length || null : null;
    if (meta === undefined || !isNonPdfSource(entry.filePath, meta.filename ?? null, meta.contentType ?? null)) {
      packEntryMetas.push({ entry, importance, mentionsClaimedCondition, originalFilePath: entry.filePath, availablePageCount });
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
      const renderedKey = `cases/${caseId}/_rendered/${meta.id}-v${c.version}.pdf`;
      await uploadRenderedPdf(renderedKey, rendered.bytes);
      packEntryMetas.push({
        entry: {
          ...entry,
          filePath: renderedKey,
          pageRanges: [{ from: 1, to: rendered.pageCount }],
          pageCount: rendered.pageCount,
        },
        importance,
        mentionsClaimedCondition,
        // E2: KeyDoc bookkeeping follows the ORIGINAL document path, not the rendered key.
        originalFilePath: entry.filePath,
        availablePageCount: rendered.pageCount,
      });
    } catch (renderErr) {
      console.warn(`doctor-pack: could not render non-PDF source ${displayName} (entry dropped, pack continues):`, renderErr);
      renderNotes.push(`could not render ${displayName}`);
    }
  }

  // §1 no-dx signal is computed AFTER the budget now (over the SURVIVORS, override-aware) — see
  // the post-budget block below. Computing it here (pre-budget) double-counted a clinical doc the
  // budget would later evict and ignored the chart-fact override.

  // ROUND 2 (C): the veteran's lay/timeline statement (Case.veteranStatement) renders into a
  // one-page LAY-category entry; an empty statement becomes a Not-included note the panel
  // surfaces.
  {
    const statementText = (caseWithDocs.veteranStatement ?? '').trim();
    if (statementText.length === 0) {
      renderNotes.push(NO_LAY_STATEMENT_NOTE);
    } else {
      try {
        const createdAtRaw = caseWithDocs.createdAt ?? null;
        const rendered = await renderRecordTextPdf({
          originalFilename: 'Veteran statement (from intake)',
          pages: [{ sourcePageNumber: 1, text: statementText }],
          provenanceHeader: buildVeteranStatementHeader(createdAtRaw !== null ? new Date(createdAtRaw) : null),
          omitSourceFooters: true,
        });
        const statementKey = `cases/${caseId}/_rendered/veteran-statement-v${c.version}.pdf`;
        await uploadRenderedPdf(statementKey, rendered.bytes);
        packEntryMetas.push({
          entry: {
            filePath: statementKey,
            docType: 'lay_statement',
            classification: 'high_signal',
            pageRanges: [{ from: 1, to: rendered.pageCount }],
            pageCount: rendered.pageCount,
            displayLabel: 'Veteran statement (from intake)',
          },
          importance: 70,
          mentionsClaimedCondition: textMentionsCondition(statementText, claimedCondition),
          // E2: a rendered-only entry with no source Document → no KeyDoc row to map back to.
          originalFilePath: null,
          availablePageCount: rendered.pageCount,
        });
      } catch (statementErr) {
        console.warn('doctor-pack: could not render the veteran statement (pack continues):', statementErr);
        renderNotes.push('could not render the veteran statement');
      }
    }
  }

  // DOCTOR_PACK_CATEGORY_FLOORS (2026-06-26): resolve a meta's OVERRIDE pack category — the
  // chart-fact category (a granted-SC doc the classifier mislabeled → 'sc_proof') first, else the
  // defining-study force-include (the study docType for the claimed condition → 'tests'). Keyed off
  // the ORIGINAL document path (m.entry.filePath may be a rendered key). Returns undefined when the
  // flag is off OR no override applies ⇒ the docType→category map stands (byte-identical).
  const overrideCatFor = (m: PackEntryMeta): PackCategory | undefined => {
    if (!categoryFloorsOn) return undefined;
    const docId = m.originalFilePath !== null ? docMetaByPath.get(m.originalFilePath)?.id : undefined;
    if (docId !== undefined) {
      const chartCat = chartFactCategoryByDoc.get(docId);
      if (chartCat !== undefined) return chartCat; // 'sc_proof' | 'denial' | 'clinical'
    }
    if (expectedStudy !== null && m.entry.docType === expectedStudy.docType) return 'tests';
    return undefined;
  };

  // ROUND 2 (E): medicine-first order — clinical (dx note first) → lay → denial → sc_proof →
  // tests → service → other; deterministic within category (importance desc, then path). The
  // override category (when present) drives the order too.
  const orderedMetas = orderPackEntriesMedicineFirst(packEntryMetas, (m) => {
    const pc = overrideCatFor(m);
    return {
      docType: m.entry.docType,
      importance: m.importance,
      filePath: m.entry.filePath,
      ...(pc !== undefined ? { packCategory: pc } : {}),
    };
  });

  // ===== doctor-pack grounded pages, 2026-06-13 (E2): THE budget — run LAST, over the COMPLETE set
  // (rendered non-PDF pages + the veteran statement are now INSIDE the budget; the cover index is
  // the ONLY exemption and is added on top afterward). Two correctness fixes vs the old early pass:
  //   1. Rendered/statement pages used to be appended AFTER the trim, escaping the budget.
  //   2. A whole-doc passthrough entry (empty pageRanges + null Document.pageCount) had pageCount 0,
  //      so the budget couldn't see its size and shipped the WHOLE PDF. We now derive a real
  //      pageCount from the document's available page-text count (availablePageCount) so it is
  //      TRIMMABLE. (Only entries with genuinely-unknown size — no per-page OCR — keep the legacy
  //      whole-doc passthrough.)
  // The budget keys off entry.filePath (which may be a rendered key); we map its output back to the
  // metas by that same key, and separately back to ORIGINAL paths for KeyDoc bookkeeping below.
  // doctor-pack grounded pages PR-3, 2026-06-13 (POLICY B): for each ordered meta, resolve the
  // PINNED pages (the back-mapped pages that grounded an extracted chart fact) + their fact kind so
  // the budget protects them ahead of regex/LLM pages and trims them last by yield. Keyed off the
  // ORIGINAL document path (entry.filePath may be a rendered key) → documentId → groundedByDocumentId.
  // Pinning applies ONLY to a NON-rendered entry (entry.filePath === originalFilePath): a rendered
  // non-PDF entry renumbers its pages 1..N, so the source-page-numbered grounded pages no longer map
  // (and the union never applied to it either). Flag OFF ⇒ groundedByDocumentId is empty ⇒ every meta
  // resolves to no pinned pages ⇒ orderedBudgetEntries carry no pinned fields ⇒ applyPackPageBudget
  // runs byte-identically.
  const pinnedFor = (m: PackEntryMeta): { pinnedPages: number[]; pinnedFactKindByPage: Record<number, GroundedPage['factKind']> } => {
    const empty = { pinnedPages: [] as number[], pinnedFactKindByPage: {} as Record<number, GroundedPage['factKind']> };
    if (!groundedPagesEnabled) return empty;
    if (m.originalFilePath === null || m.entry.filePath !== m.originalFilePath) return empty; // rendered/synthetic → no source-page pins
    const documentId = docMetaByPath.get(m.originalFilePath)?.id;
    if (documentId === undefined) return empty;
    const grounded = groundedByDocumentId.get(documentId) ?? [];
    if (grounded.length === 0) return empty;
    const pinnedFactKindByPage: Record<number, GroundedPage['factKind']> = {};
    for (const g of grounded) pinnedFactKindByPage[g.page] = g.factKind;
    return { pinnedPages: grounded.map((g) => g.page), pinnedFactKindByPage };
  };
  const orderedBudgetEntries: BudgetEntry[] = orderedMetas.map((m) => {
    const e = m.entry;
    const hasRanges = e.pageRanges.length > 0;
    // Whole-doc passthrough with a KNOWN available page count → synthesize a 1..N range so the
    // budget can trim it. Unknown (null) → leave empty ranges (legacy passthrough, budget-exempt).
    const ranges = hasRanges
      ? e.pageRanges
      : (m.availablePageCount !== null ? [{ from: 1, to: m.availablePageCount }] : []);
    const pageCount = ranges.reduce((sum, r) => sum + Math.max(0, r.to - r.from + 1), 0);
    const pinned = pinnedFor(m);
    let pinnedPages = pinned.pinnedPages;
    let pinnedFactKindByPage = pinned.pinnedFactKindByPage;
    // DOCTOR_PACK_CATEGORY_FLOORS: defining-study FORCE-INCLUDE. Pin the study's first selected page
    // (factKind 'screening' — an objective test) so Phase 0 of the budget protects it ahead of every
    // ordinary page: the sleep study an OSA letter is built on can never be trimmed out. Flag OFF ⇒
    // expectedStudy is null ⇒ no pin ⇒ byte-identical.
    if (categoryFloorsOn && expectedStudy !== null && e.docType === expectedStudy.docType && ranges.length > 0) {
      const firstPage = ranges[0]!.from;
      if (!pinnedPages.includes(firstPage)) {
        pinnedPages = [...pinnedPages, firstPage];
        pinnedFactKindByPage = { ...pinnedFactKindByPage, [firstPage]: 'screening' };
      }
    }
    const overrideCat = overrideCatFor(m);
    return {
      filePath: e.filePath,
      docType: e.docType,
      classification: e.classification,
      pageRanges: ranges,
      pageCount,
      importance: m.importance,
      // DOCTOR_PACK_CATEGORY_FLOORS: the chart-fact / study override category. Absent (flag off or no
      // override) ⇒ the budget derives the category from docType (byte-identical).
      ...(overrideCat !== undefined ? { packCategory: overrideCat } : {}),
      // PR-3 (POLICY B): only attach pinned fields when there ARE pinned pages — an absent field is
      // the byte-identical flag-off shape the budget's `hasPinned` fast-path keys on.
      ...(pinnedPages.length > 0
        ? { pinnedPages, pinnedFactKindByPage }
        : {}),
    };
  });
  const budget = applyPackPageBudget(orderedBudgetEntries, packBudget);
  const budgetByKey = new Map(budget.entries.map((e) => [e.filePath, e]));
  // Re-emit the metas in their ordered sequence, dropping any the budget evicted entirely and
  // applying the budgeted ranges/pageCount to the survivors. The cover is added AFTER this.
  const budgetedMetas: PackEntryMeta[] = [];
  for (const m of orderedMetas) {
    const budgeted = budgetByKey.get(m.entry.filePath);
    if (budgeted === undefined) continue; // evicted by the budget
    budgetedMetas.push({ ...m, entry: { ...m.entry, pageRanges: budgeted.pageRanges, pageCount: budgeted.pageCount } });
  }
  // KeyDoc bookkeeping (keyed by ORIGINAL document path): which originals were trimmed, and the
  // exact ranges that ended up in the pack. Rendered keys map back to originalFilePath; the budget
  // also reports trims under the rendered key, so translate.
  const trimmedPaths = new Set<string>();
  const finalRangesByPath = new Map<string, readonly { from: number; to: number }[]>();
  const renderedKeyToOriginal = new Map(orderedMetas.map((m) => [m.entry.filePath, m.originalFilePath]));
  for (const tp of budget.trimmedFilePaths) {
    const orig = renderedKeyToOriginal.get(tp);
    if (orig != null) trimmedPaths.add(orig);
  }
  for (const m of budgetedMetas) {
    if (m.originalFilePath !== null) finalRangesByPath.set(m.originalFilePath, m.entry.pageRanges);
  }

  // §1 no-dx signal — computed POST-budget over the SURVIVORS, override-aware (DOCTOR_PACK_CATEGORY_FLOORS).
  // A clinical doc the budget evicted no longer counts; a doc the chart-fact override routed INTO
  // 'clinical' does. A whole-doc passthrough clinical entry (empty ranges) counts as contributing —
  // the assembler ships it (the "passthrough credit" that keeps missingClinical false when the only
  // clinical doc is an unsized passthrough). Flag OFF ⇒ overrideCatFor is undefined ⇒ the category
  // derives from docType exactly as the old CLINICAL_DX_DOC_TYPES set did, and every present clinical
  // doc survives the clinical floor ⇒ this matches the pre-flag pre-budget result.
  const clinicalPageContribution = budgetedMetas
    .filter((m) => (overrideCatFor(m) ?? packCategoryOf(m.entry.docType)) === 'clinical')
    .reduce((sum, m) => sum + (m.entry.pageRanges.length === 0 ? Math.max(1, m.entry.pageCount) : m.entry.pageCount), 0);
  const missingClinical = clinicalPageContribution === 0;

  // DOCTOR_PACK_CATEGORY_FLOORS: per-category DROPPED warnings — a category present pre-budget whose
  // documents were ALL evicted post-budget. Flag-gated (empty when off ⇒ byte-identical).
  const droppedCategoryWarnings: string[] = [];
  if (categoryFloorsOn) {
    const preBudgetCounts = new Map<PackCategory, number>();
    for (const m of orderedMetas) {
      const cat = overrideCatFor(m) ?? packCategoryOf(m.entry.docType);
      preBudgetCounts.set(cat, (preBudgetCounts.get(cat) ?? 0) + 1);
    }
    const survivingCategories = new Set<PackCategory>();
    for (const m of budgetedMetas) survivingCategories.add(overrideCatFor(m) ?? packCategoryOf(m.entry.docType));
    droppedCategoryWarnings.push(...computeDroppedCategoryWarnings(preBudgetCounts, survivingCategories));
  }

  // DOCTOR_PACK_CATEGORY_FLOORS: the cover coverage checklist (flag-gated → empty when off ⇒ cover
  // byte-identical). One line per must-have category: surviving pages or NOT FOUND IN CHART / NONE ON
  // FILE, plus the defining study for the claimed condition.
  const categoryAssertions = categoryFloorsOn
    ? buildCategoryAssertionLines(
        budgetedMetas.map((m) => ({
          category: overrideCatFor(m) ?? packCategoryOf(m.entry.docType),
          displayLabel: m.entry.displayLabel,
          pageRanges: m.entry.pageRanges,
        })),
        expectedStudy,
      )
    : [];

  // doctor-pack grounded pages PR-3, 2026-06-13 (POLICY B): per-entry cover "why" lines for the
  // PINNED pages that SURVIVED the budget. Intersect the entry's final (budgeted) pages with the
  // back-map's grounded pages for that document, and emit one line per surviving pinned page (in
  // page order) carrying the grounding fact's kind + source quote. Same gate + same non-rendered
  // restriction as pinnedFor() above — flag off (or no grounded survivors) ⇒ no pinned why-lines ⇒
  // cover text byte-identical.
  const pinnedWhyLinesFor = (m: PackEntryMeta): string[] => {
    if (!groundedPagesEnabled) return [];
    if (m.originalFilePath === null || m.entry.filePath !== m.originalFilePath) return [];
    const documentId = docMetaByPath.get(m.originalFilePath)?.id;
    if (documentId === undefined) return [];
    const grounded = groundedByDocumentId.get(documentId) ?? [];
    if (grounded.length === 0) return [];
    const survivingPages = new Set<number>();
    for (const r of m.entry.pageRanges) for (let p = r.from; p <= r.to; p++) survivingPages.add(p);
    return grounded
      .filter((g) => survivingPages.has(g.page))
      .sort((a, b) => a.page - b.page)
      .map((g) => coverPinnedWhyLine(g.page, g.factKind, g.sourceQuote));
  };

  // DOCTOR_PACK_LINKED_COVER (2026-06-27): the calm clickable-TOC cover. Read at request time (no
  // image rebuild). When ON, the cover lists each document with a friendly label + ONE predicted
  // assembled page ref, and a coverLinkMap travels on the manifest so the Python assembler stamps a
  // PDF link (cover row → that document's first page) + a 2-level outline. OFF ⇒ byte-identical
  // legacy cover, no link-map.
  const linkedCoverOn = process.env['DOCTOR_PACK_LINKED_COVER'] === 'on';

  // Cover-page summary (architect plan: lives in DoctorPack.manifestJson.coverPage). Computed here
  // (moved up from after the cover) so the linked cover can reuse the veteran name + active problems
  // for its case-snapshot block — same data, one fetch. Output is identical to the pre-move position.
  const coverPage = await aggregateChartSummary({
    db,
    caseRow: await fetchCaseRowForCover(db, caseId, c.veteranId),
  });

  // LINKED COVER snapshot inputs: SC conditions WITH rating % (aggregateChartSummary returns names
  // only) for the "Service-connected:" line. Only queried when the flag is on (OFF ⇒ no extra query
  // ⇒ byte-identical). Active problems + veteran name reuse the coverPage fetch above.
  let snapshotSc: { condition: string; ratingPct: number | null }[] = [];
  if (linkedCoverOn) {
    const scRows = await db.scCondition.findMany({
      where: { veteranId: c.veteranId, status: 'service_connected' },
      orderBy: { condition: 'asc' },
    });
    snapshotSc = scRows.map((r) => ({ condition: r.condition, ratingPct: r.ratingPct ?? null }));
  }

  // ROUND 2 (D): one-page cover index, rendered + prepended as manifest entry #0. Fail-open:
  // a cover render failure drops only the cover (note in trimNotes), never the pack.
  // DOCTOR_PACK_CATEGORY_FLOORS: per-category DROPPED warnings join the Not-included notes (empty
  // when the flag is off ⇒ byte-identical).
  const dedupAndBudgetNotes = [...dedup.notes, ...budget.trimNotes, ...droppedCategoryWarnings];
  let coverEntry: LabeledEntry | null = null;
  let coverLinkMap: CoverLinkMapEntry[] | null = null;
  {
    try {
      const coverNotIncluded = humanizeTrimNotes([...dedupAndBudgetNotes, ...renderNotes], displayNameByPath);
      if (linkedCoverOn) {
        // Predicted assembled start page per entry = cover pages + preceding entry pages + 1. The
        // cover's own page count depends on its line count (rows are length-capped to one rendered
        // line, so the count is independent of the page-number digits); measure once and the numbers
        // are stable. The coverLinkMap rects come from the FINAL rendered input, so the clickable link
        // is always correct regardless of the printed number.
        const cumPreceding: number[] = [];
        let acc = 0;
        for (const m of budgetedMetas) { cumPreceding.push(acc); acc += m.entry.pageCount; }
        const buildAt = (coverPageCount: number): CoverIndexBuild => buildCoverIndexLines({
          caseId,
          ...(claimedCondition !== undefined ? { claimedCondition } : {}),
          claimType: caseWithDocs.claimType ?? null,
          framingChoice: caseWithDocs.framingChoice ?? null,
          upstreamScCondition: caseWithDocs.upstreamScCondition ?? null,
          linkedCover: true,
          veteranName: coverPage?.veteran.fullName ?? '',
          serviceConnected: snapshotSc,
          activeProblems: coverPage?.activeProblems ?? [],
          entries: budgetedMetas.map((m, k) => ({
            displayLabel: m.entry.displayLabel,
            category: packCategoryOf(m.entry.docType),
            docType: m.entry.docType,
            pageRanges: m.entry.pageRanges,
            mentionsClaimedCondition: m.mentionsClaimedCondition,
            assembledStartPage: coverPageCount + cumPreceding[k]! + 1,
          })),
          notIncluded: coverNotIncluded,
        });
        // Resolve the cover's own page count (converges in <=2 iterations; the row count is fixed).
        let coverPageCount = 1;
        let built = buildAt(coverPageCount);
        for (let iter = 0; iter < 3; iter++) {
          const planned = await previewRecordTextLayout({
            originalFilename: 'Doctor pack cover index',
            pages: [{ sourcePageNumber: 1, text: built.lines.join('\n') }],
            provenanceHeader: 'DOCTOR PACK — COVER INDEX',
            omitSourceFooters: true,
          });
          if (planned.length === coverPageCount) break;
          coverPageCount = planned.length;
          built = buildAt(coverPageCount);
        }
        const coverInput = {
          originalFilename: 'Doctor pack cover index',
          pages: [{ sourcePageNumber: 1, text: built.lines.join('\n') }],
          provenanceHeader: 'DOCTOR PACK — COVER INDEX',
          omitSourceFooters: true,
        };
        const rendered = await renderRecordTextPdf(coverInput);
        const coverKey = `cases/${caseId}/_rendered/cover-index-v${c.version}.pdf`;
        await uploadRenderedPdf(coverKey, rendered.bytes);
        coverEntry = {
          filePath: coverKey,
          docType: 'cover_index',
          classification: 'high_signal',
          pageRanges: [{ from: 1, to: rendered.pageCount }],
          pageCount: rendered.pageCount,
          displayLabel: 'Cover index',
        };
        // Link-map: each content row → the bounding rectangle of its rendered lines on its cover
        // page. entryIndex is the MANIFEST entry index (cover is #0, so budgetedMetas[k] is k+1).
        const rects = await previewRecordTextLineRects(coverInput);
        const map: CoverLinkMapEntry[] = [];
        for (const row of built.contentRows ?? []) {
          const lineRects = rects.filter((r) => r.sourceLineIndex === row.sourceLineIndex);
          if (lineRects.length === 0) continue;
          const pageIdx = lineRects[0]!.pdfPageIndex;
          const onPage = lineRects.filter((r) => r.pdfPageIndex === pageIdx);
          const x0 = Math.min(...onPage.map((r) => r.rect[0]));
          const y0 = Math.min(...onPage.map((r) => r.rect[1]));
          const x1 = Math.max(...onPage.map((r) => r.rect[2]));
          const y1 = Math.max(...onPage.map((r) => r.rect[3]));
          map.push({
            entryIndex: row.entriesIndex + 1,
            coverPageIndex: pageIdx,
            rect: [x0, y0, x1, y1],
            category: row.category,
            categoryLabel: COVER_SECTION_HEADER[row.category],
            label: row.label,
          });
        }
        if (map.length > 0) coverLinkMap = map;
      } else {
        const coverLines = buildCoverIndexLines({
          caseId,
          ...(claimedCondition !== undefined ? { claimedCondition } : {}),
          claimType: caseWithDocs.claimType ?? null,
          framingChoice: caseWithDocs.framingChoice ?? null,
          upstreamScCondition: caseWithDocs.upstreamScCondition ?? null,
          ...(categoryAssertions.length > 0 ? { categoryAssertions } : {}),
          entries: budgetedMetas.map((m) => {
            const pinnedWhyLines = pinnedWhyLinesFor(m);
            return {
              displayLabel: m.entry.displayLabel,
              category: packCategoryOf(m.entry.docType),
              pageRanges: m.entry.pageRanges,
              mentionsClaimedCondition: m.mentionsClaimedCondition,
              ...(pinnedWhyLines.length > 0 ? { pinnedWhyLines } : {}),
            };
          }),
          notIncluded: coverNotIncluded,
        });
        const rendered = await renderRecordTextPdf({
          originalFilename: 'Doctor pack cover index',
          pages: [{ sourcePageNumber: 1, text: coverLines.lines.join('\n') }],
          provenanceHeader: 'DOCTOR PACK — COVER INDEX',
          omitSourceFooters: true,
        });
        const coverKey = `cases/${caseId}/_rendered/cover-index-v${c.version}.pdf`;
        await uploadRenderedPdf(coverKey, rendered.bytes);
        coverEntry = {
          filePath: coverKey,
          docType: 'cover_index',
          classification: 'high_signal',
          pageRanges: [{ from: 1, to: rendered.pageCount }],
          pageCount: rendered.pageCount,
          displayLabel: 'Cover index',
        };
      }
    } catch (coverErr) {
      console.warn('doctor-pack: could not render the cover index (pack continues):', coverErr);
      renderNotes.push('could not render the cover index');
    }
  }

  const packEntries: LabeledEntry[] = [...(coverEntry !== null ? [coverEntry] : []), ...budgetedMetas.map((m) => m.entry)];
  const packTrimNotes = [...dedupAndBudgetNotes, ...renderNotes];
  const refinedTotalPageCount = packEntries.reduce((sum, e) => sum + e.pageCount, 0);

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
      // ROUND 2 (A): a content-duplicate keeps its KeyDoc row (the RN doc list stays complete)
      // but its rationale says exactly why it is not in the pack.
      const dupKeptPath = dedup.duplicateOf.get(f.filePath);
      const dupSuffix = dupKeptPath !== undefined
        ? `; duplicate of ${displayNameByPath.get(dupKeptPath) ?? dupKeptPath} (identical content) — omitted from the pack`
        : '';
      const rationaleToWrite = (wasTrimmed
        ? `${sel.selection.selectorRationale}; pack_page_budget(${packBudget}) trimmed this file`
        : sel.selection.selectorRationale) + dupSuffix;
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
    // Ryan 2026-06-12 (reversing the round-2 hard gate): a pack with ZERO clinical-category
    // pages STILL generates and enqueues normally — the manifest warning below drives a calm
    // panel notice; nothing is held back.
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
          // DOCTOR_PACK_LINKED_COVER (2026-06-27): the TS→Python link-map (cover rect → assembled
          // page offset). Absent (flag off, or no content rows) ⇒ the assembler skips link/outline
          // stamping ⇒ today's behavior.
          ...(coverLinkMap ? { coverLinkMap } : {}),
          ...(missingClinical ? { warnings: [NO_CLINICAL_DX_WARNING] } : {}),
          // ROUND 2: the budgetTrim block appears whenever ANY Not-included note exists —
          // budget trims, dedup omissions (A), render failures, or the no-lay-statement note (C).
          ...(budget.trimmed || packTrimNotes.length > 0
            ? {
                budgetTrim: {
                  budget: packBudget,
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
          budget: packBudget,
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

    // §1 audit row: a pack with ZERO clinical-dx pages writes the manifest warning + its own
    // audit row (soft signal only — the pack still assembles and delivers).
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
