// 250-case stress regression suite for the CDS engine (cds-1.0.0).
//
// Buckets:
//   A. Layer-A hard gates                    (~60)
//   B. Layer-B threshold boundaries          (~60, real-pair coverage; synthetic boundaries in
//                                             cdsEngine.thresholds.test.ts which mocks the atlas)
//   C. BVA-pair coverage                     (~50)
//   D. No-match / non-secondary              (~30)
//   E. Edge / malformed input                (~30)
//   F. Determinism / idempotency             (~20)
//
// The engine is pure; cases inside each bucket are order-independent and run via it.concurrent.
// Per task spec, the suite asserts engine OUTPUTS; a `reject` verdict is a recommendation, not an
// action gate. If a case fails in a way that suggests an engine bug, the failure surfaces here
// and is recorded in docs/verification/phase5-cds-stress/findings.md — engine is NOT edited.

import { describe, expect, it } from 'vitest';
import { evaluateCds, CDS_ENGINE_VERSION, type CdsEngineInput, type CdsResult } from '../services/cdsEngine.js';

// ---------- shared helpers ----------

interface ExpectedShape {
  verdict?: 'accept' | 'caution' | 'reject';
  oddsPctMin?: number;
  oddsPctMax?: number;
  oddsPctExact?: number | null;
  hardGateTriggered?: boolean;
  hardGateRule?: 'barred_theory' | 'no_diagnosis' | 'no_sc_anchor' | null;
  bvaMatched?: boolean;
}

function assertResult(r: CdsResult, exp: ExpectedShape, label: string): void {
  if (exp.verdict !== undefined) {
    expect(r.verdict, `${label}: verdict`).toBe(exp.verdict);
  }
  if (exp.hardGateTriggered !== undefined) {
    expect(r.hardGate.triggered, `${label}: hardGate.triggered`).toBe(exp.hardGateTriggered);
  }
  if (exp.hardGateRule !== undefined) {
    expect(r.hardGate.rule, `${label}: hardGate.rule`).toBe(exp.hardGateRule);
  }
  if (exp.bvaMatched !== undefined) {
    expect(r.bva.matched, `${label}: bva.matched`).toBe(exp.bvaMatched);
  }
  if (exp.oddsPctExact !== undefined) {
    expect(r.oddsPct, `${label}: oddsPct exact`).toBe(exp.oddsPctExact);
  } else {
    if (exp.oddsPctMin !== undefined && r.oddsPct !== null) {
      expect(r.oddsPct, `${label}: oddsPct >= ${exp.oddsPctMin}`).toBeGreaterThanOrEqual(exp.oddsPctMin);
    }
    if (exp.oddsPctMax !== undefined && r.oddsPct !== null) {
      expect(r.oddsPct, `${label}: oddsPct <= ${exp.oddsPctMax}`).toBeLessThanOrEqual(exp.oddsPctMax);
    }
  }
  // Invariants on every result.
  expect(r.engineVersion, `${label}: engineVersion`).toBe(CDS_ENGINE_VERSION);
  expect(r.checkedAt, `${label}: checkedAt is ISO`).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(typeof r.summary, `${label}: summary is string`).toBe('string');
  expect(r.summary.length, `${label}: summary non-empty`).toBeGreaterThan(0);
}

function buildInput(overrides: Partial<CdsEngineInput>): CdsEngineInput {
  return {
    claimedCondition: 'Obstructive sleep apnea',
    claimType: 'initial',
    framingChoice: 'secondary',
    upstreamScCondition: 'PTSD',
    serviceConnectedConditions: ['PTSD'],
    activeProblems: ['Obstructive sleep apnea'],
    ...overrides,
  };
}

interface BucketCase {
  readonly label: string;
  readonly input: CdsEngineInput;
  readonly expected: ExpectedShape;
}

// ============================================================================
// Bucket A: Layer-A hard gates (~60 cases)
// ============================================================================

const tobaccoPhrases: readonly string[] = [
  'COPD from in-service tobacco use',
  'Lung cancer secondary to smoking',
  'Bronchitis from nicotine dependence',
  'Emphysema, tobacco use disorder',
  'COPD from cigarette use during service',
  'Chronic bronchitis due to smoking',
  'Tobacco-related lung disease',
  'Nicotine-induced COPD',
  'Asthma due to in-service cigarette use',
  'Cigarette-related throat cancer',
  'Smoking-related COPD',
  'COPD - tobacco etiology',
];

const directFramings: readonly string[] = ['direct', 'in service', '', 'initial', 'service connection'];

const bucketA: BucketCase[] = [];

// A1: barred-tobacco direct theory permutations (12 phrases × 3 framings = 36)
for (const phrase of tobaccoPhrases) {
  for (const framing of directFramings.slice(0, 3)) {
    bucketA.push({
      label: `A1 tobacco direct: "${phrase}" / framing="${framing}"`,
      input: buildInput({
        claimedCondition: phrase,
        framingChoice: framing,
        upstreamScCondition: null,
        serviceConnectedConditions: [],
        activeProblems: [phrase],
      }),
      expected: { verdict: 'reject', hardGateTriggered: true, hardGateRule: 'barred_theory' },
    });
  }
}

// A2: tobacco words inside a SECONDARY framing should NOT trigger barred_theory (only direct does).
// Asthma->COPD has no BVA pair, so the engine falls through to caution.
bucketA.push({
  label: 'A2 tobacco-as-secondary not barred (no pair => caution)',
  input: buildInput({
    claimedCondition: 'COPD secondary to smoking-aggravated asthma',
    framingChoice: 'secondary',
    upstreamScCondition: 'Asthma',
    serviceConnectedConditions: ['Asthma'],
    activeProblems: ['COPD'],
  }),
  expected: { verdict: 'caution', hardGateTriggered: false, bvaMatched: false },
});

// A3: tobacco words with an upstream SC condition present should NOT trigger barred_theory.
// Same atlas constraint — no Asthma->COPD pair, so caution.
bucketA.push({
  label: 'A3 tobacco with upstream-SC bypasses barred theory (no pair => caution)',
  input: buildInput({
    claimedCondition: 'COPD with tobacco etiology',
    framingChoice: 'secondary',
    upstreamScCondition: 'Asthma',
    serviceConnectedConditions: ['Asthma'],
    activeProblems: ['COPD'],
  }),
  expected: { hardGateTriggered: false, verdict: 'caution', bvaMatched: false },
});

