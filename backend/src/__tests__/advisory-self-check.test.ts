import { describe, it, expect } from 'vitest';
import { runSelfCheck, applySelfCheck } from '../advisory/selfCheck.js';

const chunk = (text: string) => ({ text, citation: 'c', source: 's' });

describe('Ask Aegis self-check (Layer 1 deterministic)', () => {
  it('BLOCKS BVA-% / pair-atlas leakage', () => {
    const r = runSelfCheck('This pairing has an 89% IMO-adjusted win rate per the pair-atlas.', []);
    expect(r.blocked).toBe(true);
    expect(r.flags).toContain('bva_pct_leak');
    expect(applySelfCheck('x', r)).toMatch(/VERIFY BEFORE USING/);
  });
  it('flags a fabricated PMID not in the retrieved material (soft caveat)', () => {
    const r = runSelfCheck('See PMID 12345678 for the mechanism.', [chunk('unrelated text PMID 99999999')]);
    expect(r.flags).toContain('fabricated_pmid');
    expect(r.blocked).toBe(false);
  });
  it('does NOT flag a PMID that IS in the retrieved material', () => {
    const r = runSelfCheck('See PMID 12345678.', [chunk('Teodorescu 2015 PMID 12345678 asthma OSA')]);
    expect(r.flags).not.toContain('fabricated_pmid');
  });
  it('BLOCKS the $50 refund line', () => {
    const r = runSelfCheck('We will refund your $50 record review fee if not supportable.', []);
    expect(r.blocked).toBe(true);
    expect(r.flags).toContain('refund_50');
  });
  it('flags an excluded-pair suggestion when a hint matches', () => {
    const r = runSelfCheck('You could argue OSA caused your asthma.', [], ['OSA caused your asthma']);
    expect(r.blocked).toBe(true);
    expect(r.flags).toContain('excluded_pair_suggested');
  });
  it('passes a clean grounded answer with no flags', () => {
    const r = runSelfCheck('Asthma can aggravate OSA via airway inflammation; the record supports this.', [chunk('asthma OSA airway')]);
    expect(r.blocked).toBe(false);
    expect(r.caveats.length).toBe(0);
    expect(applySelfCheck('answer', r)).toBe('answer');
  });
});
