// Document digest for the advisory ask-path — the freshness manifest + high-signal extracted-text
// digest of a case's uploaded documents, so Ask Aegis can SEE what arrived instead of being blind to
// every upload (prior state: the chart slice was scConditions/problems/meds only, so "nothing new has
// come through" was emitted even when 3 unparsed files were sitting on the case).
//
// PURE module: no Prisma, no env, no model call. The impure adapter (DB reads) lives in chartSlice.ts;
// this takes already-fetched document + page rows and produces deterministic text. The output text is
// VETERAN-SUPPLIED document content — it is placed INSIDE the untrusted-data fence by the assembler and
// NEVER reaches pgvector or a log (live-pull only, discarded after the answer).
//
// Two parts, in this order:
//   1. ALWAYS a freshness manifest: "Documents on file: N (M extracted)" + one line per doc
//      [abbreviated filename · docType/tag · extracted? · pages] — so the model can say "3 new files
//      exist but aren't parsed yet" rather than implying the chart is unchanged.
//   2. For EXTRACTED docs, the high-signal spans of page text, capped (per-doc + total), prioritizing
//      pages whose text hits the decision/SC/event content patterns (reused from the key-docs
//      classifier — NOT a new pattern set) over chronological order. Whitespace-collapsed.

import { classifyContentText } from '../services/key-docs-classifier.js';

// --- Caps (byte-exact; enforced in tests). Total ~8,000 chars ≈ 2-3k tokens at ~3-4 chars/token. ---
export const PER_DOC_DIGEST_CHARS = 1_200;
export const TOTAL_DIGEST_CHARS = 8_000;
// #5 (Zimmelman, 2026-06-21): a guaranteed per-doc FLOOR so EVERY extracted doc contributes a slice — the
// newest records can no longer be starved out of the digest by older docs eating the total cap first. The
// floor is taken from each doc's single HIGHEST-signal page (its most decision-relevant span). When there
// are too many docs to floor them all within the total cap, the floor is granted NEWEST-FIRST (docs are fed
// to the digest newest-first; see buildDigestForCase orderBy) so the modern dx/decision always lands.
export const PER_DOC_FLOOR_CHARS = 400;

// Inputs are the already-fetched rows (chartSlice.ts does the SELECT). Kept narrow + plain so the unit
// tests stay DB-free.
export interface DigestDocInput {
  readonly id: string;
  readonly filename: string;
  readonly docTag: string | null;
  readonly pageCount: number | null;
}
export interface DigestPageInput {
  readonly documentId: string;
  readonly pageNumber: number;
  readonly text: string;
}

export interface DocumentDigest {
  readonly text: string; // the full digest block (manifest + extracted spans), fence-safe-ready
  readonly totalDocs: number;
  readonly extractedDocs: number;
}

// Collapse all runs of whitespace (incl. newlines/tabs from OCR) to single spaces, trim. OCR text is
// noisy with column gaps + page-break newlines; collapsing both keeps the cap honest (we budget chars,
// not lines) and the digest readable.
function collapseWs(s: string): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

