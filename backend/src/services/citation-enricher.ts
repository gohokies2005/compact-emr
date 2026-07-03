/**
 * Citation Enricher service — Feature B (2026-06-24). The physician requests grounded medical
 * citations (real, verified PubMed PMIDs) for an existing letter, previews candidates, and on
 * approval the verified citations are deterministically inserted into Section VIII (and an optional
 * grounding sentence into Section VI) as a new letter version.
 *
 * SAFETY KEYSTONE: every PMID and every "killer stat" comes from NCBI via the vendored
 * citationFallback module (backend/src/vendor/citationFallback.cjs, vendored verbatim from FRN), which
 * holds the anti-fabrication invariants (PMID from esearch, killer_finding a verbatim abstract
 * substring, retraction reject, never throws). This module is the THIN typed adapter around it plus:
 *   - a STRICT-SCHEMA Haiku call that maps a highlighted claim sentence to SEARCH TERMS ONLY (the
 *     schema has NO citation/pmid field, so the model cannot invent a cite — it can only steer the
 *     NCBI search); and
 *   - the DETERMINISTIC insertion (no LLM weave) that adds a numbered §VIII reference + an optional
 *     PMID-anchored §VI sentence. The insertion adds ONLY the verified PMIDs (no embedded statistic),
 *     so the apply-side diffCitationsSanctioned can prove the citation delta equals the sanctioned set.
 *
 * The retrieval is several serial NCBI round-trips → the route runs it ASYNC and the physician polls.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { resolveAnthropicApiKey } from './letter-surgical-propose.js';

// ── Vendored citationFallback loader (createRequire from the anchor-vendor tree) ───────────────
// Identical pattern to case-viability.ts: the CJS module is loaded at RUNTIME from disk (api-stack
// copies backend/src/vendor → <task>/anchor-vendor; the same dir holds anchorMechanism.cjs etc.).
// citationFallback is pure Node `https` with no data files, so it would also bundle — but the
// runtime-load keeps it consistent with the rest of the vendor tree and needs no esbuild config.
const VENDOR_DIR = process.env['ANCHOR_VENDOR_DIR'] ?? 'anchor-vendor';

/** One grounded anchor the vendored module returns. */
export interface GroundedAnchor {
  slot: 'A1' | 'A2' | 'A3';
  slot_label: string;
  pmid: string;
  title: string;
  journal: string;
  year: string;
  full_citation: string;
  killer_finding: string;
  source: string;
  title_match: boolean;
}
export interface RetrieveResult {
  condition: string;
  status: 'grounded' | 'no_data' | 'invalid_condition' | 'network_error';
  anchors: GroundedAnchor[];
  trace: unknown[];
  retrieved_at: string;
}
/** The shape of a single-PMID re-verify (verifyPmidById). `verified` gates everything downstream. */
export interface VerifyResult {
  verified: boolean;
  pmid: string;
  title: string;
  journal: string;
  year: string;
  killer_finding: string;
  /** House-format reference line (Author. Title. Journal. Year;Vol(Issue):Pages) built from the SAME
   * esummary metadata as a grounded anchor. Present on a verified result; used to insert a §VIII
   * reference that matches the existing numbered entries exactly (Spring §VIII formatting fix). */
  full_citation?: string;
  reason?: string;
  error?: string;
}
interface CitationFallbackModule {
  retrieveGroundedAnchors(condition: string, opts?: { mechanismHints?: string[] }): Promise<RetrieveResult>;
  verifyPmidById(pmid: string, claimedCondition?: string): Promise<VerifyResult>;
}

let _fallback: CitationFallbackModule | null = null;
function loadCitationFallback(): CitationFallbackModule {
  if (_fallback !== null) return _fallback;
  const candidates = [
    path.join(process.cwd(), VENDOR_DIR, 'citationFallback.cjs'), // Lambda runtime (anchor-vendor copy)
    path.join(process.cwd(), 'src', 'vendor', 'citationFallback.cjs'), // backend/ cwd (vitest, tsx dev)
    path.join(process.cwd(), 'backend', 'src', 'vendor', 'citationFallback.cjs'), // repo-root cwd
  ];
  const entry = candidates.find((c) => existsSync(c));
  if (entry === undefined) {
    throw new Error(`citationFallback vendor module not found (tried: ${candidates.join(' | ')})`);
  }
  const req = createRequire(path.join(process.cwd(), '_anchor_require_base.cjs'));
  _fallback = req(entry) as CitationFallbackModule;
  return _fallback;
}

