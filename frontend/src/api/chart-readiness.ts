import { apiGet } from './client';

export type FileReadTerminalStatus = 'read' | 'manual_summary_required' | 'manual_summary_provided';

export interface ChartReadinessBlockingFile {
  readonly id?: string;
  readonly caseId?: string;
  readonly filePath: string;
  readonly terminalStatus: FileReadTerminalStatus;
  readonly manualSummary?: string | null;
  readonly lastCheckedAt?: string | null;
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
