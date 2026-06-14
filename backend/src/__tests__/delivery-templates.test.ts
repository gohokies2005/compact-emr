import { describe, expect, it } from 'vitest';
import {
  buildDeliveryEmail,
  buildCoverMemoText,
  DELIVERY_EMAIL_SUBJECT,
  DELIVERY_FROM_ADDRESS,
  FRN_FOOTER,
} from '../services/delivery-templates.js';
import { KASKY_CREDENTIALS } from '../services/credential-block.js';

// Chunk E2 (work-order 5a-bis2): the delivery email body order is greeting → intro → payment
// instruction + Stripe link (paragraph-2 zone) → wording rationale → §VII excerpt LAST → questions
// line → locked footer. HARD RULES: the email's OWN prose never names the claimed condition (the
// quoted §VII excerpt may — decision E-1), never mentions any refund or the $50 fee, and carries
// no em dashes.

const EXCERPT_BLOCK = [
  'The final opinion and sources from your full letter, excerpted below:',
  '',
  'Opinion:',
  '"It is my opinion that the veteran\'s obstructive sleep apnea is more likely than not (greater than 50% probability) proximately due to his service-connected major depressive disorder."',
  '',
  'References:',
  '1. Gupta MA, et al. J Clin Sleep Med. 2015;11(2):165-175.',
].join('\n');

const STRIPE_LINK = 'https://buy.stripe.com/link500?client_reference_id=CASE_C1';

function build(excerptBlock: string | null = EXCERPT_BLOCK, stripeLink: string | null = STRIPE_LINK) {
  return buildDeliveryEmail({ veteranFirstName: 'Armand', excerptBlock, stripeLink });
}

describe('buildDeliveryEmail (E2 body order)', () => {
  it('orders the body: greeting → intro → payment instruction + link → rationale → excerpt → questions → footer', () => {
    const { body } = build();
    const order = [
      'Hi Armand,',
      'Your nexus letter is complete and ready for delivery.',
      'To receive your signed letter, please complete payment using the secure link below:',
      STRIPE_LINK,
      'A quick note on the wording:',
      'The final opinion and sources from your full letter, excerpted below:',
      'If you have any questions before then, reply to this email.',
      'All correspondence should be directed to info@flatratenexus.com.',
    ];
    let last = -1;
    for (const marker of order) {
      const idx = body.indexOf(marker);
      expect(idx, `missing or out-of-order marker: ${marker}`).toBeGreaterThan(last);
      last = idx;
    }
  });

  it('the payment link sits in the paragraph-2 zone (before the rationale and the excerpt)', () => {
    const { body } = build();
    expect(body.indexOf(STRIPE_LINK)).toBeLessThan(body.indexOf('A quick note on the wording:'));
    expect(body.indexOf(STRIPE_LINK)).toBeLessThan(body.indexOf('Opinion:'));
  });

  it('the excerpt (citations) reads as the natural END: after it come only the questions line + footer', () => {
    const { body } = build();
    const afterExcerpt = body.slice(body.indexOf('References:'));
    expect(afterExcerpt).toContain('If you have any questions before then, reply to this email.');
    expect(afterExcerpt).toContain('Flat Rate Nexus');
    expect(afterExcerpt).not.toContain('complete payment');
  });

  it('NEVER names the claimed condition in the email\'s OWN prose (the quoted excerpt may)', () => {
    const { body } = build();
    // Remove the quoted excerpt block; what remains is the email's own framing prose.
    const ownProse = body.replace(EXCERPT_BLOCK, '');
    expect(ownProse).not.toMatch(/sleep apnea|depressive|PTSD|tinnitus/i);
    // Sanity: the excerpt itself (quoted letter text) is allowed to carry it.
    expect(body).toContain('obstructive sleep apnea');
  });

  it('never mentions a refund or the $50 fee (hard business rule)', () => {
    const { body, subject } = build();
    for (const text of [body, subject]) {
      expect(text).not.toMatch(/refund/i);
      expect(text).not.toMatch(/\$50\b/);
    }
  });

  it('contains no em or en dashes in its own prose', () => {
    // Build with a null excerpt so ONLY the email's own prose is present.
    const { body } = build(null);
    expect(body).not.toMatch(/[—–]/);
  });

  it('reproduces the locked FRN footer verbatim at the end', () => {
    const { body } = build();
    expect(body.endsWith(FRN_FOOTER)).toBe(true);
  });

  it('falls back to a generic line when no excerpt exists, and a placeholder when Stripe is unconfigured', () => {
    const { body } = build(null, null);
    expect(body).toContain('The final opinion and the sources it relies on are contained in your full letter.');
    expect(body).toContain('[Stripe payment link will appear here once Stripe is configured]');
  });

  it('keeps the fixed subject + from address', () => {
    const built = build();
    expect(built.subject).toBe(DELIVERY_EMAIL_SUBJECT);
    expect(built.fromAddress).toBe(DELIVERY_FROM_ADDRESS);
    expect(built.subject).toBe('Your nexus letter is ready, invoice enclosed');
  });

  it('greets "there" when no first name is on file', () => {
    const { body } = buildDeliveryEmail({ veteranFirstName: null, excerptBlock: null, stripeLink: null });
    expect(body.startsWith('Hi there,')).toBe(true);
  });
});