/** Grounded NCBI retrieval. Never throws (the vendored module catches all network/parse errors). */
export async function retrieveGroundedAnchors(condition: string, mechanismHints?: string[]): Promise<RetrieveResult> {
  return loadCitationFallback().retrieveGroundedAnchors(condition, mechanismHints && mechanismHints.length > 0 ? { mechanismHints } : {});
}

/**
 * Apply-time SERVER-SIDE re-verify of a single PMID against NCBI (re-fetch + confirm real,
 * non-retracted, on-topic, with a verbatim killer stat). NEVER trust a client 'verified' flag —
 * this is the authoritative check the apply endpoint runs on every selected PMID. Never throws.
 */
export async function verifyPmidById(pmid: string, condition?: string): Promise<VerifyResult> {
  return loadCitationFallback().verifyPmidById(pmid, condition);
}

// ── Claim → SEARCH TERMS (strict-schema Haiku) ─────────────────────────────────────────────────
const TERMS_MODEL = 'claude-3-5-haiku-latest';

// The tool schema extracts SEARCH TERMS ONLY. There is deliberately NO pmid / citation / author /
// year field — the model literally cannot emit a citation, only a condition string + optional
// mechanism phrases that steer the grounded NCBI search. This is the anti-fabrication guarantee at
// the term-mapping step: the model never names a paper; NCBI returns every PMID.
const EXTRACT_TERMS_TOOL: Anthropic.Tool = {
  name: 'search_terms',
  description: 'Extract the medical search terms (condition + optional mechanism phrases) from a clinical claim sentence. Output search terms ONLY — never a citation, author, year, or PMID.',
  input_schema: {
    type: 'object',
    properties: {
      condition: { type: 'string', description: 'the single core medical condition or relationship to search PubMed for (e.g. "obstructive sleep apnea" or "PTSD hypertension")' },
      mechanismHints: { type: 'array', items: { type: 'string' }, description: 'optional short mechanism phrases that focus the search (e.g. "sympathetic activation", "intermittent hypoxia"). 0-3 items.' },
    },
    required: ['condition'],
  },
};

const EXTRACT_TERMS_SYSTEM = [
  'You map a highlighted sentence from a VA nexus letter (a medical opinion) to PubMed SEARCH TERMS.',
  'Return ONLY the search_terms tool: a single core condition/relationship string + up to 3 optional mechanism phrases.',
  'You are NOT citing or recalling any paper. Do not output an author, a year, a PMID, or a study name — only the terms a librarian would type into PubMed. The actual citations come from a grounded NCBI search downstream.',
].join('\n');

export interface ExtractedTerms { condition: string; mechanismHints: string[]; }

/** Build a Haiku-backed claim→terms extractor from an API key. Injected for test stubbing. */
export type TermsExtractor = (claim: string) => Promise<ExtractedTerms>;

export function makeTermsExtractor(apiKey: string): TermsExtractor {
  const anthropic = new Anthropic({ apiKey });
  return async (claim: string): Promise<ExtractedTerms> => {
    const resp = await anthropic.messages.create({
      model: TERMS_MODEL,
      max_tokens: 300,
      system: EXTRACT_TERMS_SYSTEM,
      tools: [EXTRACT_TERMS_TOOL],
      tool_choice: { type: 'tool', name: 'search_terms' },
      messages: [{ role: 'user', content: `HIGHLIGHTED CLAIM:\n${claim}` }],
    });
    // Forced tool_choice means a well-formed call ends with stop_reason 'tool_use'. Treat anything
    // else (end_turn with no tool block, max_tokens, refusal) as a failure to extract — the caller
    // falls back to using the raw claim/condition as the search term (still grounded by NCBI).
    if (resp.stop_reason !== 'tool_use' && resp.stop_reason !== 'end_turn') {
      throw new Error(`terms extractor: unexpected stop_reason ${String(resp.stop_reason)}`);
    }
    const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUse === undefined) throw new Error('terms extractor: model returned no structured terms');
    const raw = toolUse.input as { condition?: unknown; mechanismHints?: unknown };
    if (typeof raw.condition !== 'string' || raw.condition.trim() === '') {
      throw new Error('terms extractor: malformed tool input (no condition)');
    }
    const hints = Array.isArray(raw.mechanismHints)
      ? raw.mechanismHints.map((h) => String(h ?? '').trim()).filter((h) => h.length > 0).slice(0, 3)
      : [];
    return { condition: raw.condition.trim(), mechanismHints: hints };
  };
}

