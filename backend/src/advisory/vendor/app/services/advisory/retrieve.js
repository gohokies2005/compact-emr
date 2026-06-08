'use strict';

/**
 * retrieve(input, { pgClient, bedrockClient }) -> Promise<RetrievalResult>   [§5 FROZEN CONTRACT]
 *
 * THE SEAM the EMR ask-path calls. REAL implementation (semantic wired to live pgvector).
 *   - pgClient.query(text, params) runs as advisory_ro (SELECT-only on advisory.ref_chunk). The EMR
 *     SETs ROLE advisory_ro before calling. retrieve() reads ONLY ref_chunk — the chart NEVER flows
 *     through here (input.caseConditions are already-extracted routing-canonical keys the EMR passes).
 *   - bedrockClient = a BedrockRuntimeClient; used ONLY to Titan-v2-embed the query (same model/dims as
 *     the indexed docs — must match).
 *
 * Stress-test hardening (2026-06-07 findings) baked in:
 *   - COVERAGE = library-folder-resolve (a ref_chunk row exists for the asked condition) OR top cosine
 *     >= RELEVANCE_FLOOR. Not a bare cosine floor (knee->back scored 0.43 and would false-flag no-coverage).
 *   - A BVA stat is attached ONLY when a real upstream->claimed PAIR is identified (pairLookup). psychRollup
 *     is used ONLY when the question is explicitly about a psychiatric anchor — never a blind rollup that
 *     surfaces a wrong-pair number.
 *   - No coverage -> live PubMed pull (real PMIDs) + a coverage_gap for the library-build roadmap; never
 *     anchor on off-topic chunks, never fabricate.
 *
 * RetrievalResult = { status, mode_ran, errors, chunks, stats?, notes, coverage_gap? }
 * RUNTIME: needs the Titan-v2 embed (bedrockClient) + NCBI egress (eutils) for the PubMed fallback.
 */

const { classify } = require('./intentRouter');
const { resolveCondition } = require('./bvaConditionMatch');
const { pairLookup, psychRollup } = require('./bvaPairLookup');
const { livePubmedLookup } = require('./advisoryLiteratureLookup');

const SEM_K = 8;             // semantic top-k
const RELEVANCE_FLOOR = 0.40; // cosine; below this AND no folder match = no coverage (calibrated 2026-06-07)
const PSYCH_RE = /\b(psych|psychiatric|mental health|mental-health|any psych)\b/i;

// ---- BVA stat helpers ------------------------------------------------------
/** Parse "claimed secondary to/from upstream" into both conditions (stub-grade; the LLM also parses). */
function parsePair(question) {
  const q = question || '';
  // "claimed secondary to / due to / from / caused by / aggravated by upstream"  (left=claimed, right=upstream)
  let m = q.match(/(.*?)\b(?:secondary to|due to|from|caused by|aggravated by|proximately due to)\s+(.*)/i);
  if (m) return { claimed: resolveCondition(m[1]), upstream: resolveCondition(m[2]) };
  // "upstream to / -> claimed"  (stats phrasing, e.g. "win rate for PTSD to OSA")  (left=upstream, right=claimed)
  m = q.match(/(.*?)\s+(?:->|→|\bto\b)\s+(.*)/i);
  if (m) { const up = resolveCondition(m[1]); const cl = resolveCondition(m[2]); if (up && cl && up !== cl) return { claimed: cl, upstream: up }; }
  return { claimed: resolveCondition(q), upstream: null };
}
function toStats(r) {
  return {
    n: r.n, tier: r.tier, grant_pct: r.grant_pct,
    display_grant_pct: r.display_grant_pct != null ? r.display_grant_pct : r.grant_pct,
    win_pct: r.win_pct, imo_n: r.imo_n, imo_grant_pct: r.imo_grant_pct, imo_win_pct: r.imo_win_pct,
    basis: r.basis, relative_signal_only: true,
    shrunk_grant_pct: r.shrunk_grant_pct, directionality: r.directionality,
    directionality_reliable: r.directionality_reliable, wins_without_us: r.wins_without_us,
  };
}
function statsChunk(r) {
  const rate = r.display_grant_pct != null ? r.display_grant_pct : r.grant_pct;
  const imo = r.imo_quotable ? ` With a private IMO (n=${r.imo_n}): ${r.imo_grant_pct}%.` : '';
  const dir = (r.directionality != null && r.directionality_reliable)
    ? ` Direction: grants more than the reverse (log-odds ${r.directionality}).` : '';
  return {
    text: `${r.upstream} -> ${r.claimed}: ${rate}% grant rate among ${r.n} cases (tier ${r.tier}).${imo}${dir} `
      + 'RELATIVE RANKING SIGNAL ONLY — not a win probability; mechanism gates framing first; internal strategy, never in the letter or to the veteran.',
    source: 'sql', citation: 'BVA pair atlas (internal aggregate)',
    metadata: { upstream: r.upstream, claimed: r.claimed, n: r.n, tier: r.tier, wins_without_us: r.wins_without_us, caveats: r.caveats || [] },
    letter_citable: false,
  };
}
/** Resolve a BVA stat ONLY for a real pair (or an explicit psych-anchor question). Never a wrong-pair row.
 *  PRECEDENCE: an EXPLICIT pair named in the QUESTION wins — the RN asked about THAT pair, not whatever
 *  case happens to be bound. caseConditions are a FALLBACK only when the question does not name a pair.
 *  (Bug fix 2026-06-07: the old chart-first precedence let an unrelated bound case override the asked pair,
 *  so "stats for migraines secondary to OSA" returned NULL — or a wrong pair — on any non-matching case.) */
