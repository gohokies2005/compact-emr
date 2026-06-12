'use strict';

/**
 * viabilityGrounding — task (f): "Ask Aegis consults the viability engine".
 *
 * When the RN/physician asks a VIABILITY-shaped question ("is an OSA claim viable
 * if service-connected for PTSD, and why not the knee?"), this module calls the
 * DETERMINISTIC viability engine (anchorMechanism.assessClaimViability) and formats
 * its output as a clearly-labeled FACTS block that the advisory retrieve() layer
 * injects ABOVE the retrieved corpus context. The ENGINE decides the band + anchor;
 * the model only EXPLAINS the block in plain RN language (system-prompt rule).
 *
 * DESIGN INVARIANTS (per the architect plan + design doc):
 *   - DETERMINISTIC + NO LLM. isViabilityQuery() and extractSlots() are pure regex.
 *   - PHI-FREE. We pass only free-text condition labels to the engine.
 *   - NO BVA / IMO / win-rate / grant% anywhere in the FACTS block. The viability
 *     engine is the mechanism-authority; BVA stats are a SEPARATE (stats_lookup) path.
 *   - FAIL-OPEN. If the engine abstains, the table is absent, or anything throws,
 *     we return a one-line "deterministic viability data not available" note and the
 *     caller continues with corpus-only retrieval. We NEVER fabricate a band and
 *     NEVER crash the ask-path.
 *   - FLAG-GATED at the call site (retrieve.js / index.js) on AEGIS_VIABILITY_GROUNDING.
 *     This module itself does no flag check (so it is unit-testable directly); the
 *     consumer gates.
 *
 * The require here is the WHOLE point of the keystone extraction: anchorMechanism
 * pulls conditionCanon (pure) + the vendored anchor_mechanism_pairs.json ONLY — no
 * better-sqlite3 / DB / llm-client — so this module is safe to vendor into the
 * standalone Lambda zip.
 */

const { resolveCondition } = require('./bvaConditionMatch');

let _assess = null;
/** Lazy-require so a missing/broken engine degrades to fail-open rather than a load-time crash. */
function _engine() {
  if (_assess === null) {
    // eslint-disable-next-line global-require
    _assess = require('../anchorMechanism').assessClaimViability;
  }
  return _assess;
}

// ── (a) detector ────────────────────────────────────────────────────────────
// A viability question asks whether a claimed condition can be service-connected
// (often "secondary to" / "anchored on" an SC condition), or names an anchor/
// pathway/framing decision. Deliberately permissive but NOT email-shaped: the
// caller only invokes this when the routed intent is viability-relevant, so the
// detector's job is to confirm the question is about WHETHER A PAIRING/CLAIM WORKS,
// which is exactly what the engine answers.
// NOTE: `connect(?:ed|ion|ing|s)?` not `connect\b` — a trailing \b lands MID-WORD
// on "service-connectED" (the most common phrasing) and the match silently fails
// (live smoke 2026-06-11: PTSD->HTN grounded as causation because the detector
// never fired). `secondary` (not just "secondary to") so "claim X as secondary"
// counts. The AND with _CLAIM_RE keeps it from over-firing.
const _VIABILITY_RE = /\b(viab(?:le|ility)|service[\s-]?connect(?:ed|ion|ing|s)?|secondary|anchor|pathway|connect(?:ed|ion|ing|s)?\b.*\bto\b|aggravat|proximately due to|why not\b)\b/i;
const _CLAIM_RE = /\b(claim|case|condition|secondary|viab(?:le|ility)|connect(?:ed|ion|ing|s)?|anchor|pathway|service[\s-]?connect(?:ed|ion|ing|s)?)\b/i;

/** True when the text is asking whether a claim/pairing is viable / how it anchors. */
function isViabilityQuery(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  return _VIABILITY_RE.test(t) && _CLAIM_RE.test(t);
}

// ── (b) deterministic slot extraction (NO LLM) ──────────────────────────────
// Returns { claimed, grantedScs[] }. We reuse the SAME pair-parse shapes the
// advisory retrieve.parsePair uses, plus an explicit "service-connected for X /
// SC for X / granted X" scan to collect granted anchors named in the question.
// Everything is run through resolveCondition (the advisory synonym map) so the
// engine gets recognizable labels; un-resolvable fragments are dropped (the
// engine itself also tolerates raw text, but resolving keeps the FACTS clean).

