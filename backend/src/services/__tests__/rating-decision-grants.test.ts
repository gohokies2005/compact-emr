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
});
