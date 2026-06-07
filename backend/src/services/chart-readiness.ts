import type { FileReadStatusRecord, FileTerminalStatus } from './db-types.js';

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

const MIN_WORDS_FOR_READ = 40;
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
}

export interface ReadAttemptOutcome {
  readonly succeeded: boolean;
  readonly wordCount: number;
  readonly corruptedTokenRatio: number;
  readonly reason: string | null;
}

/**
 * Decide whether a read attempt produced usable text. The threshold contract:
 *   - wordCount >= 40 (MIN_WORDS_FOR_READ), AND
 *   - corruptedTokenRatio <= 0.08 (GARBLED_RATIO_THRESHOLD)
 *
 * Returns succeeded=true with reason=null when both hold; otherwise succeeded=false with a
 * human-readable reason that the worker can log + surface to the RN UI.
 */
export function classifyReadAttempt(input: ReadAttemptInput): ReadAttemptOutcome {
  const wc = wordCount(input.extractedText);
  const ratio = corruptedTokenRatio(input.extractedText);

  if (wc < MIN_WORDS_FOR_READ) {
    return { succeeded: false, wordCount: wc, corruptedTokenRatio: ratio, reason: `too-few-words (${wc} < ${MIN_WORDS_FOR_READ})` };
  }
  if (ratio > GARBLED_RATIO_THRESHOLD) {
    return { succeeded: false, wordCount: wc, corruptedTokenRatio: ratio, reason: `garbled (corrupted-token-ratio=${ratio.toFixed(3)} > ${GARBLED_RATIO_THRESHOLD})` };
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
  readonly lastAttempt: { method: string; wordCount: number; corruptedTokenRatio: number; note: string | null } | null;
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

export function evaluateChartReadiness(rows: readonly FileReadStatusRecord[]): ChartReadinessResult {
  const blockers: ChartReadinessBlocker[] = [];
  let read = 0;
  let required = 0;
  let provided = 0;

  for (const row of rows) {
    // The Intake Summary is a doc WE generate from the form answers — always valid (a sparse intake
    // yields a short PDF that trips the <40-word read threshold). It must never block drafting or
    // send an RN to manual review. Match the GENERATED key precisely (it's minted as
    // `cases/<id>/<uuid>-Intake_Summary.pdf`, so the key ends with '-Intake_Summary.pdf') — NOT a
    // loose substring, so a real uploaded "Nursing Intake Summary" record is never masked. (QA #5.)
    if (isIntakeSummaryPath(row.filePath)) {
      read++;
      continue;
    }
    if (row.terminalStatus === 'read') {
      read++;
    } else if (row.terminalStatus === 'manual_summary_provided') {
      // Defense-in-depth: if status claims provided but summary is missing / too short, treat as required.
      if (isValidManualSummary(row.manualSummary)) {
        provided++;
      } else {
        required++;
        blockers.push({
          fileReadStatusId: row.id,
          filePath: row.filePath,
          terminalStatus: 'manual_summary_required',
          lastAttempt: lastAttemptOf(row),
        });
      }
    } else {
      required++;
      blockers.push({
        fileReadStatusId: row.id,
        filePath: row.filePath,
        terminalStatus: row.terminalStatus,
        lastAttempt: lastAttemptOf(row),
      });
    }
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
  };
}

export const CHART_READINESS_GATE_VERSION = READINESS_GATE_VERSION;
