'use strict';

/**
 * intentRouter — cheap, rules-first intent classification for the RN advisory AI.
 *
 * Runs BEFORE retrieval so we only pull what the matched intent needs (the lever
 * that keeps cost ~5-10c/question instead of stuffing the whole corpus). No LLM
 * call here — pure keyword/heuristic rules over intent_recipes.json's classifier_cues.
 * Ambiguous -> 'general' fallback (the system prompt can still re-route mid-answer).
 *
 * Intents: viability | email_response | stats_lookup | general. See intent_recipes.json.
 *
 * Returns { intent, confidence:'high'|'low', scores, matched_cues, signals, recipe }.
 */

const fs = require('fs');
const path = require('path');

const RECIPES_PATH = path.join(__dirname, '..', '..', 'config', 'advisory', 'intent_recipes.json');

// STOP phrases that force the email lane into DEFLECT (Playbook STEP 1). Presence is
// a strong signal the message is an email needing the bait-deflection handling.
const STOP_PHRASES = [
  'is my case strong', 'is my case good', 'is my case a winner', 'what are my chances',
  'what are my odds', 'will i get', 'will this work', 'get to 100', 'path to 100',
  'should i file', 'which form', '0995', '0996', 'how do i fill out', 'what appeal',
  'can you connect', 'secondary to', 'is this pathway', 'would my theory',
  'refund me', 'cancel and refund', 'delete my records', 'sign this letter',
  'on your letterhead', 'my odds',
];

let _recipes = null;
function loadRecipes() {
  if (_recipes) return _recipes;
  _recipes = JSON.parse(fs.readFileSync(RECIPES_PATH, 'utf8'));
  return _recipes;
}
function _reset() { _recipes = null; }

/** Does the text OPEN with a salutation addressed to us? Strong "this is a pasted
 *  veteran message" signal — a direct RN question rarely starts with "Dear"/"Hi team". */
function opensWithSalutation(text) {
  return /^\s*(dear|hi|hello|hey|good (morning|afternoon|evening))\b/i.test(text || '');
}

/** Heuristic: does the text look like a pasted email/message (vs a direct question)? */
function looksLikeEmail(text) {
  const t = text || '';
  const signals = [
    /^\s*from:/im, /^\s*subject:/im, /^\s*to:/im, /\bwrote:\s*$/im,
    /\b(hi|hello|dear|hey)\b[\s,].{0,40}\b(team|flat rate|dr\.?\s*ryan)\b/i,
    /\b(thank you|thanks|regards|sincerely|v\/r)\b[\s,]*$/im,
  ];
  let hits = signals.reduce((n, re) => n + (re.test(t) ? 1 : 0), 0);
  // Long multi-line block with a greeting also reads as a forwarded message.
  if (t.length > 400 && /\n/.test(t)) hits += 1;
  return hits >= 2;
}

function countCues(textLower, cues) {
  const matched = [];
  for (const cue of cues) {
    if (cue === '*') continue;
    if (textLower.includes(cue.toLowerCase())) matched.push(cue);
  }
  return matched;
}

/**
 * Classify a question.
 * @param {string} question - the user's text (may include a pasted email block)
 * @param {object} [ctx] - optional { hasCaseBound:bool } hints from the caller
 */
function classify(question, ctx = {}) {
  const recipes = loadRecipes().intents;
  const text = question || '';
  const lower = text.toLowerCase();

  const signals = {
    looks_like_email: looksLikeEmail(text),
    opens_with_salutation: opensWithSalutation(text),
    stop_phrase: STOP_PHRASES.find((p) => lower.includes(p)) || null,
    case_bound: !!ctx.hasCaseBound,
  };

  // Score each non-general intent by cue hits.
  const scores = {};
  const matched = {};
  for (const [name, def] of Object.entries(recipes)) {
    if (name === 'general') continue;
    const hits = countCues(lower, def.classifier_cues || []);
    matched[name] = hits;
    scores[name] = hits.length;
  }

  // Heuristic boosts.
  // KEY distinction: a STOP phrase ("can you connect X to Y", "what are my odds") is
  // bait the RN must DEFLECT *to a veteran* — but the SAME phrase asked by the RN
  // DIRECTLY to this internal tool is a legitimate viability/stats question (both
  // views get full access). So the deflect-to-email boost fires ONLY when the text is
  // actually a veteran message being triaged (looks like an email OR the RN explicitly
  // asked "how do I respond"). Otherwise a STOP phrase means the RN is asking us to
  // assess a pairing/odds -> boost viability + stats, never deflect.
  // "email framing" = the text is a veteran message being triaged, signalled by an
  // opening salutation to us, an email-shaped body, OR an explicit triage cue
  // ("respond"/"reply"/"how do I answer"). Length is NOT the signal (a 1-line bait
  // email still needs deflecting — architect progress gate, 2026-06-06).
  const emailFraming = signals.looks_like_email || signals.opens_with_salutation || scores.email_response > 0;
  if (signals.looks_like_email || signals.opens_with_salutation) scores.email_response += 2;
  if (signals.stop_phrase) {
    if (emailFraming) {
      scores.email_response += 2; // triaging a veteran message that contains bait -> deflect lane
    } else {
      scores.viability += 1;      // RN asking us directly to assess a pairing/odds -> answer it
      scores.stats_lookup += 1;
    }
  }

  // Pick the winner.
  let intent = 'general';
  let best = 0;
  for (const [name, score] of Object.entries(scores)) {
    if (score > best) { best = score; intent = name; }
  }

  // Confidence: a clear single winner with >=2 signal points = high; otherwise low.
  const sorted = Object.values(scores).sort((a, b) => b - a);
  const clearWinner = best >= 2 && (sorted.length < 2 || best > sorted[1]);
  const confidence = clearWinner ? 'high' : 'low';
  if (best === 0) intent = 'general';

  return {
    intent,
    confidence,
    scores,
    matched_cues: matched[intent] || [],
    signals,
    recipe: recipes[intent],
  };
}

module.exports = { classify, looksLikeEmail, opensWithSalutation, loadRecipes, _reset, STOP_PHRASES };