/**
 * Lazily-resolved terms extractor for production — the Anthropic key is fetched on first use and
 * cached (mirrors makeSurgicalProposerFromEnv). Mount whenever ANTHROPIC_API_KEY or
 * API_ANTHROPIC_KEY_SECRET_ARN is set; absent → the route never offers the claim-mapping step and
 * uses the operator-supplied condition directly.
 */
export function makeTermsExtractorFromEnv(): TermsExtractor {
  let delegate: TermsExtractor | null = null;
  let resolving: Promise<TermsExtractor> | null = null;
  async function ensure(): Promise<TermsExtractor> {
    if (delegate) return delegate;
    if (!resolving) {
      resolving = resolveAnthropicApiKey()
        .then((key) => { delegate = makeTermsExtractor(key); return delegate; })
        .catch((e: unknown) => { resolving = null; throw e; });
    }
    return resolving;
  }
  return async (claim: string): Promise<ExtractedTerms> => (await ensure())(claim);
}

// ── Candidate shape the poll returns (preview) ─────────────────────────────────────────────────
export interface EnrichCandidate {
  pmid: string;
  title: string;
  journal: string;
  year: string;
  killer_finding: string;
  pubmedUrl: string;
  slot: 'A1' | 'A2' | 'A3';
}

export function pubmedUrl(pmid: string): string {
  return `https://pubmed.ncbi.nlm.nih.gov/${String(pmid).replace(/\D/g, '')}/`;
}

/** Map grounded anchors to preview candidates (preview-only; never trusted at apply). */
export function anchorsToCandidates(anchors: readonly GroundedAnchor[]): EnrichCandidate[] {
  return anchors.map((a) => ({
    pmid: a.pmid,
    title: a.title,
    journal: a.journal,
    year: a.year,
    killer_finding: a.killer_finding,
    pubmedUrl: pubmedUrl(a.pmid),
    slot: a.slot,
  }));
}

// ── DIRECT-PMID resolver (Feature B complement, 2026-07-02) ────────────────────────────────────
// The physician types an EXACT PubMed ID (not a claim/condition to search). We fetch + VERIFY that
// one paper against NCBI and return it in the SAME EnrichCandidate shape the claim-search path uses,
// so the preview + apply UI + sanctioned-PMID plumbing are reused verbatim.
//
// KEYSTONE (anti-fabrication, medico-legal): the citation is added ONLY if NCBI returns it for that
// exact PMID — every metadata field comes FROM verifyPmidById's esummary/efetch, NEVER from the raw
// input. verifyPmidById already holds the invariants (real PMID + non-retracted + grounded verbatim
// killer stat). We call it WITHOUT a condition, so the claimed-condition ON-TOPIC gate is SKIPPED:
// the physician's explicit PMID choice is the relevance authority (a foundational/mechanism paper
// need not name the condition), and the frontend citationMayBeOffTopic advisory + the physician's
// judgment cover relevance. Anti-fabrication is never relaxed — only the relevance heuristic is.
// This mirrors the apply-time re-verify discipline (same verifyPmidById), so a PMID that resolves
// here also passes at apply (the by-PMID job stores condition:'' so apply skips on-topic too).

/** The verifier seam (verifyPmidById in prod; a stub in tests). Injected so the resolver is testable
 *  without the vendored NCBI module / any network. */
export type PmidVerifier = (pmid: string, condition?: string) => Promise<VerifyResult>;

/** Outcome of a by-PMID resolve. `ok` carries a preview candidate (same shape as a claim-search
 *  candidate); every other status is a clear, non-fabricating failure the route turns into a message. */
