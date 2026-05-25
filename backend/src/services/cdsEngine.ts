import bvaData from '../data/bva_secondary_pairs.json' with { type: 'json' };

// Clinical Decision Support engine — deterministic, reproducible, grounded in BVA outcome data.
// Layer A: hard "obvious-no" gates (pure logic on chart facts). Layer B: BVA pair odds (imo_win_pct).
// A `reject` is a RECOMMENDATION; a human confirms before any veteran-facing action.

export const CDS_ENGINE_VERSION = 'cds-1.0.0';

// Thresholds (imo_win_pct, %): accept >= 70, caution 50-70, reject-flag < 50.
const ACCEPT_MIN = 70;
const CAUTION_MIN = 50;
const IMO_MIN_N = 10; // below this IMO sample, fall back to the overall win_pct.

export type CdsEngineVerdict = 'accept' | 'caution' | 'reject';

export interface PairStats {
  readonly n: number;
  readonly tier: 'high' | 'medium' | 'low';
  readonly win_pct: number;
  readonly grant_pct: number;
  readonly imo_n: number | null;
  readonly imo_win_pct: number | null;
}

export interface CdsResult {
  verdict: CdsEngineVerdict;
  oddsPct: number | null;
  summary: string;
  hardGate: { triggered: boolean; rule: string | null; detail: string | null };
  bva: { matched: boolean; upstream: string | null; claimed: string | null; n: number | null; tier: 'high' | 'medium' | 'low' | null; winPct: number | null; imoWinPct: number | null };
  checkedAt: string;
  engineVersion: string;
}

export interface CdsEngineInput {
  readonly claimedCondition: string;
  readonly claimType: string;
  readonly framingChoice: string | null;
  readonly upstreamScCondition: string | null;
  readonly serviceConnectedConditions: readonly string[];
  readonly activeProblems: readonly string[];
}

const PAIRS = (bvaData as unknown as { pairs: Record<string, Record<string, PairStats>> }).pairs;

