import { describe, it, expect } from 'vitest';
import { computeStrategyPreview, findChainPathway, type StrategyPreviewInput } from '../services/strategy-preview.js';

// Locks the deterministic tier ladder. The two anchors Ryan named: knee->blindness must STOP (no
// established pathway), OSA->PTSD must be STRONG (a known strong Board pair). Same chart -> same tier.

function input(over: Partial<StrategyPreviewInput>): StrategyPreviewInput {
  return {
    claimedCondition: 'OSA', claimType: 'secondary', framingChoice: 'causation',
    upstreamScCondition: 'PTSD', serviceConnectedConditions: ['PTSD'], activeProblems: ['OSA'],
    ...over,
  };
}

describe('strategy-preview tier ladder (deterministic, reproducible)', () => {
  const cases: Array<{ name: string; over: Partial<StrategyPreviewInput>; tier: string }> = [
    { name: 'OSA secondary to PTSD = Strong (known strong Board pair)', over: {}, tier: 'Strong' },
    // DIRECT claim with no Board pair must NEVER Stop — the false-Stop bug Ryan caught (GERD/OSA direct).
    // P1e 3-state: only a DOCUMENTED inServiceEvent makes the hook green -> Plausible; a veteran
    // statement alone is AMBER -> Thin (the Porter fix); neither -> Thin.
    { name: 'direct claim WITH DOCUMENTED in-service event, no Board pair = Plausible (NEVER Stop)', over: { claimType: 'direct', claimedCondition: 'GERD / Gastritis', framingChoice: 'direct', upstreamScCondition: null, serviceConnectedConditions: [], activeProblems: ['GERD'], inServiceEvent: 'onset during service after a deployment exposure', proposedMechanism: 'onset during service after a deployment exposure' }, tier: 'Plausible' },
    { name: 'direct claim with veteran STATEMENT ONLY (no documented event) = Thin, never Plausible (Porter)', over: { claimType: 'direct', claimedCondition: 'GERD / Gastritis', framingChoice: 'direct', upstreamScCondition: null, serviceConnectedConditions: [], activeProblems: ['GERD'], veteranStatement: 'I was exposed to burn pits and my reflux started then', proposedMechanism: 'I was exposed to burn pits and my reflux started then' }, tier: 'Thin' },
    { name: 'direct claim with NO in-service hook = Thin (flag the missing nexus story, not Stop)', over: { claimType: 'direct', claimedCondition: 'GERD / Gastritis', framingChoice: 'direct', upstreamScCondition: null, serviceConnectedConditions: [], activeProblems: ['GERD'] }, tier: 'Thin' },
    // SECONDARY claim with no Board pair = Thin ("rely on literature"), not Stop — absence of data ≠ impossible.
    { name: 'secondary, no Board pair = Thin (not Stop)', over: { claimedCondition: 'blindness', upstreamScCondition: 'knee', serviceConnectedConditions: ['knee'], activeProblems: ['blindness'] }, tier: 'Thin' },
    { name: 'no diagnosis on file = Stop (hard gate)', over: { activeProblems: [] }, tier: 'Stop' },
    { name: 'anchor named but not service-connected = Stop (hard gate)', over: { serviceConnectedConditions: [] }, tier: 'Stop' },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(computeStrategyPreview(input(c.over)).tier).toBe(c.tier);
    });
  }

  it('is NOT evaluable on a bare/untriaged case (no claimed condition) — card stays hidden', () => {
    expect(computeStrategyPreview(input({ claimedCondition: '' })).evaluable).toBe(false);
    expect(computeStrategyPreview(input({})).evaluable).toBe(true);
  });

  it('recommends secondary-to-X when a strong Board pair exists for a granted SC condition', () => {
    // OSA claimed, framed "direct", but PTSD is granted SC and PTSD->OSA is a strong pair -> suggest secondary.
    const r = computeStrategyPreview(input({ claimType: 'direct', framingChoice: 'direct', upstreamScCondition: null, serviceConnectedConditions: ['PTSD'], claimedCondition: 'OSA', activeProblems: ['OSA'] }));
    expect(r.recommendedPathway.kind).toBe('secondary');
    expect(r.recommendedPathway.anchor?.toLowerCase()).toContain('ptsd');
    expect(r.recommendedPathway.differsFromCurrent).toBe(true);
  });

  it('RECOVERS the effective anchor from a garbage stored value (Stocks: migraines secondary to OSA = Strong)', () => {
    const r = computeStrategyPreview(input({
      claimType: 'secondary', framingChoice: 'secondary', claimedCondition: 'migraines',
      upstreamScCondition: 'service I wake up with headaches', // garbage — resolves to no atlas pair
      serviceConnectedConditions: ['Obstructive sleep apnea'], activeProblems: ['migraines'],
    }));
    expect(r.tier).toBe('Strong');
    expect(r.anchor?.toLowerCase()).toContain('sleep apnea');
    expect(r.primaryArgument.toLowerCase()).toContain('sleep apnea');
    expect(r.criteria.every((c) => c.pass), JSON.stringify(r.criteria)).toBe(true);
  });

  it('does NOT override a scoreable stored anchor (no silent rewrite of a deliberate framing)', () => {
    const r = computeStrategyPreview(input({})); // default = OSA secondary to PTSD; PTSD resolves to a pair
    expect(r.anchor?.toLowerCase()).toContain('ptsd');
  });

  it('preserves aggravation framing when recovering the anchor', () => {
    const r = computeStrategyPreview(input({
      claimType: 'secondary', framingChoice: 'aggravation', claimedCondition: 'migraines',
      upstreamScCondition: 'garbage zzz', serviceConnectedConditions: ['Obstructive sleep apnea'], activeProblems: ['migraines'],
    }));
    expect(r.primaryArgument.toLowerCase()).toContain('aggravation');
    expect(r.anchor?.toLowerCase()).toContain('sleep apnea');
  });

  it('OSA claim in Jotform format "Sleep Apnea (OSA)" matches the Board pair (Yorde secondary to PTSD = Strong, was Thin)', () => {
    const r = computeStrategyPreview(input({
      claimType: 'secondary', framingChoice: 'secondary', claimedCondition: 'Sleep Apnea (OSA)',
      upstreamScCondition: 'PTSD', serviceConnectedConditions: ['PTSD'], activeProblems: ['Sleep Apnea (OSA)'],
    }));
    expect(r.tier).toBe('Strong');
  });

  it('does NOT nag to switch when already anchored on the suggested pathway', () => {
    // Default input = OSA already framed secondary to granted PTSD (the strong pair) — no "switch" nag.
    const r = computeStrategyPreview(input({}));
    expect(r.recommendedPathway.kind).toBe('secondary');
    expect(r.recommendedPathway.differsFromCurrent).toBe(false);
  });

  it('recommends direct when no granted SC condition has a Board pair to the claimed condition', () => {
    const r = computeStrategyPreview(input({ claimType: 'direct', upstreamScCondition: null, serviceConnectedConditions: [], claimedCondition: 'GERD' }));
    expect(r.recommendedPathway.kind).toBe('direct');
  });

  it('is reproducible — same input twice gives the identical result', () => {
    expect(computeStrategyPreview(input({}))).toEqual(computeStrategyPreview(input({})));
  });

  // ---- P1 re-source (2026-06-11): band wording replaces the two BVA-pair-atlas strings ----
  it('strength criterion renders the viability-engine why VERBATIM when threaded in (band wording, no numbers)', () => {
    const why = 'Strong: service-connected PTSD is a dominant recognized cause of Obstructive sleep apnea.';
    const r = computeStrategyPreview(input({ viability: { band: 'strong', why } }));
    const strength = r.criteria.find((c) => c.key === 'strength')!;
    expect(strength.detail).toBe(why);
  });

  it('strength detail fails open to plain non-numeric copy when the viability read is unavailable (null)', () => {
    const r = computeStrategyPreview(input({ viability: null }));
    const strength = r.criteria.find((c) => c.key === 'strength')!;
    expect(strength.detail).toContain('Viability read unavailable');
  });

  it('strength detail on a DIRECT claim is plain non-numeric copy (the engine answers anchors, not direct claims)', () => {
    const r = computeStrategyPreview(input({
      claimType: 'direct', framingChoice: 'direct', claimedCondition: 'GERD / Gastritis',
      upstreamScCondition: null, serviceConnectedConditions: [], activeProblems: ['GERD'],
      inServiceEvent: 'onset during service after a deployment exposure',
    }));
    const strength = r.criteria.find((c) => c.key === 'strength')!;
    expect(strength.detail).toContain('Not applicable to a direct claim');
  });

  // THE LOCK (Ryan item 2/5): no raw BVA n / % / win-rate / atlas tier may serialize ANYWHERE in the
  // payload — matched secondary, rescued thin pair, unmatched secondary, or direct. The exact strings
  // Ryan named ("n=60, tier high", "Granted in 45 of 60 decided Board appeals (75%)") are the regression.
  it('NO-BVA-STRING LOCK: no n=, decided Board appeals, %, or tier-word serializes in any criterion/payload', () => {
    const payloads = [
      input({}), // matched strong pair (PTSD -> OSA)
      input({ claimedCondition: 'lumbar back', upstreamScCondition: 'knee', serviceConnectedConditions: ['knee'], activeProblems: ['lumbar back'], viability: { band: 'moderate', why: 'Moderate: recognized pathway.' } }),
      input({ claimedCondition: 'obstructive sleep apnea', upstreamScCondition: 'diabetes type 2', serviceConnectedConditions: ['diabetes type 2'], activeProblems: ['obstructive sleep apnea'] }), // rescued thin pair
      input({ claimedCondition: 'blindness', upstreamScCondition: 'knee', serviceConnectedConditions: ['knee'], activeProblems: ['blindness'] }), // unmatched
      input({ claimType: 'direct', framingChoice: 'direct', claimedCondition: 'GERD', upstreamScCondition: null, serviceConnectedConditions: [], activeProblems: ['GERD'], inServiceEvent: 'deployment exposure' }),
    ];
    for (const p of payloads) {
      const json = JSON.stringify(computeStrategyPreview(p));
      expect(json).not.toMatch(/\bn=\d/);
      expect(json).not.toMatch(/decided Board appeals/i);
      expect(json).not.toMatch(/\d+(\.\d+)?%/);
      expect(json).not.toMatch(/tier (high|moderate|low)/i);
      expect(json).not.toMatch(/IMO \d/i);
    }
  });

  // ---- CHANGE 1: thin-sample near-miss rescue (Option A) ----
  // A knee->back-shaped, recognized pairing is NEVER Thin (owner's explicit red line).
  it('knee -> back (robust, n=487, 61.6%) is never Thin/Stop — lands Strong', () => {
    const r = computeStrategyPreview(input({
      claimedCondition: 'lumbar back', upstreamScCondition: 'knee',
      serviceConnectedConditions: ['knee'], activeProblems: ['lumbar back'],
    }));
    expect(r.tier).not.toBe('Thin');
    expect(r.tier).not.toBe('Stop');
    expect(r.tier).toBe('Strong');
  });

  it('thin sample + near-miss grant rate (DM2 -> OSA) rescues Thin -> Plausible (internal numbers; none serialize)', () => {
    const r = computeStrategyPreview(input({
      claimedCondition: 'obstructive sleep apnea', upstreamScCondition: 'diabetes type 2',
      serviceConnectedConditions: ['diabetes type 2'], activeProblems: ['obstructive sleep apnea'],
    }));
    expect(r.tier).toBe('Plausible');
    // The rescued tier must NOT show an adverse ✗ on strength — it rests on mechanism. The detail is
    // now band-sourced / fail-open plain copy (P1 re-source) — the grant numbers never serialize.
    const strength = r.criteria.find((c) => c.key === 'strength')!;
    expect(strength.pass).toBe(true);
    expect(strength.detail).not.toMatch(/\d+(\.\d+)?%/);
    expect(strength.detail).not.toMatch(/decided Board appeals/i);
  });

  it('robust-and-low pair (Hip -> Knee, tier high, 33.3%) is NOT rescued — stays Thin with an adverse ✗', () => {
    const r = computeStrategyPreview(input({
      claimedCondition: 'knee', upstreamScCondition: 'hip',
      serviceConnectedConditions: ['hip'], activeProblems: ['knee'],
    }));
    expect(r.tier).toBe('Thin');
    const strength = r.criteria.find((c) => c.key === 'strength')!;
    expect(strength.pass).toBe(false);
  });

  // ---- P1e: 3-state in-service criterion (the Porter fix) ----
  it('DIRECT + veteranStatement only: event criterion pass:false with tone:"amber" (distinct from red), tier Thin', () => {
    const r = computeStrategyPreview(input({
      claimType: 'direct', framingChoice: 'direct', claimedCondition: 'GERD / Gastritis',
      upstreamScCondition: null, serviceConnectedConditions: [], activeProblems: ['GERD'],
      veteranStatement: 'burn pit exposure on deployment', inServiceEvent: null,
      proposedMechanism: 'burn pit exposure on deployment',
    }));
    expect(r.tier).toBe('Thin'); // NEVER Plausible on an amber-only hook
    const ev = r.criteria.find((c) => c.key === 'anchor')!;
    expect(ev.pass).toBe(false);
    expect(ev.tone).toBe('amber');
    expect(ev.detail).toMatch(/not yet corroborated/i);
    expect(ev.detail).toMatch(/DD-214/);
    // The statement still DISPLAYS — it just no longer satisfies the check.
    expect(r.proposedMechanism).toBe('burn pit exposure on deployment');
  });

  it('DIRECT + documented inServiceEvent: event criterion pass:true (green, no tone), tier Plausible', () => {
    const r = computeStrategyPreview(input({
      claimType: 'direct', framingChoice: 'direct', claimedCondition: 'GERD / Gastritis',
      upstreamScCondition: null, serviceConnectedConditions: [], activeProblems: ['GERD'],
      inServiceEvent: 'STR 2009-04: treated for reflux after deployment', veteranStatement: null,
    }));
    expect(r.tier).toBe('Plausible');
    const ev = r.criteria.find((c) => c.key === 'anchor')!;
    expect(ev.pass).toBe(true);
    expect(ev.tone).toBeUndefined();
    expect(ev.detail).toMatch(/documented in the record/i);
  });

  it('DIRECT + neither field: event criterion pass:false with NO tone (red), tier Thin', () => {
    const r = computeStrategyPreview(input({
      claimType: 'direct', framingChoice: 'direct', claimedCondition: 'GERD / Gastritis',
      upstreamScCondition: null, serviceConnectedConditions: [], activeProblems: ['GERD'],
      inServiceEvent: null, veteranStatement: null,
    }));
    expect(r.tier).toBe('Thin');
    const ev = r.criteria.find((c) => c.key === 'anchor')!;
    expect(ev.pass).toBe(false);
    expect(ev.tone).toBeUndefined();
  });

  it('builds a readable primary argument + surfaces the proposed mechanism + 5 criteria', () => {
    const r = computeStrategyPreview(input({ proposedMechanism: 'weight gain from PTSD meds worsened airway collapse' }));
    expect(r.primaryArgument).toContain('OSA');
    expect(r.primaryArgument).toContain('secondary to service-connected PTSD');
    expect(r.proposedMechanism).toBe('weight gain from PTSD meds worsened airway collapse');
    expect(r.criteria).toHaveLength(5);
  });
});