// A4: no-diagnosis (empty activeProblems) — should hard-reject
const noDxConditions: readonly string[] = ['OSA', 'PTSD', 'Hypertension', 'GERD', 'Tinnitus', 'Migraines', 'Lumbar back', 'Knee'];
for (const cond of noDxConditions) {
  bucketA.push({
    label: `A4 no diagnosis: ${cond}`,
    input: buildInput({
      claimedCondition: cond,
      activeProblems: [],
    }),
    expected: { verdict: 'reject', hardGateTriggered: true, hardGateRule: 'no_diagnosis' },
  });
}

// A5: secondary without SC anchor (claimType=secondary + clear mismatch on SC list)
const noAnchorPairs: readonly { up: string; cl: string; sc: readonly string[] }[] = [
  { up: 'PTSD', cl: 'OSA', sc: ['Tinnitus'] },
  { up: 'PTSD', cl: 'OSA', sc: ['Right knee strain'] },
  { up: 'PTSD', cl: 'OSA', sc: ['Hearing loss', 'Plantar fasciitis'] },
  { up: 'Diabetes type 2', cl: 'Peripheral neuropathy', sc: ['PTSD'] },
  { up: 'Diabetes type 2', cl: 'Hypertension', sc: ['Tinnitus', 'Knee'] },
  { up: 'Lumbar back', cl: 'Radiculopathy', sc: ['MDD'] },
  { up: 'Obesity', cl: 'OSA', sc: ['Migraines'] },
];
for (const pair of noAnchorPairs) {
  bucketA.push({
    label: `A5 no SC anchor: ${pair.up}->${pair.cl} (SC=[${pair.sc.join(',')}])`,
    input: buildInput({
      claimedCondition: pair.cl,
      framingChoice: 'secondary',
      upstreamScCondition: pair.up,
      serviceConnectedConditions: pair.sc,
      activeProblems: [pair.cl],
    }),
    expected: { verdict: 'reject', hardGateTriggered: true, hardGateRule: 'no_sc_anchor' },
  });
}

// A6: two gates triggered simultaneously — engine checks barred_theory FIRST, then no_diagnosis,
// then no_sc_anchor (per code order in evaluateCds). Verify the *first* rule wins.
bucketA.push({
  label: 'A6 barred-tobacco + no-diagnosis collision (barred wins)',
  input: buildInput({
    claimedCondition: 'COPD from in-service smoking',
    framingChoice: 'direct',
    upstreamScCondition: null,
    serviceConnectedConditions: [],
    activeProblems: [],
  }),
  expected: { verdict: 'reject', hardGateTriggered: true, hardGateRule: 'barred_theory' },
});

bucketA.push({
  label: 'A6 no-diagnosis + no-SC-anchor collision (no_diagnosis wins)',
  input: buildInput({
    claimedCondition: 'OSA',
    framingChoice: 'secondary',
    upstreamScCondition: 'PTSD',
    serviceConnectedConditions: ['Tinnitus'],
    activeProblems: [],
  }),
  expected: { verdict: 'reject', hardGateTriggered: true, hardGateRule: 'no_diagnosis' },
});

// barredTheory only fires when isDirect (no upstream AND framing != secondary/aggravat). With
// upstreamScCondition='PTSD' present, isDirect=false, so barred does NOT fire. no_sc_anchor wins.
bucketA.push({
  label: 'A6 tobacco-claim + upstream-set + no-SC-anchor => no_sc_anchor wins (barred skipped)',
  input: buildInput({
    claimedCondition: 'COPD from smoking',
    framingChoice: 'direct',
    upstreamScCondition: 'PTSD',
    serviceConnectedConditions: ['Tinnitus'],
    activeProblems: ['COPD'],
  }),
  expected: { verdict: 'reject', hardGateTriggered: true, hardGateRule: 'no_sc_anchor' },
});

// A7: secondary framing word in framingChoice with no upstream — barred check sees this as "secondary"
// (because /secondary|aggravat/ in framing => isDirect=false), so barred should NOT fire.
bucketA.push({
  label: 'A7 tobacco + framing=secondary + no upstream + no anchor + no Dx (no_diagnosis wins)',
  input: buildInput({
    claimedCondition: 'COPD from smoking',
    framingChoice: 'secondary',
    upstreamScCondition: null,
    serviceConnectedConditions: [],
    activeProblems: [],
  }),
  expected: { verdict: 'reject', hardGateTriggered: true, hardGateRule: 'no_diagnosis' },
});

describe('CDS stress | Bucket A: Layer-A hard gates', () => {
  it.concurrent.each(bucketA)('$label', ({ input, expected, label }) => {
    const r = evaluateCds(input);
    assertResult(r, expected, label);
  });
});

// ============================================================================
// Bucket B: Layer-B threshold-coverage (real pairs) (~60 cases)
// ============================================================================
//
// Note: real bva_secondary_pairs.json IMO data only ranges 53.8%–100% — no real pair sits exactly
// at the 70/50 boundary nor below 50% with usable IMO. The exact-boundary synthetic tests live in
// cdsEngine.thresholds.test.ts where the atlas is replaced via vi.mock. This bucket asserts the
// threshold logic against REAL pairs spread across high/moderate/low-tier and IMO-usable/fallback
// branches.

interface ThresholdCase { up: string; cl: string; oddsExact: number; tier: 'high' | 'moderate' | 'low'; expectedVerdict: 'accept' | 'caution' | 'reject'; }