// Common FRN phrasings -> the normalized form used by the BVA atlas keys.
const ALIASES: Record<string, string> = {
  'osa': 'obstructive sleep apnea',
  'sleep apnea': 'obstructive sleep apnea',
  'post traumatic stress disorder': 'ptsd',
  'posttraumatic stress disorder': 'ptsd',
  'post traumatic stress': 'ptsd',
  'mdd': 'mdd depression',
  'major depressive disorder': 'mdd depression',
  'depression': 'mdd depression',
  'htn': 'hypertension',
  'high blood pressure': 'hypertension',
  'gad': 'anxiety gad',
  'generalized anxiety disorder': 'anxiety gad',
  'anxiety': 'anxiety gad',
  'low back': 'lumbar back',
  'lumbar': 'lumbar back',
  'back': 'lumbar back',
  'lumbar spine': 'lumbar back',
  'neck': 'cervical neck',
  'cervical spine': 'cervical neck',
  'type 2 diabetes': 'diabetes type 2',
  'dm2': 'diabetes type 2',
  'diabetes': 'diabetes type 2',
  'diabetes mellitus type 2': 'diabetes type 2',
  'traumatic brain injury': 'tbi',
  'migraine': 'migraines headaches',
  'migraines': 'migraines headaches',
  'headaches': 'migraines headaches',
  'ihd': 'ischemic heart disease',
  'coronary artery disease': 'ischemic heart disease',
  'afib': 'atrial fibrillation',
  'a fib': 'atrial fibrillation',
  'irritable bowel syndrome': 'ibs',
  'aud': 'alcohol use disorder',
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function significantTokens(norm: string): string[] {
  return norm.split(' ').filter((t) => t.length > 2);
}

// Conservative matcher: alias -> exact-normalized -> token containment in either direction.
function matchKey(input: string | null | undefined, keys: readonly string[]): string | null {
  if (!input) return null;
  const norm = normalize(input);
  if (!norm) return null;
  const target = ALIASES[norm] ?? norm;
  for (const k of keys) { const nk = normalize(k); if (nk === target || nk === norm) return k; }
  const inTokens = significantTokens(target);
  if (inTokens.length === 0) return null;
  for (const k of keys) {
    const kTokens = significantTokens(normalize(k));
    if (kTokens.length === 0) continue;
    if (inTokens.every((t) => kTokens.includes(t))) return k;
    if (kTokens.every((t) => inTokens.includes(t))) return k;
  }
  return null;
}

function matchesAny(input: string, candidates: readonly string[]): boolean {
  return matchKey(input, candidates) !== null;
}

// Direct-causation theories the VA bars by statute (no nexus can rescue them).
function barredTheory(input: CdsEngineInput): string | null {
  const text = normalize(`${input.claimedCondition} ${input.framingChoice ?? ''}`);
  const isDirect = !input.upstreamScCondition && !/secondary|aggravat/.test(normalize(input.framingChoice ?? ''));
  if (isDirect && /(tobacco|nicotine|cigarette|smoking)/.test(text)) {
    return 'Direct service connection for a tobacco/nicotine-use disability is barred by 38 U.S.C. § 1103.';
  }
  return null;
}

export function evaluateCds(input: CdsEngineInput): CdsResult {
  const checkedAt = new Date().toISOString();
  const base = { checkedAt, engineVersion: CDS_ENGINE_VERSION };
  const isSecondary = Boolean(input.upstreamScCondition) || /secondary/.test(normalize(input.framingChoice ?? ''));

  // ---- BVA lookup (computed regardless, for rationale context) ----
  const upstreamKey = matchKey(input.upstreamScCondition, Object.keys(PAIRS));
  const claimedKey = upstreamKey ? matchKey(input.claimedCondition, Object.keys(PAIRS[upstreamKey])) : null;
  const stats = upstreamKey && claimedKey ? PAIRS[upstreamKey][claimedKey] : null;
  const bva = stats
    ? { matched: true, upstream: upstreamKey, claimed: claimedKey, n: stats.n, tier: stats.tier, winPct: stats.win_pct, imoWinPct: stats.imo_win_pct }
    : { matched: false, upstream: upstreamKey, claimed: null, n: null, tier: null, winPct: null, imoWinPct: null };

  // ---- Layer A: hard gates (obvious no) ----
  const barred = barredTheory(input);
  if (barred) {
    return { ...base, verdict: 'reject', oddsPct: null, summary: `Recommend reject: ${barred}`, hardGate: { triggered: true, rule: 'barred_theory', detail: barred }, bva };
  }
  if (input.activeProblems.length === 0) {
    return { ...base, verdict: 'reject', oddsPct: null, summary: 'Recommend reject: no diagnosis on file for any condition. A current diagnosis is required.', hardGate: { triggered: true, rule: 'no_diagnosis', detail: 'The veteran has no active problems / diagnoses recorded.' }, bva };
  }
  if (isSecondary && input.upstreamScCondition && !matchesAny(input.upstreamScCondition, input.serviceConnectedConditions)) {
    const detail = `Secondary claim, but the upstream condition "${input.upstreamScCondition}" is not among the veteran's service-connected conditions.`;
    return { ...base, verdict: 'reject', oddsPct: null, summary: `Recommend reject: ${detail}`, hardGate: { triggered: true, rule: 'no_sc_anchor', detail }, bva };
  }

  // ---- Layer B: BVA odds ----
  const hardGate = { triggered: false, rule: null, detail: null };
  if (!stats) {
    const why = isSecondary ? 'no BVA outcome data for this upstream→claimed pair' : 'BVA pair odds cover secondary claims; this is not a secondary claim';
    return { ...base, verdict: 'caution', oddsPct: null, summary: `Caution: ${why}. Refer to clinical review.`, hardGate, bva };
  }
  const imoUsable = stats.imo_n !== null && stats.imo_n >= IMO_MIN_N && stats.imo_win_pct !== null;
  const oddsPct = imoUsable && stats.imo_win_pct !== null ? stats.imo_win_pct : stats.win_pct;
  let verdict: CdsEngineVerdict;
  if (oddsPct >= ACCEPT_MIN && stats.tier !== 'low') verdict = 'accept';
  else if (oddsPct >= CAUTION_MIN) verdict = 'caution';
  else if (oddsPct >= ACCEPT_MIN) verdict = 'caution'; // >=70 but tier=low: thin data, do not auto-accept
  else verdict = 'reject';

  const oddsLabel = `${oddsPct}% ${imoUsable ? 'IMO' : 'overall'} BVA win rate (${bva.upstream} → ${bva.claimed}, n=${stats.n}, tier ${stats.tier})`;
  const summary = verdict === 'accept'
    ? `Accept: ${oddsLabel}.`
    : verdict === 'reject'
      ? `Recommend reject: ${oddsLabel} is below the supportable threshold. Confirm before any veteran-facing action.`
      : `Caution: ${oddsLabel}${stats.tier === 'low' ? ' (thin data)' : ''}. Physician/clinical review advised.`;

  return { ...base, verdict, oddsPct, summary, hardGate, bva };
}
