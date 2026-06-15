// ───────────────────────────────────────────────────────────────────────────
// VENDORED COPY — DO NOT HAND-EDIT THE LOGIC.
// Source of truth: flatratenexus-project/app/services/eventCanon.js (FRN repo).
// This is a verbatim vendor of the FRN deterministic event-type resolver so the
// EMR LLM event-classifier (backend/src/services/event-classifier.ts) builds its
// forced-tool enum FROM the SAME closed EVENT_ENUM the FRN deterministic floor +
// public tool use — the two can never diverge.
//
// eventCanon.js is PURE / deterministic / no-I/O (no fs, no env, no LLM, no DB),
// so it is vendorable as-is, exactly like anchorMechanism.cjs / conditionCanon.cjs.
// It is loaded at RUNTIME via createRequire (the established vendor convention in
// case-viability.ts / realRetrieve.ts) so it survives both esbuild bundling and
// vitest/tsx dev.
//
// The 16 frozen EVENT_ENUM values are content-pinned by
// backend/src/services/__tests__/event-classifier.test.ts — a stale vendor that
// drifts from the 16 expected values FAILS THE BUILD LOUD. To re-vendor: copy the
// FRN source again and update the pin in that test in the SAME commit.
// ───────────────────────────────────────────────────────────────────────────

// app/services/eventCanon.js
//
// DETERMINISTIC in-service EVENT-TYPE resolver — the event-axis analog of
// conditionCanon.js. The direct-SC viability table (references/sc_direct_pairs.json)
// is keyed on EVENT TYPE; this maps a veteran's in-service events (from the chart's
// conceded fields OR free-text lay phrasing on the public tool) onto a CLOSED enum
// of canonical event types. Pure, deterministic, never throws, no LLM, no I/O —
// so it is Cloudflare-Worker-vendorable exactly like conditionCanon.
//
// WHY THIS EXISTS (direct-SC build, 2026-06-14): a secondary anchor is fed from the
// chart's structured granted_service_connections. A DIRECT claim's anchor is an
// in-service EVENT, which is NOT structured — it lives in free text
// (va_concessions.in_service_event_conceded) + boolean concession flags
// (tera_concession, noise_exposure_conceded). Both the architect and the AI-SME
// flagged: without this resolver, the direct table is INERT. This is the keystone.
//
// CONTRACT: resolveEventCanon(input) -> [{ event_canonical, evidence, source }]
//   input: a chart va_concessions object, OR a free-text string (public tool).
//   Returns [] when nothing resolves (caller must fail-safe to "abstain", never "no").
//   Every result carries `evidence` (the matched substring / flag) for audit.
//
// The LLM classifier (Aegis chart-extract) is an ADDITIVE recall layer for events
// documented-but-not-conceded in STR free text; it emits the SAME event_canonical
// enum + a verbatim evidence span. This module is the deterministic floor + the
// public-tool path; the two share this enum so they can never diverge.

'use strict';

// ── CLOSED enum of canonical event types ────────────────────────────────────
// Lean set (Ryan 2026-06-14 "obvious vs contributing" + PCP-panel corrections):
// vibration folded into repetitive MSK load; loud-environment folded into MOS noise;
// MST kept distinct ONLY for its evidentiary relaxation (shares the trauma mechanism);
// combat (§1154(b)) is a MODIFIER flag, not a standalone event (set separately).
const EVENT_TYPES = {
  MOS_ACOUSTIC_NOISE: 'mos_acoustic_noise',
  BLAST_TBI: 'blast_tbi',
  REPETITIVE_MSK_LOAD: 'repetitive_msk_load',
  ACUTE_IN_SERVICE_INJURY: 'acute_in_service_injury',
  CRITERION_A_TRAUMA: 'criterion_a_trauma',
  MST: 'mst',
  CHRONIC_OPERATIONAL_STRESS: 'chronic_operational_stress', // PCP-added clinical hole
  CHEMICAL_SOLVENT_FUEL_TERA: 'chemical_solvent_fuel_tera',
  BURN_PIT_AIRBORNE: 'burn_pit_airborne',                   // presumptive
  HERBICIDE_AGENT_ORANGE: 'herbicide_agent_orange',         // presumptive
  GULF_WAR_ENVIRONMENTAL: 'gulf_war_environmental',         // presumptive
  CAMP_LEJEUNE_WATER: 'camp_lejeune_water',                 // presumptive
  IONIZING_RADIATION: 'ionizing_radiation',                 // presumptive
  COLD_INJURY: 'cold_injury',
  ASBESTOS: 'asbestos',
  CHRONIC_DISEASE_1YR: 'chronic_disease_1yr',               // presumptive (3.307/3.309(a))
};
const EVENT_ENUM = Object.freeze(Object.values(EVENT_TYPES));
// Presumptive events route to the existing _PRESUMPTIVE redirect ("file presumptive,
// no letter needed"), never to a drafting anchor (architect §4).
const PRESUMPTIVE_EVENTS = new Set([
  EVENT_TYPES.BURN_PIT_AIRBORNE, EVENT_TYPES.HERBICIDE_AGENT_ORANGE,
  EVENT_TYPES.GULF_WAR_ENVIRONMENTAL, EVENT_TYPES.CAMP_LEJEUNE_WATER,
  EVENT_TYPES.IONIZING_RADIATION, EVENT_TYPES.CHRONIC_DISEASE_1YR,
]);

