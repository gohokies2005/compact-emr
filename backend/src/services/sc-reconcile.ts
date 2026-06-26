// services/sc-reconcile.ts — read-time reconcile of service-connected condition rows.
//
// THE PROBLEM (Ryan 2026-06-20): "PTSD listed as both SC and pending — confusing;
// it truly is SC." Across-run extraction + manual entry can leave two ScCondition
// rows for the SAME condition (e.g. "PTSD" service_connected AND "Posttraumatic
// Stress Disorder" pending), or two synonym rows of the same status. The UI shows
// both; the drafter counts both; the RN can't tell the real status.
//
// THE FIX: collapse rows that refer to the same condition — using the EXISTING
// synonym/qualifier fold (chart-extractor.normalizeName: PTSD ≡ post-traumatic
// stress disorder, OSA ≡ obstructive sleep apnea, etc.) — into ONE row carrying the
// AUTHORITATIVE status. Precedence: service_connected > pending > denied (a grant
// supersedes a stale denial/claim for anchor purposes; NEVER let denied win).
//
// READ-TIME ONLY: this never mutates or deletes DB rows. It is applied where rows
// are SURFACED (the veteran GET that feeds the UI, the drafter bundle, the advisory
// chart slice), so existing cases are fixed INSTANTLY with no re-extraction. The
// underlying rows stay as provenance.

import { normalizeName } from './chart-extractor.js';

// Authoritative-status precedence. Higher wins. An unknown/null status ranks 0.
const STATUS_RANK: Record<string, number> = {
  service_connected: 3,
  pending: 2,
  denied: 1,
};

function statusRank(status: unknown): number {
  return typeof status === 'string' ? (STATUS_RANK[status] ?? 0) : 0;
}

function ratingValue(pct: unknown): number {
  return typeof pct === 'number' && Number.isFinite(pct) ? pct : -1;
}

export interface ReconcilableSc {
  readonly condition: string;
  readonly status?: string | null;
  readonly ratingPct?: number | null;
  readonly dcCode?: string | null;
  readonly needsReview?: boolean | null;
  // SC-provenance (Woodley fix): carried through the generic spread so the keystone anchor gate
  // (buildGrantedScAnchors → effectiveScStatus) sees whether a 'service_connected' row came from an
  // authoritative VA decision. Optional — legacy/untyped callers compile unchanged.
  readonly source?: string | null;
  readonly scStatusAuthoritative?: boolean | null;
  readonly sourceAuthorityTier?: string | null;
}

// The winner carries a statusConflict flag when its group mixed service_connected
// with denied — because there is NO `severed` status (ScConditionStatus is only
// service_connected|pending|denied), a granted-then-SEVERED condition is modeled as
// `denied`, and blindly preferring service_connected would silently RESURRECT a
// severed grant on a medico-legal letter. We still surface the SC row (Ryan: "it
// truly IS SC" is the common case — a pending/denied dup of a real grant), but the
// flag lets the UI/drafter say "conflicting status on file — verify" instead of
// hiding the contradiction. (QA finding, anthropic + architect, 2026-06-20.)
export type ReconciledSc<T> = T & { readonly statusConflict?: boolean };

// Pick the surviving row for a group of same-condition rows. Order of tie-breaks:
//   1. highest authoritative status (service_connected > pending > denied > unknown)
//   2. a row WITH a rating % beats one without; higher % wins (more complete grant)
//   3. the longer display name (prefer "Posttraumatic Stress Disorder" over "PTSD")
//   4. stable: keep the earlier row
function pickWinner<T extends ReconcilableSc>(a: T, b: T): T {
  const sr = statusRank(b.status) - statusRank(a.status);
  if (sr !== 0) return sr > 0 ? b : a;
  const rr = ratingValue(b.ratingPct) - ratingValue(a.ratingPct);
  if (rr !== 0) return rr > 0 ? b : a;
  const nl = (b.condition?.length ?? 0) - (a.condition?.length ?? 0);
  if (nl > 0) return b;
  return a;
}

// Stable group key: normalizeName already lowercases + collapses whitespace (incl.
// NBSP via \s) + strips qualifier suffixes + folds synonyms; NFKC first neutralizes
// compatibility/fullwidth forms so visually-identical glyphs key together.
function groupKey(condition: string): string {
  return normalizeName(condition.normalize('NFKC'));
}

/**
 * Collapse same-condition rows to one authoritative row. Pure; preserves the order
 * of first appearance. Rows with no resolvable condition string pass through untouched.
 * The surviving row is best-fields-merged within its group: it keeps the authoritative
 * status (pickWinner), inherits a dcCode if it lacked one, carries needsReview if ANY
 * group member needed review (never silently drop a review flag), and is flagged
 * statusConflict when the group mixed service_connected with denied (see ReconciledSc).
 */
export function reconcileScConditions<T extends ReconcilableSc>(rows: readonly T[]): Array<ReconciledSc<T>> {
  if (!Array.isArray(rows)) return [];
  // Collect members per group, preserving first-appearance order.
  const membersByKey = new Map<string, T[]>();
  const orderByKey = new Map<string, number>();
  const passthrough: Array<{ idx: number; row: ReconciledSc<T> }> = [];
  let order = 0;
  for (const row of rows) {
    const name = typeof row?.condition === 'string' ? row.condition.trim() : '';
    if (!name) { passthrough.push({ idx: order++, row }); continue; }
    const key = groupKey(name);
    if (!membersByKey.has(key)) { membersByKey.set(key, [row]); orderByKey.set(key, order++); }
    else { membersByKey.get(key)!.push(row); }
  }
  const out: Array<{ idx: number; row: ReconciledSc<T> }> = passthrough.slice();
  for (const [key, members] of membersByKey) {
    const winner = members.reduce((a, b) => pickWinner(a, b));
    if (members.length === 1) { out.push({ idx: orderByKey.get(key)!, row: winner }); continue; }
    const dcCode = winner.dcCode ?? members.find((m) => m.dcCode)?.dcCode ?? null;
    const needsReview = members.some((m) => m.needsReview === true) || undefined;
    const hasConflict = members.some((m) => m.status === 'service_connected') && members.some((m) => m.status === 'denied');
    const merged: ReconciledSc<T> = {
      ...winner,
      ...(winner.dcCode == null && dcCode != null ? { dcCode } : {}),
      ...(needsReview && winner.needsReview !== true ? { needsReview: true } : {}),
      ...(hasConflict ? { statusConflict: true } : {}),
    };
    out.push({ idx: orderByKey.get(key)!, row: merged });
  }
  return out.sort((x, y) => x.idx - y.idx).map((e) => e.row);
}
