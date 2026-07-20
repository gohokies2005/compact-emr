/**
 * Non-destructive merge plan for auto-extracted chart items. PURE — the merge endpoint applies the
 * plan in a transaction; this decides insert-vs-skip.
 *
 * Rules (Ryan 2026-06-03 — "without messing it up"):
 *   - A row the RN entered by hand (source='manual') is IMMUTABLE: never overwritten, never
 *     duplicated. If an extracted item matches a manual row by normalized name, it's skipped.
 *   - A row from a prior extraction (source='extracted') is not clobbered either — skip on match.
 *   - Otherwise insert as a new 'extracted' row with full provenance.
 *   - Dedup within the incoming set on (category, normalizeName) so the same condition from two
 *     documents lands once.
 */

import { chartDedupKey, type ExtractCategory } from './chart-extractor.js';
import type { FinalExtractedItem } from './chart-extract-llm.js';
import { statusRank } from './sc-reconcile.js';
import { scStatusAuthoritativeFor, type ScAuthorityTier } from './sc-authority.js';

export interface ExistingChartRow {
  category: ExtractCategory;
  /** condition / problem / drugName as stored. */
  name: string;
  /** 'manual' | 'extracted' */
  source: string;
  /** row primary key — carried so the merge can target an UPDATE (upgrade-on-merge promotion). */
  id?: string;
  /** SC benefit status ('service_connected' | 'pending' | 'denied'). Load-bearing for the promotion gate. */
  status?: string | null;
  // Medication temporality (full-read). Carried so the dedup key matches the EXTRACTED key: a manual
  // "active escitalopram" blocks an extracted active escitalopram, but NOT an extracted historical
  // 2015 occurrence (different key) — so the treatment history is additive, never clobbering.
  medStatus?: string | null;
  startDate?: string | null;
  lastSeenDate?: string | null;
}

/**
 * An upgrade-on-merge promotion (continuation-grant fix, 2026-07-19). A prior EXTRACTED row that is
 * `pending` is PROMOTED (an UPDATE, not a skip) to `service_connected` when a later authoritative
 * rating-decision grant lands for the same condition — otherwise the stale pending persists forever
 * (the bronchitis incident: extracted pending, later granted, the grant row was skipped). `target` is
 * the existing row to update (carries its `id`); `incoming` is the authoritative grant that supplies the
 * new status/ratingPct/provenance.
 */
export interface MergePromotion {
  target: ExistingChartRow;
  incoming: FinalExtractedItem;
}

export interface MergePlan {
  toInsert: FinalExtractedItem[];
  /** Prior-extracted `pending` rows to PROMOTE to `service_connected` (monotonic UP only). */
  toPromote: MergePromotion[];
  skippedManual: number;
  skippedPriorExtracted: number;
  skippedDuplicate: number;
}

// Upgrade-on-merge gate (continuation-grant fix). A prior-extracted row is PROMOTED — not skipped — only
// when ALL hold: (1) the existing row is source='extracted' (NEVER manual — RN values are immutable),
// (2) the existing SC status is `pending`, (3) the incoming row proposes `service_connected` from an
// AUTHORITATIVE rating-decision/benefit-summary source (scStatusAuthoritative bit OR an authoritative
// sourceAuthorityTier stamped by chart-merge-apply), and (4) it is strictly MONOTONIC UP by the shared
// STATUS_RANK (service_connected 3 > pending 2). Reuses sc-reconcile.statusRank + sc-authority — no second
// ranking, never a demotion.
function isAuthoritativeScGrant(it: FinalExtractedItem): boolean {
  if (it.category !== 'sc_condition' || it.status !== 'service_connected') return false;
  if (it.scStatusAuthoritative === true) return true;
  return it.sourceAuthorityTier != null && scStatusAuthoritativeFor(it.sourceAuthorityTier as ScAuthorityTier);
}
function shouldPromote(existing: ExistingChartRow, incoming: FinalExtractedItem): boolean {
  if (existing.category !== 'sc_condition' || existing.source === 'manual') return false;
  if (existing.status !== 'pending') return false;              // only a pending row is promotable
  if (!isAuthoritativeScGrant(incoming)) return false;          // authoritative rating-decision grant only
  return statusRank(incoming.status) > statusRank(existing.status); // monotonic UP (never demote)
}

// TEST-LOCK (keystone pkg 6): the dedup correctness of this merge lives in normalizeName
// (chart-extractor.ts) — qualifier stripping, parenthetical-abbrev stripping, and the synonym
// fold all happen THERE, surfaced via the shared chartDedupKey. planMerge only keys on it. Extend
// canonicalization in normalizeName, never by adding a second normalization here
// (chart-extractor.test.ts + chart-merge.test.ts lock the contract: manual rows always win; no
// insert whose canonical key matches an existing row of the same category; within-run duplicates
// collapse). Meds additionally key on medStatus + start/last-seen year (chartDedupKey).

export function planMerge(existing: readonly ExistingChartRow[], extracted: readonly FinalExtractedItem[]): MergePlan {
  const existingByKey = new Map<string, ExistingChartRow>();
  for (const e of existing) existingByKey.set(chartDedupKey(e), e);

  const toInsert: FinalExtractedItem[] = [];
  const toPromote: MergePromotion[] = [];
  const seen = new Set<string>();
  let skippedManual = 0;
  let skippedPriorExtracted = 0;
  let skippedDuplicate = 0;

  for (const it of extracted) {
    const k = chartDedupKey(it);
    if (seen.has(k)) { skippedDuplicate++; continue; }
    seen.add(k);

    const existingRow = existingByKey.get(k);
    if (existingRow === undefined) { toInsert.push(it); continue; }
    if (existingRow.source === 'manual') { skippedManual++; continue; } // manual is IMMUTABLE
    // UPGRADE-ON-MERGE: an authoritative rating-decision grant PROMOTES a prior-extracted pending row
    // (UPDATE, not skip) so a later grant doesn't leave a stale pending. Monotonic up only (shouldPromote).
    if (shouldPromote(existingRow, it)) { toPromote.push({ target: existingRow, incoming: it }); continue; }
    skippedPriorExtracted++; // 'extracted' or any other — don't clobber
  }

  return { toInsert, toPromote, skippedManual, skippedPriorExtracted, skippedDuplicate };
}
