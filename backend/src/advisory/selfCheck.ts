// Ask Aegis pre-send self fact-check (Ryan 2026-06-19): a cheap, reliable pass over the model's answer
// BEFORE it lands, to catch the highest-leakage mistakes. Layer 1 is DETERMINISTIC ($0, instant, no
// latency — safe on the 29s-capped request path): it catches the KNOWN-bad / fabrication patterns with
// regex over the answer + the retrieved chunks. (Layer 2 — a cheap LLM grounding check — is a planned
// fail-open enhancement; kept OUT of the synchronous path for now to avoid a second-call timeout, per the
// SOAP 29s lesson. Ask Aegis is staff-gated — RN/physician reviews before any veteran-facing use — so
// Layer 1 + the human gate already drive veteran-facing leakage near zero.)
//
// Asymmetric: default PASS, flag only genuine problems. BLOCK-class flags (BVA-% leakage, a fabricated
// citation, an excluded-pair suggestion) prepend a loud VERIFY banner; soft flags append a caveat. Never
// throws (a self-check must not itself break the answer).

export interface SelfCheckResult {
  readonly blocked: boolean;       // a block-class issue → the answer carries a loud VERIFY banner
  readonly caveats: readonly string[]; // human-readable flags appended to the answer + logged
  readonly flags: readonly string[];   // machine tags for logging/metrics
}

export interface SelfCheckChunk { readonly text: string; readonly citation: string; readonly source: string }

// CLAUDE.md #17: aggregate BVA win/grant/IMO % + the "pair-atlas" term are FORBIDDEN in any vet-facing or
// letter content (our unpublished regex, no PMID, adversarially indefensible). Catch them leaking into an answer.
const BVA_LEAK = /\bpair[- ]?atlas\b|\b\d{1,3}\s?%\s*(?:imo[- ]?adjusted|win|grant|success|favorab)/i;
const BVA_LEAK_2 = /\bBVA\b[^.]{0,40}\b\d{1,3}\s?%/i;
// A claimed PubMed citation — high-signal fabrication marker if it isn't in the retrieved material.
const PMID = /\bPMID:?\s*(\d{6,9})\b/gi;
// Veteran-facing forbidden content the deterministic cleaner may not fully catch (belt + suspenders).
const REFUND_50 = /\$?\s*50[- ]?(?:dollar)?\s*(?:record[- ]?review\s*)?(?:fee\s*)?refund|refund[^.]{0,30}\$?\s*50\b/i;
const DR_RYAN_PERSONALLY = /Dr\.?\s*Ryan\s+(?:personally|himself)\b/i;

function norm(s: string): string { return (s ?? '').toLowerCase(); }

/**
 * Deterministic Layer-1 self-check. `excludedPairHints` is an optional list of "upstream→claimed"
 * phrasings the engine has marked NEVER-argue (reverse-causation / pyramiding); if any appears in the
 * answer it's a block-class flag. Pure + synchronous; $0; never throws.
 */
export function runSelfCheck(
  answer: string,
  chunks: readonly SelfCheckChunk[],
  excludedPairHints: readonly string[] = [],
): SelfCheckResult {
  const caveats: string[] = [];
  const flags: string[] = [];
  let blocked = false;
  try {
    const a = answer ?? '';
    const an = norm(a);

    // 1. BVA-% / pair-atlas leakage → BLOCK (must never reach a veteran or a letter).
    if (BVA_LEAK.test(a) || BVA_LEAK_2.test(a)) {
      blocked = true; flags.push('bva_pct_leak');
      caveats.push('This answer referenced an internal BVA/win-rate statistic that must NOT go to a veteran or into a letter — remove it before using this.');
    }

    // 2. Fabricated PubMed citation → flag if the PMID is not in the retrieved material.
    const corpus = norm(chunks.map((c) => `${c.text} ${c.citation}`).join('\n'));
    const pmids = [...a.matchAll(PMID)].map((m) => m[1]);
    const fabricatedPmids = pmids.filter((p) => !corpus.includes(p));
    if (fabricatedPmids.length > 0) {
      flags.push('fabricated_pmid');
      caveats.push(`A cited PMID (${fabricatedPmids.slice(0, 3).join(', ')}) is not in our retrieved library — verify it exists before relying on or quoting it.`);
    }

    // 3. Excluded-pair mention → SOFT caveat (NOT block). The picker plan + prompt deliberately tell the
    //    model to NAME an excluded anchor when answering "why not X" ("the knee won't work here because…"),
    //    so a compliant, correct answer legitimately contains the excluded name. A bare substring match
    //    would false-BLOCK exactly the answer we asked for (QA 2026-06-19, architect edge bug). So only
    //    flag — and only when the name appears WITHOUT nearby exclusion/negation phrasing (i.e. it reads
    //    like advocacy, not a "why not"). Block-class stays reserved for content that must not ship verbatim
    //    (BVA-%, $50-refund, fabricated PMID). The human review gate is the backstop here.
    const NEGATION_NEARBY = /\b(why not|won'?t work|does(?:n'?t| not) work|off the table|excluded?|rule[ds]? out|not (?:a )?(?:viable|supported|credible|good)|wrong (?:way|direction)|pyramid|reverse|avoid)\b/i;
    if (!NEGATION_NEARBY.test(a)) {
      for (const hint of excludedPairHints) {
        const h = norm(hint);
        if (h.length >= 6 && an.includes(h)) {
          flags.push('excluded_pair_mentioned');
          caveats.push(`This answer names ${hint}, which the engine excludes — double-check it is explaining WHY NOT to argue it, not suggesting it as a pathway.`);
          break;
        }
      }
    }

    // 4. Veteran-facing forbidden content (belt + suspenders over the deterministic cleaner).
    if (REFUND_50.test(a)) { blocked = true; flags.push('refund_50'); caveats.push('Remove the $50-refund line — the review fee is never offered or mentioned to a veteran.'); }
    if (DR_RYAN_PERSONALLY.test(a)) { flags.push('dr_ryan_personally'); caveats.push('Use the team / board-certified-physician voice, not "Dr. Ryan personally".'); }
  } catch {
    // A self-check must never break the answer — fail open to "no flags".
    return { blocked: false, caveats: [], flags: ['selfcheck_error'] };
  }
  return { blocked, caveats, flags };
}

/** Compose the checked answer: a loud VERIFY banner for block-class, a quiet caveat block otherwise. */
export function applySelfCheck(answer: string, r: SelfCheckResult): string {
  if (r.caveats.length === 0) return answer;
  if (r.blocked) {
    return `⚠️ VERIFY BEFORE USING — automated check flagged this answer:\n- ${r.caveats.join('\n- ')}\n\n---\n${answer}`;
  }
  return `${answer}\n\n— Automated check note: ${r.caveats.join(' ')}`;
}