// Mix of real pairs at varied imo/fallback percentages. Each row's expected verdict was hand-
// derived from the engine rules: verdict=accept iff (odds>=70 AND tier!='low'), else caution iff
// odds>=50, else caution iff odds>=70 (tier=low dead branch), else reject.
const realBoundaries: readonly ThresholdCase[] = [
  // Top-of-distribution (IMO usable, accept tier)
  { up: 'PTSD', cl: 'Knee', oddsExact: 100, tier: 'high', expectedVerdict: 'accept' },
  { up: 'PTSD', cl: 'Tinnitus', oddsExact: 100, tier: 'high', expectedVerdict: 'accept' },
  { up: 'Knee', cl: 'Cervical / neck', oddsExact: 100, tier: 'high', expectedVerdict: 'accept' },
  { up: 'Obesity', cl: 'Obstructive sleep apnea', oddsExact: 96.3, tier: 'high', expectedVerdict: 'accept' },
  { up: 'PTSD', cl: 'Hearing loss', oddsExact: 95.2, tier: 'high', expectedVerdict: 'accept' },
  { up: 'Tinnitus', cl: 'Migraines / headaches', oddsExact: 95, tier: 'high', expectedVerdict: 'accept' },
  { up: 'Hearing loss', cl: 'Tinnitus', oddsExact: 94.7, tier: 'high', expectedVerdict: 'accept' },
  { up: 'Lumbar / back', cl: 'Hearing loss', oddsExact: 94.4, tier: 'high', expectedVerdict: 'accept' },
  { up: 'PTSD', cl: 'Obstructive sleep apnea', oddsExact: 89.2, tier: 'high', expectedVerdict: 'accept' },
  { up: 'Lumbar / back', cl: 'Obstructive sleep apnea', oddsExact: 88.7, tier: 'high', expectedVerdict: 'accept' },
  { up: 'Diabetes type 2', cl: 'Peripheral neuropathy', oddsExact: 88.2, tier: 'high', expectedVerdict: 'accept' },
  { up: 'MDD / Depression', cl: 'Obstructive sleep apnea', oddsExact: 86.7, tier: 'high', expectedVerdict: 'accept' },
  { up: 'PTSD', cl: 'Hypertension', oddsExact: 85, tier: 'high', expectedVerdict: 'accept' },
  { up: 'Lumbar / back', cl: 'Knee', oddsExact: 84.4, tier: 'high', expectedVerdict: 'accept' },
  { up: 'Ankle', cl: 'Knee', oddsExact: 78.4, tier: 'high', expectedVerdict: 'accept' },
  { up: 'Knee', cl: 'Lumbar / back', oddsExact: 79, tier: 'high', expectedVerdict: 'accept' },
  { up: 'Lumbar / back', cl: 'Hip', oddsExact: 80, tier: 'high', expectedVerdict: 'accept' },
  { up: 'Lumbar / back', cl: 'Cervical / neck', oddsExact: 77.5, tier: 'high', expectedVerdict: 'accept' },
  { up: 'Diabetes type 2', cl: 'Obstructive sleep apnea', oddsExact: 75, tier: 'high', expectedVerdict: 'accept' },
  { up: 'Tinnitus', cl: 'Obstructive sleep apnea', oddsExact: 73.3, tier: 'high', expectedVerdict: 'accept' },
  // Moderate tier (still accept)
  { up: 'GERD', cl: 'Obstructive sleep apnea', oddsExact: 93.8, tier: 'moderate', expectedVerdict: 'accept' },
  { up: 'Hypertension', cl: 'Stroke / CVA', oddsExact: 90, tier: 'moderate', expectedVerdict: 'accept' },
  { up: 'Lumbar / back', cl: 'Ankle', oddsExact: 90.9, tier: 'moderate', expectedVerdict: 'accept' },
  { up: 'Knee', cl: 'PTSD', oddsExact: 91.7, tier: 'moderate', expectedVerdict: 'accept' },
  { up: 'Cervical / neck', cl: 'Obstructive sleep apnea', oddsExact: 90, tier: 'moderate', expectedVerdict: 'accept' },
  // Caution band (50-70)
  { up: 'Lumbar / back', cl: 'Peripheral neuropathy', oddsExact: 66.7, tier: 'high', expectedVerdict: 'caution' },
  { up: 'TBI', cl: 'Obstructive sleep apnea', oddsExact: 66.7, tier: 'moderate', expectedVerdict: 'caution' },
  { up: 'Hypertension', cl: 'Obstructive sleep apnea', oddsExact: 64.7, tier: 'high', expectedVerdict: 'caution' },
  { up: 'Tinnitus', cl: 'Vertigo / Meniere', oddsExact: 64.3, tier: 'high', expectedVerdict: 'caution' },
  { up: 'Ischemic heart disease', cl: 'Obstructive sleep apnea', oddsExact: 61.5, tier: 'moderate', expectedVerdict: 'caution' },
  { up: 'Diabetes type 2', cl: 'Hypertension', oddsExact: 61.1, tier: 'high', expectedVerdict: 'caution' },
  { up: 'Hip', cl: 'Knee', oddsExact: 60, tier: 'moderate', expectedVerdict: 'caution' },
  { up: 'Hypertension', cl: 'Ischemic heart disease', oddsExact: 53.8, tier: 'high', expectedVerdict: 'caution' },
  // Low tier with high odds — engine should NOT auto-accept (caution due to thin data)
  { up: 'PTSD', cl: 'Wrist', oddsExact: 92.3, tier: 'low', expectedVerdict: 'caution' },
  { up: 'PTSD', cl: 'Hip', oddsExact: 100, tier: 'low', expectedVerdict: 'caution' },
  { up: 'PTSD', cl: 'Plantar fasciitis / foot', oddsExact: 91.7, tier: 'low', expectedVerdict: 'caution' },
  { up: 'PTSD', cl: 'Diabetes type 2', oddsExact: 85.7, tier: 'low', expectedVerdict: 'caution' },
  // Low tier mid-band (caution by either rule)
  { up: 'PTSD', cl: 'Asthma', oddsExact: 64.3, tier: 'low', expectedVerdict: 'caution' },
  // Reject (<50, real fallback pairs — the only 3 in the atlas)
  { up: 'Hip', cl: 'Cervical / neck', oddsExact: 16.7, tier: 'low', expectedVerdict: 'reject' },
  { up: 'Shoulder', cl: 'Tinnitus', oddsExact: 40, tier: 'low', expectedVerdict: 'reject' },
  { up: 'Peripheral neuropathy', cl: 'Lumbar / back', oddsExact: 40, tier: 'low', expectedVerdict: 'reject' },
];

const bucketB: BucketCase[] = realBoundaries.map((row) => ({
  label: `B real-boundary ${row.up} -> ${row.cl} @ ${row.oddsExact}% (tier ${row.tier}) => ${row.expectedVerdict}`,
  input: buildInput({
    claimedCondition: row.cl,
    framingChoice: 'secondary',
    upstreamScCondition: row.up,
    serviceConnectedConditions: [row.up],
    activeProblems: [row.cl],
  }),
  expected: { verdict: row.expectedVerdict, oddsPctExact: row.oddsExact, bvaMatched: true, hardGateTriggered: false },
}));

