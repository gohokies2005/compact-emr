import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * DOC-SET EXCLUSION CLOSURE — source-scanning meta-test (doc-set closure + sweep hardening, 2026-06-14).
 *
 * WHY THIS TEST EXISTS — the screening-summary / intake-summary wedge class (2026-06-13/14):
 * The chart extractor mints a SYNTHETIC OUTPUT document onto the case — the screening-summary
 * (Document docTag='screening_summary', s3Key marker '00000000-screening-summary.txt'). It is an
 * OUTPUT of extraction, not an OCR INPUT: ocr-start skips it, so it NEVER gets a terminal
 * FileReadStatus. THREE separate bugs (Jamarious 2026-06-13, then the reprocess + doctor-pack gates)
 * came from a per-case document-SET gate FORGETTING to exclude it:
 *   - the all-terminal extract trigger wedged at 'ocr_in_progress' FOREVER (the summary never goes terminal),
 *   - reprocess futilely re-OCR'd it every run,
 *   - the doctor pack tried to source pages from a 0-page synthetic doc,
 *   - and feeding it back to the extractor lets the model re-read its own summary.
 *
 * The canonical exclusion is ONE of:
 *   - `isScreeningSummaryKey(<key>)`  (the s3Key marker predicate, exported from chart-build-state.ts), or
 *   - filtering on `docTag` `=== / !== 'screening_summary'` (the Document tag).
 * It already lives at computeTriggerHash / deriveChartBuildState / chart-extract-docs / the extract
 * trigger / reprocess / the stuck-doc watcher / doctor-pack-generate.
 *
 * This test GREPS the backend source for every site that materializes a per-CASE document SET from the
 * DB — i.e. a `*.document.findMany({ where: { caseId ... } })` (or the `caseId: { in: [...] }` veteran-
 * scoped variant), and a `<caseRow>.documents` member read off a Case loaded with select/include
 * documents — and asserts the ENCLOSING FUNCTION ALSO references the canonical exclusion. A site that
 * legitimately needs ALL documents is on the ALLOW_LIST with a justification. A NEW ungated doc-set
 * query (the next forgotten-marker wedge) FAILS this test with its file:line.
 *
 * Scope discipline (so it doesn't false-positive on every findMany): comments + string literals are
 * stripped before scanning (a `// Case.documents` prose mention is not a query). Enrichment lookups
 * keyed by EXPLICIT s3Keys (`where: { s3Key: { in } }`) and the raw veteran file-browser list are NOT
 * the wedge surface and are allow-listed. `document.findUnique` (a single doc) is never a set gate.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(here, '..'); // backend/src

// The canonical exclusion tokens — a site is "gated" if ANY appears in the enclosing function body.
const EXCLUSION_TOKENS = [
  'isScreeningSummaryKey',
  "docTag !== 'screening_summary'",
  "docTag === 'screening_summary'",
  'SCREENING_SUMMARY_KEY_MARKER',
];

/**
 * ALLOW_LIST — sites that legitimately query a per-case doc set WITHOUT the exclusion. Keyed by
 * `relPath#functionHint` (a substring of the enclosing-function signature/name we detect). EACH needs
 * a reason. Adding here is deliberate; the test's value is that a NEW ungated site NOT here fails.
 */
// Each entry: a per-case doc-set site that legitimately needs ALL docs. Matched by relPath + a
// fnHint substring that appears in the ENCLOSING BLOCK's body (ORIGINAL text), so it survives line drift.
const ALLOW_LIST: ReadonlyArray<{ readonly relPath: string; readonly fnHint: string; readonly reason: string }> = [
  {
    relPath: 'routes/documents.ts',
    fnHint: 'case: { veteranId }',
    reason:
      'GET /veterans/:id/documents is the raw file-browser list — it INTENTIONALLY shows every document ' +
      '(including the synthetic screening-summary) so ops can see/download it. Not a gate; never wedges.',
  },
  {
    relPath: 'routes/chart-readiness.ts',
    fnHint: 'liveKeys',
    reason:
      'The per-case readiness + files-pending-manual routes use docs ONLY to build a liveKeys SET that ' +
      'reconciles AGAINST FileReadStatus rows. The screening-summary has NO FileReadStatus row, so it can ' +
      'never match a row and cannot leak into the pending list — safe by construction.',
  },
  {
    relPath: 'routes/chart-readiness.ts',
    fnHint: 'reconcileChartReadiness(rows, docs)',
    reason:
      'GET /chart-readiness now delegates the liveKeys reconcile to the shared reconcileChartReadiness ' +
      'helper (CLM-4DACAF4A80) — docs feed ONLY that intersection-against-FileReadStatus. The synthetic ' +
      'screening-summary has no FileReadStatus row so it cannot leak into the verdict. Same safe-by-' +
      'construction reconcile as the `liveKeys` entry; the exclusion is the no-matching-row invariant.',
  },
  {
    relPath: 'routes/chart-readiness.ts',
    fnHint: 'candidateCaseIds',
    reason:
      'RN cross-case files-pending-manual — same liveKeys-reconcile-against-FileReadStatus construction over ' +
      'candidateCaseIds; the summary has no FileReadStatus row so it cannot surface. Safe by construction.',
  },
  {
    relPath: 'routes/chart-readiness.ts',
    fnHint: 'computeExtractionCoverage(docs, rows, latestRun',
    reason:
      'GET /cases/:id/extraction-coverage (transparency report, 2026-06-14). The route loads the full ' +
      'per-case doc set ONLY to pass it to computeExtractionCoverage, which EXCLUDES the synthetic ' +
      'screening-summary (and _rendered outputs) up front via isChartInputKey → isScreeningSummaryKey ' +
      'before any page accounting. Exclusion lives in the called pure helper, not this route body — same ' +
      'pattern as the drafter-bundle entry; advisory report, never a gate, never wedges.',
  },
  {
    relPath: 'services/doctor-pack-grounded-pages.ts',
    fnHint: 'caseDocumentIds',
    reason:
      'caseDocumentIds is a MEMBERSHIP set used to confirm an extracted-fact row (sourceDocumentId) belongs ' +
      'to the case. The synthetic summary has 0 pages and is never a fact source, so its presence in the set ' +
      'is inert — no fact row ever points at it. Safe by construction.',
  },
  {
    relPath: 'services/chart-readiness.ts',
    fnHint: 'loadReconciledChartReadiness',
    reason:
      'THE shared reconciled-readiness loader (CLM-4DACAF4A80). Uses the per-case documents ONLY to build a ' +
      'liveKeys SET that reconcileChartReadiness intersects with FileReadStatus rows. The synthetic ' +
      'screening-summary has NO FileReadStatus row, so it can never match a row and cannot leak into the ' +
      'gate verdict — same safe-by-construction reconcile as the routes/chart-readiness.ts `liveKeys` entry.',
  },
  {
    relPath: 'services/drafter-bundle.ts',
    fnHint: 'buildDrafterBundle',
    reason:
      'The GATE decision (chartReadiness.extractionState) is computed via deriveChartBuildState → ' +
      'computeTriggerHash, which EXCLUDES the summary by marker — so the wedge surface is already gated in ' +
      'the called helper. The raw documents[] payload deliberately carries ALL of the veteran\'s docs ' +
      '(returning-customer reuse, Ryan 2026-06-04); the synthetic summary has 0 DocumentPage rows so it is ' +
      'inert page-content to the drafter. Exclusion lives in the helper, not this function body.',
  },
  {
    relPath: 'advisory/chartSlice.ts',
    fnHint: 'buildDigestForCase',
    reason:
      'Ask-Aegis live-pull digest. The screening-summary Document has ZERO DocumentPage rows (OCR is skipped ' +
      'for it), so it contributes no page text to the digest — at most a header line naming the synthetic doc. ' +
      'Low-risk (advisory, not a gate; never wedges). RECOMMENDED CHEAP FOLLOW-UP: add a docTag !== ' +
      "'screening_summary' filter here too so the model never even sees the header. Out of scope for this sweep.",
  },
];

// ── Comment + string stripping so prose/strings never trip the scanner ──
// Replaces // line comments, /* block */ comments, and '..'/".."/`..` literals with same-length blanks
// (newlines preserved) so char offsets + line numbers stay stable.
function stripCommentsAndStrings(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (from: number, to: number) => { for (let k = from; k < to && k < n; k += 1) { if (out[k] !== '\n') out[k] = ' '; } };
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      let j = i + 2;
      while (j < n && src[j] !== '\n') j += 1;
      blank(i, j); i = j; continue;
    }
    if (c === '/' && c2 === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
      j = Math.min(n, j + 2);
      blank(i, j); i = j; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) { j += 1; break; }
        j += 1;
      }
      // keep the quote delimiters; blank the inside so EXCLUSION_TOKENS' own string literals (which we
      // search for in the ORIGINAL text, see below) are unaffected by this — we scan exclusion tokens
      // against the ORIGINAL source, and query-shape detection against the STRIPPED source.
      blank(i + 1, j - 1); i = j; continue;
    }
    i += 1;
  }
  return out.join('');
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * Find the brace-delimited body that ENCLOSES `index` and return its [start,end) char range. Walks
 * backward to the nearest unmatched '{' then forward to its match. Falls back to a generous line
 * window if brace matching fails (defensive — never throws).
 */
