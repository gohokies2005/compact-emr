/**
 * Citation + statistic integrity guard for the Guided Revision letter-edit tier (Guided Revision,
 * 2026-06-13).
 *
 * WHY THIS EXISTS — the safety keystone of guided revision.
 * The surgical editor (letter-surgical-propose.ts) is deliberately narrow ("change ONLY what is
 * asked"). Guided revision is a BROADER tier: the physician highlights a passage and tells Opus to
 * reshape it (tone / emphasis / argument). With softer prose rules comes a new failure mode the
 * surgical tier never had — the model, while rewording an argument, can INVENT a citation or a
 * statistic to make the new prose sound supported, or DROP a citation/stat the reworded sentence no
 * longer mentions. In a medico-legal nexus letter (an independent medical opinion) a fabricated PMID
 * or an unsupported "OR 3.1" is a probative-value catastrophe.
 *
 * THE CONTRACT (per the work order):
 *   - A NET-NEW citation/stat in the revised passage (in `after`, absent from `before`) => the
 *     proposal is REJECTED (never returned as applyable). The model may rephrase prose AROUND the
 *     cited facts but may not introduce new cited facts to support a reworded argument.
 *   - A REMOVED citation/stat (present in `before`, gone from `after`) => the proposal is RETURNED
 *     but with a WARNING the physician must see before accepting. Removal can be legitimate
 *     (de-emphasizing a marginal secondary theory drops its supporting cite), so it is the
 *     physician's call, not an auto-block.
 *
 * BIAS TO BLOCK on ambiguity (medico-legal): a false ALLOW ships a letter with a fabricated cite or
 * a phantom statistic; a false BLOCK merely makes the doctor refine the instruction. Every
 * extraction rule below errs toward CAPTURING a token (so a reworded form still matches its prior
 * self and is not falsely flagged as net-new) while still treating a genuinely new token as added.
 *
 * Pure + dependency-free: no S3, no Prisma, no LLM. Unit-tested hard in
 * __tests__/letter-citation-integrity.test.ts.
 */

/** A single extracted citation/stat token, normalized for set comparison. */
export interface CitationToken {
  /** 'pmid' | 'author_year' | 'stat' — the class of cited fact. */
  readonly kind: 'pmid' | 'author_year' | 'stat';
  /** The normalized comparison key (lowercased, whitespace-collapsed). Set membership uses this. */
  readonly key: string;
  /** The first raw surface form seen (for human-readable warnings/rejections). */
  readonly raw: string;
}

export interface CitationDiff {
  /** Tokens present in `after` but NOT in `before` — model-invented. Non-empty => REJECT. */
  readonly added: readonly CitationToken[];
  /** Tokens present in `before` but NOT in `after` — dropped. Non-empty => WARN. */
  readonly removed: readonly CitationToken[];
}

// ── Extraction patterns ──────────────────────────────────────────────────────
// PMID: "PMID: 12345678" or "PMID 12345678". PubMed IDs are 1-8 digits historically, but we accept
// up to 9 to be safe against future growth. Case-insensitive on the label.
const PMID_RE = /\bPMID\s*:?\s*(\d{1,9})\b/gi;

// Author-year: "Smith 2019", "Dell'Isola 2021", "El-Serag 2014", "Smith and Jones 2018",
// "Smith et al. 2020", "Smith et al 2020". The surname token allows internal apostrophes/hyphens
// (Dell'Isola, El-Serag) and must start uppercase. The year is a 4-digit 19xx/20xx. We capture the
// SURNAME + YEAR as the identity (the "and Jones"/"et al" connective is normalized away) so that
// "Smith et al. 2019" and "Smith 2019" compare EQUAL — a reworded citation form is not a new cite.
const AUTHOR_YEAR_RE =
  /\b([A-Z][a-zA-Z]*(?:['’-][A-Za-z]+)*)(?:\s+(?:and|&)\s+[A-Z][a-zA-Z]*(?:['’-][A-Za-z]+)*|\s+et\s+al\.?)?\s*,?\s*((?:19|20)\d{2})\b/g;

