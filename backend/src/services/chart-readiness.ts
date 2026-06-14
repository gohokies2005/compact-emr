import type { AppDbTransaction, FileReadStatusRecord, FileTerminalStatus } from './db-types.js';

/**
 * Chart-readiness gate — Phase 5.2 OCR HARD-STOP enforcement.
 *
 * Per Ryan's HARD RULE: every uploaded file MUST be read. If neither native PDF extract nor
 * Tesseract nor Claude vision can read it, the file's terminalStatus terminates at
 * 'manual_summary_required' and downstream consumers (viability gate, sign-off, draft worker)
 * HALT until an RN writes a manual_summary >= 40 chars (flipping terminalStatus to
 * 'manual_summary_provided').
 *
 * There is no skip flag. There is no admin override. The only two ready states are:
 *   1. 'read'                       — a machine successfully extracted text
 *   2. 'manual_summary_provided'    — an RN read the file and wrote a summary
 *
 * Ported (concept) from FRN `app/services/chartCompleteness.js` (commit 3ddb9d5). Algorithm
 * details below match the FRN calibration (corrupted-token-ratio > 0.08 = garbled).
 */

// ====================== Corrupted-token-ratio detector ======================

// 40 → 20 (Ryan 2026-06-11): a legible 37-word image (Thomas_OSA_Misc_3.png) blocked drafting —
// "thats a stupid fail." 20 words still screens out empty photos/fax covers while letting short
// real documents through. NOTE: terminalStatus is written ONCE at classification time, so the
// retroactive reconciliation in evaluateChartReadiness (below) is what heals rows classified
// under the old threshold — lowering this constant alone would not.
const MIN_WORDS_FOR_READ = 20;
const GARBLED_RATIO_THRESHOLD = 0.08;
const MANUAL_SUMMARY_MIN_LENGTH = 40;