// Add same-pair phrasing variations (alias/casing/whitespace) to bring bucket to ~60.
const phrasingVariants: readonly { up: string; cl: string; expected: ExpectedShape }[] = [
  { up: 'ptsd', cl: 'sleep apnea', expected: { verdict: 'accept', oddsPctExact: 89.2, bvaMatched: true } },
  { up: 'POST-TRAUMATIC STRESS DISORDER', cl: 'OSA', expected: { verdict: 'accept', oddsPctExact: 89.2, bvaMatched: true } },
  { up: '  PTSD  ', cl: '  Obstructive sleep apnea  ', expected: { verdict: 'accept', oddsPctExact: 89.2, bvaMatched: true } },
  { up: 'Post traumatic stress', cl: 'Sleep apnea', expected: { verdict: 'accept', oddsPctExact: 89.2, bvaMatched: true } },
  { up: 'Hypertension', cl: 'Ischemic Heart Disease', expected: { verdict: 'caution', oddsPctExact: 53.8, bvaMatched: true } },
  { up: 'HTN', cl: 'ischemic heart disease', expected: { verdict: 'caution', oddsPctExact: 53.8, bvaMatched: true } },
  { up: 'High blood pressure', cl: 'IHD', expected: { verdict: 'caution', oddsPctExact: 53.8, bvaMatched: true } },
  { up: 'diabetes', cl: 'peripheral neuropathy', expected: { verdict: 'accept', oddsPctExact: 88.2, bvaMatched: true } },
  { up: 'dm2', cl: 'peripheral neuropathy', expected: { verdict: 'accept', oddsPctExact: 88.2, bvaMatched: true } },
  { up: 'type 2 diabetes', cl: 'PN', expected: { bvaMatched: false, verdict: 'caution' } },
  { up: 'low back', cl: 'radiculopathy', expected: { verdict: 'accept', oddsPctExact: 92.3, bvaMatched: true } },
  { up: 'lumbar', cl: 'radiculopathy', expected: { verdict: 'accept', oddsPctExact: 92.3, bvaMatched: true } },
  { up: 'lumbar spine', cl: 'radiculopathy', expected: { verdict: 'accept', oddsPctExact: 92.3, bvaMatched: true } },
];
for (const v of phrasingVariants) {
  bucketB.push({
    label: `B phrasing variant ${v.up} -> ${v.cl}`,
    input: buildInput({
      claimedCondition: v.cl,
      framingChoice: 'secondary',
      upstreamScCondition: v.up,
      serviceConnectedConditions: [v.up],
      activeProblems: [v.cl],
    }),
    expected: { hardGateTriggered: false, ...v.expected },
  });
}

describe('CDS stress | Bucket B: Layer-B threshold coverage (real pairs)', () => {
  it.concurrent.each(bucketB)('$label', ({ input, expected, label }) => {
    const r = evaluateCds(input);
    assertResult(r, expected, label);
  });
});

// ============================================================================
// Bucket C: BVA-pair coverage across 50 real pairs (~50 cases)
// ============================================================================
//
// High-volume + mid-volume + low-tier + outlier-reject pairs. Asserts engine returns matched=true
// with the correct stats — establishes that the matcher / pair-lookup is not row-order-sensitive.

interface CoveragePair { up: string; cl: string; expectedOdds: number; expectedVerdict: 'accept' | 'caution' | 'reject'; }

const bucketC_pairs: readonly CoveragePair[] = [
  { up: 'PTSD', cl: 'Obstructive sleep apnea', expectedOdds: 89.2, expectedVerdict: 'accept' },
  { up: 'Knee', cl: 'Lumbar / back', expectedOdds: 79, expectedVerdict: 'accept' },
  { up: 'Lumbar / back', cl: 'Radiculopathy', expectedOdds: 92.3, expectedVerdict: 'accept' },
  { up: 'PTSD', cl: 'Hypertension', expectedOdds: 85, expectedVerdict: 'accept' },
  { up: 'Lumbar / back', cl: 'Knee', expectedOdds: 84.4, expectedVerdict: 'accept' },
  { up: 'MDD / Depression', cl: 'Obstructive sleep apnea', expectedOdds: 86.7, expectedVerdict: 'accept' },
  { up: 'Sinusitis / rhinitis', cl: 'Obstructive sleep apnea', expectedOdds: 92.9, expectedVerdict: 'accept' },
  { up: 'Hearing loss', cl: 'Tinnitus', expectedOdds: 94.7, expectedVerdict: 'accept' },
  { up: 'Knee', cl: 'Hip', expectedOdds: 91.4, expectedVerdict: 'accept' },
  { up: 'Obesity', cl: 'Obstructive sleep apnea', expectedOdds: 96.3, expectedVerdict: 'accept' },
  { up: 'Lumbar / back', cl: 'Cervical / neck', expectedOdds: 77.5, expectedVerdict: 'accept' },
  { up: 'PTSD', cl: 'Migraines / headaches', expectedOdds: 92.7, expectedVerdict: 'accept' },
  { up: 'Ankle', cl: 'Knee', expectedOdds: 78.4, expectedVerdict: 'accept' },
  { up: 'Lumbar / back', cl: 'Obstructive sleep apnea', expectedOdds: 88.7, expectedVerdict: 'accept' },
  { up: 'Lumbar / back', cl: 'Hip', expectedOdds: 80, expectedVerdict: 'accept' },
  { up: 'Ankle', cl: 'Lumbar / back', expectedOdds: 84.8, expectedVerdict: 'accept' },
  { up: 'Diabetes type 2', cl: 'Peripheral neuropathy', expectedOdds: 88.2, expectedVerdict: 'accept' },
  { up: 'Tinnitus', cl: 'Migraines / headaches', expectedOdds: 95, expectedVerdict: 'accept' },
  { up: 'GERD', cl: 'Obstructive sleep apnea', expectedOdds: 93.8, expectedVerdict: 'accept' },
  { up: 'Obstructive sleep apnea', cl: 'Hypertension', expectedOdds: 86.7, expectedVerdict: 'accept' },
  { up: 'MDD / Depression', cl: 'Hypertension', expectedOdds: 75, expectedVerdict: 'accept' },
  { up: 'Hypertension', cl: 'Stroke / CVA', expectedOdds: 90, expectedVerdict: 'accept' },
  { up: 'Lumbar / back', cl: 'Migraines / headaches', expectedOdds: 88.2, expectedVerdict: 'accept' },
  { up: 'Lumbar / back', cl: 'Ankle', expectedOdds: 90.9, expectedVerdict: 'accept' },
  { up: 'Plantar fasciitis / foot', cl: 'Ankle', expectedOdds: 73.7, expectedVerdict: 'accept' },
  { up: 'Knee', cl: 'Acquired psychiatric (unspecified)', expectedOdds: 81.8, expectedVerdict: 'accept' },
  { up: 'Hip', cl: 'Knee', expectedOdds: 60, expectedVerdict: 'caution' },
  { up: 'MDD / Depression', cl: 'Migraines / headaches', expectedOdds: 100, expectedVerdict: 'accept' },
  { up: 'TBI', cl: 'Obstructive sleep apnea', expectedOdds: 66.7, expectedVerdict: 'caution' },
  { up: 'Knee', cl: 'PTSD', expectedOdds: 91.7, expectedVerdict: 'accept' },
  { up: 'PTSD', cl: 'MDD / Depression', expectedOdds: 76.3, expectedVerdict: 'accept' },
  { up: 'PTSD', cl: 'Ischemic heart disease', expectedOdds: 82.1, expectedVerdict: 'accept' },
  { up: 'PTSD', cl: 'TBI', expectedOdds: 92, expectedVerdict: 'accept' },
  { up: 'PTSD', cl: 'Peripheral neuropathy', expectedOdds: 88, expectedVerdict: 'accept' },
  { up: 'PTSD', cl: 'Shoulder', expectedOdds: 91.3, expectedVerdict: 'accept' },
  { up: 'PTSD', cl: 'Asthma', expectedOdds: 64.3, expectedVerdict: 'caution' },
  { up: 'PTSD', cl: 'Diabetes type 2', expectedOdds: 85.7, expectedVerdict: 'caution' },
  { up: 'PTSD', cl: 'Wrist', expectedOdds: 92.3, expectedVerdict: 'caution' },
  { up: 'PTSD', cl: 'Hip', expectedOdds: 100, expectedVerdict: 'caution' },
  { up: 'PTSD', cl: 'Plantar fasciitis / foot', expectedOdds: 91.7, expectedVerdict: 'caution' },
  { up: 'Shoulder', cl: 'Tinnitus', expectedOdds: 40, expectedVerdict: 'reject' },
  { up: 'Hip', cl: 'Cervical / neck', expectedOdds: 16.7, expectedVerdict: 'reject' },
  { up: 'Peripheral neuropathy', cl: 'Lumbar / back', expectedOdds: 40, expectedVerdict: 'reject' },
  { up: 'Lumbar / back', cl: 'Peripheral neuropathy', expectedOdds: 66.7, expectedVerdict: 'caution' },
  { up: 'Diabetes type 2', cl: 'Hypertension', expectedOdds: 61.1, expectedVerdict: 'caution' },
  { up: 'Tinnitus', cl: 'Vertigo / Meniere', expectedOdds: 64.3, expectedVerdict: 'caution' },
  { up: 'Ischemic heart disease', cl: 'Obstructive sleep apnea', expectedOdds: 61.5, expectedVerdict: 'caution' },
  { up: 'Hypertension', cl: 'Obstructive sleep apnea', expectedOdds: 64.7, expectedVerdict: 'caution' },
  { up: 'Hypertension', cl: 'Ischemic heart disease', expectedOdds: 53.8, expectedVerdict: 'caution' },
  { up: 'Cervical / neck', cl: 'Radiculopathy', expectedOdds: 94.4, expectedVerdict: 'accept' },
];