function resolveStat(question, caseConditions) {
  const parsed = parsePair(question);
  // The question explicitly named upstream -> claimed: honor it, never let the bound chart override it.
  if (parsed.upstream && parsed.claimed) { const r = pairLookup(parsed.upstream, parsed.claimed); return r.found ? r : null; }
  // Vague question -> fall back to the bound chart conditions to infer the pair.
  const claimed = (caseConditions.length ? resolveCondition(caseConditions[caseConditions.length - 1]) : null) || parsed.claimed;
  const upstream = (caseConditions.length >= 2 ? resolveCondition(caseConditions[0]) : null) || parsed.upstream;
  if (upstream && claimed && upstream !== claimed) { const r = pairLookup(upstream, claimed); return r.found ? r : null; }
  if (claimed && PSYCH_RE.test(question)) { const r = psychRollup(claimed); return r.found ? r : null; }
  return null; // no clear pair -> attach NO stat (do not force a rollup)
}

// ---- semantic (live pgvector) ----------------------------------------------
async function embedQuery(bedrockClient, text, InvokeModelCommand) {
  // InvokeModelCommand is INJECTED by the EMR wrapper so esbuild bundles the SDK into the Lambda — this
  // vendored module is loaded OUTSIDE the bundle and can't resolve @aws-sdk at runtime (would crash
  // MODULE_NOT_FOUND). Falls back to require() for local/non-Lambda use. [EMR drop-in edit 2026-06-07.]
  const Cmd = InvokeModelCommand || require('@aws-sdk/client-bedrock-runtime').InvokeModelCommand;
  const body = JSON.stringify({ inputText: String(text).slice(0, 8000), dimensions: 1024, normalize: true });
  const res = await bedrockClient.send(new Cmd({
    modelId: 'amazon.titan-embed-text-v2:0', contentType: 'application/json', accept: 'application/json', body,
  }));
  const out = JSON.parse(Buffer.from(res.body).toString('utf8'));
  return out.embedding;
}
async function semanticSearch(pgClient, qvec, caseConditions) {
  const qstr = '[' + qvec.join(',') + ']';
  // folder-check: does the curated library cover an asked condition? (strong coverage signal)
  let folderCovered = false;
  if (caseConditions && caseConditions.length) {
    const fc = await pgClient.query('SELECT 1 FROM advisory.ref_chunk WHERE condition = ANY($1) LIMIT 1', [caseConditions]);
    folderCovered = (fc.rows || []).length > 0;
  }
  const where = folderCovered ? 'WHERE condition = ANY($2)' : '';
  const params = folderCovered ? [qstr, caseConditions] : [qstr];
  const sql = `SELECT id, text, source, citation, condition, library_path, letter_citable, `
    + `1 - (embedding <=> $1::vector) AS score FROM advisory.ref_chunk ${where} `
    + `ORDER BY embedding <=> $1::vector LIMIT ${SEM_K}`;
  const res = await pgClient.query(sql, params);
  const chunks = (res.rows || []).map((row) => ({
    text: row.text, source: row.source || 'semantic', citation: row.citation,
    metadata: { id: row.id, condition: row.condition, library_path: row.library_path, score: Number(row.score) },
    letter_citable: row.letter_citable !== false,
  }));
  const topScore = chunks.length ? chunks[0].metadata.score : 0;
  return { chunks, folderCovered, topScore };
}