// ── free-text → event-type regex catalog (ordered; first-match-wins per pattern) ─
// Robust to lay phrasing (public tool) AND clinician phrasing (chart concession text).
// Each entry: [event_canonical, /regex/]. Multiple may match one input (a veteran can
// have several events) — we return ALL distinct matches.
const PATTERNS = [
  [EVENT_TYPES.MST, /\b(mst|military sexual trauma|sexual assault|sexually assaulted|raped?|sexual harassment)\b/i],
  [EVENT_TYPES.CRITERION_A_TRAUMA, /\b(combat(?!\s+stress\s+disorder)|firefights?|heavy fighting|took fire|under fire|came under (?:fire|attack)|\bied\b|\brpg\b|mortar|ambush(?:ed)?|attacked|witnessed[\s\S]{0,45}(?:die|died|dying|dies|death|killed|killing|suicide|blown up|blown apart)|(?:fellow (?:service ?member|soldier|marine|sailor|airman)|friend|buddy|someone|comrade|squad ?mate|team ?mate)[\s\S]{0,35}(?:die|died|killed|blown up|suicide)|saw[\s\S]{0,20}(?:death|dead|killed)|fear(?:ed)? for (?:my|his|her|their) life|dead bodies|killed in action|mass casualt|fear of hostile|criterion a|life[- ]threat)/i],
  [EVENT_TYPES.BLAST_TBI, /\b(blast|concuss|tbi|traumatic brain|blown up|explosion|ied blast|head injury)\b/i],
  [EVENT_TYPES.BURN_PIT_AIRBORNE, /\b(burn ?pits?|airborne hazard|smoke from the pits?|particulate matter|open[- ]air burn)\b/i],
  [EVENT_TYPES.HERBICIDE_AGENT_ORANGE, /\b(agent orange|herbicides?|2,?4[- ]?d|dioxin|defoliants?|sprayed (?:the )?(?:brush|perimeter)|vietnam.{0,25}(?:spray|defoliant|herbicid))\b/i],
  [EVENT_TYPES.CAMP_LEJEUNE_WATER, /\b(camp lejeune|lejeune water|contaminated water.{0,30}lejeune)\b/i],
  [EVENT_TYPES.GULF_WAR_ENVIRONMENTAL, /\b(gulf war|southwest asia|undiagnosed illness|gulf war (?:illness|syndrome)|desert (?:storm|shield))\b/i],
  [EVENT_TYPES.IONIZING_RADIATION, /\b(ionizing radiation|atomic|nuclear test|radiogenic|radiation[- ]exposed)\b/i],
  [EVENT_TYPES.ASBESTOS, /\basbestos\b/i],
  [EVENT_TYPES.COLD_INJURY, /\b(cold injury|frostbite|frostnip|cold[- ]weather injury|trench foot|hypothermia)\b/i],
  [EVENT_TYPES.MOS_ACOUSTIC_NOISE, /\b(acoustic|hazardous noise|noise exposure|flight ?line|flight ?deck|artillery|gunfire|weapons fire|machine ?guns?|heavy weapons|\bmortar|rifle (?:fire|range)|range instructor|jet engine|aircraft (?:noise|maintenance)|tank crew|tank gunner|tracked vehicle|\barmor\b|armor crew|generator noise|generators?\b|running engines|engines? running|helicopters?|door gunner|small[- ]?arms|firing range|the range\b|engine ?room|machinery|no hearing protection|loud (?:environment|equipment|noise|machinery)|ears? (?:rang|ringing) (?:after|from)|mos noise)\b/i],
  [EVENT_TYPES.CHEMICAL_SOLVENT_FUEL_TERA, /\b(jet ?fuel|jp[- ]?8|diesel|solvents?|degreasers?|trichloroethylene|tce|benzene|fuel handler|petroleum|chemicals?|pesticides?|\bcarc\b|spray ?paint|tera|toxic exposure|chemical exposure)\b/i],
  [EVENT_TYPES.REPETITIVE_MSK_LOAD, /\b(heavy lifting|load[- ]bearing|rucking|ruck march|\brucks?\b|hump(?:ing|ed) (?:a )?(?:ruck|pack|gear)|parachute|\bairborne\b(?!\s+hazard)|paratrooper|jumped out of (?:planes?|aircraft)|repetitive (?:lifting|strain|motion|stress)|carr(?:y|ies|ying|ied) (?:heavy )?(?:gear|kit|equipment|pack|load)|body armor|wore (?:kit|gear|armor)|running in boots|kneeling|crawling|on (?:my|his|her|their) feet all day|whole[- ]body vibration|prolonged standing|vibration)\b/i],
  [EVENT_TYPES.CHRONIC_OPERATIONAL_STRESS, /\b(sleep deprivation|sleep[- ]deprived|operational (?:stress|tempo)|optempo|watch rotation|shift work|chronic stress|sustained stress|deployment stress|long hours|combat stress(?! disorder))\b/i],
  // acute injury is the LAST MSK-ish catch: a documented sick-call/LOD injury to a structure
  [EVENT_TYPES.ACUTE_IN_SERVICE_INJURY, /\b(sick ?call|line of duty|\blod\b|sprain(?:ed)?|strain(?!ed relations)|fractur\w*|broke (?:his|her|my|the)|injured|injury|\bacl\b|\bmcl\b|meniscus|rotator cuff|torn (?:ligament|meniscus|rotator)|mva|motor vehicle accident|twisted|tore|torn|dislocat|fell (?:and|down|off|from|while)|fell[\s\S]{0,25}(?:injur|hurt))\b/i],
];

