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
const { pickAdvisoryFolders } = require('./advisoryFolderPicker');
// COVERAGE-GATE MODE. Off (default) = the legacy cosine RELEVANCE_FLOOR decides curated coverage. On =
// an LLM (Haiku) picks the library folder(s) by meaning (synonym/alt-name robust) — folder hit => use it,
// miss => live PubMed. Fail-open to the cosine path, so flipping this on can only ADD decisions.
const FOLDER_PICKER_ON = process.env.ADVISORY_FOLDER_PICKER === 'on';
const { isViabilityQuery, buildViabilityFacts } = require('./viabilityGrounding');
const { selectByQuota } = require('./sourceQuota');

// Task (f): when AEGIS_VIABILITY_GROUNDING is on AND the question is viability-shaped,
// inject the DETERMINISTIC viability engine's FACTS block ABOVE the corpus context.
// DARK by default (flag off). Fail-open: a non-available block degrades to a one-line
// note; the engine never crashes the ask-path and never fabricates a band.
const VIABILITY_GROUNDING_ON = process.env.AEGIS_VIABILITY_GROUNDING === 'true';

const SEM_K = 8;             // legacy semantic top-k (superseded by SEM_CANDIDATES/SEM_CAP below)
const SEM_CANDIDATES = 24;   // WIDE candidate pull so per-source-type quotas have material to draw from
const SEM_CAP = 11;          // final chunk cap after quota selection (cost guard: ~5-10c/call at this width)
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
async function embedQuery(bedrockClient, text) {
  const { InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
  const body = JSON.stringify({ inputText: String(text).slice(0, 8000), dimensions: 1024, normalize: true });
  const res = await bedrockClient.send(new InvokeModelCommand({
    modelId: 'amazon.titan-embed-text-v2:0', contentType: 'application/json', accept: 'application/json', body,
  }));
  const out = JSON.parse(Buffer.from(res.body).toString('utf8'));
  return out.embedding;
}
async function semanticSearch(pgClient, qvec) {
  const qstr = '[' + qvec.join(',') + ']';
  // PURE embedding kNN — the QUESTION's embedding finds the right condition's chunks.
  // Do NOT hard-filter by the chart's problem list (caseConditions): an osteoarthritis question on a
  // veteran who ALSO has hypertension was getting HTN-only literature because the WHERE filter restricted
  // to the bound chart's conditions instead of the asked one. (Bug fix 2026-06-07.) At 1,316 chunks the
  // kNN is fast + accurate; coverage is judged by cosine, not by the chart.
  const sql = `SELECT id, text, source, citation, condition, library_path, letter_citable, `
    + `1 - (embedding <=> $1::vector) AS score FROM advisory.ref_chunk `
    + `ORDER BY embedding <=> $1::vector LIMIT ${SEM_CANDIDATES}`;
  const res = await pgClient.query(sql, [qstr]);
  const chunks = (res.rows || []).map((row) => ({
    text: row.text, source: row.source || 'semantic', citation: row.citation,
    metadata: { id: row.id, condition: row.condition, library_path: row.library_path, score: Number(row.score) },
    letter_citable: row.letter_citable !== false,
  }));
  const topScore = chunks.length ? chunks[0].metadata.score : 0;
  return { chunks, topScore };
}
// Same kNN as semanticSearch but SCOPED to the LLM-picked folder(s): the picker decided coverage, so we
// take the best chunks WITHIN those folders, ranked by the question embedding. No cosine floor applies —
// coverage was already decided by the folder pick, not by similarity.
async function semanticSearchInFolders(pgClient, qvec, folders) {
  const qstr = '[' + qvec.join(',') + ']';
  const sql = `SELECT id, text, source, citation, condition, library_path, letter_citable, `
    + `1 - (embedding <=> $1::vector) AS score FROM advisory.ref_chunk `
    + `WHERE library_path = ANY($2) ORDER BY embedding <=> $1::vector LIMIT ${SEM_CANDIDATES}`;
  const res = await pgClient.query(sql, [qstr, folders]);
  return (res.rows || []).map((row) => ({
    text: row.text, source: row.source || 'semantic', citation: row.citation,
    metadata: { id: row.id, condition: row.condition, library_path: row.library_path, score: Number(row.score) },
    letter_citable: row.letter_citable !== false,
  }));
}

// ---- main ------------------------------------------------------------------
async function retrieve(input, clients = {}) {
  const { question = '', caseConditions = [] } = input || {};
  const { pgClient, bedrockClient } = clients;
  // Injected by realRetrieve (kept out of a top-level require so the vendored module doesn't hard-depend
  // on @aws-sdk at load). Fall back to a local require for the standalone/test path.
  const InvokeModelCommand = clients.InvokeModelCommand
    || (() => { try { return require('@aws-sdk/client-bedrock-runtime').InvokeModelCommand; } catch (_) { return null; } })();
  const errors = [], notes = [], chunks = [], mode_ran = [];
  let stats, coverage_gap;

  let routed;
  try { routed = classify(question, { hasCaseBound: caseConditions.length > 0 }); }
  catch (e) { return { status: 'degraded', mode_ran: [], errors: [`classify failed: ${e.message}`], chunks: [], notes: [] }; }
  const sources = (routed.recipe && routed.recipe.sources) || [];
  notes.push(`intent=${routed.intent} (${routed.confidence})`);

  // --- DETERMINISTIC VIABILITY FACTS (task f; flag-gated + DARK + fail-open) ---
  // Injected ABOVE the corpus so the model EXPLAINS the engine's ground-truth band/
  // anchor rather than inferring one. Carries NO BVA/win-rate figures (mechanism
  // authority only). Never throws past here — buildViabilityFacts is self-contained
  // fail-open, and this whole block is additionally try/caught.
  let viability_facts;
  if (VIABILITY_GROUNDING_ON && isViabilityQuery(question)) {
    try {
      const vf = buildViabilityFacts(question);
      viability_facts = vf.block;
      // Prepend as the FIRST chunk so any consumer that only reads chunks[] still
      // sees the engine ground truth ahead of the retrieved corpus.
      chunks.unshift({
        text: vf.block,
        source: 'viability_facts',
        citation: 'FRN viability engine (deterministic)',
        metadata: { available: vf.available, deterministic: true },
        letter_citable: false,
      });
      notes.push(`viability_facts: ${vf.available ? 'engine ground-truth injected' : 'not available (fail-open note)'}`);
    } catch (e) {
      errors.push(`viability grounding failed (fail-open): ${e.message}`);
    }
  }

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
        const qvec = await embedQuery(bedrockClient, question);
        semanticRan = true;

        // COVERAGE GATE. When ADVISORY_FOLDER_PICKER is on, an LLM (Haiku) picks the library folder(s)
        // for the asked pair BY MEANING (synonym/alt-name robust) — folder hit => use that folder; no
        // folder => coverage=false => the live-PubMed block below fires. FAIL-OPEN: if the picker can't
        // decide (ok:false) OR the flag is off, fall through to the exact legacy cosine path below, so
        // this only ever ADDS a decision and never breaks retrieval.
        let pickerDecided = false;
        if (FOLDER_PICKER_ON) {
          try {
            const pair = parsePair(question);
            const claimed = pair.claimed || caseConditions[caseConditions.length - 1] || question;
            const pick = await pickAdvisoryFolders(claimed, pair.upstream, { pgClient, bedrockClient, InvokeModelCommand });
            if (pick.ok) {
              pickerDecided = true;
              if (pick.folders.length && !pick.noCuratedBridge) {
                const scoped = await semanticSearchInFolders(pgClient, qvec, pick.folders);
                covered = scoped.length > 0;
                if (covered) {
                  const quotas = (routed.recipe && routed.recipe.quotas) || null;
                  const picked = selectByQuota(scoped, { quotas, floor: 0, cap: SEM_CAP }); // LLM already decided coverage → no cosine floor
                  chunks.push(...picked);
                  notes.push(`folder-picker: [${pick.folders.join(', ')}] -> ${picked.length} chunks (${pick.reasoning})`);
                } else {
                  notes.push(`folder-picker: picked [${pick.folders.join(', ')}] but no chunks loaded — treating as no coverage`);
                }
              } else {
                covered = false;
                notes.push(`folder-picker: no curated folder for this pairing -> live PubMed (${pick.reasoning || pick.error || ''})`);
              }
            } else {
              notes.push(`folder-picker: undecided (${pick.error || 'no verdict'}) — using cosine floor`);
            }
          } catch (e) { errors.push(`folder-picker failed (fail-open to cosine): ${e.message}`); }
        }

        // LEGACY cosine path — the default, and the fail-open fallback when the picker is off/undecided.
        if (!pickerDecided) {
          const sem = await semanticSearch(pgClient, qvec);
          covered = sem.topScore >= RELEVANCE_FLOOR;   // UNCHANGED: judged on the FULL candidate set (top chunk always present)
          if (covered) {
            const quotas = (routed.recipe && routed.recipe.quotas) || null;
            const picked = selectByQuota(sem.chunks, { quotas, floor: RELEVANCE_FLOOR, cap: SEM_CAP });
            chunks.push(...picked);
            notes.push(`semantic: ${picked.length}/${sem.chunks.length} chunks (quota), top=${sem.topScore.toFixed(3)}`);
          } else {
            notes.push(`semantic: weak (top=${sem.topScore.toFixed(3)} < ${RELEVANCE_FLOOR}) — treating as no coverage`);
          }
        }
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

  return { status, mode_ran, errors, chunks, stats, notes, coverage_gap, viability_facts };
}

module.exports = { retrieve, parsePair, resolveStat, RELEVANCE_FLOOR };
