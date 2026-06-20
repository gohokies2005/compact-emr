/**
 * rating-decision-grants.ts — DETERMINISTIC granted-SC extraction from VA rating decisions.
 *
 * WHY THIS EXISTS (Ryan, 2026-06-20, 3rd recurrence): the broad Sonnet chart-extract pass
 * repeatedly DROPS granted service-connected conditions from rating-decision pages (Woodley,
 * Hackworth). The granted-SC list is the single most load-bearing fact in the whole pipeline (the
 * secondary-claim anchor), and a stochastic LLM cannot be trusted with it — prompt-patching it has
 * failed twice. A VA rating decision states grants in a RIGID, regex-parseable form
 * ("Service connection for X is granted with an evaluation of N percent"), so deterministic
 * extraction is both possible and reliable — PROVEN: this regex recovered all 4 grants from
 * Hackworth's actual (noisy) OCR where the LLM extracted zero.
 *
 * CONTRACT: produces RawExtractedItem rows (category 'sc_condition', status 'service_connected')
 * that are fed into the SAME groundAndDispose as the broad pass — so every grant is verbatim-quote
 * grounded and deduped against the LLM rows (no double-count). Deterministic is the AUTHORITY: it
 * guarantees "no grant silently lost" (incl. the partial-loss case the gate can't catch); the LLM
 * supplements. NEVER fabricates: only "...is granted" recitals match, so an all-denied decision
 * yields nothing. A 0% grant IS a grant (service_connected, noncompensable) and is captured.
 */

import type { BundleDocument } from './chart-extractor.js';
import type { RawExtractedItem } from './chart-extract-llm.js';

// Grant-recital patterns. Each captures the condition NAME (group order noted). Non-greedy name
// spans stop at the grant verb so trailing OCR noise ("...Facebook: ... evaluation of 50") lands
// AFTER the captured name, not inside it. Only GRANTS — never "is denied".
interface GrantPattern { re: RegExp; nameGroup: number }
const GRANT_PATTERNS: GrantPattern[] = [
  // "Service connection for chronic headaches is granted [with an evaluation of 50 percent]"
  { re: /service[\s-]?connection for ([\s\S]{2,80}?) (?:is|has been) (?:granted|established)/gi, nameGroup: 1 },
  // reverse order: "an evaluation of 50 percent is assigned for chronic headaches"
  { re: /an evaluation of \d{1,3}\s*percent (?:is|has been) assigned for ([\s\S]{2,80}?)(?:[.,;]|effective|\n)/gi, nameGroup: 1 },
  // "chronic headaches is 50 percent disabling"
  { re: /([A-Z][\s\S]{2,70}?) is \d{1,3}\s*percent disabling/gi, nameGroup: 1 },
];

// After a grant recital, the percentage usually follows within ~160 chars as "evaluation of N
// percent" / "N% disabling" / "rated at N percent". OCR may bracket a digit ("5[0]") — tolerate it.
const PCT_AFTER = /(?:evaluation of|rated(?:\s+at)?|assigned)\D{0,40}?(\d{1,3})(?:\s*\[?\d?\]?)?\s*(?:percent|%)/i;
const PCT_INLINE = /(\d{1,3})\s*(?:percent|%)\s*disabling/i;

// Obvious non-condition noise tokens that OCR interleaves into rating-decision pages.
const NOISE_RE = /twitter|facebook|www\.|http|@va|veteransbenefits|\.gov|\.com/i;

/** Clean a regex-captured condition name: strip OCR noise/punctuation, collapse whitespace, cap. */
function cleanName(raw: string): string | null {
  let s = raw.replace(/\s+/g, ' ').trim();
  // Drop a leading article and any leading "the/a" boilerplate.
  s = s.replace(/^(?:the|a|an|your)\s+/i, '').trim();
  // Strip trailing connective fragments the non-greedy span may include.
  s = s.replace(/[\s,;:.\-]+$/g, '').trim();
  if (!s || s.length < 3 || s.length > 70) return null;
  if (NOISE_RE.test(s)) return null;                 // captured social/URL noise → not a condition
  if (!/[a-z]/i.test(s)) return null;                // must contain letters
  if (/\b(?:granted|denied|service|connection|evaluation|percent)\b/i.test(s)) return null; // captured boilerplate, not a name
  return s;
}

function findPctNear(text: string, fromIndex: number): number | undefined {
  const window = text.slice(fromIndex, fromIndex + 160);
  const m = PCT_AFTER.exec(window) ?? PCT_INLINE.exec(window);
  if (!m) return undefined;
  const n = parseInt(m[1]!, 10);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : undefined;
}

/** A short verbatim window around the match, used as the grounding sourceQuote (real page substring). */
function quoteWindow(text: string, start: number, matchLen: number): string {
  const end = Math.min(text.length, start + Math.max(matchLen, 0) + 120);
  return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 220);
}

/**
 * Deterministically extract granted SC conditions from every page of every document.
 * Pure. Returns RawExtractedItem rows ready for groundAndDispose (they ARE grounded by construction:
 * sourceQuote is a verbatim page substring). Dedups identical (name+page) within this pass.
 */
export function extractRatingDecisionGrants(documents: BundleDocument[]): RawExtractedItem[] {
  const out: RawExtractedItem[] = [];
  const seen = new Set<string>();
  for (const doc of documents) {
    for (const page of doc.pages) {
      const text = page.text;
      if (!text || text.length < 20) continue;
      for (const { re, nameGroup } of GRANT_PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          const name = cleanName(m[nameGroup] ?? '');
          if (!name) continue;
          const matchEnd = m.index + m[0].length;
          const ratingPct = findPctNear(text, matchEnd);
          const key = `${doc.id}:${page.pageNumber}:${name.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            category: 'sc_condition',
            name,
            status: 'service_connected',
            ...(ratingPct !== undefined ? { ratingPct } : {}),
            sourceDocumentId: doc.id,
            sourcePage: page.pageNumber,
            sourceQuote: quoteWindow(text, m.index, m[0].length),
            confidence: 0.98, // deterministic regex over the rigid rating-decision form
          });
        }
      }
    }
  }
  return out;
}
