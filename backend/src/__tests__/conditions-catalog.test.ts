import { describe, expect, it } from 'vitest';
import { buildConditionsCatalog, canonicalConditionLabels, SYSTEM_ORDER } from '../services/conditions-catalog.js';
import { evaluateCds } from '../services/cdsEngine.js';

describe('conditions-catalog', () => {
  it('builds a non-empty grouped catalog from the BVA atlas', () => {
    const catalog = buildConditionsCatalog();
    expect(catalog.groups.length).toBeGreaterThan(0);
    const total = catalog.groups.reduce((sum, g) => sum + g.conditions.length, 0);
    // The atlas union is 41 canonical conditions today; assert a sane floor, not an exact count.
    expect(total).toBeGreaterThanOrEqual(40);
    expect(total).toBe(canonicalConditionLabels().length);
  });

  it('uses only known body systems and emits them in the defined order', () => {
    const catalog = buildConditionsCatalog();
    for (const g of catalog.groups) expect(SYSTEM_ORDER).toContain(g.system);
    const indices = catalog.groups.map((g) => SYSTEM_ORDER.indexOf(g.system));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  it('assigns every canonical condition to a real body system (none silently fall to Other)', () => {
    const catalog = buildConditionsCatalog();
    const other = catalog.groups.find((g) => g.system === 'Other');
    expect(other).toBeUndefined();
  });

  it('uses identical value and label for each option (the canonical key)', () => {
    const catalog = buildConditionsCatalog();
    for (const g of catalog.groups) {
      for (const c of g.conditions) expect(c.value).toBe(c.label);
    }
  });

  it('emits options the CDS engine can match (round-trip a known secondary pair)', () => {
    const catalog = buildConditionsCatalog();
    const all = catalog.groups.flatMap((g) => g.conditions.map((c) => c.value));
    expect(all).toContain('PTSD');
    expect(all).toContain('Obstructive sleep apnea');
    // Selecting canonical labels feeds the CDS engine cleanly: PTSD -> OSA is a matched BVA pair.
    const result = evaluateCds({
      claimedCondition: 'Obstructive sleep apnea',
      claimType: 'initial',
      framingChoice: 'secondary',
      upstreamScCondition: 'PTSD',
      serviceConnectedConditions: ['PTSD'],
      activeProblems: ['Obstructive sleep apnea'],
    });
    expect(result.bva.matched).toBe(true);
  });

  it('sorts conditions alphabetically within each group', () => {
    const catalog = buildConditionsCatalog();
    for (const g of catalog.groups) {
      const labels = g.conditions.map((c) => c.label);
      expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    }
  });
});