const CLEAN_CODE_PATTERN = /^(?:[A-Z]\d{1,2}(?:[.-]\d{1,3}[A-Z]?){0,3}|L\d-L\d|S\d-S\d|T\d{1,2}-T\d{1,2}|C\d-C\d)$/;
const TOKEN_SPLIT = /[\s,;:()[\]{}!?"'`]+/;
const LETTER_BEARING = /[A-Za-z]/;
const EMBEDDED_SYMBOL_IN_LETTERS = /(?:[A-Za-z][^A-Za-z0-9\s][A-Za-z])|(?:[A-Za-z][0-9\W]+[A-Za-z][0-9\W]+[A-Za-z])/;

/**
 * Compute the corrupted-token ratio for an OCR'd / extracted text payload.
 *
 * Definition (from FRN calibration):
 *   - Tokenize on whitespace + common punctuation.
 *   - Letter-bearing token = contains at least one A-Z or a-z character.
 *   - Skip tokens matching the CLEAN_CODE_PATTERN (e.g. "L4-L5", "M47.817", "T2DM") — these
 *     look corrupted to a naive regex but are valid medical / coding tokens.
 *   - A token is "corrupted" if it contains a non-alphanumeric symbol embedded between
 *     letters, OR multiple letter/digit/symbol transitions (the classic OCR-garbled signature).
 *   - Return corrupted / total letter-bearing tokens. 0 when no letter tokens are present.
 *
 * Calibrated to keep clean docs (audiograms, rating decisions, CPT/lab tables) below 0.02,
 * and garbled scans above 0.14. The 0.08 threshold sits in the empirical gap.
 */
export function corruptedTokenRatio(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const tokens = text.split(TOKEN_SPLIT).filter((t) => t.length > 0);
  let total = 0;
  let corrupted = 0;
  for (const tok of tokens) {
    if (!LETTER_BEARING.test(tok)) continue;
    if (CLEAN_CODE_PATTERN.test(tok)) continue;
    total++;
    if (EMBEDDED_SYMBOL_IN_LETTERS.test(tok)) corrupted++;
  }
  return total === 0 ? 0 : corrupted / total;
}

/**
 * Heuristic word count for read-success detection. Native PDF extract for a typical 1-page
 * medical record sits at 200-800 words; garbled scans usually < 30 (Tesseract gives up).
 */
export function wordCount(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return text.split(/\s+/).filter((t) => t.length > 0).length;
}

// ====================== Read-attempt classifier ======================

export interface ReadAttemptInput {
  readonly method: 'native_pdf_text' | 'tesseract_ocr' | 'textract' | 'bedrock_data_automation' | 'claude_vision';
  readonly extractedText: string;
  // Document page count (when known). The word-count floor is SIZE-AWARE: a legitimately small file
  // (a 1-page note that just says "CPAP") is VALID and must NOT block the case as "incomplete". Only a
  // SUBSTANTIAL file (>=2 pages) that yields almost no text is the real "OCR choked on a big scan"
  // signal. null/unknown → treat as substantial (require the full word floor — conservative, no
  // regression). (Ryan 2026-06-13: "some files are small … that little detail would hold us all up.")
  readonly pageCount?: number | null;
}

export interface ReadAttemptOutcome {
  readonly succeeded: boolean;
  readonly wordCount: number;
  readonly corruptedTokenRatio: number;
  readonly reason: string | null;
}

/**
 * Decide whether a read attempt produced usable text. The threshold contract:
 *   - wordCount >= MIN_WORDS_FOR_READ (20), AND
 *   - corruptedTokenRatio <= 0.08 (GARBLED_RATIO_THRESHOLD)
 *
 * Returns succeeded=true with reason=null when both hold; otherwise succeeded=false with a
 * human-readable reason that the worker can log + surface to the RN UI.
 */
export function classifyReadAttempt(input: ReadAttemptInput): ReadAttemptOutcome {
  const wc = wordCount(input.extractedText);
  const ratio = corruptedTokenRatio(input.extractedText);
  const pageCount = input.pageCount ?? null;

  // Garbled text is OCR corruption, not brevity — never acceptable at any size (the worker re-reads it
  // via Claude vision upstream).
  if (ratio > GARBLED_RATIO_THRESHOLD) {
    return { succeeded: false, wordCount: wc, corruptedTokenRatio: ratio, reason: `garbled (corrupted-token-ratio=${ratio.toFixed(3)} > ${GARBLED_RATIO_THRESHOLD})` };
  }
  // An EMPTY read (0 words) is NEVER a "valid small file" — it's a failed read (e.g. a scanned 1-page
  // DD-214 OCR couldn't see). Flag it so Claude/RN handle it; never silently accept a blank.
  if (wc === 0) {
    return { succeeded: false, wordCount: wc, corruptedTokenRatio: ratio, reason: 'empty (0 words)' };
  }
  // SIZE-AWARE word floor (Ryan 2026-06-13): a legitimately small file — a 1-page note that just says
  // "CPAP" — is VALID and must NOT block the case as "incomplete". Only a SUBSTANTIAL file (>=2 pages,
  // or unknown size) that STILL has <20 words after the upstream Claude re-read is the genuine
  // "unreadable big scan" → flag for the RN. A <=1-page file with any non-garbled text → accept.
  if (pageCount !== null && pageCount <= 1) {
    return { succeeded: true, wordCount: wc, corruptedTokenRatio: ratio, reason: null };
  }
  if (wc < MIN_WORDS_FOR_READ) {
    return { succeeded: false, wordCount: wc, corruptedTokenRatio: ratio, reason: `too-few-words (${wc} < ${MIN_WORDS_FOR_READ}) for a ${pageCount ?? 'multi'}-page file` };
  }
  return { succeeded: true, wordCount: wc, corruptedTokenRatio: ratio, reason: null };
}

// ====================== Manual-summary validation ======================

export function isValidManualSummary(summary: unknown): summary is string {
  if (typeof summary !== 'string') return false;
  return summary.trim().length >= MANUAL_SUMMARY_MIN_LENGTH;
}

export const MANUAL_SUMMARY_MIN_LEN = MANUAL_SUMMARY_MIN_LENGTH;
export const READ_THRESHOLD_RATIO = GARBLED_RATIO_THRESHOLD;
export const READ_THRESHOLD_WORDS = MIN_WORDS_FOR_READ;

// ====================== Chart-readiness aggregator ======================

export interface ChartReadinessBlocker {
  readonly fileReadStatusId: string;
  readonly filePath: string;
  readonly terminalStatus: FileTerminalStatus;
  readonly lastAttempt: { method: string; wordCount: number; corruptedTokenRatio: number; note: string | null; pageCount?: number | null } | null;
  // The chart Document row matching this file (joined on s3Key by the route) — lets the UI render the
  // blocking file as a clickable link (presigned view), not a dead name. Optional: the pure evaluator
  // has no DB access; the GET /chart-readiness route enriches it. (CLM-BBFCB3F8CE fix 5, 2026-06-11.)
  readonly documentId?: string | null;
}

export interface ChartReadinessResult {
  readonly ready: boolean;
  readonly totalFiles: number;
  readonly readFiles: number;
  readonly manualSummaryRequired: number;
  readonly manualSummaryProvided: number;
  readonly blockingFiles: readonly ChartReadinessBlocker[];
  readonly checkedAt: string;
  readonly gateVersion: string;
}

const READINESS_GATE_VERSION = 'chart-readiness-1.0.0';

/**
 * Aggregate file-read-status rows for a case into a single readiness verdict.
 *
 * ready=true ONLY when every row has terminalStatus IN ('read', 'manual_summary_provided').
 * Any row with 'manual_summary_required' (or missing summary on what claims to be provided)
 * blocks. Empty file set = ready (no files to read yet — that's a chart-empty problem,
 * separate from the OCR gate).
 */
// A generated intake-summary PDF (minted as cases/<id>/<uuid>-Intake_Summary.pdf, and the legacy
// <uuid>-<Last>_Intake_Summary.pdf form) — always valid, never blocks the gate. Anchored to end-of-string
// on the underscore form so a real uploaded "Nursing Intake Summary.pdf" (space) is NOT masked. (QA 2026-06-07
// — the legacy lastname-embedded form slipped past the old `-intake_summary` regex and blocked Yorde forever.)
export function isIntakeSummaryPath(filePath: unknown): boolean {
  return typeof filePath === 'string' && /intake_summary\.pdf$/i.test(filePath);
}

/**
 * Retroactive threshold reconciliation (Ryan 2026-06-11, MIN_WORDS_FOR_READ 40 → 20).
 *
 * terminalStatus is written ONCE, at classification time (POST /files/read-attempts →
 * classifyReadAttempt). Rows classified under the OLD threshold therefore sit at
 * 'manual_summary_required' forever even though their stored attempt stats would pass today —
 * lowering the constant does nothing for them on its own. Re-judge the LAST attempt's stored
 * wordCount/corruptedTokenRatio against the CURRENT thresholds at evaluation time: if it would
 * succeed now, the row is treated as 'read'. Existing victims (Thomas_OSA_Misc_3.png, 37 words)
 * self-heal without re-OCR, and because every consumer (drafter gate, sign-off, viability,
 * letter approve, doctor pack, GET /chart-readiness) derives readiness through this evaluator,
 * the heal applies everywhere with no DB write or migration.
 */
function lastAttemptPassesCurrentThresholds(row: FileReadStatusRecord): boolean {
  const last = lastAttemptOf(row);
  if (last === null) return false;
  if (typeof last.wordCount !== 'number' || typeof last.corruptedTokenRatio !== 'number') return false;
  if (last.corruptedTokenRatio > GARBLED_RATIO_THRESHOLD) return false;
  if (last.wordCount === 0) return false;
  // Mirror classifyReadAttempt's SIZE-AWARE floor so an already-stored small-file attempt self-heals (a
  // 1-page "CPAP" note classified manual_summary_required under the bare 20-word floor). pageCount absent
  // on pre-2026-06-13 attempts → treated as substantial (require the 20-word floor; no regression).
  const pageCount = typeof last.pageCount === 'number' ? last.pageCount : null;
  if (pageCount !== null && pageCount <= 1) return true;
  return last.wordCount >= MIN_WORDS_FOR_READ;
}

/**
 * Shared row-level readiness predicate — Package 1 (H), 2026-06-11.
 *
 * TRUE when a file-read-status row needs NO RN attention under CURRENT thresholds, i.e. it is
 * effectively read by any of the four branches:
 *   1. A generated intake-summary PDF (a doc WE generate from the form answers — always valid; a
 *      sparse intake yields a short PDF that trips the word threshold; it must never block
 *      drafting or send an RN to manual review). Matches the GENERATED key precisely (minted as
 *      `cases/<id>/<uuid>-Intake_Summary.pdf`), NOT a loose substring, so a real uploaded
 *      "Nursing Intake Summary" record is never masked. (QA #5.)
 *   2. terminalStatus 'read' — a machine successfully extracted text.
 *   3. 'manual_summary_provided' with a VALID (>= 40 char) summary — defense-in-depth: a
 *      provided-status row with a missing/short summary does NOT count.
 *   4. The stored LAST attempt passes the CURRENT thresholds — the retroactive 40→20 heal (see
 *      the reconciliation doc comment above): terminalStatus is written once, so old-threshold
 *      rows self-heal at evaluation time with no DB write.
 *
 * This is THE single copy of the branch logic: evaluateChartReadiness CALLS it, and the
 * files-pending-manual queue routes (per-case + cross-case /rn) filter through it so the queue
 * always agrees with the gate. NEVER fork a parallel copy — raw terminalStatus reads that bypass
 * this predicate are exactly the divergence class that made 15/16 queue rows false positives.
 * (Doctor-pack inclusion consolidates onto it in Package 7.)
 */
export function isEffectivelyRead(row: FileReadStatusRecord): boolean {
  // The intake-summary short-circuit applies ONLY when the file actually read OK (terminalStatus
  // 'read'). A veteran-UPLOADED "<Last>_Intake_Summary.pdf" that FAILED OCR (and failed the Claude
  // rescue) terminates at 'manual_summary_required'; masking it here as effectively-read hid it from
  // /chart-readiness, /files-pending-manual and the RN queue while the drafter still refused on it —
  // undraftable + invisible (Jamarious sibling; OCR-worker fix ef153c2 did NOT cover this TS mask).
  // A failed intake-summary must fall through to the normal branches so it surfaces to the RN like
  // any other failed file. A genuinely-read (even sparse) generated summary still passes — via this
  // branch when 'read', or the retroactive-threshold heal below. (consistency sweep fixes, 2026-06-14.)
  if (isIntakeSummaryPath(row.filePath) && row.terminalStatus === 'read') return true;
  if (row.terminalStatus === 'read') return true;
  if (row.terminalStatus === 'manual_summary_provided' && isValidManualSummary(row.manualSummary)) return true;
  return lastAttemptPassesCurrentThresholds(row);
}

export function evaluateChartReadiness(rows: readonly FileReadStatusRecord[]): ChartReadinessResult {
  const blockers: ChartReadinessBlocker[] = [];
  let read = 0;
  let required = 0;
  let provided = 0;

  for (const row of rows) {
    if (isEffectivelyRead(row)) {
      // Count classification (informational): a valid RN summary counts as 'provided'; every other
      // effectively-read branch — intake summary, machine 'read', or the retroactive threshold
      // heal — counts as 'read'. (Intake summaries count as 'read' even when a summary also exists,
      // matching the pre-refactor branch order.)
      if (!isIntakeSummaryPath(row.filePath) && row.terminalStatus === 'manual_summary_provided' && isValidManualSummary(row.manualSummary)) {
        provided++;
      } else {
        read++;
      }
      continue;
    }
    required++;
    blockers.push({
      fileReadStatusId: row.id,
      filePath: row.filePath,
      // A 'manual_summary_provided' row with a missing/short summary still REQUIRES one
      // (defense-in-depth) — surface it as such so the RN UI queues it.
      terminalStatus: row.terminalStatus === 'manual_summary_provided' ? 'manual_summary_required' : row.terminalStatus,
      lastAttempt: lastAttemptOf(row),
    });
  }

  return {
    ready: blockers.length === 0,
    totalFiles: rows.length,
    readFiles: read,
    manualSummaryRequired: required,
    manualSummaryProvided: provided,
    blockingFiles: blockers,
    checkedAt: new Date().toISOString(),
    gateVersion: READINESS_GATE_VERSION,
  };
}

/**
 * THE shared reconciled-readiness loader (CLM-4DACAF4A80, 2026-06-14).
 *
 * Readiness rows (file_read_status) and the chart's document list are SEPARATE tables with NO
 * FK between them. A file_read_status row whose filePath is no longer among the case's documents
 * — a deleted/superseded/legacy file (e.g. an old final-letter PDF that was replaced) — is an
 * ORPHAN: it can never be cleared from the UI (the chart can't even show it) yet, evaluated RAW,
 * it still reports `ready: false` and HARD-BLOCKS sign-off / approve / finalize. Wayne Moseley
 * (CLM-4DACAF4A80) was stuck finalizing a letter whose chart had nothing unread, because a deleted
 * file left an orphaned readiness row.
 *
 * GET /chart-readiness already reconciles (drops orphans → the UI correctly shows "nothing unread")
 * but the four GATE sites (sign-off, approve, finalize-import, approve-blockers advisory) and the
 * two per-case DRAFT gates evaluated RAW rows — so the gate and the UI could DISAGREE. This is the
 * single source of truth that makes that impossible: every readiness GATE derives its verdict from
 * THIS function (or, for the bundle, the inline reconcile that mirrors it exactly), never from a
 * raw `evaluateChartReadiness(findMany(...))`.
 *
 * Reconcile rule (IDENTICAL to the GET /chart-readiness route, chart-readiness.ts the router):
 *   keep a row iff its filePath is a live document key (liveKeys.has) OR it is a generated
 *   intake-summary PDF (isIntakeSummaryPath) — the latter is minted by us, never appears as an
 *   uploaded Document, and must always be allowed to satisfy the gate. Self-healing: deleting the
 *   stale file clears the block with no migration.
 *
 * Accepts a `Pick<AppDbTransaction, 'fileReadStatus' | 'document'>` so it works with the top-level
 * db AND inside an existing `$transaction` (tx) at any gate site, with no extra plumbing.
 */
export async function loadReconciledChartReadiness(
  db: Pick<AppDbTransaction, 'fileReadStatus' | 'document'>,
  caseId: string,
): Promise<ChartReadinessResult> {
  const [rows, docs] = await Promise.all([
    db.fileReadStatus.findMany({ where: { caseId } }),
    db.document.findMany({ where: { caseId }, select: { s3Key: true } }) as Promise<readonly { s3Key: string }[]>,
  ]);
  return reconcileChartReadiness(rows, docs);
}

/**
 * Pure reconcile-then-evaluate, factored out so callers that ALREADY hold the rows + documents
 * (the drafter bundle pulls both veteran-wide in one Promise.all) can reuse the EXACT reconcile
 * logic without a second DB round-trip — and so this single predicate is the one place the
 * "live key OR intake summary" rule lives. `docs` is whatever live-key view the caller has (the
 * loader passes this case's docs; the bundle passes this case's slice of the veteran-wide docs).
 */
export function reconcileChartReadiness(
  rows: readonly FileReadStatusRecord[],
  docs: readonly { s3Key: string }[],
): ChartReadinessResult {
  const liveKeys = new Set(docs.map((d) => d.s3Key));
  const reconciled = rows.filter((r) => liveKeys.has(r.filePath) || isIntakeSummaryPath(r.filePath));
  return evaluateChartReadiness(reconciled);
}

function lastAttemptOf(row: FileReadStatusRecord): ChartReadinessBlocker['lastAttempt'] {
  const attempts = row.attemptsJson;
  if (!Array.isArray(attempts) || attempts.length === 0) return null;
  const last = attempts[attempts.length - 1];
  if (!last) return null;
  return {
    method: last.method,
    wordCount: last.wordCount,
    corruptedTokenRatio: last.corruptedTokenRatio,
    note: last.note,
    pageCount: typeof last.pageCount === 'number' ? last.pageCount : null,
  };
}

export const CHART_READINESS_GATE_VERSION = READINESS_GATE_VERSION;

// ====================== Human filename + descriptive gate message ======================

/**
 * Recover the human filename from an s3Key minted `cases/<caseId>/<uuid>-<OriginalName.ext>`:
 * basename minus the leading uuid- prefix. Falls back to the basename (or the whole path) on
 * legacy/odd keys — never throws. Mirrors the frontend lib/documentFileName helper.
 *
 * Single copy (consistency sweep 2026-06-14): the GET /chart-readiness route, the descriptive
 * gate-message builder, and any future consumer share THIS one — never re-implement the basename
 * regex (a second copy is exactly the second-stale-layer drift class).
 */
export function originalFileName(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  return base.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, '');
}

