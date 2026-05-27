import { apiClient, apiGet } from './client';

export interface CostReportRow {
  readonly caseId: string;
  readonly veteranName: string;
  readonly claimedCondition: string;
  readonly status: string;
  readonly draftCount: number;
  readonly costUsd: number;
}

export interface CostReport {
  readonly rows: readonly CostReportRow[];
  readonly totalCostUsd: number;
  readonly from: string;
  readonly to: string;
}

function buildCostQuery(from?: string, to?: string): string {
  const sp = new URLSearchParams();
  if (from) sp.set('from', from);
  if (to) sp.set('to', to);
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

/** Admin-only per-claim drafting cost report (GET /api/v1/reports/costs). */
export async function getCostReport(from?: string, to?: string): Promise<CostReport> {
  return apiGet<CostReport>(`/api/v1/reports/costs${buildCostQuery(from, to)}`);
}

/** Path (relative to the API base) of the CSV export — exported for reference/links. */
export function costReportCsvUrl(from?: string, to?: string): string {
  return `/api/v1/reports/costs.csv${buildCostQuery(from, to)}`;
}

/**
 * Download the cost report CSV through the authenticated apiClient (so the Bearer token rides
 * along via the request interceptor) and trigger a browser download via a Blob. A plain
 * <a download> link can't carry the Authorization header, so we fetch + synthesize the download.
 */
export async function fetchCostCsv(from?: string, to?: string): Promise<void> {
  const response = await apiClient.get(costReportCsvUrl(from, to), { responseType: 'blob' });
  const blob = response.data instanceof Blob ? response.data : new Blob([response.data], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = 'drafting-costs.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