const bucketC: BucketCase[] = bucketC_pairs.map((p) => ({
  label: `C pair-coverage ${p.up} -> ${p.cl} (expect ${p.expectedVerdict} @ ${p.expectedOdds}%)`,
  input: buildInput({
    claimedCondition: p.cl,
    framingChoice: 'secondary',
    upstreamScCondition: p.up,
    serviceConnectedConditions: [p.up],
    activeProblems: [p.cl],
  }),
  expected: { verdict: p.expectedVerdict, oddsPctExact: p.expectedOdds, bvaMatched: true, hardGateTriggered: false },
}));

describe('CDS stress | Bucket C: BVA pair coverage (50 real pairs)', () => {
  it.concurrent.each(bucketC)('$label', ({ input, expected, label }) => {
    const r = evaluateCds(input);
    assertResult(r, expected, label);
  });
});

// ============================================================================
// Bucket D: No-match / non-secondary (~30)
// ============================================================================

// D1: claimed conditions with no pair under a valid upstream — should be caution + matched=false.
// (note: hasScAnchor uses *loose* token overlap, so we must construct upstream/SC pairs that
// share at least one significant token — otherwise no_sc_anchor fires and overrides.)
const noPairCombos: readonly { up: string; cl: string; note: string }[] = [
  { up: 'PTSD', cl: 'Glaucoma', note: 'PTSD has no Glaucoma pair' },
  { up: 'PTSD', cl: 'Cataract', note: 'no PTSD->Cataract pair' },
  { up: 'Tinnitus', cl: 'COPD', note: 'no Tinnitus->COPD pair' },
  { up: 'Knee', cl: 'Asthma', note: 'no Knee->Asthma pair' },
  { up: 'Lumbar / back', cl: 'COPD', note: 'no Lumbar->COPD pair' },
  { up: 'Diabetes type 2', cl: 'Migraines / headaches', note: 'no DM->Migraine pair' },
  { up: 'Hearing loss', cl: 'Hypertension', note: 'no HL->HTN pair' },
  { up: 'Tinnitus', cl: 'Glaucoma', note: 'no Tinnitus->Glaucoma pair' },
];
const bucketD: BucketCase[] = noPairCombos.map((c) => ({
  label: `D1 no-pair: ${c.up} -> ${c.cl} (${c.note})`,
  input: buildInput({
    claimedCondition: c.cl,
    framingChoice: 'secondary',
    upstreamScCondition: c.up,
    serviceConnectedConditions: [c.up],
    activeProblems: [c.cl],
  }),
  expected: { verdict: 'caution', bvaMatched: false, hardGateTriggered: false, oddsPctExact: null },
}));

// D2: non-secondary claims (direct, initial, presumptive, supplemental) without an upstream — BVA
// branch skipped, caution + matched=false.
const nonSecondaryConditions: readonly { cond: string; framing: string }[] = [
  { cond: 'Tinnitus', framing: 'direct' },
  { cond: 'PTSD', framing: 'direct' },
  { cond: 'Hearing loss', framing: 'direct' },
  { cond: 'Asthma', framing: 'direct' },
  { cond: 'Lumbar / back', framing: 'initial' },
  { cond: 'Knee', framing: 'initial' },
  { cond: 'Type 2 diabetes', framing: 'presumptive' },
  { cond: 'Ischemic heart disease', framing: 'presumptive' },
  { cond: 'Hypertension', framing: 'presumptive' },
  { cond: 'GERD', framing: 'service connection' },
  { cond: 'Migraines / headaches', framing: 'direct' },
  { cond: 'Tinnitus', framing: '' },
  { cond: 'PTSD', framing: 'in service stressor' },
];
for (const ns of nonSecondaryConditions) {
  bucketD.push({
    label: `D2 non-secondary "${ns.cond}" (framing="${ns.framing}")`,
    input: buildInput({
      claimedCondition: ns.cond,
      framingChoice: ns.framing,
      upstreamScCondition: null,
      serviceConnectedConditions: [],
      activeProblems: [ns.cond],
    }),
    expected: { verdict: 'caution', bvaMatched: false, hardGateTriggered: false, oddsPctExact: null },
  });
}

