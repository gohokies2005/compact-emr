// SC-PROVENANCE DRY-RUN / DETERMINISTIC RE-CLASSIFICATION (Woodley follow-on, 2026-06-26).
//
// THE PROBLEM the flip-alone does NOT solve: applyExtractionMerge's planMerge PROTECTS prior-extracted
// rows, so re-running the extractor SKIPS existing SC rows and never re-classifies them. Flipping
// SC_PROVENANCE_ENFORCED=on therefore cleans nothing on the existing fleet — it only governs NEW inserts.
// To actually re-validate / clean an existing case (Woodley included) we re-derive each extracted SC row's
// source-document authority DETERMINISTICALLY (no LLM) from the source Document (filename + docTag + a
// text sample of its first pages) and, in apply-mode, mirror the WRITER: a non-authoritative
// service_connected → status='pending' + ratingPct=null + stamp the tier.
//
// THE OVER-FILTER DEFENSE (Dr. Kasky's worry — "make sure it's not filtering out stuff it shouldn't"): a
// genuine VA rating decision whose docTag is 'unspecified' and whose filename is generic (scan_017.pdf)
// would mis-tier as non-authoritative on filename alone. So we pass a TEXT SAMPLE; the classifier's
// fingerprint (VA letterhead + decision recital) rescues it to va_decision. The dry-run report then lists
// an OVER-FILTER WATCH set: any wouldDemote row whose text STILL looks like a real VA decision — the exact
// false-positive to eyeball before applying.
//
// This module is PURE (no DB): the route loads rows + docs + page samples and calls in. Same SSOT
// classifier (authorityTierForDocument / scStatusAuthoritativeFor / looksLikeVaDecisionText) the
// writer + gate use — never a reimplementation.

import {
  authorityTierForDocument,
  scStatusAuthoritativeFor,
  looksLikeVaDecisionText,
  type ScAuthorityTier,
} from './sc-authority.js';
import type { KeyDocType } from './db-types.js';

export const EXTRACTED_SOURCE_VALUE = 'extracted';

export interface ScDryrunRowInput {
  id: string;
  caseId: string;
  veteranId: string;
  condition: string;
  status: string;
  ratingPct: number | null;
  dcCode: string | null;
  source: string | null;
  sourceDocumentId: string | null;
  // already-stamped values (dark-window inserts may carry these); reported for transparency.
  sourceAuthorityTier: string | null;
  scStatusAuthoritative: boolean | null;
}

export interface ScDryrunDoc {
  filename: string | null;
  docTag: string | null;
  textSample: string | null; // first ~2 pages, ~4000 chars
}

export type ScDryrunAction =
  | 'downgrade' // non-authoritative service_connected → pending (+ stamp false)
  | 'stamp' // extracted, classifiable, authoritative (or non-SC) → stamp tier/authoritative only
  | 'skip_manual' // source manual/null → immutable, never touched
  | 'skip_no_source' // extracted but no sourceDocumentId → cannot classify, leave scStatusAuthoritative null (trusted)
  | 'skip_not_sc'; // not a service_connected grant (pending/denied) → nothing to demote (still stamp if classifiable)

export interface ScDryrunRowResult {
  id: string;
  caseId: string;
  veteranId: string;
  condition: string;
  status: string;
  ratingPct: number | null;
  dcCode: string | null;
  source: string | null;
  sourceDocumentId: string | null;
  filename: string | null;
  docTag: string | null;
  computedTier: ScAuthorityTier;
  authoritative: boolean;
  textSampleUsed: boolean; // false ⇒ classified on filename/docTag alone (a blind classification)
  looksLikeRealDecision: boolean;
  wouldDemote: boolean; // status is a SC grant that enforcement would strip
  overFilterWatch: boolean; // wouldDemote AND the source text looks like a real VA decision → EYEBALL
  action: ScDryrunAction;
}

export interface ScDryrunSummary {
  totalRows: number;
  extractedRows: number;
  serviceConnectedExtractedRows: number;
  byTier: Record<string, number>;
  wouldDemoteCount: number;
  overFilterWatchCount: number;
  blindDemoteCount: number; // wouldDemote with NO text sample (filename/docTag-only) — lower-confidence
  noSourceExtractedCount: number; // extracted grants with no sourceDocumentId (left trusted)
}

export interface ScDryrunReport {
  summary: ScDryrunSummary;
  rows: ScDryrunRowResult[];
  overFilterWatch: ScDryrunRowResult[]; // the manual-review gate before apply
}

