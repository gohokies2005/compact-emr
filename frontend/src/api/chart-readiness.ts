import { apiGet } from './client';

export type FileReadTerminalStatus = 'read' | 'manual_summary_required' | 'manual_summary_provided';

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

export interface ChartReadinessResult {
  readonly ready: boolean;
  readonly blockingFiles?: readonly ChartReadinessBlockingFile[];
  readonly blockers?: readonly ChartReadinessBlockingFile[];
  readonly reason?: string | null;
}

export async function getChartReadiness(caseId: string): Promise<{ data: ChartReadinessResult }> {
  return apiGet(`/api/v1/cases/${encodeURIComponent(caseId)}/chart-readiness`);
}