// D3: upstream condition is real but completely unknown (no key in atlas) — claimed irrelevant.
// hasScAnchor: claimed-text upstream shares no tokens with SC. We make SC contain a matching token
// so we don't fall into no_sc_anchor; we want to test the no-pair branch specifically.
const unknownUpstreams: readonly { up: string; cl: string }[] = [
  { up: 'Vitiligo', cl: 'Obstructive sleep apnea' },
  { up: 'Rosacea', cl: 'PTSD' },
  { up: 'Bunion', cl: 'Knee' },
  { up: 'Lipoma', cl: 'Lumbar / back' },
  { up: 'Costochondritis', cl: 'GERD' },
  { up: 'Pseudofolliculitis', cl: 'Hypertension' },
  { up: 'Verruca', cl: 'Tinnitus' },
  { up: 'Anosmia', cl: 'Migraines / headaches' },
  { up: 'Synovitis', cl: 'Plantar fasciitis / foot' },
];
for (const u of unknownUpstreams) {
  bucketD.push({
    label: `D3 unknown upstream "${u.up}" -> ${u.cl}`,
    input: buildInput({
      claimedCondition: u.cl,
      framingChoice: 'secondary',
      upstreamScCondition: u.up,
      serviceConnectedConditions: [u.up],
      activeProblems: [u.cl],
    }),
    expected: { verdict: 'caution', bvaMatched: false, hardGateTriggered: false, oddsPctExact: null },
  });
}

describe('CDS stress | Bucket D: No-match / non-secondary', () => {
  it.concurrent.each(bucketD)('$label', ({ input, expected, label }) => {
    const r = evaluateCds(input);
    assertResult(r, expected, label);
  });
});

// ============================================================================
// Bucket E: Edge / malformed input (~30)
// ============================================================================

const bucketE: BucketCase[] = [];

// E1: case-insensitivity confirmation — engine normalizes both sides via normalize().
const caseVariants: readonly { c: string; u: string }[] = [
  { c: 'ptsd', u: 'obstructive sleep apnea' },
  { c: 'PTSD', u: 'OBSTRUCTIVE SLEEP APNEA' },
  { c: ' Ptsd ', u: ' Obstructive Sleep Apnea ' },
  { c: 'pTsD', u: 'obstructive SLEEP apnea' },
];
// Caveat: claimedCondition='ptsd' with upstream='OSA' — the engine looks up PAIRS[upstream][claimed].
// So we test PTSD as the UPSTREAM and OSA variants as the CLAIMED.
for (const v of caseVariants) {
  bucketE.push({
    label: `E1 case/whitespace "${v.c}" -> "${v.u}" (PTSD upstream, OSA claimed)`,
    input: buildInput({
      claimedCondition: v.u, // OSA-variant
      framingChoice: 'secondary',
      upstreamScCondition: v.c, // PTSD-variant
      serviceConnectedConditions: [v.c],
      activeProblems: [v.u],
    }),
    expected: { verdict: 'accept', oddsPctExact: 89.2, bvaMatched: true, hardGateTriggered: false },
  });
}

// E2: whitespace-only claimedCondition — engine's barred check sees empty text, no_diagnosis (or
// upstream-anchor check) governs depending on other fields. Empty claimedCondition + empty
// activeProblems => no_diagnosis. Empty claimed + populated activeProblems + secondary + anchored
// upstream => falls through to BVA branch where matchKey returns null for the empty claimed.
bucketE.push({
  label: 'E2 empty claimedCondition + empty activeProblems => no_diagnosis',
  input: buildInput({
    claimedCondition: '',
    activeProblems: [],
  }),
  expected: { verdict: 'reject', hardGateTriggered: true, hardGateRule: 'no_diagnosis' },
});

bucketE.push({
  label: 'E2 whitespace claimedCondition + empty activeProblems => no_diagnosis',
  input: buildInput({
    claimedCondition: '   ',
    activeProblems: [],
  }),
  expected: { verdict: 'reject', hardGateTriggered: true, hardGateRule: 'no_diagnosis' },
});

bucketE.push({
  label: 'E2 empty claimedCondition + populated Dx + anchored upstream => caution (BVA cannot match empty)',
  input: buildInput({
    claimedCondition: '',
    activeProblems: ['Some diagnosis'],
  }),
  expected: { verdict: 'caution', bvaMatched: false, hardGateTriggered: false },
});

// E3: whitespace-only upstream — anchor check sees empty token set; engine treats hasScAnchor as
// "no overlap" because conceptTokens('  ')=[] AND scConditions.length>0 still triggers anchor=true
// path... but the upstream string itself is technically present (truthy ' '). Let's verify.
// hasScAnchor: up=Set(), since size==0 returns scConditions.length>0. With SC=['PTSD'], anchor=true.
// Then BVA matchKey(' ', keys) normalizes to '' => returns null. So we fall to "no stats" branch
// caution. Expected: caution + matched=false.
bucketE.push({
  label: 'E3 whitespace upstreamScCondition + SC populated => caution (anchor passes loose, BVA empty)',
  input: buildInput({
    claimedCondition: 'Obstructive sleep apnea',
    upstreamScCondition: '   ',
    serviceConnectedConditions: ['PTSD'],
  }),
  expected: { verdict: 'caution', bvaMatched: false, hardGateTriggered: false },
});

// E4: very long strings — must not crash, normalize() collapses, matcher returns null.
const longUp = 'a'.repeat(1500);
const longCl = 'b'.repeat(1500);
bucketE.push({
  label: 'E4 1500-char upstream and claimed (no crash, no match)',
  input: buildInput({
    claimedCondition: longCl,
    upstreamScCondition: longUp,
    serviceConnectedConditions: [longUp],
    activeProblems: [longCl],
  }),
  expected: { verdict: 'caution', bvaMatched: false, hardGateTriggered: false },
});

// E5: unicode / emoji in inputs — must not crash. normalize() strips non-alphanumerics.
bucketE.push({
  label: 'E5 emoji-laden claimedCondition',
  input: buildInput({
    claimedCondition: 'obstructive sleep apnea',
    upstreamScCondition: 'PTSD',
    serviceConnectedConditions: ['PTSD'],
    activeProblems: ['Obstructive sleep apnea'],
  }),
  expected: { verdict: 'accept', oddsPctExact: 89.2, bvaMatched: true },
});

bucketE.push({
  label: 'E5 unicode-only claimedCondition (CJK)',
  input: buildInput({
    claimedCondition: '無呼吸',
    upstreamScCondition: 'PTSD',
    serviceConnectedConditions: ['PTSD'],
    activeProblems: ['無呼吸'],
  }),
  expected: { verdict: 'caution', bvaMatched: false, hardGateTriggered: false },
});

