import { apiDelete, apiGet, apiPatch, apiPost } from './client';

export interface ChartNote {
  readonly id: string;
  readonly veteranId: string;
  readonly body: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export async function listChartNotes(veteranId: string): Promise<{ data: readonly ChartNote[] }> {
  return apiGet(`/api/v1/veterans/${encodeURIComponent(veteranId)}/chart-notes`);
}
export async function createChartNote(veteranId: string, body: string): Promise<{ data: ChartNote }> {
  return apiPost(`/api/v1/veterans/${encodeURIComponent(veteranId)}/chart-notes`, { body });
}
export async function patchChartNote(id: string, input: { version: number; body: string }): Promise<{ data: ChartNote }> {
  return apiPatch(`/api/v1/chart-notes/${encodeURIComponent(id)}`, input);
}
export async function deleteChartNote(id: string): Promise<void> {
  return apiDelete(`/api/v1/chart-notes/${encodeURIComponent(id)}`);
}