// ── E5 trustworthy viability (2026-06-13) — input visibility + intermediary chain ────────────────
describe('E5 — input visibility (the fact set the verdict was computed from)', () => {
  it('returns an inputSet mirroring the SC list, meds, problems, key facts + a correct factCount', () => {
    const r = computeStrategyPreview(input({
      serviceConnectedConditions: ['PTSD', 'Tinnitus'],
      activeProblems: ['OSA', 'Hypertension'],
      medications: [{ drugName: 'sertraline', indication: 'PTSD' }],
      keyFacts: [{ label: 'Weight', value: '240 lb' }],
    }));
    expect(r.inputSet).toBeDefined();
    expect(r.inputSet!.scConditions).toEqual(['PTSD', 'Tinnitus']);
    expect(r.inputSet!.medications).toEqual([{ drugName: 'sertraline', indication: 'PTSD' }]);
    expect(r.inputSet!.activeProblems).toEqual(['OSA', 'Hypertension']);
    expect(r.inputSet!.keyFacts).toEqual([{ label: 'Weight', value: '240 lb' }]);
    // 2 SC + 1 med + 2 problems + 1 key fact = 6
    expect(r.inputSet!.factCount).toBe(6);
  });

  it('factCount is 0-fact honest on a thin parse (no SC / meds / problems extracted)', () => {
    // A claimed condition with an empty chart: the engine Stops (no dx), but the inputSet must show
    // factCount 0 so the RN distrusts the verdict on sight (the Woodley lesson).
    const r = computeStrategyPreview(input({ serviceConnectedConditions: [], activeProblems: [] }));
    expect(r.inputSet!.factCount).toBe(0);
  });
});