export type PmidResolveResult =
  | { status: 'ok'; candidate: EnrichCandidate }
  | { status: 'invalid_pmid' | 'pmid_not_found' | 'retracted' | 'not_grounded'; pmid: string; reason?: string };

/**
 * Build a by-PMID resolver over an injected verifier. Normalizes the PMID to bare digits, verifies it
 * against NCBI (no condition → no on-topic gate), and maps a verified result to an EnrichCandidate.
 * Never throws (verifyPmidById never throws). A non-existent/unreadable/retracted PMID yields a clear
 * status — NEVER a fabricated citation.
 */
export function makeResolveCitationByPmid(verify: PmidVerifier): (pmid: string) => Promise<PmidResolveResult> {
  return async (pmid: string): Promise<PmidResolveResult> => {
    const clean = String(pmid ?? '').replace(/\D/g, '').replace(/^0+/, '');
    if (clean.length === 0) return { status: 'invalid_pmid', pmid: '' };
    // NO condition argument → verifyPmidById does NOT run the on-topic gate (physician's explicit choice).
    const v = await verify(clean);
    if (!v.verified) {
      const reason = v.reason ?? 'unverified';
      // Map the vendored reject reason to a caller-facing status. no_summary/invalid_pmid == NCBI has
      // no such record; retracted == reject; anything else (no_abstract / no_grounded_stat / efetch or
      // network error) == real record but not groundable/reachable right now.
      const status: Exclude<PmidResolveResult['status'], undefined> =
        reason === 'retracted' ? 'retracted'
          : (reason === 'no_summary' || reason === 'invalid_pmid') ? 'pmid_not_found'
            : 'not_grounded';
      return { status, pmid: clean, reason };
    }
    const candidate: EnrichCandidate = {
      pmid: v.pmid,
      title: v.title,
      journal: v.journal,
      year: v.year,
      killer_finding: v.killer_finding,
      pubmedUrl: pubmedUrl(v.pmid),
      slot: 'A2', // not a slot-search result; a neutral placeholder (the shape requires a slot).
    };
    return { status: 'ok', candidate };
  };
}

/** Production by-PMID resolver — verifies against NCBI via the vendored citationFallback module. */
export const resolveCitationByPmid = makeResolveCitationByPmid(verifyPmidById);

// ── DETERMINISTIC insertion (no LLM weave) ─────────────────────────────────────────────────────
// Build the §VIII reference line for a verified citation in the house numbered format
// (`<N>. Author. Title. Journal. Year;...` is the canonical FRN entry, but the grounded module
// already produced a `full_citation`; here we just NUMBER it). We add ONLY the citation — never a
// statistic — so the citation delta the sanctioned-diff sees is exactly the inserted PMIDs.
export interface VerifiedCitationForInsert {
  pmid: string;
  title: string;
  journal: string;
  year: string;
  killer_finding: string;
  /** House-format reference body (Author. Title. Journal. Year;Vol(Issue):Pages) from the grounded
   * module. When present, buildReferenceLine uses it verbatim so the inserted §VIII entry matches the
   * existing numbered references exactly. Absent → fall back to the degraded title/journal/year form. */
  full_citation?: string;
}

// Build a §VIII reference line in the FRN HOUSE FORMAT (Spring §VIII formatting fix, 2026-06-25):
//   N. Author(s). Title. Journal. Year;Volume(Issue):Pages. PMID: NNNN.
// The grounded module's `full_citation` already carries "Author. Title. Journal. Year;Vol(Issue):Pages"
// (built by buildCitation from NCBI esummary — the SAME shape as the existing numbered entries), so we
// number it and append the PMID. Only when full_citation is missing (older verify result) do we fall
// back to the prior degraded title/journal/year line. We add ONLY the citation — never a statistic —
// so the apply-side diffCitationsSanctioned sees a citation delta equal to exactly the inserted PMIDs.
function buildReferenceLine(n: number, c: VerifiedCitationForInsert): string {
  const fc = (c.full_citation ?? '').trim().replace(/\.+$/, '');
  if (fc.length > 0) {
    return `${n}. ${fc}. PMID: ${c.pmid}.`;
  }
  // Fallback (no full_citation): the prior shape, still numbered + PMID-tagged.
  const title = c.title.replace(/\.+$/, '');
  const yr = c.year ? ` ${c.year}` : '';
  return `${n}. ${title}. ${c.journal}.${yr} PMID: ${c.pmid}.`;
}

