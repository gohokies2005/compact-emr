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

export interface ExistingChartRow {
  category: ExtractCategory;
  /** condition / problem / drugName as stored. */
  name: string;
  /** 'manual' | 'extracted' */
  source: string;
  // Medication temporality (full-read). Carried so the dedup key matches the EXTRACTED key: a manual
  // "active escitalopram" blocks an extracted active escitalopram, but NOT an extracted historical
  // 2015 occurrence (different key) — so the treatment history is additive, never clobbering.
  medStatus?: string | null;
  startDate?: string | null;
  lastSeenDate?: string | null;
}

export interface MergePlan {
  toInsert: FinalExtractedItem[];
  skippedManual: number;
  skippedPriorExtracted: number;
  skippedDuplicate: number;
}

// TEST-LOCK (keystone pkg 6): the dedup correctness of this merge lives in normalizeName
// (chart-extractor.ts) — qualifier stripping, parenthetical-abbrev stripping, and the synonym
// fold all happen THERE, surfaced via the shared chartDedupKey. planMerge only keys on it. Extend
// canonicalization in normalizeName, never by adding a second normalization here
// (chart-extractor.test.ts + chart-merge.test.ts lock the contract: manual rows always win; no
// insert whose canonical key matches an existing row of the same category; within-run duplicates
// collapse). Meds additionally key on medStatus + start/last-seen year (chartDedupKey).

export function planMerge(existing: readonly ExistingChartRow[], extracted: readonly FinalExtractedItem[]): MergePlan {
  const existingSourceByKey = new Map<string, string>();
  for (const e of existing) existingSourceByKey.set(chartDedupKey(e), e.source);

  const toInsert: FinalExtractedItem[] = [];
  const seen = new Set<string>();
  let skippedManual = 0;
  let skippedPriorExtracted = 0;
  let skippedDuplicate = 0;

  for (const it of extracted) {
    const k = chartDedupKey(it);
    if (seen.has(k)) { skippedDuplicate++; continue; }
    seen.add(k);

    const existingSource = existingSourceByKey.get(k);
    if (existingSource === 'manual') { skippedManual++; continue; }
    if (existingSource !== undefined) { skippedPriorExtracted++; continue; } // 'extracted' or any other — don't clobber
    toInsert.push(it);
  }

  return { toInsert, skippedManual, skippedPriorExtracted, skippedDuplicate };
}
