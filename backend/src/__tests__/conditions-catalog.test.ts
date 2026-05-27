import { describe, expect, it } from 'vitest';
import { buildConditionsCatalog, canonicalConditionLabels, systemForCondition, SYSTEM_ORDER } from '../services/conditions-catalog.js';
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

  it('sorts conditions alphabetically within each group, but pins "Unspecified …" last', () => {
    const catalog = buildConditionsCatalog();
    for (const g of catalog.groups) {
      const labels = g.conditions.map((c) => c.label);
      const specific = labels.filter((l) => !l.startsWith('Unspecified'));
      const unspecified = labels.filter((l) => l.startsWith('Unspecified'));
      // Specifics come first and are alphabetical; any "Unspecified …" entries are pinned last.
      expect(labels).toEqual([...specific, ...unspecified]);
      expect(specific).toEqual([...specific].sort((a, b) => a.localeCompare(b)));
    }
  });

  it('includes supplemental conditions (CHF + an "Unspecified …" catch-all)', () => {
    const catalog = buildConditionsCatalog();
    const all = catalog.groups.flatMap((g) => g.conditions);
    const chf = all.find((c) => c.value === 'CHF / congestive heart failure');
    expect(chf).toBeDefined();
    expect(chf?.noBvaData).toBe(true);
    const unspecMsk = all.find((c) => c.value === 'Unspecified musculoskeletal condition');
    expect(unspecMsk).toBeDefined();
    expect(unspecMsk?.noBvaData).toBe(true);
  });

  it('places CHF in the Cardiovascular group and pins "Unspecified cardiovascular condition" last there', () => {
    const catalog = buildConditionsCatalog();
    const cardio = catalog.groups.find((g) => g.system === 'Cardiovascular');
    expect(cardio).toBeDefined();
    const values = cardio!.conditions.map((c) => c.value);
    expect(values).toContain('CHF / congestive heart failure');
    expect(values[values.length - 1]).toBe('Unspecified cardiovascular condition');
  });

  it('systemForCondition maps atlas labels, supplementals, and returns null for free-text', () => {
    // Atlas labels
    expect(systemForCondition('PTSD')).toBe('Mental health');
    expect(systemForCondition('Obstructive sleep apnea')).toBe('Respiratory / Sleep');
    expect(systemForCondition('Lumbar / back')).toBe('Musculoskeletal');
    // Supplementals
    expect(systemForCondition('CHF / congestive heart failure')).toBe('Cardiovascular');
    expect(systemForCondition('Unspecified mental health condition')).toBe('Mental health');
    // Free-text / unknown => null (exempt from the same-system guard)
    expect(systemForCondition('Some rare unlisted thing')).toBeNull();
    expect(systemForCondition('')).toBeNull();
    expect(systemForCondition('   ')).toBeNull();
  });

  it('every supplemental condition resolves to a real (non-null) body system', () => {
    const catalog = buildConditionsCatalog();
    const supplementals = catalog.groups
      .flatMap((g) => g.conditions)
      .filter((c) => c.noBvaData === true);
    expect(supplementals.length).toBeGreaterThan(0);
    for (const s of supplementals) {
      const system = systemForCondition(s.value);
      expect(system, `${s.value} should map to a body system`).not.toBeNull();
      expect(SYSTEM_ORDER).toContain(system as string);
    }
  });
});
