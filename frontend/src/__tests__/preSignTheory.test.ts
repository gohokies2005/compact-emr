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

  it('MISMATCH reason uses ONLY why_not — never counterargument/rationale', () => {
    const t = buildPreSignTheory({
      framingChoice: 'secondary',
      upstreamScCondition: 'Flat feet',
      aiViabilityPlanJson: plan({ framing: 'secondary', upstream: 'PTSD', counterargument: 'PTSD is the strongest anchor.', rationale: 'strong PTSD nexus' }),
    });
    expect(t.mismatch).not.toBeNull();
    expect(t.mismatch!.suggestEdit).toBe(false); // flat feet not a listed alternative
    expect(t.mismatch!.reason).toBeNull(); // no why_not → neutral, does NOT borrow counterargument
  });

  it('LOOSE match: "Asthma" vs "Asthma, Bronchial" → not flagged', () => {
    const t = buildPreSignTheory({ framingChoice: 'secondary', upstreamScCondition: 'Asthma', aiViabilityPlanJson: plan({ framing: 'secondary', upstream: 'Asthma, Bronchial' }) });
    expect(t.mismatch).toBeNull();
  });

  it('LATERALITY same joint: "Left knee" vs "Right knee" → NOT flagged (same condition, "knee" matches)', () => {
    const t = buildPreSignTheory({ framingChoice: 'secondary', upstreamScCondition: 'Left knee', aiViabilityPlanJson: plan({ framing: 'secondary', upstream: 'Right knee' }) });
    expect(t.mismatch).toBeNull();
  });

  it('LATERALITY different joints: "Left ankle" vs "Left wrist" → FLAGGED (must not match on "left")', () => {
    const t = buildPreSignTheory({ framingChoice: 'secondary', upstreamScCondition: 'Left ankle', aiViabilityPlanJson: plan({ framing: 'secondary', upstream: 'Left wrist' }) });
    expect(t.mismatch).not.toBeNull();
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
    expect(t.letterTheory).toBe('Direct service connection — fall during a training exercise');
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