function classifyRow(row: ScDryrunRowInput, doc: ScDryrunDoc | undefined): ScDryrunRowResult {
  const filename = doc?.filename ?? null;
  const docTag = doc?.docTag ?? null;
  const textSample = doc?.textSample ?? null;
  const computedTier = authorityTierForDocument({
    docType: (docTag as KeyDocType | null) ?? undefined,
    filename,
    textSample,
  });
  const authoritative = scStatusAuthoritativeFor(computedTier);
  const isSc = String(row.status || '').toLowerCase() === 'service_connected';
  const isExtracted = row.source === EXTRACTED_SOURCE_VALUE;
  const hasSource = row.sourceDocumentId != null && row.sourceDocumentId !== '';
  const textSampleUsed = typeof textSample === 'string' && textSample.length > 0;
  const looksLikeRealDecision = looksLikeVaDecisionText(textSample);

  // A row demotes only when: extracted (manual/null is immutable), a SC grant, classifiable (has a source
  // doc), and the source is non-authoritative. A no-source extracted grant cannot be classified → leave
  // trusted (never demote blind). Mirrors effectiveScStatus' "affirmative non-authoritative only" rule.
  const wouldDemote = isExtracted && isSc && hasSource && !authoritative;

  let action: ScDryrunAction;
  if (!isExtracted) action = 'skip_manual';
  else if (!hasSource) action = 'skip_no_source';
  else if (wouldDemote) action = 'downgrade';
  else if (!isSc) action = 'skip_not_sc';
  else action = 'stamp';

  return {
    id: row.id,
    caseId: row.caseId,
    veteranId: row.veteranId,
    condition: row.condition,
    status: row.status,
    ratingPct: row.ratingPct,
    dcCode: row.dcCode,
    source: row.source,
    sourceDocumentId: row.sourceDocumentId,
    filename,
    docTag,
    computedTier,
    authoritative,
    textSampleUsed,
    looksLikeRealDecision,
    wouldDemote,
    overFilterWatch: wouldDemote && looksLikeRealDecision,
    action,
  };
}

/**
 * Deterministically re-classify a set of SC rows against their source documents. Pure: no DB, no LLM.
 * docsById maps sourceDocumentId → {filename, docTag, textSample}.
 */
export function buildScProvenanceDryrun(rows: ScDryrunRowInput[], docsById: Map<string, ScDryrunDoc>): ScDryrunReport {
  const results = rows.map((r) => classifyRow(r, r.sourceDocumentId ? docsById.get(r.sourceDocumentId) : undefined));

  const byTier: Record<string, number> = {};
  for (const r of results) byTier[r.computedTier] = (byTier[r.computedTier] ?? 0) + 1;

  const extracted = results.filter((r) => r.source === EXTRACTED_SOURCE_VALUE);
  const scExtracted = extracted.filter((r) => String(r.status || '').toLowerCase() === 'service_connected');
  const wouldDemote = results.filter((r) => r.wouldDemote);
  const overFilterWatch = results.filter((r) => r.overFilterWatch);

  return {
    summary: {
      totalRows: results.length,
      extractedRows: extracted.length,
      serviceConnectedExtractedRows: scExtracted.length,
      byTier,
      wouldDemoteCount: wouldDemote.length,
      overFilterWatchCount: overFilterWatch.length,
      blindDemoteCount: wouldDemote.filter((r) => !r.textSampleUsed).length,
      noSourceExtractedCount: scExtracted.filter((r) => r.sourceDocumentId == null || r.sourceDocumentId === '').length,
    },
    rows: results,
    overFilterWatch,
  };
}

/**
 * The mutation an APPLY would perform for a single classified row (mirrors chart-merge-apply.ts:128-132).
 * Returns null when the row must NOT be written (manual/no-source). The route runs these in a transaction.
 */
export interface ScRowMutation {
  id: string;
  sourceAuthorityTier: ScAuthorityTier;
  scStatusAuthoritative: boolean;
  newStatus?: 'pending'; // present only on a downgrade
  dropRatingPct?: boolean; // present only on a downgrade
}
export function mutationForRow(r: ScDryrunRowResult): ScRowMutation | null {
  if (r.action === 'skip_manual' || r.action === 'skip_no_source') return null;
  const m: ScRowMutation = {
    id: r.id,
    sourceAuthorityTier: r.computedTier,
    scStatusAuthoritative: r.authoritative,
  };
  if (r.action === 'downgrade') {
    m.newStatus = 'pending';
    m.dropRatingPct = true;
  }
  return m;
}