// Statistics. Each pattern captures the NUMERIC payload that identifies the stat; the surrounding
// label (OR/RR/HR/n/%) is folded into the normalized key so "OR 3.1" and "odds ratio of 3.1" share
// identity on the value+kind. Order matters: more specific labeled forms first.
//  - percentages: "18%", "18.5 %", "18 percent". NOTE: no trailing \b — "%" is a non-word char so a
//    "%" followed by space/paren has no word boundary after it; "percent" gets its own \b instead.
const PERCENT_RE = /\b(\d{1,3}(?:\.\d+)?)\s*(?:%|percent\b)/gi;
//  - ratios with a label: OR / RR / HR / SMD / aOR / aHR  e.g. "OR 11.7", "RR of 1.07", "HR=1.60"
const RATIO_RE = /\b(a?OR|RR|a?HR|SMD)\s*(?:of|=|:)?\s*(\d+(?:\.\d+)?)\b/gi;
//  - sample size: "n = 548,681", "n=548681", "N = 30"
const N_RE = /\bn\s*=\s*([\d,]+)\b/gi;
//  - confidence interval bounds: "95% CI 1.07-1.60", "CI: 1.07 to 1.60" — captured as a CI token so
//    a reworded CI ("1.07 to 1.60" vs "1.07-1.60") still matches. Both bounds form the key.
const CI_RE = /\bCI\s*:?\s*(\d+(?:\.\d+)?)\s*(?:-|to|,)\s*(\d+(?:\.\d+)?)\b/gi;

function pushUnique(map: Map<string, CitationToken>, token: CitationToken): void {
  // First raw surface form wins for display; set identity is the key.
  if (!map.has(token.key)) map.set(token.key, token);
}

/**
 * Extract the de-duplicated set of citation + statistic tokens from a passage. Returns a Map keyed
 * by the normalized comparison key so callers can do clean set difference. Pure; never throws.
 */
export function extractCitationTokenMap(text: string): Map<string, CitationToken> {
  const out = new Map<string, CitationToken>();
  if (typeof text !== 'string' || text.length === 0) return out;

  for (const m of text.matchAll(PMID_RE)) {
    // Strip a leading zero or two so "PMID 012345" and "PMID 12345" are the same id.
    const digits = String(m[1]).replace(/^0+/, '') || '0';
    pushUnique(out, { kind: 'pmid', key: `pmid:${digits}`, raw: m[0].trim() });
  }
  for (const m of text.matchAll(AUTHOR_YEAR_RE)) {
    const surname = String(m[1]).toLowerCase().replace(/’/g, "'");
    const year = String(m[2]);
    pushUnique(out, { kind: 'author_year', key: `ay:${surname}:${year}`, raw: `${m[1]} ${year}` });
  }
  for (const m of text.matchAll(PERCENT_RE)) {
    const val = normalizeNumber(m[1]);
    pushUnique(out, { kind: 'stat', key: `pct:${val}`, raw: `${m[1]}%` });
  }
  for (const m of text.matchAll(RATIO_RE)) {
    const label = String(m[1]).toLowerCase();
    const val = normalizeNumber(m[2]);
    pushUnique(out, { kind: 'stat', key: `ratio:${label}:${val}`, raw: `${m[1]} ${m[2]}` });
  }
  for (const m of text.matchAll(N_RE)) {
    const val = String(m[1]).replace(/,/g, '');
    pushUnique(out, { kind: 'stat', key: `n:${val}`, raw: `n=${m[1]}` });
  }
  for (const m of text.matchAll(CI_RE)) {
    const lo = normalizeNumber(m[1]);
    const hi = normalizeNumber(m[2]);
    pushUnique(out, { kind: 'stat', key: `ci:${lo}:${hi}`, raw: `CI ${m[1]}-${m[2]}` });
  }
  return out;
}

/** Trim trailing-zero noise so "1.60" and "1.6" compare equal; keep integers as-is. */
function normalizeNumber(s: string): string {
  if (!s.includes('.')) return s;
  const trimmed = s.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' ? '0' : trimmed;
}

/** Convenience: the de-duplicated list of tokens in a passage (order: insertion). */
export function extractCitationTokens(text: string): CitationToken[] {
  return [...extractCitationTokenMap(text).values()];
}

/**
 * Diff the citation/stat token sets of a passage before and after a proposed revision.
 *   added   = tokens in `after` not in `before` (model-invented => the route REJECTS).
 *   removed = tokens in `before` not in `after` (dropped => the route WARNS).
 * Pure; never throws.
 */
export function diffCitations(before: string, after: string): CitationDiff {
  const b = extractCitationTokenMap(before);
  const a = extractCitationTokenMap(after);
  const added: CitationToken[] = [];
  const removed: CitationToken[] = [];
  for (const [key, tok] of a) if (!b.has(key)) added.push(tok);
  for (const [key, tok] of b) if (!a.has(key)) removed.push(tok);
  return { added, removed };
}

/** Human-readable summary of a citation token for a rejection/warning message. */
export function describeToken(t: CitationToken): string {
  return t.raw;
}