// ── E4 cover-memo bug fixes (2026-06-14): subject casing + prior-decision date placeholder ────────
describe('buildCoverMemoText (E4 bug fixes)', () => {
  const base = {
    pathway: 'supplemental' as const,
    veteranFullName: 'Armand Frank',
    veteranLastName: 'Frank',
    claimedCondition: 'osa',
    signer: KASKY_CREDENTIALS,
    letterDate: '2026-06-11',
  };

  it('SUBJECT CASING: the header subject is the properly-cased condition label, never the raw lowercase slug', () => {
    const memo = buildCoverMemoText({ ...base, priorDecisionDate: '2026-01-15' });
    // "osa" must render "Obstructive Sleep Apnea (OSA)" in the header, never "regarding osa".
    expect(memo).toContain('Independent Medical Opinion regarding Obstructive Sleep Apnea (OSA)');
    expect(memo).toContain('OSA');
    expect(memo).not.toMatch(/regarding osa\b/);
    // The mid-sentence BODY use is the LOWERCASE form (coverMemo.js formatConditionLowercase): it
    // preserves an already-uppercase acronym but does NOT uppercase a lowercase slug — so the body
    // reads "...claim for osa". The header-vs-body split is the canonical FRN convention; only the
    // header was buggy (raw slug). This asserts the body is untouched by the header fix.
    expect(memo).toMatch(/supplemental claim for osa\b/);
  });

  it('SUBJECT CASING: a properly-cased input acronym is preserved in BOTH header and body', () => {
    const memo = buildCoverMemoText({ ...base, claimedCondition: 'OSA', priorDecisionDate: '2026-01-15' });
    expect(memo).toContain('Independent Medical Opinion regarding Obstructive Sleep Apnea (OSA)');
    // formatConditionLowercase preserves the all-caps acronym in the body too.
    expect(memo).toMatch(/supplemental claim for OSA\b/);
  });

  it('NO unfilled [BRACKET] tokens ever appear (only the [SIGNATURE] render sentinel)', () => {
    const memo = buildCoverMemoText({ ...base, priorDecisionDate: null });
    expect(memo).not.toContain('[PRIOR_DECISION_DATE]');
    const brackets = memo.match(/\[[A-Z0-9_]+\]/g) ?? [];
    expect(brackets).toEqual(['[SIGNATURE]']);
  });

  it('PRIOR DATE present + valid: prints it nicely ("January 15, 2026")', () => {
    const memo = buildCoverMemoText({ ...base, priorDecisionDate: '2026-01-15' });
    expect(memo).toContain('the prior decision dated January 15, 2026');
  });

  it('PRIOR DATE missing (null): DROPS the date, references the prior decision vaguely, NO placeholder', () => {
    const memo = buildCoverMemoText({ ...base, priorDecisionDate: null });
    expect(memo).not.toContain('[PRIOR_DECISION_DATE]');
    expect(memo).not.toMatch(/prior decision dated/);
    // The supplemental block still references the prior decision, just without a date.
    expect(memo).toContain('not of record at the time of the prior decision and reflects');
  });

  it('PRIOR DATE unreliable (non-ISO free text): treated as missing → vague phrasing, never printed', () => {
    const memo = buildCoverMemoText({ ...base, priorDecisionDate: 'sometime last year' });
    expect(memo).not.toContain('sometime last year');
    expect(memo).not.toMatch(/prior decision dated/);
    expect(memo).toContain('not of record at the time of the prior decision and reflects');
  });

  it('HLR pathway with no date references "the prior decision" plainly (no dangling "dated")', () => {
    const memo = buildCoverMemoText({ ...base, pathway: 'hlr_request', priorDecisionDate: null });
    expect(memo).not.toContain('[PRIOR_DECISION_DATE]');
    expect(memo).toContain('Higher-Level Review of the prior decision.');
    expect(memo).not.toMatch(/prior decision dated/);
  });

  it('HLR pathway with a valid date prints it', () => {
    const memo = buildCoverMemoText({ ...base, pathway: 'hlr_request', priorDecisionDate: '2026-01-15' });
    expect(memo).toContain('Higher-Level Review of the prior decision dated January 15, 2026.');
  });
});