describe('E5 — intermediary chain (a direct "no" auto-runs the two-hop search)', () => {
  it('findChainPathway composes SC → intermediary → claimed (Tinnitus → Anxiety → Hypertension)', () => {
    // Tinnitus → Hypertension is NOT a direct atlas pair, but Tinnitus → Anxiety and Anxiety →
    // Hypertension both are — the chain recovers the pathway the flat "no" was hiding.
    const chain = findChainPathway('Hypertension', ['Tinnitus'], [{ label: 'Anxiety / GAD', source: 'comorbid_dx' }]);
    expect(chain).not.toBeNull();
    expect(chain!.anchor).toBe('Tinnitus');
    expect(chain!.hops).toHaveLength(2);
    expect(chain!.hops[1].to.toLowerCase()).toContain('hypertension');
  });

  it('a SECONDARY claim with no direct pair SEARCHES the chain and surfaces the recovered pathway', () => {
    const r = computeStrategyPreview(input({
      claimedCondition: 'Hypertension', upstreamScCondition: 'Tinnitus',
      serviceConnectedConditions: ['Tinnitus'], activeProblems: ['Hypertension', 'Anxiety / GAD'],
    }));
    expect(r.chainAttempt).toBeDefined();
    expect(r.chainAttempt!.searched).toBe(true);
    expect(r.chainAttempt!.pathway).not.toBeNull();
    expect(r.chainAttempt!.pathway!.intermediary.toLowerCase()).toContain('anxiety');
  });

  it('uses a med indication as the chain bridge (the med-treating-the-primary pathway)', () => {
    // No comorbid Anxiety on the problem list, but a med treats it — the indication bridges the chain.
    const r = computeStrategyPreview(input({
      claimedCondition: 'Hypertension', upstreamScCondition: 'Tinnitus',
      serviceConnectedConditions: ['Tinnitus'], activeProblems: ['Hypertension'],
      medications: [{ drugName: 'sertraline', indication: 'Anxiety / GAD' }],
    }));
    expect(r.chainAttempt!.pathway).not.toBeNull();
    expect(r.chainAttempt!.pathway!.intermediarySource).toBe('medication_indication');
  });

  it('searches but finds nothing when no intermediary bridges (honest "we looked")', () => {
    const r = computeStrategyPreview(input({
      claimedCondition: 'Hypertension', upstreamScCondition: 'Tinnitus',
      serviceConnectedConditions: ['Tinnitus'], activeProblems: ['Hypertension'],
    }));
    expect(r.chainAttempt!.searched).toBe(true);
    expect(r.chainAttempt!.pathway).toBeNull();
  });

  it('does NOT run the chain search when a DIRECT pathway already exists (OSA secondary to PTSD)', () => {
    const r = computeStrategyPreview(input({})); // default = OSA secondary to PTSD, a direct pair
    expect(r.chainAttempt).toBeUndefined();
  });

  it('the chain NEVER moves the deterministic tier (advisory only) — Tinnitus→HTN stays Thin', () => {
    const r = computeStrategyPreview(input({
      claimedCondition: 'Hypertension', upstreamScCondition: 'Tinnitus',
      serviceConnectedConditions: ['Tinnitus'], activeProblems: ['Hypertension', 'Anxiety / GAD'],
    }));
    expect(r.tier).toBe('Thin'); // no direct pair → Thin, regardless of the recovered chain
    expect(r.chainAttempt!.pathway).not.toBeNull();
  });
});
