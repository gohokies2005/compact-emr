import { apiDelete, apiGet, apiPatch, apiPost } from './client';

export interface ChartNote {
  readonly id: string;
  readonly veteranId: string;
  readonly body: string;
  readonly createdBy: string;
  /** Quick note = a flagged entry in this same stream (Ryan 2026-06-21). false = ordinary staff note. */
  readonly isQuickNote: boolean;
  /** Resolved author display name (AppUser name/email); falls back to createdBy. (Ryan 2026-06-20) */
  readonly createdByName?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export async function listChartNotes(veteranId: string): Promise<{ data: readonly ChartNote[] }> {
  return apiGet(`/api/v1/veterans/${encodeURIComponent(veteranId)}/chart-notes`);
}
/** Most-recent quick note for a veteran (dashboard / case Overview), or null. (Ryan 2026-06-21) */
export async function getLatestQuickNote(veteranId: string): Promise<{ data: ChartNote | null }> {
  return apiGet(`/api/v1/veterans/${encodeURIComponent(veteranId)}/chart-notes/latest-quick`);
}
export async function createChartNote(veteranId: string, body: string, isQuickNote = false): Promise<{ data: ChartNote }> {
  return apiPost(`/api/v1/veterans/${encodeURIComponent(veteranId)}/chart-notes`, { body, isQuickNote });
}
export async function patchChartNote(id: string, input: { version: number; body: string }): Promise<{ data: ChartNote }> {
  return apiPatch(`/api/v1/chart-notes/${encodeURIComponent(id)}`, input);
}
export async function deleteChartNote(id: string): Promise<void> {
  return apiDelete(`/api/v1/chart-notes/${encodeURIComponent(id)}`);
}
