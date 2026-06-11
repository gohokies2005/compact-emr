import { apiGet, apiPatch } from './client';

/**
 * Doctor-pay API client (Track pay tab). Thin fetch wrappers over routes/pay.ts — all earnings
 * math is server-side; money crosses the wire as integer CENTS (format with formatCents, never
 * float-math in the UI).
 */

export interface PayRow {
  readonly caseId: string;
  readonly veteranName: string;
  readonly condition: string;
  readonly letterType: string;
  readonly payCents: number;
  readonly payUsd: number;
  readonly monthPT: string;
  readonly firstApprovedAt: string;
}

export interface PayReport {
  readonly physicianId?: string;
  /** 'YYYY-MM' (Pacific) or 'all'. */
  readonly month: string;
  readonly rows: readonly PayRow[];
  readonly totalCents: number;
  readonly totalUsd: number;
  readonly availableMonths: readonly string[];
}

/** Own earnings — identity always derives from the caller's JWT server-side (self-only). */
export async function getMyPay(month: string): Promise<PayReport> {
  const res = await apiGet<{ data: PayReport }>(`/api/v1/pay/me?month=${encodeURIComponent(month)}`);
  return res.data;
}

/** Month-dropdown source: every PT month since employment start, descending ('All' is UI-side). */
export async function getMyPayMonths(): Promise<readonly string[]> {
  const res = await apiGet<{ data: { months: readonly string[] } }>('/api/v1/pay/months/me');
  return res.data.months;
}

/** Admin-only: any physician's earnings (future Compensation surface). */
export async function getPhysicianPay(physicianId: string, month: string): Promise<PayReport> {
  const res = await apiGet<{ data: PayReport }>(
    `/api/v1/pay/physician/${encodeURIComponent(physicianId)}?month=${encodeURIComponent(month)}`,
  );
  return res.data;
}

/** Admin-only memo tag: re-type one approved_final revision (the v1 memo flow). */
export async function setLetterRevisionType(
  revisionId: string,
  letterType: 'nexus_letter' | 'nexus_memo',
): Promise<{ id: string; letterType: string; payCents: number }> {
  const res = await apiPatch<{ data: { id: string; letterType: string; payCents: number } }>(
    `/api/v1/letter-revisions/${encodeURIComponent(revisionId)}/type`,
    { letterType },
  );
  return res.data;
}
