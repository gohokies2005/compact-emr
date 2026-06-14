import { apiClient, apiGet } from './client';
import type { CaseStatus } from '../types/prisma';

// === D2 dashboard tiles (2026-06-13) — mirrors backend/src/routes/dashboard.ts ===
// One read-only endpoint returns every tile's count PLUS a declarative `filter` contract the
// frontend translates into a deep-link to the filtered list. Keep this shape in lockstep with the
// backend TileFilter / Tile / DashboardResponse types.

export type DashboardTileFilter =
  | { readonly kind: 'cases'; readonly status: CaseStatus }
  | { readonly kind: 'cases'; readonly statuses: readonly CaseStatus[] }
  | { readonly kind: 'cases'; readonly status: CaseStatus; readonly unpaidLetter500OlderThanDays: number }
  | { readonly kind: 'intakes'; readonly createdSince: string }
  | { readonly kind: 'intakes'; readonly status: string; readonly olderThanDays: number }
  | { readonly kind: 'draft-jobs'; readonly stuck: true; readonly startedBeforeMinutes: number; readonly staleHeartbeat: boolean }
  | { readonly kind: 'veterans' };

export interface DashboardTile {
  readonly key: string;
  readonly label: string;
  readonly count?: number;
  // Tile 2 only (the 7-day turnaround): a duration metric, not a list. null when uncomputable.
  readonly value?: number | null;
  readonly unit?: string;
  readonly reason?: string;
  readonly clickable: boolean;
  readonly filter?: DashboardTileFilter;
}

export interface DashboardResponse {
  readonly generatedAt: string;
  readonly timezone: string;
  readonly pacificMidnightUtc: string;
  readonly tiles: readonly DashboardTile[];
}

/** Admin/ops_staff dashboard metrics (GET /api/v1/reports/dashboard). Single source of truth for
 *  the HomePage tiles — replaces the old ~7 client-side listCases counts + browser-tz "today" math. */
export async function getDashboard(): Promise<DashboardResponse> {
  return apiGet<DashboardResponse>('/api/v1/reports/dashboard');
}

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