function enclosingBlock(stripped: string, index: number): { start: number; end: number } {
  // Walk back to the opening brace of the function/block we're inside.
  let depth = 0;
  let start = -1;
  for (let i = index; i >= 0; i -= 1) {
    const ch = stripped[i];
    if (ch === '}') depth += 1;
    else if (ch === '{') {
      if (depth === 0) { start = i; break; }
      depth -= 1;
    }
  }
  if (start === -1) return { start: Math.max(0, index - 1500), end: Math.min(stripped.length, index + 1500) };
  // Walk forward to the matching close brace.
  let d = 0;
  let end = stripped.length;
  for (let i = start; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (ch === '{') d += 1;
    else if (ch === '}') { d -= 1; if (d === 0) { end = i + 1; break; } }
  }
  return { start, end };
}

interface Site {
  readonly relPath: string;
  readonly absPath: string;
  readonly index: number; // char offset of the matched query
  readonly line: number;
  readonly shape: 'findMany' | 'caseDocsMember';
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      out.push(...walkTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const FIND_MANY_RE = /\bdocument\.findMany\s*\(/g;
const CASE_DOCS_MEMBER_RE = /\b\w*[cC]ase\w*\.documents\b/g;

/**
 * Is THIS document.findMany a per-CASE document SET? We look at the small slice right after the
 * `findMany(` for the where-shape. Per-case = `where: { caseId` (incl. `caseId: { in` ). We EXCLUDE:
 *   - `where: { s3Key: { in` (explicit-key enrichment, can't pull the summary unless already curated),
 *   - `findUnique` (a single doc — never reached here; regex is findMany only).
 * Returns 'percase' | 'enrichment' | 'other'.
 */
function findManyShape(stripped: string, afterParenIndex: number): 'percase' | 'enrichment' | 'other' {
  const slice = stripped.slice(afterParenIndex, afterParenIndex + 220);
  if (/where:\s*\{\s*s3Key:\s*\{\s*in/.test(slice)) return 'enrichment';
  if (/where:\s*\{\s*caseId\b/.test(slice)) return 'percase';
  if (/where:\s*\{\s*case:\s*\{\s*veteranId/.test(slice)) return 'percase'; // veteran file-browser (allow-listed)
  return 'other';
}

function findDocSetSites(): Site[] {
  const files = walkTsFiles(SRC_ROOT);
  const sites: Site[] = [];
  for (const file of files) {
    const original = readFileSync(file, 'utf8');
    const stripped = stripCommentsAndStrings(original);
    const relPath = path.relative(SRC_ROOT, file).split(path.sep).join('/');

    FIND_MANY_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FIND_MANY_RE.exec(stripped)) !== null) {
      const after = m.index + m[0].length;
      const shape = findManyShape(stripped, after);
      if (shape !== 'percase') continue; // only per-case set queries are the wedge surface
      sites.push({ relPath, absPath: file, index: m.index, line: lineOf(original, m.index), shape: 'findMany' });
    }

    CASE_DOCS_MEMBER_RE.lastIndex = 0;
    while ((m = CASE_DOCS_MEMBER_RE.exec(stripped)) !== null) {
      // `<caseRow>.documents` read off a DB-loaded case. Only count it once per enclosing block (the
      // first member read) and only when the enclosing block actually loaded documents from the DB
      // (a `documents:` select/include appears in the block) — avoids type-decl / repeated-read noise.
      const blk = enclosingBlock(stripped, m.index);
      const blockText = stripped.slice(blk.start, blk.end);
      if (!/documents:\s*\{/.test(blockText)) continue; // not a DB-loaded case-with-docs
      sites.push({ relPath, absPath: file, index: m.index, line: lineOf(original, m.index), shape: 'caseDocsMember' });
    }
  }
  return sites;
}

/** Does the enclosing function/block reference a canonical exclusion token (in the ORIGINAL source)? */
function blockHasExclusion(original: string, stripped: string, index: number): boolean {
  const blk = enclosingBlock(stripped, index);
  const blockText = original.slice(blk.start, blk.end);
  return EXCLUSION_TOKENS.some((tok) => blockText.includes(tok));
}

/**
 * Allow-list match: relPath + a fnHint substring found in the enclosing block (ORIGINAL text), with a
 * couple of synthetic hints for the two chart-readiness routes (distinguished by their route path).
 */
function isAllowListed(original: string, stripped: string, site: Site): { allowed: boolean; reason?: string } {
  const blk = enclosingBlock(stripped, site.index);
  // Widen ~200 chars before the block open-brace so the function SIGNATURE (its name, e.g.
  // buildDigestForCase) is in scope for the hint match, not just the body.
  const blockText = original.slice(Math.max(0, blk.start - 200), blk.end);
  for (const entry of ALLOW_LIST) {
    if (site.relPath !== entry.relPath) continue;
    if (blockText.includes(entry.fnHint)) return { allowed: true, reason: entry.reason };
  }
  return { allowed: false };
}

describe('doc-set exclusion closure (screening-summary wedge guard)', () => {
  const sites = findDocSetSites();

  it('finds the known per-case doc-set query sites (sanity: the scanner is actually scanning)', () => {
    // If this collapses the regex/walk/shape-filter broke and every other assertion is vacuous.
    expect(sites.length).toBeGreaterThanOrEqual(6);
  });

  it('every per-case document-SET query references the screening-summary exclusion (or is allow-listed)', () => {
    const offenders: string[] = [];
    for (const site of sites) {
      const original = readFileSync(site.absPath, 'utf8');
      const stripped = stripCommentsAndStrings(original);
      if (blockHasExclusion(original, stripped, site.index)) continue;
      if (isAllowListed(original, stripped, site).allowed) continue;
      offenders.push(
        `${site.relPath}:${site.line} (${site.shape}) — per-case document-set query whose enclosing ` +
          `function does NOT reference the screening-summary exclusion, and is not on the ALLOW_LIST. ` +
          `Add the exclusion (isScreeningSummaryKey / docTag !== 'screening_summary') or, if this site ` +
          `legitimately needs ALL documents, add it to ALLOW_LIST with a justification.`,
      );
    }
    expect(offenders, `\n${offenders.join('\n')}`).toEqual([]);
  });

  // ── Detector self-proof: demonstrate the test WOULD catch a regression ──
  it('DETECTOR PROOF: a planted ungated per-case `document.findMany({ where: { caseId } })` is flagged', () => {
    const planted = [
      'export async function leakyNewGate(db, caseId) {',
      '  const docs = await db.document.findMany({ where: { caseId }, select: { s3Key: true } });',
      '  return docs.map((d) => d.s3Key);',
      '}',
    ].join('\n');
    const stripped = stripCommentsAndStrings(planted);
    FIND_MANY_RE.lastIndex = 0;
    const m = FIND_MANY_RE.exec(stripped);
    expect(m).not.toBeNull();
    // shape is per-case
    expect(findManyShape(stripped, m!.index + m![0].length)).toBe('percase');
    // enclosing block has NO exclusion token → would be reported
    expect(blockHasExclusion(planted, stripped, m!.index)).toBe(false);
    expect(isAllowListed(planted, stripped, { relPath: 'routes/leaky.ts', absPath: '', index: m!.index, line: 2, shape: 'findMany' }).allowed).toBe(false);
  });

  it('DETECTOR PROOF: the SAME query WITH the exclusion in the enclosing function is NOT flagged', () => {
    const gated = [
      'export async function gatedGate(db, caseId) {',
      '  const all = await db.document.findMany({ where: { caseId }, select: { s3Key: true } });',
      '  const docs = all.filter((d) => !isScreeningSummaryKey(d.s3Key));',
      '  return docs.map((d) => d.s3Key);',
      '}',
    ].join('\n');
    const stripped = stripCommentsAndStrings(gated);
    FIND_MANY_RE.lastIndex = 0;
    const m = FIND_MANY_RE.exec(stripped);
    expect(blockHasExclusion(gated, stripped, m!.index)).toBe(true);
  });

  it('DETECTOR PROOF: a prose mention of `Case.documents` in a comment is NOT counted as a query', () => {
    const prose = [
      'export async function notAQuery(db, id) {',
      '  // accessed read-side through Case.documents in other routes',
      '  const doc = await db.document.findUnique({ where: { id } });',
      '  return doc;',
      '}',
    ].join('\n');
    const stripped = stripCommentsAndStrings(prose);
    // The comment text is blanked → the member regex finds nothing; findUnique is not findMany.
    CASE_DOCS_MEMBER_RE.lastIndex = 0;
    expect(CASE_DOCS_MEMBER_RE.exec(stripped)).toBeNull();
    FIND_MANY_RE.lastIndex = 0;
    expect(FIND_MANY_RE.exec(stripped)).toBeNull();
  });

  it('DETECTOR PROOF: an s3Key-keyed enrichment findMany is classified enrichment, not per-case', () => {
    const enrich = 'const docs = await db.document.findMany({ where: { s3Key: { in: keys } }, select: { id: true } });';
    const stripped = stripCommentsAndStrings(enrich);
    FIND_MANY_RE.lastIndex = 0;
    const m = FIND_MANY_RE.exec(stripped);
    expect(findManyShape(stripped, m!.index + m![0].length)).toBe('enrichment');
  });
});