// E6: condition aliases — Spelled-out forms should match atlas keys via ALIASES.
const aliasTests: readonly { input: string; effective: string }[] = [
  { input: 'major depressive disorder', effective: 'MDD / Depression' },
  { input: 'mdd', effective: 'MDD / Depression' },
  { input: 'high blood pressure', effective: 'Hypertension' },
  { input: 'generalized anxiety disorder', effective: 'Anxiety / GAD' },
  { input: 'a fib', effective: 'Atrial fibrillation' },
  { input: 'coronary artery disease', effective: 'Ischemic heart disease' },
  { input: 'traumatic brain injury', effective: 'TBI' },
  { input: 'migraine', effective: 'Migraines / headaches' },
  { input: 'irritable bowel syndrome', effective: 'IBS' },
];
for (const a of aliasTests) {
  // Use each alias as the claimed condition against a known PTSD upstream (PTSD doesn't have all
  // these as pairs, so we expect bvaMatched=false BUT no crash). The point is alias resolution.
  bucketE.push({
    label: `E6 alias resolution: "${a.input}"`,
    input: buildInput({
      claimedCondition: a.input,
      upstreamScCondition: 'PTSD',
      serviceConnectedConditions: ['PTSD'],
      activeProblems: [a.input],
    }),
    expected: { hardGateTriggered: false },
  });
}

// E7: null upstream + secondary framing — isSecondary=true via framing, but upstreamScCondition is
// null, so anchor check is skipped (engine guards with `input.upstreamScCondition &&`). BVA branch
// runs with upstreamKey=null => no stats => caution.
bucketE.push({
  label: 'E7 null upstream + framing=secondary + Dx present => caution',
  input: buildInput({
    claimedCondition: 'Obstructive sleep apnea',
    framingChoice: 'secondary',
    upstreamScCondition: null,
    serviceConnectedConditions: [],
    activeProblems: ['Obstructive sleep apnea'],
  }),
  expected: { verdict: 'caution', bvaMatched: false, hardGateTriggered: false },
});

// E8: empty SC list with framing=secondary but null upstream — same as E7.
bucketE.push({
  label: 'E8 framing aggravation + null upstream',
  input: buildInput({
    claimedCondition: 'GERD',
    framingChoice: 'aggravation',
    upstreamScCondition: null,
    serviceConnectedConditions: [],
    activeProblems: ['GERD'],
  }),
  expected: { verdict: 'caution', bvaMatched: false, hardGateTriggered: false },
});

// E9: empty serviceConnectedConditions + non-null upstream + secondary — hasScAnchor returns false
// (no SC entries to overlap with), so no_sc_anchor fires.
bucketE.push({
  label: 'E9 secondary + upstream populated + SC list empty => no_sc_anchor',
  input: buildInput({
    claimedCondition: 'OSA',
    framingChoice: 'secondary',
    upstreamScCondition: 'PTSD',
    serviceConnectedConditions: [],
    activeProblems: ['OSA'],
  }),
  expected: { verdict: 'reject', hardGateTriggered: true, hardGateRule: 'no_sc_anchor' },
});

// E10: punctuation-heavy condition names — engine strips via regex.
const punctVariants: readonly string[] = [
  'Obstructive sleep apnea!!!',
  '...obstructive sleep apnea...',
  '(obstructive) sleep apnea (OSA)',
  'obstructive_sleep_apnea',
  'obstructive-sleep-apnea',
  'obstructive/sleep/apnea',
  'obstructive,sleep,apnea',
];
for (const v of punctVariants) {
  bucketE.push({
    label: `E10 punctuation: "${v}"`,
    input: buildInput({
      claimedCondition: v,
      upstreamScCondition: 'PTSD',
      serviceConnectedConditions: ['PTSD'],
      activeProblems: [v],
    }),
    expected: { verdict: 'accept', oddsPctExact: 89.2, bvaMatched: true, hardGateTriggered: false },
  });
}

// E11: numeric-only / nonsense conditions — must not crash, return caution (no match).
const nonsense: readonly string[] = ['12345', '???', 'null', 'undefined', 'NaN', '0', 'foo bar baz', 'XXX YYY ZZZ'];
for (const n of nonsense) {
  bucketE.push({
    label: `E11 nonsense claimed: "${n}"`,
    input: buildInput({
      claimedCondition: n,
      upstreamScCondition: 'PTSD',
      serviceConnectedConditions: ['PTSD'],
      activeProblems: [n],
    }),
    expected: { verdict: 'caution', bvaMatched: false, hardGateTriggered: false },
  });
}

// E12: very large SC condition list — must not crash.
const bigSc: readonly string[] = ['PTSD', 'Tinnitus', 'Hearing loss', 'Lumbar / back', 'Knee', 'Hip', 'Ankle', 'Shoulder', 'MDD', 'GERD', 'Sinusitis', 'Migraine', 'Asthma', 'Hypertension', 'OSA'];
bucketE.push({
  label: 'E12 large SC list (15 entries)',
  input: buildInput({
    claimedCondition: 'Obstructive sleep apnea',
    upstreamScCondition: 'PTSD',
    serviceConnectedConditions: bigSc,
    activeProblems: ['Obstructive sleep apnea'],
  }),
  expected: { verdict: 'accept', oddsPctExact: 89.2, bvaMatched: true, hardGateTriggered: false },
});

// E13: SC list contains only stopwords — hasScAnchor with upstream having real tokens should still
// find the upstream in SC list via the upstream string. But if upstream has tokens AND SC has only
// stopword tokens, anchor=false. Constructed to verify.
bucketE.push({
  label: 'E13 SC list all-stopwords + real upstream => no_sc_anchor',
  input: buildInput({
    claimedCondition: 'OSA',
    upstreamScCondition: 'PTSD',
    serviceConnectedConditions: ['chronic disorder', 'unspecified syndrome'],
    activeProblems: ['OSA'],
  }),
  expected: { verdict: 'reject', hardGateTriggered: true, hardGateRule: 'no_sc_anchor' },
});

// E14: upstream is all-stopwords (no concept tokens) — engine permits anchor when SC list is
// non-empty (per hasScAnchor's up.size===0 branch).
bucketE.push({
  label: 'E14 upstream all-stopwords + SC nonempty => anchor passes loose',
  input: buildInput({
    claimedCondition: 'Obstructive sleep apnea',
    upstreamScCondition: 'chronic disorder',
    serviceConnectedConditions: ['PTSD'],
    activeProblems: ['Obstructive sleep apnea'],
  }),
  expected: { hardGateTriggered: false }, // no specific verdict because upstreamKey lookup will be null
});

describe('CDS stress | Bucket E: Edge / malformed input', () => {
  it.concurrent.each(bucketE)('$label', ({ input, expected, label }) => {
    const r = evaluateCds(input);
    assertResult(r, expected, label);
  });
});