/** Find the highest leading "<N>." number already in the references block so we append, not collide. */
function maxRefNumber(referencesBlock: string): number {
  let max = 0;
  for (const m of referencesBlock.matchAll(/^\s*(\d+)\.\s/gm)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

export interface InsertResult {
  /** The new full letter text with the citations appended to §VIII as numbered references. */
  newText: string;
  /** The PMIDs actually inserted (bare digits) — the SANCTIONED set the diff is checked against. */
  insertedPmids: string[];
}

// Section VIII header forms we anchor on. The FRN house letter uses "VIII. References" (sometimes
// bolded markdown). We match the first such header and append numbered lines under that block.
const SECTION_VIII_RE = /(^|\n)(\*{0,2}\s*(?:VIII\.|Section\s+VIII\b)[^\n]*References[^\n]*\*{0,2})\s*\n/i;

/**
 * Deterministically insert the verified citations as numbered §VIII references.
 *
 * BUG 2 FIX (Spring, 2026-06-25): the enricher NO LONGER appends a generic "the opinion is further
 * supported by additional peer-reviewed literature" sentence to Section VI. Whether the physician
 * searched by a HIGHLIGHTED PASSAGE or by a CONDITION, the result is the SAME: real, numbered §VIII
 * references in the house format (Bug 1). A throwaway §VI sentence was worthless (Dr. Kasky on
 * Spring's letter) — it added no specific finding and read as filler. If the physician wants the
 * actual finding woven into §VI prose, they use the Guided Revision tool to reference the now-present
 * §VIII PMID (which the Bug 4 cross-reference allowance now permits).
 *
 *   - §VIII: append a numbered reference line per citation (continuing the existing numbering). If no
 *     §VIII header is found we append a new "VIII. References" block at the end of the letter.
 *
 * Pure string assembly; never an LLM. Returns the new text + the bare-digit PMIDs inserted.
 *
 * `opts.groundInSectionVi` is accepted for call-site backward compatibility but is now a NO-OP — the
 * generic §VI grounding sentence was removed (Bug 2). It is retained so existing callers/tests do not
 * break; it can be deleted once the route + frontend stop passing it.
 */
export function insertVerifiedCitations(
  letterText: string,
  citations: readonly VerifiedCitationForInsert[],
  _opts: { groundInSectionVi?: boolean } = {},
): InsertResult {
  const insertedPmids = citations.map((c) => String(c.pmid).replace(/\D/g, '').replace(/^0+/, '')).filter((p) => p.length > 0);
  if (citations.length === 0) return { newText: letterText, insertedPmids: [] };

  let text = letterText;

  // ── §VIII references ──
  const vMatch = SECTION_VIII_RE.exec(text);
  if (vMatch !== null) {
    // Find the end of the §VIII block: from the header to the next blank-line-separated section or EOF.
    const headerEnd = (vMatch.index ?? 0) + vMatch[0].length;
    // The references block runs to the next double-newline that precedes a non-reference line, or EOF.
    const rest = text.slice(headerEnd);
    // Conservatively treat everything from headerEnd to EOF as the references block (refs are last in
    // the canonical letter). Count existing numbers there to continue the sequence.
    const startNum = maxRefNumber(rest) + 1 || 1;
    const lines = citations.map((c, i) => buildReferenceLine(startNum + i, c));
    // Append after the existing references, ensuring exactly one trailing newline separation.
    const trimmedRest = rest.replace(/\s*$/, '');
    const joiner = trimmedRest.length > 0 ? '\n' : '';
    text = text.slice(0, headerEnd) + trimmedRest + joiner + lines.join('\n') + '\n';
  } else {
    // No §VIII — append a fresh references block at the end.
    const lines = citations.map((c, i) => buildReferenceLine(i + 1, c));
    text = text.replace(/\s*$/, '') + '\n\nVIII. References\n' + lines.join('\n') + '\n';
  }

  return { newText: text, insertedPmids };
}
