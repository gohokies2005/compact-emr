import { describe, expect, it } from 'vitest';
import { evaluateCds, type CdsEngineInput, type CdsResult } from '../services/cdsEngine.js';
import bvaData from '../data/bva_secondary_pairs.json' with { type: 'json' };

const PAIRS = (bvaData as unknown as { pairs: Record<string, Record<string, unknown>> }).pairs;

interface StressCase { label: string; input: CdsEngineInput; viable: boolean; }

// "viable" = should NOT be hard-gate-rejected (has a real SC anchor + a diagnosis). A reject on
// these is a FALSE NON-VIABLE — the thing Ryan wants near-zero (prefers loose over over-screening).
function buildCases(): StressCase[] {
  const cases: StressCase[] = [];
  for (const [upstream, claimedMap] of Object.entries(PAIRS)) {
    for (const claimed of Object.keys(claimedMap)) {
      // 1. clean exact pair
      cases.push({ label: `exact ${upstream}->${claimed}`, viable: true, input: { claimedCondition: claimed, claimType: 'initial', framingChoice: 'secondary', upstreamScCondition: upstream, serviceConnectedConditions: [upstream], activeProblems: [claimed] } });
      // 2. messy real-world phrasing on BOTH sides + distractor conditions (stresses the matcher)
      cases.push({ label: `messy ${upstream}->${claimed}`, viable: true, input: { claimedCondition: `${claimed}, chronic`, claimType: 'supplemental', framingChoice: 'secondary to service-connected condition', upstreamScCondition: `${upstream} (service connected, 70%)`, serviceConnectedConditions: [`${upstream} secondary residuals`, 'Tinnitus', 'Right knee strain'], activeProblems: [`${claimed} - confirmed on exam`, 'Hypertension'] } });
    }
  }
  // hard no's (SHOULD reject — not counted as false non-viable)
  cases.push({ label: 'no Dx', viable: false, input: { claimedCondition: 'OSA', claimType: 'initial', framingChoice: 'secondary', upstreamScCondition: 'PTSD', serviceConnectedConditions: ['PTSD'], activeProblems: [] } });
  cases.push({ label: 'no SC anchor', viable: false, input: { claimedCondition: 'OSA', claimType: 'initial', framingChoice: 'secondary', upstreamScCondition: 'PTSD', serviceConnectedConditions: ['Tinnitus', 'Right knee strain'], activeProblems: ['OSA'] } });
  cases.push({ label: 'barred tobacco', viable: false, input: { claimedCondition: 'COPD from in-service smoking', claimType: 'initial', framingChoice: 'direct', upstreamScCondition: null, serviceConnectedConditions: [], activeProblems: ['COPD'] } });
  // fuzz / edge — must not crash
  const weird = ['', '   ', '???', 'a'.repeat(600), 'PTSD\n\t\r', '🦅 sleep apnea ☠', 'UNKNOWN CONDITION XYZ', 'null', '12345'];
  for (const w of weird) {
    cases.push({ label: `fuzz "${w.slice(0, 8)}"`, viable: false, input: { claimedCondition: w, claimType: w, framingChoice: w, upstreamScCondition: w, serviceConnectedConditions: [w], activeProblems: [w] } });
  }
  return cases;
}

describe('CDS stress', () => {
  it('runs 250+ cases: no crashes, near-zero false non-viables', () => {
    const cases = buildCases();
    expect(cases.length).toBeGreaterThanOrEqual(250);
    const dist: Record<string, number> = { accept: 0, caution: 0, reject: 0 };
    const falseNonViable: string[] = [];
    let crashes = 0;
    for (const c of cases) {
      let r: CdsResult;
      try { r = evaluateCds(c.input); } catch { crashes++; continue; }
      dist[r.verdict] = (dist[r.verdict] ?? 0) + 1;
      if (c.viable && r.verdict === 'reject' && r.hardGate.triggered) falseNonViable.push(`${c.label} [${r.hardGate.rule}]`);
    }
    console.log(`CDS stress: ${cases.length} cases | dist ${JSON.stringify(dist)} | crashes ${crashes} | false-non-viable ${falseNonViable.length}`);
    if (falseNonViable.length) console.log('FALSE NON-VIABLES (sample):', falseNonViable.slice(0, 15));
    expect(crashes).toBe(0);
    expect(falseNonViable.length).toBe(0);
  });
});
