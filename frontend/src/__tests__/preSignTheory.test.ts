import { describe, it, expect } from 'vitest';
import { buildPreSignTheory } from '../components/preSignTheory';
import type { AiViabilityCard } from '../api/case-viability';

function plan(lead: Partial<AiViabilityCard['lead']>, alternatives: AiViabilityCard['alternatives'] = []): AiViabilityCard {
  return {
    source: 'ai_route_picker',
    viability: 'supportable',
    lead: { upstream: '', claimed: '', framing: '', cfr_basis: '', mechanism: '', confidence: '', rationale: '', counterargument: '', ...lead },
    convergent: [],
    alternatives,
    missing: [],
    nuance: '',
    overall: '',
  };
}

describe('buildPreSignTheory', () => {
  it('ALIGNED: veteran secondary-to-PTSD, letter secondary-to-PTSD → no mismatch, "Their theory" label', () => {
    const t = buildPreSignTheory({
      claimedCondition: 'Obstructive Sleep Apnea',
      framingChoice: 'secondary',
      upstreamScCondition: 'PTSD',
      veteranStatement: 'I think my sleep apnea is from my PTSD.',
      aiViabilityPlanJson: plan({ claimed: 'Obstructive Sleep Apnea', framing: 'secondary', upstream: 'PTSD' }),
    });
    expect(t.mismatch).toBeNull();
    expect(t.veteranTheory).toBe('Secondary to service-connected PTSD');
    expect(t.letterTheory).toBe('Obstructive Sleep Apnea secondary to PTSD');
  });

  it('does NOT emit a positive "matches" affirmation (no green ✓ field exists)', () => {
    const t = buildPreSignTheory({ framingChoice: 'secondary', upstreamScCondition: 'PTSD', aiViabilityPlanJson: plan({ framing: 'secondary', upstream: 'PTSD' }) });
    expect((t as unknown as Record<string, unknown>).matches).toBeUndefined();
  });

  it('MISMATCH: veteran secondary-to-Ankle, letter secondary-to-PTSD → mismatch w/ why_not + suggestEdit', () => {
    const t = buildPreSignTheory({
      framingChoice: 'secondary',
      upstreamScCondition: 'Ankle',
      aiViabilityPlanJson: plan(
        { claimed: 'OSA', framing: 'secondary', upstream: 'PTSD', counterargument: 'weak ankle link' },
        [{ upstream: 'Ankle', framing: 'secondary', why_not: 'The ankle-to-OSA mechanism is not well supported.' }],
      ),
    });
    expect(t.mismatch).not.toBeNull();
    expect(t.mismatch!.reason).toContain('ankle-to-OSA');
    expect(t.mismatch!.suggestEdit).toBe(true);
  });

  it('reason comes ONLY from why_not (never counterargument/rationale); a bare non-alternative anchor is silent', () => {
    // Flat feet is not a plan alternative + same framing as the lead → nothing specific/grounded → SILENT.
    const silent = buildPreSignTheory({
      framingChoice: 'secondary',
      upstreamScCondition: 'Flat feet',
      aiViabilityPlanJson: plan({ framing: 'secondary', upstream: 'PTSD', counterargument: 'PTSD is the strongest anchor.', rationale: 'strong PTSD nexus' }),
    });
    expect(silent.mismatch).toBeNull();
    // When the veteran pushes a DEMOTED alternative, reason = its (tidied) why_not — NEVER the counterargument.
    const flagged = buildPreSignTheory({
      framingChoice: 'secondary',
      upstreamScCondition: 'Flat feet',
      aiViabilityPlanJson: plan(
        { framing: 'secondary', upstream: 'PTSD', counterargument: 'PTSD is the strongest anchor.', rationale: 'strong PTSD nexus' },
        [{ upstream: 'Flat feet', framing: 'secondary_causation', why_not: 'pes planus is a weaker mechanism' }],
      ),
    });
    expect(flagged.mismatch!.reason).toBe('Pes planus is a weaker mechanism.'); // tidied why_not, not counterargument
  });

  it('LOOSE match: "Asthma" vs "Asthma, Bronchial" → not flagged', () => {
    const t = buildPreSignTheory({ framingChoice: 'secondary', upstreamScCondition: 'Asthma', aiViabilityPlanJson: plan({ framing: 'secondary', upstream: 'Asthma, Bronchial' }) });
    expect(t.mismatch).toBeNull();
  });

  it('LATERALITY same joint: "Left knee" vs "Right knee" → NOT flagged (same condition, "knee" matches)', () => {
    const t = buildPreSignTheory({ framingChoice: 'secondary', upstreamScCondition: 'Left knee', aiViabilityPlanJson: plan({ framing: 'secondary', upstream: 'Right knee' }) });
    expect(t.mismatch).toBeNull();
  });

  it('LATERALITY: a distinct-joint anchor does NOT wrongly align on "left" — a same-joint ALTERNATIVE is skipped, a different one surfaces', () => {
    // lead = Left wrist; alternatives = Right wrist (same joint "wrist" → letter already argues it, 2 framings)
    // + GERD (distinct, 2 framings). Only GERD should surface; the "wrist" alt must be recognized as the lead's.
    const t = buildPreSignTheory({
      veteranStatement: 'my left wrist problem caused it',
      aiViabilityPlanJson: plan(
        { framing: 'secondary', upstream: 'Left wrist' },
        [
          { upstream: 'Right wrist', framing: 'secondary_causation', why_not: 'a' },
          { upstream: 'Right wrist', framing: 'aggravation', why_not: 'b' },
          { upstream: 'gastroesophageal reflux disease (GERD)', framing: 'secondary_causation', why_not: 'c' },
          { upstream: 'gastroesophageal reflux disease (GERD)', framing: 'aggravation', why_not: 'd' },
        ],
      ),
      veteranTheoryAi: { theory: 'Veteran attributes it to the left wrist.', framing: 'secondary', upstream: 'Left wrist' },
    });
    expect(t.mismatch!.summary).toContain('GERD');
    expect(t.mismatch!.summary).not.toContain('wrist'); // same-joint-as-lead alternative is not an "addition"
  });

  it('ACRONYM: "PTSD" vs "post-traumatic stress disorder" → NOT flagged', () => {
    const t = buildPreSignTheory({ framingChoice: 'secondary', upstreamScCondition: 'PTSD', aiViabilityPlanJson: plan({ framing: 'secondary', upstream: 'post-traumatic stress disorder' }) });
    expect(t.mismatch).toBeNull();
  });

  it('IMPLICIT SECONDARY: framingChoice="" (Auto) + upstream present → theory shows + conflict detectable', () => {
    const t = buildPreSignTheory({ framingChoice: '', upstreamScCondition: 'PTSD', aiViabilityPlanJson: plan({ framing: 'direct', mechanism: 'in-service exposure' }) });
    expect(t.veteranTheory).toBe('Secondary to service-connected PTSD');
    expect(t.mismatch).not.toBeNull();
  });

  it('AUTO framing, NO upstream, plan present → no theory line, no mismatch, no false affirmation', () => {
    const t = buildPreSignTheory({ claimedCondition: 'Tinnitus', framingChoice: '', aiViabilityPlanJson: plan({ claimed: 'Tinnitus', framing: 'direct', mechanism: 'artillery' }) });
    expect(t.veteranTheory).toBeNull();
    expect(t.mismatch).toBeNull();
    expect(t.hasContent).toBe(true);
  });

  it('TRUST GUARD (Jay CLM-47FAC163B8): stale upstream="Ankle" that contradicts the depression statement → NO theory, NO mismatch', () => {
    const t = buildPreSignTheory({
      claimedCondition: 'Obstructive Sleep Apnea (OSA)',
      framingChoice: 'secondary',
      upstreamScCondition: 'Ankle', // auto-derived + STALE
      veteranStatement: 'I am service connected for depressive disorder with chronic sleep impairment and believe my sleep apnea was caused or aggravated by my service-connected mental health condition.',
      aiViabilityPlanJson: plan(
        { claimed: 'OSA', framing: 'secondary', upstream: 'depressive disorder with chronic sleep impairment' },
        [{ upstream: 'LIMITED MOTION OF ANKLE', framing: 'secondary', why_not: 'ankle-to-OSA is indirect' }],
      ),
    });
    expect(t.veteranTheory).toBeNull(); // "Ankle" is not in the veteran's words → not asserted as their theory
    expect(t.mismatch).toBeNull(); // veteran said depression, letter argues depression → no real mismatch
    expect(t.veteranStatement).toContain('depressive disorder');
    expect(t.letterTheory).toBe('OSA secondary to depressive disorder with chronic sleep impairment');
  });

  it('TRUST GUARD: upstream CORROBORATED by the statement → theory shows + mismatch works', () => {
    const t = buildPreSignTheory({
      framingChoice: 'secondary',
      upstreamScCondition: 'PTSD',
      veteranStatement: 'My PTSD from combat gave me sleep apnea.',
      aiViabilityPlanJson: plan({ framing: 'secondary', upstream: 'Asthma' }, [{ upstream: 'PTSD', framing: 'secondary', why_not: 'asthma is a stronger anchor' }]),
    });
    expect(t.veteranTheory).toBe('Secondary to service-connected PTSD'); // corroborated by "my PTSD"
    expect(t.mismatch).not.toBeNull(); // PTSD (veteran) vs Asthma (letter) → real, trusted mismatch
  });

  it('direct claim: letter shows the mechanism, aligned → no mismatch', () => {
    const t = buildPreSignTheory({
      framingChoice: 'direct',
      claimedCondition: 'Lumbar strain',
      aiViabilityPlanJson: plan({ claimed: 'Lumbar strain', framing: 'direct', mechanism: 'fall during a training exercise' }),
    });
    expect(t.mismatch).toBeNull();
    expect(t.letterTheory).toBe('Direct service connection (fall during a training exercise)');
  });

  it('aggravation framing line renders', () => {
    const t = buildPreSignTheory({ framingChoice: 'aggravation', upstreamScCondition: 'Diabetes' });
    expect(t.veteranTheory).toBe('Aggravation of service-connected Diabetes');
  });

  it('no route-picker plan → blocks 2+3 empty, veteran block still present (fail-open)', () => {
    const t = buildPreSignTheory({ claimedCondition: 'Tinnitus', framingChoice: 'direct', veteranStatement: 'The ringing started after artillery.', aiViabilityPlanJson: null });
    expect(t.letterTheory).toBeNull();
    expect(t.mismatch).toBeNull();
    expect(t.hasContent).toBe(true);
    expect(t.veteranClaim).toBe('Tinnitus');
  });

  it('hasContent true from veteranStatement alone', () => {
    expect(buildPreSignTheory({ veteranStatement: 'my knee hurts since service' }).hasContent).toBe(true);
  });

  it('claimedConditions with a blank entry does not leave a trailing separator', () => {
    const t = buildPreSignTheory({ claimedConditions: ['Asthma', '  ', 'OSA'] });
    expect(t.veteranClaim).toBe('Asthma, OSA');
  });

  it('hasContent is false when there is nothing to show', () => {
    expect(buildPreSignTheory({}).hasContent).toBe(false);
  });
});