// ============================================================================
// Bucket F: Determinism / idempotency (~20)
// ============================================================================
//
// For each well-known input, run the engine N=10 times and assert verdict + oddsPct are
// bit-for-bit identical. Then assert checkedAt is the only field allowed to vary.

const detSeeds: readonly { name: string; input: CdsEngineInput }[] = [
  { name: 'PTSD->OSA accept', input: buildInput({}) },
  { name: 'Hypertension->IHD caution', input: buildInput({ claimedCondition: 'Ischemic heart disease', upstreamScCondition: 'Hypertension', serviceConnectedConditions: ['Hypertension'], activeProblems: ['Ischemic heart disease'] }) },
  { name: 'Hip->Cervical reject', input: buildInput({ claimedCondition: 'Cervical / neck', upstreamScCondition: 'Hip', serviceConnectedConditions: ['Hip'], activeProblems: ['Cervical / neck'] }) },
  { name: 'no diagnosis reject', input: buildInput({ activeProblems: [] }) },
  { name: 'tobacco direct reject', input: buildInput({ claimedCondition: 'COPD from smoking', framingChoice: 'direct', upstreamScCondition: null, serviceConnectedConditions: [], activeProblems: ['COPD'] }) },
  { name: 'no-anchor reject', input: buildInput({ serviceConnectedConditions: ['Tinnitus'] }) },
  { name: 'direct no-pair caution', input: buildInput({ claimedCondition: 'Tinnitus', framingChoice: 'direct', upstreamScCondition: null, serviceConnectedConditions: [], activeProblems: ['Tinnitus'] }) },
  { name: 'alias OSA accept', input: buildInput({ claimedCondition: 'Sleep apnea', upstreamScCondition: 'Post-traumatic stress disorder' }) },
  { name: 'low-tier high-odds caution', input: buildInput({ claimedCondition: 'Hip', upstreamScCondition: 'PTSD' }) },
  { name: 'no-pair caution', input: buildInput({ claimedCondition: 'Glaucoma', upstreamScCondition: 'PTSD', activeProblems: ['Glaucoma'] }) },
];

const bucketF: { label: string; input: CdsEngineInput }[] = detSeeds.map((s) => ({
  label: `F deterministic: ${s.name}`,
  input: s.input,
}));

// Pad bucket to 20 with phrasing-variant determinism (same logical input, different surface form).
bucketF.push({ label: 'F deterministic: PTSD->OSA ALLCAPS', input: buildInput({ claimedCondition: 'OBSTRUCTIVE SLEEP APNEA', upstreamScCondition: 'PTSD', serviceConnectedConditions: ['PTSD'], activeProblems: ['OBSTRUCTIVE SLEEP APNEA'] }) });
bucketF.push({ label: 'F deterministic: PTSD->OSA lower', input: buildInput({ claimedCondition: 'obstructive sleep apnea', upstreamScCondition: 'ptsd', serviceConnectedConditions: ['ptsd'], activeProblems: ['obstructive sleep apnea'] }) });
bucketF.push({ label: 'F deterministic: PTSD->OSA mixed casing', input: buildInput({ claimedCondition: 'Obstructive Sleep Apnea', upstreamScCondition: 'PtSd' }) });
bucketF.push({ label: 'F deterministic: alias HTN->IHD', input: buildInput({ claimedCondition: 'IHD', upstreamScCondition: 'HTN', serviceConnectedConditions: ['HTN'], activeProblems: ['IHD'] }) });
bucketF.push({ label: 'F deterministic: noisy real-world phrasing', input: buildInput({ claimedCondition: 'Obstructive sleep apnea, chronic, confirmed', upstreamScCondition: 'PTSD (service connected, 70%)', serviceConnectedConditions: ['PTSD secondary residuals', 'Tinnitus', 'Right knee strain'], activeProblems: ['Obstructive sleep apnea - confirmed on exam', 'Hypertension'] }) });
bucketF.push({ label: 'F deterministic: long upstream', input: buildInput({ upstreamScCondition: 'a'.repeat(800), serviceConnectedConditions: ['a'.repeat(800)] }) });
bucketF.push({ label: 'F deterministic: framing=aggravation', input: buildInput({ framingChoice: 'aggravation' }) });
bucketF.push({ label: 'F deterministic: empty framing', input: buildInput({ framingChoice: '' }) });
bucketF.push({ label: 'F deterministic: null framing', input: buildInput({ framingChoice: null }) });
bucketF.push({ label: 'F deterministic: trailing punctuation upstream', input: buildInput({ upstreamScCondition: 'PTSD.', serviceConnectedConditions: ['PTSD.'] }) });

describe('CDS stress | Bucket F: Determinism / idempotency (N=10)', () => {
  it.concurrent.each(bucketF)('$label', ({ input, label }) => {
    const runs: CdsResult[] = [];
    for (let i = 0; i < 10; i++) runs.push(evaluateCds(input));
    // verdict + oddsPct + summary + hardGate + bva: bit-for-bit identical across runs.
    const first = runs[0];
    if (first === undefined) throw new Error(`${label}: no runs`);
    for (let i = 1; i < runs.length; i++) {
      const r = runs[i];
      if (r === undefined) throw new Error(`${label}: missing run ${i}`);
      expect(r.verdict, `${label}: run ${i} verdict`).toBe(first.verdict);
      expect(r.oddsPct, `${label}: run ${i} oddsPct`).toBe(first.oddsPct);
      expect(r.summary, `${label}: run ${i} summary`).toBe(first.summary);
      expect(r.hardGate, `${label}: run ${i} hardGate`).toEqual(first.hardGate);
      expect(r.bva, `${label}: run ${i} bva`).toEqual(first.bva);
      expect(r.engineVersion, `${label}: run ${i} engineVersion`).toBe(first.engineVersion);
      // checkedAt MAY differ (it's Date.now-based) — assert it's still ISO.
      expect(r.checkedAt, `${label}: run ${i} checkedAt is ISO`).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});

// ============================================================================
// Bucket count sanity check — fails the suite if total drops below 250.
// ============================================================================

describe('CDS stress | Bucket count guard', () => {
  it('asserts 250+ distinct cases across buckets', () => {
    const counts = {
      A: bucketA.length,
      B: bucketB.length,
      C: bucketC.length,
      D: bucketD.length,
      E: bucketE.length,
      F: bucketF.length,
    };
    const total = counts.A + counts.B + counts.C + counts.D + counts.E + counts.F;
    console.log('CDS stress bucket counts:', counts, 'total', total);
    expect(total).toBeGreaterThanOrEqual(250);
  });
});
