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

import { normalizeName, type ExtractCategory } from './chart-extractor.js';
import type { FinalExtractedItem } from './chart-extract-llm.js';

export interface ExistingChartRow {
  category: ExtractCategory;
  /** condition / problem / drugName as stored. */
  name: string;
  /** 'manual' | 'extracted' */
  source: string;
}

export interface MergePlan {
  toInsert: FinalExtractedItem[];
  skippedManual: number;
  skippedPriorExtracted: number;
  skippedDuplicate: number;
}

// TEST-LOCK (keystone pkg 6): the dedup correctness of this merge lives in normalizeName
// (chart-extractor.ts) — qualifier stripping, parenthetical-abbrev stripping, and the synonym
// fold all happen THERE. planMerge only keys on it. Extend canonicalization in normalizeName,
// never by adding a second normalization here (chart-extractor.test.ts + chart-merge.test.ts
// lock the contract: manual rows always win; no insert whose canonical key matches an existing
// row of the same category; within-run duplicates collapse).
function key(category: ExtractCategory, name: string): string {
  return `${category}::${normalizeName(name)}`;
}

export function planMerge(existing: readonly ExistingChartRow[], extracted: readonly FinalExtractedItem[]): MergePlan {
  const existingSourceByKey = new Map<string, string>();
  for (const e of existing) existingSourceByKey.set(key(e.category, e.name), e.source);

  const toInsert: FinalExtractedItem[] = [];
  const seen = new Set<string>();
  let skippedManual = 0;
  let skippedPriorExtracted = 0;
  let skippedDuplicate = 0;

  for (const it of extracted) {
    const k = key(it.category, it.name);
    if (seen.has(k)) { skippedDuplicate++; continue; }
    seen.add(k);

    const existingSource = existingSourceByKey.get(k);
    if (existingSource === 'manual') { skippedManual++; continue; }
    if (existingSource !== undefined) { skippedPriorExtracted++; continue; } // 'extracted' or any other — don't clobber
    toInsert.push(it);
  }

  return { toInsert, skippedManual, skippedPriorExtracted, skippedDuplicate };
}