// ---- main ------------------------------------------------------------------
async function retrieve(input, clients = {}) {
  const { question = '', caseConditions = [] } = input || {};
  const { pgClient, bedrockClient, InvokeModelCommand } = clients;
  const errors = [], notes = [], chunks = [], mode_ran = [];
  let stats, coverage_gap;

  let routed;
  try { routed = classify(question, { hasCaseBound: caseConditions.length > 0 }); }
  catch (e) { return { status: 'degraded', mode_ran: [], errors: [`classify failed: ${e.message}`], chunks: [], notes: [] }; }
  const sources = (routed.recipe && routed.recipe.sources) || [];
  notes.push(`intent=${routed.intent} (${routed.confidence})`);

  // --- BVA stats (atlas; file-based, decided-only) — only for a real pair ---
  if (sources.includes('pair_atlas') || sources.includes('condition_atlas') || sources.includes('live_sql')) {
    mode_ran.push('sql');
    try { const r = resolveStat(question, caseConditions); if (r) { chunks.push(statsChunk(r)); stats = toStats(r); notes.push(...(r.caveats || [])); } }
    catch (e) { errors.push(`stats failed: ${e.message}`); }
  }

  // --- semantic (LIVE pgvector) ---
  let covered = true;
  let semanticRan = false; // did the semantic backend actually execute? (vs. missing/errored)
  if (sources.includes('library') || sources.includes('cfr') || sources.includes('case_law')) {
    mode_ran.push('semantic');
    if (!pgClient || !bedrockClient) {
      errors.push('semantic unavailable: pgClient/bedrockClient not injected'); // backend outage, NOT no-coverage
    } else {
      try {
        const qvec = await embedQuery(bedrockClient, question, InvokeModelCommand);
        const sem = await semanticSearch(pgClient, qvec, caseConditions);
        semanticRan = true;
        covered = sem.folderCovered || sem.topScore >= RELEVANCE_FLOOR;
        if (covered) { chunks.push(...sem.chunks); notes.push(`semantic: ${sem.chunks.length} chunks, top=${sem.topScore.toFixed(3)}${sem.folderCovered ? ', folder-covered' : ''}`); }
        else notes.push(`semantic: weak (top=${sem.topScore.toFixed(3)} < ${RELEVANCE_FLOOR}, no folder) — treating as no coverage`);
      } catch (e) { errors.push(`semantic failed: ${e.message}`); } // errored, NOT confirmed no-coverage
    }

    // --- CONFIRMED no curated coverage (semantic ran, found nothing) -> live PubMed + gap.
    // Do NOT fire on a backend outage — that would mask a wiring bug as a no-coverage condition.
    if (semanticRan && !covered) {
      const cond = (caseConditions[caseConditions.length - 1]) || resolveCondition(question) || question;
      try {
        const pm = await livePubmedLookup(cond);
        if (pm.chunks.length) { chunks.push(...pm.chunks); notes.push(...pm.notes); mode_ran.push('pubmed_live'); }
        else notes.push(...pm.notes);
        coverage_gap = { condition: cond, pubmed_pmids: pm.chunks.map((c) => c.metadata.pmid), reason: 'no curated library coverage' };
      } catch (e) { errors.push(`pubmed fallback failed: ${e.message}`); coverage_gap = { condition: cond, pubmed_pmids: [], reason: 'no coverage; pubmed errored' }; }
    }
  }

  // --- exact (canonical_facts / playbook served via the cached system prompt) ---
  if (sources.includes('canonical_facts') || sources.includes('email_playbook') || sources.includes('email_text')) {
    mode_ran.push('exact');
    notes.push('[exact] canonical_facts + Email Playbook are served via the cached system prompt; no vector lookup.');
  }

  // --- status ---
  const semanticRequested = sources.includes('library') || sources.includes('cfr') || sources.includes('case_law');
  const hasPubmed = chunks.some((c) => c.source === 'pubmed_live');
  const hasReal = chunks.some((c) => !c.metadata || !c.metadata.stub);
  let status;
  if (semanticRequested && !semanticRan && !hasPubmed) status = 'degraded'; // backend down/unavailable, no fallback fired
  else if (coverage_gap && !hasPubmed && !stats) status = 'empty';          // confirmed no coverage, nothing to show
  else if (hasReal || mode_ran.includes('exact')) status = 'ok';
  else status = 'thin';

  return { status, mode_ran, errors, chunks, stats, notes, coverage_gap };
}

module.exports = { retrieve, parsePair, resolveStat, RELEVANCE_FLOOR };