// "claimed secondary to / due to / from / caused by / aggravated by upstream"
const _SECONDARY_RE = /(.*?)\b(?:secondary to|due to|proximately due to|caused by|aggravated by|from)\s+(.+)/i;
// "is an X claim viable" / "viability of X" / "can we service-connect X"
const _CLAIMED_LEAD_RE = /\b(?:is (?:an?|the)?|viability of|service[\s-]?connect(?:ion)? (?:for|of)?|connect(?:ing)?)\s+([a-z][a-z0-9 /,'-]{2,60}?)\s+(?:claim|case|condition|viable|secondary|to\b|service)/i;
// "claim(s/ing) X (as secondary)" — condition is the object of "claim". Stops at
// "as secondary"/"secondary to"/"to"/comma/end so it doesn't swallow the anchor.
const _CLAIM_X_RE = /\bclaim(?:s|ing)?\s+(?:that\s+)?(?:his|her|their|the|a|an)?\s*([a-z][a-z0-9 /'-]{2,50}?)\s*(?:\bas\b|\bsecondary\b|\bto\b|,|\.|$)/i;

// granted-SC anchors named in the question: "service-connected for X", "SC for X",
// "granted X", "rated for X", "if (already) service connected for X".
const _GRANTED_RES = [
  /\b(?:service[\s-]?connected|sc'?d?|s\/c)\s+(?:for|to)\s+([a-z][a-z0-9 /,'-]{2,60})/ig,
  /\bgranted\s+(?:sc\s+for\s+)?([a-z][a-z0-9 /,'-]{2,60})/ig,
  /\brated\s+for\s+([a-z][a-z0-9 /,'-]{2,60})/ig,
  // REVERSED order: "X (is) service-connected" / "X is SC". The (?!for|to)
  // lookahead means this never double-fires on the forward "service-connected
  // FOR X" form above. _cleanFragment + resolveCondition drop a captured subject
  // word ("veteran", "he") since it won't resolve to a condition.
  /\b([a-z][a-z0-9 /'-]{2,40}?)\s+(?:is\s+|are\s+|already\s+)*(?:service[\s-]?connected|sc'?d?|s\/c)\b(?!\s+(?:for|to)\b)/ig,
];

// stop-words that should terminate a captured condition fragment (so we don't
// swallow "PTSD and why not the knee" into one anchor).
function _cleanFragment(s) {
  return String(s || '')
    .replace(/\b(and|but|or|why|so|because|since|when|if|while|,|\.|\?).*$/i, '')
    .replace(/^(the|a|an|his|her|their|my|our)\s+/i, '')
    .trim();
}

/** Pull every condition-looking fragment after "why not / what about / not the X" — these are
 *  anchors the asker is interrogating ("why not the knee?"). Add them to grantedScs so the engine
 *  ranks them and the FACTS block can explain why they're weaker/excluded. */
const _WHYNOT_RE = /\b(?:why not|what about|not the|instead of|rather than|how about)\s+(?:the\s+)?([a-z][a-z0-9 /,'-]{2,40})/ig;

function _resolveAll(fragments) {
  const out = [];
  const seen = new Set();
  for (const f of fragments) {
    const cleaned = _cleanFragment(f);
    if (!cleaned) continue;
    const canon = resolveCondition(cleaned) || cleaned;
    const key = canon.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canon);
  }
  return out;
}

function extractSlots(text) {
  const t = String(text || '');
  let claimed = null;
  const grantedScs = [];

  // 1) "claimed secondary to upstream" — left=claimed, right=upstream(granted).
  const sec = t.match(_SECONDARY_RE);
  if (sec) {
    claimed = _cleanFragment(sec[1].replace(/.*\b(?:is|of|the|an?)\s+/i, ''));
    grantedScs.push(...sec[2].split(/\b(?:and|,)\b/));
  }

  // 2) lead-in "is an X claim viable" if we didn't get a claimed yet.
  if (!claimed) {
    const lead = t.match(_CLAIMED_LEAD_RE);
    if (lead) claimed = _cleanFragment(lead[1]);
  }

  // 2b) "claim(s/ing) X as secondary" / "claim X" — condition AFTER "claim"
  // (the common "wants to claim hypertension as secondary" shape the lead-in
  // pattern misses because it expects the condition BEFORE "claim").
  if (!claimed) {
    const cl = t.match(_CLAIM_X_RE);
    if (cl) claimed = _cleanFragment(cl[1]);
  }

  // 3) explicit granted-SC anchors named in the question.
  for (const re of _GRANTED_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t)) !== null) grantedScs.push(m[1]);
  }

  // 4) "why not the knee?" interrogated anchors -> also candidate granted SCs.
  _WHYNOT_RE.lastIndex = 0;
  let w;
  while ((w = _WHYNOT_RE.exec(t)) !== null) grantedScs.push(w[1]);

  const claimedCanon = claimed ? (resolveCondition(_cleanFragment(claimed)) || _cleanFragment(claimed)) : null;
  const granted = _resolveAll(grantedScs).filter((g) => !claimedCanon || g.toLowerCase() !== claimedCanon.toLowerCase());

  return { claimed: claimedCanon, grantedScs: granted };
}

// ── (c) buildViabilityFacts ─────────────────────────────────────────────────
// Calls assessClaimViability(claimed, grantedScs) INFO-LIGHT (no chartFactsPresent)
// and returns { block, raw, available }. `block` is the formatted FACTS string the
// caller injects above the corpus; `available` is false on fail-open (engine
// abstained / table absent / threw) so the caller injects the one-line not-available
// note instead.

function _fmtAlt(a) {
  // explain WHY an alternative is weaker without any BVA number.
  const tierWhy = {
    excluded: 'excluded (no credible mechanism in this direction)',
    plausible: 'long-tail / mechanism unconfirmed',
    chain: 'contingent (needs an intermediate record to bridge)',
    conditional: 'conditional (needs a supporting record confirmed)',
    moderate: 'a recognized but weaker path',
    weak: 'weak anchor',
  };
  const why = tierWhy[a.tier] || `tier ${a.tier}`;
  return `${a.upstream_canonical} — weaker here (${why})`;
}

function buildViabilityFacts(text) {
  let slots;
  try { slots = extractSlots(text); }
  catch (e) { return { block: _notAvailable('could not parse the claim/anchor from the question'), raw: null, available: false }; }

  if (!slots.claimed) {
    return { block: _notAvailable('no claimed condition identified in the question'), raw: null, available: false };
  }

  let v;
  try {
    const assess = _engine();
    v = assess(slots.claimed, slots.grantedScs);
  } catch (e) {
    return { block: _notAvailable('the deterministic viability engine was unavailable'), raw: null, available: false };
  }

  // Fail-open on abstain or no usable band (table absent/stub also returns abstain).
  if (!v || v.viability === 'abstain') {
    return { block: _notAvailable(v && v.why ? v.why : 'the engine could not place a band'), raw: v || null, available: false };
  }

  const lines = [];
  lines.push('=== DETERMINISTIC VIABILITY FACTS (ground truth from the FRN viability engine — EXPLAIN these, do not override) ===');
  lines.push(`Claimed condition: ${v.claimed_canonical || slots.claimed}`);
  if (slots.grantedScs.length) lines.push(`Granted SC anchors considered: ${slots.grantedScs.join('; ')}`);
  lines.push(`Viability band: ${v.viability}`);
  if (v.best_anchor && v.best_anchor.upstream_canonical) {
    const ba = v.best_anchor;
    lines.push(`Best anchor: ${ba.upstream_canonical}${ba.tier ? ` (tier ${ba.tier})` : ''}${ba.basis ? `, basis ${ba.basis}` : ''}.`);
    // Loud, unmissable aggravation-only flag — the `why` alone did not stop the
    // model from framing causation (live smoke 2026-06-11).
    if (ba.aggravation_only) {
      lines.push('AGGRAVATION ONLY: the VA reliably denies direct CAUSATION for this pairing. Frame it ONLY as aggravation under 38 CFR 3.310(b), as a secondary argument. Do NOT say the anchor CAUSES the claimed condition; say it AGGRAVATES a pre-existing/constitutional condition.');
    }
  } else {
    lines.push('Best anchor: none on the named granted conditions.');
  }
  if (v.why) lines.push(`Why: ${v.why}`);
  if (v.missing_fact) lines.push(`Record that would strengthen it: ${v.missing_fact}`);

  // "why not X" — the alternatives (weaker) + the excluded traps (hard no).
  const alts = Array.isArray(v.alternatives) ? v.alternatives.filter((a) => a && a.upstream_canonical) : [];
  if (alts.length) lines.push(`Other named anchors, and why they are weaker: ${alts.map(_fmtAlt).join('; ')}.`);
  const traps = Array.isArray(v.excluded_traps) ? v.excluded_traps.filter((t) => t && t.upstream_canonical) : [];
  if (traps.length) lines.push(`Excluded anchors (why NOT these): ${traps.map((t) => `${t.upstream_canonical} — ${t.reason}`).join('; ')}.`);

  if (v.presumptive_redirect) {
    lines.push(`Presumptive note: ${v.presumptive_redirect.note}${v.presumptive_redirect.advisory ? ' (advisory)' : ''}.`);
  }
  if (v.graveyard_redirect) {
    lines.push(`Redirect: avoid ${v.graveyard_redirect.dead_anchor}; argue ${v.graveyard_redirect.redirect_to} instead. ${v.graveyard_redirect.rationale}`);
  }
  lines.push('(This block carries NO BVA/win-rate figures by design — it is the mechanism-and-anchor ground truth. Explain it in plain RN/physician language; do not assert a stronger band, and do not invent an anchor not listed here.)');

  return { block: lines.join('\n'), raw: v, available: true };
}

// The engine-empty message is a HARD directive, but a CONDITIONAL one (Phase 3b,
// 2026-06-11): "abstain on absence of GROUND, not absence of a table row." It must
// NEVER let the model assert a band the engine did not give — that invariant is
// absolute and unchanged. But it no longer hard-stops unconditionally: if the
// retrieved corpus or the live PubMed pull genuinely covers the pairing, the model
// may give a clearly-labeled grounded read (cite the source, NO band, "grounded
// reasoning, not a validated pathway — physician confirm", escalate). Only when
// nothing in front of it covers the pairing does it fall to the plain-language stop.
// The reason-vs-stop choice is made by the PIPELINE from the retrieval signal
// (retrieve.js: semantic-covered / pubmed_live) and enforced mechanically by the
// answer-path backstop (sanitizeAnswer) — this text just keeps the FACTS block from
// contradicting the system prompt's conditional rule.
function _notAvailable(reason) {
  return [
    '=== DETERMINISTIC VIABILITY FACTS ===',
    `THE VIABILITY ENGINE PLACED NO BAND FOR THIS PAIRING (reason: ${reason}).`,
    'ABSOLUTE: do NOT assert or imply a viability band, a percentage, or a table-style verdict — the engine',
    'gave none, so you have none. Never free-reason a band from your own training.',
    'THEN, based ONLY on what is actually in front of you:',
    '- If the RETRIEVED CONTEXT below (or a live PubMed pull) genuinely covers these conditions, you MAY give',
    '  a grounded read FROM THAT MATERIAL: cite the exact PMID(s)/source(s), give NO band, and label it',
    '  "grounded reasoning, not a validated/blessed pathway — have Dr. Ryan confirm." Treat as needs-more-info',
    '  and escalate. Quote only what is provided; never reconstruct a study/PMID/stat from memory.',
    '- If nothing on-topic was retrieved and no PubMed papers came back, STOP: a short plain-language alert',
    '  that this pairing is not in our references so you cannot give a backed answer, run it by Dr. Ryan /',
    '  the Team Lead. No jargon, no field names.',
    '(If the question was merely vague about WHICH condition or anchor, ask them to name it instead.)',
  ].join('\n');
}

module.exports = { isViabilityQuery, extractSlots, buildViabilityFacts };
