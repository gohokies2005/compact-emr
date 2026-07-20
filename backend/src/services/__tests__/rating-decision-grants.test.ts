import { describe, it, expect } from 'vitest';
import { extractRatingDecisionGrants } from '../rating-decision-grants.js';
import type { BundleDocument } from '../chart-extractor.js';

function doc(id: string, pageText: string): BundleDocument {
  return { id, filename: `${id}.pdf`, pages: [{ pageNumber: 1, text: pageText }] } as BundleDocument;
}

describe('extractRatingDecisionGrants — deterministic granted-SC authority', () => {
  // THE PROOF: Hackworth's real OCR shape (grants interleaved with Twitter/Facebook noise) — the
  // exact text where the Sonnet broad pass extracted ZERO grants. Deterministic must recover them.
  it('recovers all grants from a Hackworth-shaped noisy rating decision (LLM dropped all)', () => {
    const text = [
      'DECISION',
      'Service connection for chronic headaches is granted with an',
      'Twitter: @VAVetBenefits Facebook: www.facebook.com/VeteransBenefits',
      'evaluation of 50 percent effective December 10, 2025.',
      'Service connection for tinnitus is granted with an evaluation of 10 percent.',
      'Service connection for chronic sinusitis is granted with an evaluation of 0 percent.',
      'Service connection for a low back condition is denied.',
    ].join('\n');
    const grants = extractRatingDecisionGrants([doc('d1', text)]);
    const names = grants.map((g) => g.name.toLowerCase());
    expect(names).toContain('chronic headaches');
    expect(names).toContain('tinnitus');
    expect(names).toContain('chronic sinusitis');
    // every recovered row is a service_connected grant, grounded by a real page quote
    for (const g of grants) {
      expect(g.category).toBe('sc_condition');
      expect(g.status).toBe('service_connected');
      expect(text.replace(/\s+/g, ' ')).toContain(g.sourceQuote.replace(/\s+/g, ' ').slice(0, 30));
    }
  });

  it('captures the rating percentage when stated (headaches=50, tinnitus=10, sinusitis=0)', () => {
    const text = 'Service connection for chronic headaches is granted with an evaluation of 50 percent. '
      + 'Service connection for tinnitus is granted with an evaluation of 10 percent. '
      + 'Service connection for chronic sinusitis is granted with an evaluation of 0 percent.';
    const grants = extractRatingDecisionGrants([doc('d', text)]);
    const byName = Object.fromEntries(grants.map((g) => [g.name.toLowerCase(), g.ratingPct]));
    expect(byName['chronic headaches']).toBe(50);
    expect(byName['tinnitus']).toBe(10);
    expect(byName['chronic sinusitis']).toBe(0); // a 0% grant IS a grant
  });

  // THE ANTI-CRAP GUARD: the old deterministic failure was false positives. A denial-only page must
  // produce ZERO grants — never fabricate a service connection.
  it('does NOT fabricate a grant from a denial-only page', () => {
    const text = [
      'Service connection for hypertension is denied.',
      'Service connection for a left shoulder condition is denied because the evidence does not show...',
      'The claim for sleep apnea is denied.',
    ].join('\n');
    expect(extractRatingDecisionGrants([doc('d', text)])).toHaveLength(0);
  });

  // boilerplate / non-condition spans must not become grant rows
  it('does NOT emit grants from boilerplate or social/URL noise', () => {
    const text = 'Visit www.va.gov for status. Twitter: @VAVetBenefits. This decision explains your benefits.';
    expect(extractRatingDecisionGrants([doc('d', text)])).toHaveLength(0);
  });

  it('reverse phrasing: "an evaluation of 20 percent is assigned for lumbar strain"', () => {
    const text = 'After review, an evaluation of 20 percent is assigned for lumbar strain, effective 2025.';
    const grants = extractRatingDecisionGrants([doc('d', text)]);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.name.toLowerCase()).toContain('lumbar strain');
  });

  it('empty / tiny pages yield nothing, no throw', () => {
    expect(extractRatingDecisionGrants([doc('d', '')])).toHaveLength(0);
    expect(extractRatingDecisionGrants([])).toHaveLength(0);
  });

  it('dedups the same grant repeated on a page', () => {
    const text = 'Service connection for tinnitus is granted. Service connection for tinnitus is granted.';
    expect(extractRatingDecisionGrants([doc('d', text)])).toHaveLength(1);
  });

  // ── CONTINUATION / INCREASE grants (continuation-grant fix, Ryan 2026-07-19) ──
  // ROOT CAUSE of the bronchitis incident: a *continuation* of an existing grant was misread as pending.
  describe('continuation / increase / decrease grants', () => {
    it('CAPTURES "Evaluation of chronic bronchitis, which is currently 10 percent disabling, is continued" as service_connected pct 10', () => {
      const text = 'Evaluation of chronic bronchitis, which is currently 10 percent disabling, is continued.';
      const grants = extractRatingDecisionGrants([doc('d', text)]);
      expect(grants).toHaveLength(1);
      expect(grants[0]!.name.toLowerCase()).toBe('chronic bronchitis');
      expect(grants[0]!.status).toBe('service_connected');
      expect(grants[0]!.ratingPct).toBe(10);
      expect(grants[0]!.grantForm).toBe('continued'); // provenance tag
      // grounded by a real page quote
      expect(text.replace(/\s+/g, ' ')).toContain(grants[0]!.sourceQuote.replace(/\s+/g, ' ').slice(0, 30));
    });

    it('DENIAL-CONTINUATION GUARD: "The previous denial of service connection for sleep apnea is confirmed and continued" is NOT captured', () => {
      const text = 'The previous denial of service connection for sleep apnea is confirmed and continued.';
      expect(extractRatingDecisionGrants([doc('d', text)])).toHaveLength(0);
    });

    it('captures an INCREASE and a DECREASE continuation as service_connected', () => {
      const text = 'Evaluation of lumbar strain, currently 20 percent disabling, is increased to 40 percent. '
        + 'Evaluation of tinnitus, which is currently 10 percent disabling, is decreased.';
      const grants = extractRatingDecisionGrants([doc('d', text)]);
      const names = grants.map((g) => g.name.toLowerCase());
      expect(names).toContain('lumbar strain');
      expect(names).toContain('tinnitus');
      for (const g of grants) expect(g.status).toBe('service_connected');
    });

    it('reverse-lead continuation: "chronic bronchitis, currently 10 percent, is continued"', () => {
      const text = 'chronic bronchitis, currently 10 percent, is continued.';
      const grants = extractRatingDecisionGrants([doc('d', text)]);
      expect(grants).toHaveLength(1);
      expect(grants[0]!.name.toLowerCase()).toBe('chronic bronchitis');
      expect(grants[0]!.ratingPct).toBe(10);
    });

    it('mixed page: a bronchitis continuation is captured while an OSA denial-continuation on the same page is excluded', () => {
      const text = [
        'Evaluation of chronic bronchitis, which is currently 10 percent disabling, is continued.',
        'The previous denial of service connection for obstructive sleep apnea is confirmed and continued.',
      ].join('\n');
      const grants = extractRatingDecisionGrants([doc('d', text)]);
      const names = grants.map((g) => g.name.toLowerCase());
      expect(names).toContain('chronic bronchitis');
      expect(names.some((n) => n.includes('sleep apnea'))).toBe(false);
    });

    it('REGRESSION: a plain initial grant still works alongside the new continuation patterns', () => {
      const text = 'Service connection for chronic headaches is granted with an evaluation of 50 percent.';
      const grants = extractRatingDecisionGrants([doc('d', text)]);
      expect(grants).toHaveLength(1);
      expect(grants[0]!.name.toLowerCase()).toBe('chronic headaches');
      expect(grants[0]!.status).toBe('service_connected');
      expect(grants[0]!.ratingPct).toBe(50);
      expect(grants[0]!.grantForm).toBeUndefined(); // initial grants carry no continuation tag
    });
  });
});
