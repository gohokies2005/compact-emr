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

// --- SEVERITY PRE-PASS (opt-in via preserveSeverity; SOAP only) -------------------------------------------
// Foster root-cause (CLM-2E42C7CE67, 2026-07-01): a very large bundle (his Foster_OSA_Misc_4.pdf is 1608
// pages / ~2.46M chars) contributes only ONE floor page to the ranked+capped spans, so a diagnostic severity
// line ("Sleep Study AHI: 36.3", "AHI 14.7/hr") buried on a low-signal page NEVER reaches the digest. Every
// downstream consumer (soap-overview's ensureSeverityMeasurements backstop, boundChartDigest key-line float)
// is then starved by the SAME total cap and cannot recover a number that isn't in the digest. The fix lives
// HERE — the layer that still holds every page's full text: when preserveSeverity is ON we scan ALL pages for
// verbatim severity lines, harvest them (tagged/deduped/bounded), reserve their small budget off the top, and
// render them at the FRONT of the extracted-content section. OFF by default → byte-identical to today.
//
// SEVERITY_LINE_RE is the exported SSOT for "this text carries a study severity index / MENTION" (mirrors the
// local KEY_DIGEST_LINE_RE that soap-overview's now-superseded boundChartDigest used); soap-overview imports it
// for its SOAP_OBJECTIVE_AHI_DROPPED canary so the harvest and the canary share ONE definition of "severity".
// It is the TIER-2 (mention) gate in the pre-pass — deliberately broad, so it must NEVER be the sole selector
// (Foster round 2: value-less CPAP/date/sleep-hours mentions with an incidental digit passed it and starved
// the real readings). The pre-pass prioritizes SEVERITY_VALUE_RE (below) ahead of it.
export const SEVERITY_LINE_RE = /\bahi\b|apnea[- ]?hypopnea|\brdi\b|respiratory disturbance|\bcpap\b|spo2|oxygen (?:sat|desat|nadir)|desaturation|nadir|polysomnogram|\bpsg\b|sleep study/i;
// TIER-1 (the diagnostic READING): a severity INDEX token immediately adjacent to its numeric VALUE — the
// index, then a number within ~10 non-digit chars (spans "AHI 36.3", "AHI: 36.3", "AHI of 36.3", "RDI 41",
// "apnea-hypopnea index of 36"). Capture group 1 is the value (for the diagnostic-DESC sort + value dedup).
// This is the tight adjacency the soap-overview SEVERITY_INDEX_EXTRACTORS already use — a bare "wearing CPAP"
// / "sleeps 5-7 hours" / "sleep study 2/24/23" carries NO index-adjacent value and is NOT tier 1.
export const SEVERITY_VALUE_RE = /\b(?:ahi|rdi|apnea[- ]?hypopnea(?:\s+index)?|respiratory disturbance(?:\s+index)?)\b[^\d\n]{0,10}(\d{1,3}(?:\.\d+)?)/i;
// Small reserve carved off the TOTAL cap for the harvested severity block (so it can never dominate the
// digest) + a per-line clip + a hard line count. A handful of verbatim readings is all the physician needs.
export const SEVERITY_RESERVE_CHARS = 600;
export const SEVERITY_LINE_MAX_CHARS = 220;
export const MAX_SEVERITY_LINES = 8;

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
  caps: { perDoc?: number; total?: number; preserveSeverity?: boolean } = {},
): DocumentDigest {
  const perDocCap = caps.perDoc ?? PER_DOC_DIGEST_CHARS;
  const totalCap = caps.total ?? TOTAL_DIGEST_CHARS;
  // OFF by default. When ON (SOAP context only): run the severity pre-pass below and carve its used chars off
  // the total budget for the span passes. When OFF (all other callers) severityUsed stays 0 → byte-identical.
  const preserveSeverity = caps.preserveSeverity ?? false;

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

  // --- 1.5 SEVERITY PRE-PASS (opt-in; SOAP only) ---
  // Scan ALL pages' FULL text (before any ranking/slicing can starve them) for verbatim severity lines and
  // harvest a small, tagged, deduped, bounded block. This is the ONLY place with every page's full text, so a
  // reading buried deep in a 1608-page doc is recoverable here even though it would never win a ranked span.
  // Anti-fabrication holds by construction: only VERBATIM lines that already carry a severity token AND a digit
  // are surfaced (no number is invented); the downstream grounding set is the whole returned string.
  const severityLines: string[] = [];
  let severityUsed = 0;
  if (preserveSeverity) {
    // TWO-TIER harvest (Foster round 2). Round 1 harvested first-come in PAGE order with the broad mention gate,
    // so six value-LESS CPAP/date/sleep-hours mentions on EARLY pages filled the 600-char reserve and the real
    // diagnostic readings ("AHI: 36.3" p724, "AHI 14.7/hr" p1150) — reached but LATER — were rejected. Same
    // starvation, relocated into the reserve. The tier split guarantees the READINGS win the slots:
    //   TIER 1 = a severity INDEX adjacent to its numeric VALUE (SEVERITY_VALUE_RE) — a real reading.
    //   TIER 2 = value-less study MENTIONS (SEVERITY_LINE_RE + an incidental digit) — fill only if budget left.
    // Tier-1 lines are collected regardless of page position, deduped by numeric value, sorted diagnostic-DESC
    // (higher untreated AHI wins over low on-CPAP residuals), and placed AHEAD of tier-2 before the caps apply.
    const seen = new Set<string>();
    const seenValue = new Set<string>();
    const tier1: Array<{ value: number; tagged: string }> = [];
    const tier2: string[] = [];
    const COLLECT_CAP = 48; // render ≤8; a margin keeps sort/dedup honest without unbounded arrays on a huge chart
    scan: for (const d of docs) {
      const label = abbreviateFilename(d.filename, 36);
      for (const p of pagesByDocId.get(d.id) ?? []) {
        const raw = p.text ?? '';
        if (raw.length === 0) continue;
        // Honor real newlines when present (OCR page text usually has them); else split into sentence-ish units.
        const candidates = raw.includes('\n') ? raw.split('\n') : raw.split(/(?<=[.;])\s+/);
        for (const c of candidates) {
          const line = collapseWs(c);
          if (line.length === 0) continue;
          const valueMatch = line.match(SEVERITY_VALUE_RE);
          // Tier 2 only when there is NO index-adjacent value AND the line still mentions a study index with a
          // digit somewhere. A bare "wearing CPAP" (no digit) or "sleeps 5-7 hours" (no index token) is neither.
          const isTier2 = !valueMatch && SEVERITY_LINE_RE.test(line) && /\d/.test(line);
          if (!valueMatch && !isTier2) continue;
          const clipped = line.length > SEVERITY_LINE_MAX_CHARS ? `${line.slice(0, SEVERITY_LINE_MAX_CHARS)}…` : line;
          const dedupKey = clipped.toLowerCase();
          if (seen.has(dedupKey)) continue;
          const tagged = `  [${label} p${p.pageNumber}] ${clipped}`;
          if (valueMatch) {
            // Dedup tier 1 by (index kind + numeric value) so repeated mentions of the SAME reading across pages
            // don't each eat a slot; keep the first (earliest-page) occurrence of each distinct value.
            const value = Number.parseFloat(valueMatch[1] ?? '');
            const kind = /\brdi\b|respiratory/i.test(valueMatch[0]) ? 'rdi' : 'ahi';
            const vKey = `${kind}::${Number.isFinite(value) ? value : (valueMatch[1] ?? '')}`;
            if (seenValue.has(vKey) || tier1.length >= COLLECT_CAP) continue;
            seen.add(dedupKey);
            seenValue.add(vKey);
            tier1.push({ value: Number.isFinite(value) ? value : 0, tagged });
          } else {
            if (tier2.length >= COLLECT_CAP) continue;
            seen.add(dedupKey);
            tier2.push(tagged);
          }
          if (tier1.length >= COLLECT_CAP && tier2.length >= COLLECT_CAP) break scan;
        }
      }
    }
    // Tier 1 first (diagnostic value DESC), then tier 2 mentions — apply the reserve caps in THAT order so a
    // reading can never be starved by a mention (the round-1 defect).
    tier1.sort((a, b) => b.value - a.value);
    for (const tagged of [...tier1.map((t) => t.tagged), ...tier2]) {
      if (severityLines.length >= MAX_SEVERITY_LINES) break;
      if (severityUsed + tagged.length + 1 > SEVERITY_RESERVE_CHARS) continue; // won't fit → skip, try the next (shorter) line
      severityLines.push(tagged);
      severityUsed += tagged.length + 1; // +1 ≈ the '\n' join cost
    }
  }
  // The span passes budget against what remains AFTER the reserved severity block. severityUsed is 0 whenever
  // preserveSeverity is off OR no severity line matched → spanBudget === totalCap → byte-identical to today.
  // Clamp ≥0 (only reachable if a caller passes a total smaller than the ≤600-char reserve — a test artifact;
  // in prod SEVERITY_RESERVE_CHARS(600) << TOTAL_DIGEST_CHARS(8000)): the reserve is guaranteed, spans yield.
  const spanBudget = Math.max(0, totalCap - severityUsed);

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
    const totalRemaining = spanBudget - totalUsed;
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
    if (totalUsed >= spanBudget) break;
    grant(topPageByDoc.get(order)!, floorCap);
  }

  // FILL PASS: distribute the remaining total budget by signal desc (the original behavior), now on top of the
  // floors. Each page can grow to its doc's full per-doc cap; the total cap stops it exactly.
  for (const pg of ranked) {
    if (totalUsed >= spanBudget) break;
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

  const hasSeverity = severityLines.length > 0;
  if (hasSeverity || spanLines.length > 0) {
    lines.push('');
    lines.push('Extracted document content (high-signal pages, capped):');
    // Reserved severity block FIRST so the diagnostic readings survive any downstream head-slice. Verbatim.
    if (hasSeverity) {
      lines.push('  Key study measurements found in the records (verbatim):');
      lines.push(...severityLines);
    }
    lines.push(...spanLines);
  }

  return { text: lines.join('\n'), totalDocs, extractedDocs };
}
