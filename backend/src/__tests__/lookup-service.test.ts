import { describe, expect, it } from 'vitest';
import { searchIcd10, searchMedications, lookupDatasetSizes } from '../services/lookup-service.js';

describe('lookup-service / dataset', () => {
  it('loads non-empty ICD-10 and medications datasets', () => {
    const sizes = lookupDatasetSizes();
    expect(sizes.icd10).toBeGreaterThan(100);
    expect(sizes.medications).toBeGreaterThan(100);
  });
});

describe('lookup-service / searchIcd10', () => {
  it('returns empty results for empty query', () => {
    const r = searchIcd10('');
    expect(r.count).toBe(0);
    expect(r.results).toEqual([]);
  });

  it('returns empty results for whitespace-only query', () => {
    const r = searchIcd10('   ');
    expect(r.count).toBe(0);
  });

  it('matches an exact ICD-10 code as the top result', () => {
    const r = searchIcd10('I10');
    expect(r.count).toBeGreaterThan(0);
    expect(r.results[0]?.code).toBe('I10');
    expect(r.results[0]?.display.toLowerCase()).toContain('hypertension');
  });

  it('matches a display-name prefix (case insensitive)', () => {
    const r = searchIcd10('hypertension');
    expect(r.count).toBeGreaterThan(0);
    const top = r.results[0];
    expect(top?.display.toLowerCase().startsWith('essential')).toBe(true);
    expect(top?.code).toBe('I10');
  });

  it('resolves a synonym ("PTSD" -> F43.10)', () => {
    const r = searchIcd10('PTSD');
    expect(r.results[0]?.code).toBe('F43.10');
  });

  it('resolves an informal-name synonym ("high blood pressure" -> I10)', () => {
    const r = searchIcd10('high blood pressure');
    const top = r.results[0];
    expect(top?.code).toBe('I10');
  });

  it('returns multiple OSA-adjacent rows when typing "sleep apnea"', () => {
    const r = searchIcd10('sleep apnea');
    expect(r.count).toBeGreaterThanOrEqual(2);
    const codes = r.results.map((x) => x.code);
    expect(codes).toContain('G47.33');
    expect(codes).toContain('G47.30');
  });

  it('honors the limit query param up to the cap', () => {
    const r = searchIcd10('a', 3);
    expect(r.results.length).toBeLessThanOrEqual(3);
  });

  it('caps the limit at the service-internal max', () => {
    const r = searchIcd10('a', 500);
    expect(r.results.length).toBeLessThanOrEqual(50);
  });

  it('returns no results for nonsense input', () => {
    const r = searchIcd10('zzzzzzzzzzzz999');
    expect(r.count).toBe(0);
  });
});

describe('lookup-service / searchMedications', () => {
  it('returns the bare row plus dose variants for amlodipine, bare row first', () => {
    const r = searchMedications('amlodipine');
    expect(r.count).toBeGreaterThanOrEqual(4);
    const names = r.results.map((x) => x.drugName);
    expect(names).toContain('Amlodipine');
    expect(names).toContain('Amlodipine 5 mg');
    expect(names).toContain('Amlodipine 10 mg');
    // The bare-no-dose row should come ahead of dose variants when scores tie.
    const bareIdx = names.indexOf('Amlodipine');
    const fiveIdx = names.indexOf('Amlodipine 5 mg');
    expect(bareIdx).toBeLessThan(fiveIdx);
  });

  it('matches a brand-name synonym ("Norvasc" -> Amlodipine)', () => {
    const r = searchMedications('Norvasc');
    const top = r.results[0];
    expect(top?.genericName).toBe('amlodipine');
  });

  it('matches a brand-name synonym for an SSRI ("Zoloft" -> Sertraline)', () => {
    const r = searchMedications('Zoloft');
    const generics = r.results.map((x) => x.genericName);
    expect(generics).toContain('sertraline');
  });

  it('returns empty for empty query', () => {
    const r = searchMedications('');
    expect(r.count).toBe(0);
  });

  it('handles partial generic-name prefix ("metfor" -> Metformin)', () => {
    const r = searchMedications('metfor');
    const top = r.results[0];
    expect(top?.genericName).toBe('metformin');
  });

  it('finds tadalafil (PDE-5) when typing "cialis"', () => {
    const r = searchMedications('cialis');
    expect(r.results[0]?.genericName).toBe('tadalafil');
  });

  it('returns no results for nonsense input', () => {
    const r = searchMedications('zzzzz-nothing-here');
    expect(r.count).toBe(0);
  });

  it('returns dose=null for bare rows and a non-null dose for variant rows', () => {
    const r = searchMedications('atorvastatin');
    const bare = r.results.find((x) => x.drugName === 'Atorvastatin');
    const ten = r.results.find((x) => x.drugName === 'Atorvastatin 10 mg');
    expect(bare?.dose).toBeNull();
    expect(ten?.dose).toBe('10 mg');
  });

  it('respects the limit ceiling', () => {
    const r = searchMedications('a', 5);
    expect(r.results.length).toBeLessThanOrEqual(5);
  });
});

describe('lookup-service / determinism', () => {
  it('returns identical results on repeated identical queries', () => {
    const a = searchIcd10('hypertension', 10);
    const b = searchIcd10('hypertension', 10);
    expect(a.results.map((x) => x.code)).toEqual(b.results.map((x) => x.code));
  });

  it('returns identical med results across repeats', () => {
    const a = searchMedications('amlodipine', 8);
    const b = searchMedications('amlodipine', 8);
    expect(a.results.map((x) => x.drugName)).toEqual(b.results.map((x) => x.drugName));
  });
});