// Abbreviate a filename to keep the manifest line compact without losing the discriminating part
// (veterans upload "Misc_3.pdf" AND "C&P_Exam_PTSD_2024.pdf" — keep the extension + a head/tail).
export function abbreviateFilename(name: string, max = 48): string {
  const base = (name ?? '').split(/[/\\]/).pop() ?? name ?? '';
  if (base.length <= max) return base;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 && base.length - dot <= 6 ? base.slice(dot) : '';
  const stem = ext ? base.slice(0, base.length - ext.length) : base;
  const keep = max - ext.length - 1; // -1 for the ellipsis char
  if (keep <= 4) return base.slice(0, max);
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${stem.slice(0, head)}…${stem.slice(stem.length - tail)}${ext}`;
}

// A page is "high-signal" if its text matches a decision/SC/event content pattern (rating decision,
// denial, DBQ, C&P, STR, statement, etc.). We REUSE the classifier's CONTENT_PATTERNS via
// classifyContentText rather than inventing a parallel pattern set — one source of truth for "what a
// decision/event page looks like" (key-docs-classifier.ts). A non-null result = the page carries the
// kind of content the advisory answer most needs.
function pageSignalRank(text: string): number {
  const hit = classifyContentText(text);
  if (hit === null) return 0;
  // Prefer the strongest evidence first: high_signal (decision/exam/statement) over bulk dumps,
  // and within that, higher confidence first. Scaled so the sort is stable + deterministic.
  const tierWeight = hit.classification === 'high_signal' ? 2 : hit.classification === 'bulk' ? 0 : 1;
  return tierWeight * 100 + Math.round(hit.confidence * 100);
}

interface RankedPage {
  readonly docOrder: number; // original document order (for stable tiebreak)
  readonly pageNumber: number;
  readonly signal: number;
  readonly text: string; // already whitespace-collapsed
}

// Build the digest from already-fetched rows. Deterministic: same rows -> identical bytes (the page
// sort is total — signal desc, then docOrder asc, then pageNumber asc — so there is no ordering
// ambiguity). Caps are enforced byte-exact.
export function buildDocumentDigest(
  docs: readonly DigestDocInput[],
  pagesByDocId: ReadonlyMap<string, readonly DigestPageInput[]>,
  caps: { perDoc?: number; total?: number } = {},
): DocumentDigest {
  const perDocCap = caps.perDoc ?? PER_DOC_DIGEST_CHARS;
  const totalCap = caps.total ?? TOTAL_DIGEST_CHARS;

  const totalDocs = docs.length;
  let extractedDocs = 0;

  // --- 1. Freshness manifest (ALWAYS, even with zero extracted text) ---
  const docOrderById = new Map<string, number>();
  const manifestLines: string[] = [];
  docs.forEach((d, i) => {
    docOrderById.set(d.id, i);
    const pages = pagesByDocId.get(d.id) ?? [];
    const hasText = pages.some((p) => collapseWs(p.text).length > 0);
    if (hasText) extractedDocs += 1;
    // tag/docType label: the human docTag if present + not the default 'Other', else "—".
    const tag = typeof d.docTag === 'string' && d.docTag.trim().length > 0 && d.docTag.trim().toLowerCase() !== 'other'
      ? d.docTag.trim()
      : '—';
    const pageLabel = d.pageCount != null && d.pageCount > 0 ? `${d.pageCount}pp` : pages.length > 0 ? `${pages.length}pp` : '?pp';
    manifestLines.push(`  - ${abbreviateFilename(d.filename)} · ${tag} · ${hasText ? 'extracted' : 'NOT extracted'} · ${pageLabel}`);
  });

  const header = `Documents on file: ${totalDocs} (${extractedDocs} extracted)`;
  const lines: string[] = [header];
  if (totalDocs > 0) lines.push(...manifestLines);
  if (totalDocs > extractedDocs && totalDocs > 0) {
    lines.push(`  (${totalDocs - extractedDocs} document(s) uploaded but not yet parsed — their content is NOT below.)`);
  }

  // --- 2. High-signal extracted spans (only when there is extracted text) ---
  // Rank every non-empty page across all docs by signal, take spans up to the per-doc + total caps.
  const ranked: RankedPage[] = [];
  for (const d of docs) {
    const order = docOrderById.get(d.id) ?? 0;
    for (const p of pagesByDocId.get(d.id) ?? []) {
      const t = collapseWs(p.text);
      if (t.length === 0) continue;
      ranked.push({ docOrder: order, pageNumber: p.pageNumber, signal: pageSignalRank(t), text: t });
    }
  }
  // Total order: signal desc, then document order asc, then page number asc. Fully deterministic.
  ranked.sort((a, b) => b.signal - a.signal || a.docOrder - b.docOrder || a.pageNumber - b.pageNumber);

  const perDocUsed = new Map<number, number>();
  let totalUsed = 0;
  // We ACCUMULATE the chars granted to each page across the floor + fill passes, then render ONE span line per
  // page at the end (a page touched by both passes is still a single, contiguous span — never split or
  // duplicated). pageKey identifies a page; pageGrant is the running char grant.
  const pageKey = (pg: RankedPage): string => `${pg.docOrder}:${pg.pageNumber}`;
  const pageGrant = new Map<string, number>();
  const pageByKey = new Map<string, RankedPage>();
  for (const pg of ranked) pageByKey.set(pageKey(pg), pg);

  // Grant (up to) `limit` MORE chars to one page, clamped to the page's remaining text + the per-doc cap + the
  // total cap. Accumulates into pageGrant (no line emitted here). Returns chars granted (0 if none fit).
  const grant = (pg: RankedPage, limit: number): number => {
    if (limit <= 0) return 0;
    const docUsed = perDocUsed.get(pg.docOrder) ?? 0;
    const docRemaining = perDocCap - docUsed;
    if (docRemaining <= 0) return 0;
    const totalRemaining = totalCap - totalUsed;
    const k = pageKey(pg);
    const already = pageGrant.get(k) ?? 0;
    const pageRemaining = pg.text.length - already;
    const add = Math.min(limit, docRemaining, totalRemaining, pageRemaining);
    if (add <= 0) return 0;
    pageGrant.set(k, already + add);
    perDocUsed.set(pg.docOrder, docUsed + add);
    totalUsed += add;
    return add;
  };

  // #5 FLOOR PASS (Zimmelman): reserve a guaranteed floor for EVERY doc — its single highest-signal page —
  // BEFORE the signal-greedy fill, so older high-signal docs can no longer eat the whole total cap and starve
  // the newest records. Docs are visited NEWEST-FIRST (docOrder asc === newest-first, since buildDigestForCase
  // feeds them newest-first), so when the floor budget can't cover every doc the newest get the floor. The
  // floor is the doc's top-ranked page (ranked is signal-desc), capped to PER_DOC_FLOOR_CHARS.
  const floorCap = Math.min(perDocCap, PER_DOC_FLOOR_CHARS);
  const topPageByDoc = new Map<number, RankedPage>();
  for (const pg of ranked) if (!topPageByDoc.has(pg.docOrder)) topPageByDoc.set(pg.docOrder, pg);
  const docOrdersNewestFirst = [...topPageByDoc.keys()].sort((a, b) => a - b);
  for (const order of docOrdersNewestFirst) {
    if (totalUsed >= totalCap) break;
    grant(topPageByDoc.get(order)!, floorCap);
  }

  // FILL PASS: distribute the remaining total budget by signal desc (the original behavior), now on top of the
  // floors. Each page can grow to its doc's full per-doc cap; the total cap stops it exactly.
  for (const pg of ranked) {
    if (totalUsed >= totalCap) break;
    grant(pg, perDocCap);
  }

  // RENDER: one span line per granted page, in signal order (the original output order — signal desc, docOrder
  // asc, pageNumber asc) so the most decision-relevant spans still lead. Each page is a single contiguous slice
  // of its granted length (floor + fill merged), never split.
  const spanLines: string[] = [];
  for (const pg of ranked) {
    const g = pageGrant.get(pageKey(pg)) ?? 0;
    if (g <= 0) continue;
    const doc = docs[pg.docOrder];
    const label = doc ? abbreviateFilename(doc.filename, 36) : `doc${pg.docOrder}`;
    spanLines.push(`  [${label} p${pg.pageNumber}] ${pg.text.slice(0, g)}`);
  }

  if (spanLines.length > 0) {
    lines.push('');
    lines.push('Extracted document content (high-signal pages, capped):');
    lines.push(...spanLines);
  }

  return { text: lines.join('\n'), totalDocs, extractedDocs };
}