describe('buildPreSignTheory — Part B LLM overlay (full-scope reconciliation)', () => {
  const planPTSD = plan({ claimed: 'OSA', framing: 'secondary', upstream: 'PTSD' });

  it('LLM prose SUPERSEDES the deterministic template (prose shown, template null); PTSD==lead → no mismatch', () => {
    const t = buildPreSignTheory({
      framingChoice: 'secondary',
      upstreamScCondition: 'PTSD',
      veteranStatement: 'my PTSD gave me sleep apnea',
      aiViabilityPlanJson: planPTSD,
      veteranTheoryAi: { theory: 'Veteran attributes his obstructive sleep apnea to service-connected PTSD.', framing: 'secondary', upstream: 'PTSD' },
    });
    expect(t.veteranTheoryProse).toContain('obstructive sleep apnea');
    expect(t.veteranTheory).toBeNull();
    expect(t.mismatch).toBeNull();
  });

  it('LLM upstream matches a CONVERGENT anchor → no mismatch (3-set includes convergent)', () => {
    const p: AiViabilityCard = { ...plan({ framing: 'secondary', upstream: 'Depression' }), convergent: [{ upstream: 'PTSD', note: 'also supports the claim' }] };
    const t = buildPreSignTheory({
      veteranStatement: 'my ptsd caused it',
      aiViabilityPlanJson: p,
      veteranTheoryAi: { theory: 'Veteran attributes the claim to service-connected PTSD.', framing: 'secondary', upstream: 'PTSD' },
    });
    expect(t.mismatch).toBeNull();
  });

  it('LLM upstream matches an ALTERNATIVE → mismatch with why_not + suggestEdit', () => {
    const p = plan({ framing: 'secondary', upstream: 'Depression' }, [{ upstream: 'PTSD', framing: 'secondary', why_not: 'depression is the stronger anchor' }]);
    const t = buildPreSignTheory({
      veteranStatement: 'my ptsd caused it',
      aiViabilityPlanJson: p,
      veteranTheoryAi: { theory: 'Veteran attributes the claim to service-connected PTSD.', framing: 'secondary', upstream: 'PTSD' },
    });
    expect(t.mismatch).not.toBeNull();
    expect(t.mismatch!.reason).toContain('stronger anchor');
    expect(t.mismatch!.suggestEdit).toBe(true);
  });

  it('veteran anchor nowhere in the plan + no grounded difference → SILENT (no useless generic "they differ")', () => {
    // Ryan 2026-07-11 (Cox): a bare "they differ" is useless. Deterministic token-matching can't tell a real
    // divergence (tinnitus vs depression) from same-theory-different-words (limited mobility vs knee strain),
    // so we stay silent unless we can ground a SPECIFIC difference. The veteran quote + letter line stand alone.
    const t = buildPreSignTheory({
      veteranStatement: 'my tinnitus caused it',
      aiViabilityPlanJson: plan({ framing: 'secondary', upstream: 'Depression' }),
      veteranTheoryAi: { theory: 'Veteran attributes the claim to service-connected tinnitus.', framing: 'secondary', upstream: 'tinnitus' },
    });
    expect(t.mismatch).toBeNull();
  });

  it('DUAL_PRONG letter framing renders in plain English, NEVER the raw key (Cox CLM-58482FEB66)', () => {
    const t = buildPreSignTheory({
      aiViabilityPlanJson: plan({ claimed: 'Obstructive Sleep Apnea (OSA)', framing: 'dual_prong', upstream: 'knee strain, limitation of flexion left' }),
    });
    expect(t.letterTheory).toBe('Obstructive Sleep Apnea (OSA) secondary to (and aggravated by) service-connected knee strain, limitation of flexion left');
    expect(t.letterTheory).not.toMatch(/dual_prong/);
  });

  it('PRESUMPTIVE letter framing renders in plain English, not the raw key', () => {
    const t = buildPreSignTheory({ aiViabilityPlanJson: plan({ claimed: 'Chronic sinusitis', framing: 'presumptive', upstream: 'burn pit exposure' }) });
    expect(t.letterTheory).toBe('Chronic sinusitis on a presumptive basis (burn pit exposure)');
    expect(t.letterTheory).not.toMatch(/presumptive"/);
  });

  it('DIFFERENCE names the letter\'s alternative anchors the veteran never raised, deduped across framings (Cox → GERD)', () => {
    const t = buildPreSignTheory({
      veteranStatement: 'Since having limited mobility because of other service connected disabilities I have gained weight, making my apnea even worse.',
      aiViabilityPlanJson: plan(
        { claimed: 'Obstructive Sleep Apnea (OSA)', framing: 'dual_prong', upstream: 'knee strain, limitation of flexion left' },
        [
          { upstream: 'gastroesophageal reflux disease (GERD)', framing: 'secondary_causation', why_not: 'contested bidirectional mechanism' },
          { upstream: 'gastroesophageal reflux disease (GERD)', framing: 'aggravation', why_not: 'supplemental, not the lead' },
        ],
      ),
      veteranTheoryAi: { theory: 'Veteran attributes worsening OSA to weight gain from limited mobility caused by service-connected disabilities.', framing: 'secondary', upstream: 'limited mobility' },
    });
    expect(t.mismatch).not.toBeNull();
    expect(t.mismatch!.summary).toContain('GERD');
    expect(t.mismatch!.summary).toContain('secondary and aggravating cause');
    expect(t.mismatch!.summary).toMatch(/didn.t raise/);
    expect(t.mismatch!.suggestEdit).toBe(false);
  });

  it('DIFFERENCE does NOT surface an alternative the veteran DID mention in their statement (grounded skip)', () => {
    const t = buildPreSignTheory({
      // The veteran's MAIN anchor is depression (= the lead), but they also mention GERD reflux in passing.
      veteranStatement: 'my depression caused my apnea, and my GERD reflux probably makes it worse too.',
      aiViabilityPlanJson: plan(
        { claimed: 'OSA', framing: 'secondary', upstream: 'depressive disorder' },
        [{ upstream: 'gastroesophageal reflux disease (GERD)', framing: 'secondary_causation', why_not: 'x' }],
      ),
      veteranTheoryAi: { theory: 'Veteran attributes OSA to service-connected depression.', framing: 'secondary', upstream: 'depressive disorder' },
    });
    // GERD was mentioned by the veteran → not a "difference"; depression aligns with the lead → silent.
    expect(t.mismatch).toBeNull();
  });

  it('vetPushesDemoted: veteran insists on an anchor the letter DEMOTED → specific summary + why_not + suggestEdit', () => {
    const t = buildPreSignTheory({
      veteranStatement: 'my ptsd caused my sleep apnea',
      aiViabilityPlanJson: plan(
        { claimed: 'OSA', framing: 'secondary', upstream: 'depressive disorder' },
        [{ upstream: 'PTSD', framing: 'secondary_causation', why_not: 'depression is the materially stronger anchor' }],
      ),
      veteranTheoryAi: { theory: 'Veteran attributes OSA to service-connected PTSD.', framing: 'secondary', upstream: 'PTSD' },
    });
    expect(t.mismatch).not.toBeNull();
    expect(t.mismatch!.summary).toContain('PTSD');
    expect(t.mismatch!.summary).toContain('fallback');
    expect(t.mismatch!.reason).toContain('stronger anchor');
    expect(t.mismatch!.suggestEdit).toBe(true);
  });

  it('ANKLE NOWHERE (Jay): a single-framing DEMOTED alternative must NEVER resurface as "the letter also weighs…"', () => {
    const t = buildPreSignTheory({
      veteranStatement: 'I am service connected for depressive disorder and believe my sleep apnea was caused by my mental health condition.',
      aiViabilityPlanJson: plan(
        { claimed: 'OSA', framing: 'secondary', upstream: 'depressive disorder with chronic sleep impairment' },
        [{ upstream: 'LIMITED MOTION OF ANKLE', framing: 'secondary_causation', why_not: 'the ankle-to-OSA pathway is indirect; depression is materially stronger' }],
      ),
      veteranTheoryAi: { theory: 'Veteran attributes his OSA to service-connected depression.', framing: 'secondary', upstream: 'depressive disorder with chronic sleep impairment' },
    });
    expect(t.mismatch).toBeNull(); // ankle is a single-framing demotion → gated out → silent
    expect(JSON.stringify(t)).not.toMatch(/ankle/i); // HARD: "ANKLE" must appear NOWHERE on the surface
  });

  it('shared-token: a veteran anchor matching BOTH the lead and a distinct alternative is ALIGNED, not a fallback (architect QA)', () => {
    const t = buildPreSignTheory({
      veteranStatement: 'my neck / cervical problem caused it',
      aiViabilityPlanJson: plan(
        { framing: 'secondary', upstream: 'cervical spine strain' },
        [{ upstream: 'cervical radiculopathy', framing: 'secondary_causation', why_not: 'x' }],
      ),
      veteranTheoryAi: { theory: 'Veteran attributes it to the cervical spine.', framing: 'secondary', upstream: 'cervical strain' },
    });
    expect(t.mismatch).toBeNull(); // aligns with the lead; must NOT say "treats cervical radiculopathy as a fallback"
  });

  it('an UNKNOWN framing key is humanized (de-underscored), never rendered raw', () => {
    const t = buildPreSignTheory({ aiViabilityPlanJson: plan({ claimed: 'OSA', framing: 'foo_bar', upstream: 'X' }) });
    expect(t.letterTheory).toBe('OSA (X): foo bar');
    expect(t.letterTheory).not.toMatch(/foo_bar/);
  });

  it('DERIVED fallback path (no LLM theory) is ALSO specific-or-silent — surfaces a developed supplemental, never generic', () => {
    // veteranTheoryAi ABSENT (flag off / Bedrock fail-open) → the deterministic path routes through the same
    // reconciler, so the useless generic "they differ" is gone there too (AI-SME I-1); a 2-framing GERD surfaces.
    const t = buildPreSignTheory({
      framingChoice: 'secondary',
      upstreamScCondition: 'depressive disorder',
      veteranStatement: 'my depression caused my apnea',
      aiViabilityPlanJson: plan(
        { framing: 'secondary', upstream: 'depressive disorder' },
        [
          { upstream: 'gastroesophageal reflux disease (GERD)', framing: 'secondary_causation', why_not: 'a' },
          { upstream: 'gastroesophageal reflux disease (GERD)', framing: 'aggravation', why_not: 'b' },
        ],
      ),
      // no veteranTheoryAi → deterministic path
    });
    expect(t.veteranTheoryProse).toBeNull();
    expect(t.mismatch!.summary).toContain('GERD');
    expect(t.mismatch!.summary).not.toMatch(/theory differs from the veteran/); // never the generic line
  });

  it('LLM framing "unclear" → prose shows but asserts NO mismatch', () => {
    const t = buildPreSignTheory({
      veteranStatement: 'a lot has happened to me',
      aiViabilityPlanJson: planPTSD,
      veteranTheoryAi: { theory: 'Veteran describes symptoms without stating a clear causal theory.', framing: 'unclear', upstream: null },
    });
    expect(t.veteranTheoryProse).toContain('symptoms');
    expect(t.mismatch).toBeNull();
  });

  it('LLM direct vs letter secondary → framing mismatch (informational)', () => {
    const t = buildPreSignTheory({
      veteranStatement: 'i was hurt in an explosion',
      aiViabilityPlanJson: planPTSD,
      veteranTheoryAi: { theory: 'Veteran attributes the claim directly to an in-service blast injury.', framing: 'direct', upstream: null },
    });
    expect(t.mismatch).not.toBeNull();
    expect(t.mismatch!.suggestEdit).toBe(false);
  });

  it('LLM present but EMPTY theory → falls through to the deterministic path (no prose)', () => {
    const t = buildPreSignTheory({
      framingChoice: 'secondary',
      upstreamScCondition: 'PTSD',
      veteranStatement: 'my ptsd caused it',
      aiViabilityPlanJson: planPTSD,
      veteranTheoryAi: { theory: '   ', framing: 'secondary', upstream: 'PTSD' },
    });
    expect(t.veteranTheoryProse).toBeNull();
    expect(t.veteranTheory).toBe('Secondary to service-connected PTSD');
  });

  it('LLM present + NO plan → prose shows, no mismatch (fail-open)', () => {
    const t = buildPreSignTheory({
      veteranStatement: 'my ptsd caused it',
      aiViabilityPlanJson: null,
      veteranTheoryAi: { theory: 'Veteran attributes the claim to service-connected PTSD.', framing: 'secondary', upstream: 'PTSD' },
    });
    expect(t.veteranTheoryProse).toContain('PTSD');
    expect(t.mismatch).toBeNull();
  });
});