function _clean(s) { return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim(); }

// Scan a free-text blob for ALL distinct event types it evidences.
function _scanText(text, source) {
  const t = _clean(text);
  if (!t) return [];
  const out = [];
  const seen = new Set();
  for (const [evt, re] of PATTERNS) {
    if (seen.has(evt)) continue;
    const m = t.match(re);
    if (m) { seen.add(evt); out.push({ event_canonical: evt, evidence: m[0], source }); }
  }
  return out;
}

// Resolve from a chart va_concessions object: boolean flags first (highest-confidence,
// VA-conceded), then the free-text in_service_event_conceded.
function _scanChart(vc) {
  const out = [];
  const seen = new Set();
  const push = (evt, evidence, source) => { if (!seen.has(evt)) { seen.add(evt); out.push({ event_canonical: evt, evidence, source }); } };
  if (vc && vc.noise_exposure_conceded && vc.noise_exposure_conceded.conceded === true) {
    push(EVENT_TYPES.MOS_ACOUSTIC_NOISE, 'noise_exposure_conceded=true' + (vc.noise_exposure_conceded.basis ? ` (${_clean(vc.noise_exposure_conceded.basis)})` : ''), 'chart_concession');
  }
  if (vc && vc.tera_concession && vc.tera_concession.conceded === true) {
    push(EVENT_TYPES.CHEMICAL_SOLVENT_FUEL_TERA, 'tera_concession=true', 'chart_concession');
  }
  // free-text conceded event(s)
  const evText = vc && (vc.in_service_event_conceded || vc.in_service_event);
  if (evText) {
    if (typeof evText === 'string') {
      for (const r of _scanText(evText, 'chart_event_text')) push(r.event_canonical, r.evidence, r.source);
    } else if (Array.isArray(evText)) {
      for (const e of evText) {
        const blob = typeof e === 'string' ? e : _clean((e && (e.scope_verbatim || e.event || e.condition)) || '');
        for (const r of _scanText(blob, 'chart_event_text')) push(r.event_canonical, r.evidence, r.source);
      }
    }
  }
  return out;
}

// PUBLIC: resolve in-service events from either a chart va_concessions object or a
// free-text string. Returns [] on no-match (caller fail-safes to abstain).
function resolveEventCanon(input) {
  if (!input) return [];
  if (typeof input === 'string') return _scanText(input, 'free_text');
  if (typeof input === 'object') {
    // accept a full chart, a va_concessions object, or {text}
    const vc = input.va_concessions || input;
    return _scanChart(vc);
  }
  return [];
}

function isPresumptiveEvent(evt) { return PRESUMPTIVE_EVENTS.has(evt); }
function isValidEvent(evt) { return EVENT_ENUM.includes(evt); }

module.exports = {
  EVENT_TYPES,
  EVENT_ENUM,
  PRESUMPTIVE_EVENTS,
  resolveEventCanon,
  isPresumptiveEvent,
  isValidEvent,
  // exported for tests / the LLM-classifier tool schema (closed enum)
  _PATTERNS: PATTERNS,
};