/**
 * Build the DESCRIPTIVE chart-readiness failure message shared by all three gate sites
 * (POST /sign-off, POST /letter/approve, POST /letter/finalize-import) — the single builder so
 * the three messages can never drift (the recurring second-stale-layer class). Lists each
 * blocking file by its human display name + the machine-read reason (lastAttempt.note, e.g.
 * "too-few-words (22 < 20)" / "empty (0 words)" / "garbled ...") so the physician sees WHICH file
 * and WHY — never the old cryptic "chart-readiness gate failed."
 *
 * `action` tailors the lead verb ("Sign-off" / "Approve" / "Finalize") so each site reads naturally.
 */
export function buildChartNotReadyMessage(
  blockingFiles: readonly ChartReadinessBlocker[],
  action: string,
): string {
  if (blockingFiles.length === 0) {
    // Defensive — callers only invoke this when !ready (>=1 blocker). Keep it honest if misused.
    return `${action} blocked: the chart-readiness gate is failing.`;
  }
  const lines = blockingFiles.map((b) => {
    const name = originalFileName(b.filePath);
    const reason = b.lastAttempt?.note ?? 'could not be machine-read';
    return `• ${name} — ${reason}`;
  });
  const n = blockingFiles.length;
  const noun = n === 1 ? 'file' : 'files';
  return (
    `${action} blocked: ${n} uploaded ${noun} could not be automatically read and ${n === 1 ? 'has' : 'have'} no manual summary:\n` +
    `${lines.join('\n')}\n` +
    `Add a manual summary for each, or — if you have personally reviewed ${n === 1 ? 'this record' : 'these records'} — sign off with the override.`
  );
}
