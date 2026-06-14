import { apiGet } from './client';

// 'auto_skipped' (document auto-recovery loop, 2026-06-14): a genuinely empty/invalid file the system
// auto-skipped — NON-BLOCKING, so it never appears in blockingFiles; included for type parity with the
// backend FileTerminalStatus.
export type FileReadTerminalStatus = 'read' | 'manual_summary_required' | 'manual_summary_provided' | 'auto_skipped';

export interface ChartReadinessBlockingFile {
  readonly id?: string;
  // The FileReadStatus row id (the backend evaluator always sends it) — the target for
  // POST /cases/:id/files/:fileReadStatusId/manual-summary, so the blocking-file alert can host
  // the manual-summary form inline instead of sending the RN hunting through Documents.
  readonly fileReadStatusId?: string;
  readonly caseId?: string;
  readonly filePath: string;
  readonly terminalStatus: FileReadTerminalStatus;
  readonly manualSummary?: string | null;
  readonly lastCheckedAt?: string | null;
  // Joined by GET /chart-readiness from the Document row (s3Key match) — the id to open the file with.
  readonly documentId?: string | null;
  // The most recent read attempt — note carries the WHY (e.g. "too-few-words (37 < 40)") so the UI
  // can give class-specific guidance instead of generic "re-upload / re-run OCR" advice.
  readonly lastAttempt?: {
    readonly method: string;
    readonly wordCount: number;
    readonly corruptedTokenRatio: number;
    readonly note: string | null;
  } | null;
}

export type ChartExtractionState = 'no_documents' | 'ocr_in_progress' | 'extracting' | 'chart_ready' | 'extract_failed';

export interface ChartReadinessResult {
  readonly ready: boolean;
  readonly blockingFiles?: readonly ChartReadinessBlockingFile[];
  readonly blockers?: readonly ChartReadinessBlockingFile[];
  readonly reason?: string | null;
  // Where the chart-build pipeline is. `ready` reflects OCR/file-read only; this reflects the
  // EXTRACTION phase (the full-read chunker, minutes long). Draft must wait for 'chart_ready'.
  // Optional: an older backend omits it → the UI treats absence as "not blocking" (fail-open).
  readonly extractionState?: ChartExtractionState;
  // Present (non-null) only when the run finished 'complete_with_gaps' — extractionState is still
  // 'chart_ready' (the door opens) but some pages went unread/truncated, surfaced here so the RN sees
  // exactly how much of the chart is incomplete instead of trusting a silent "complete". (audit 2026-06-13)
  readonly extractionGaps?: { readonly truncatedWindows: number; readonly uncoveredPages: number } | null;
  // AUTO-RECOVERY EXHAUSTION (document auto-recovery loop FIX 3, 2026-06-14): TRUE only when the
  // bounded auto-remediate has already run for the CURRENT doc-set and the chart is STILL blocked
  // (settled, real blockers remain). The last-resort ChartRecoveryBanner gates on this so it appears
  // only when a human is genuinely the last resort — NOT during a normal preparing/extracting cycle.
  // Optional: an older backend omits it → the UI treats absence as "not exhausted" (fail-safe: no nag).
  readonly autoRecoveryExhausted?: boolean;
}

export async function getChartReadiness(caseId: string): Promise<{ data: ChartReadinessResult }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/chart-readiness`);
}
