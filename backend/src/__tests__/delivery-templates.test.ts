import { describe, expect, it } from 'vitest';
import {
  buildDeliveryEmail,
  buildCoverMemoText,
  extractLetterCondition,
  DELIVERY_EMAIL_SUBJECT,
  DELIVERY_FROM_ADDRESS,
  FRN_FOOTER,
} from '../services/delivery-templates.js';
import { formatConditionLabel } from '../services/condition-label.js';
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
      'New inquiries and follow-up emails may be sent to info@flatratenexus.com, or to your assigned nurse liaison if one has been designated for your case.',
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
    // The BODY now canonicalizes the slug first (formatConditionLabel) then lowercases the prose while
    // PRESERVING the acronym → "obstructive sleep apnea (OSA)", never the lowercase slug "osa" (Ryan
    // 2026-06-14: the first sentence still read "osa"). Header is title-case; body is lowercase-prose.
    expect(memo).toMatch(/supplemental claim for obstructive sleep apnea \(OSA\)/);
    expect(memo).not.toMatch(/claim for osa\b/);
  });

  it('SUBJECT CASING: a properly-cased input acronym is preserved in BOTH header and body', () => {
    const memo = buildCoverMemoText({ ...base, claimedCondition: 'OSA', priorDecisionDate: '2026-01-15' });
    expect(memo).toContain('Independent Medical Opinion regarding Obstructive Sleep Apnea (OSA)');
    // Body canonicalizes then lowercases-with-acronym → "obstructive sleep apnea (OSA)".
    expect(memo).toMatch(/supplemental claim for obstructive sleep apnea \(OSA\)/);
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

// ── Memo condition = the approved letter's Condition line, VERBATIM (Ryan 2026-07-22) ─────────────
// "make the subject and body match the Condition line of the approved letter precisely; it's a bad
// look when it's wrong, and it's wrong a lot." The chart/plan-derived path also re-cased the label
// wrongly (formatConditionLabel turns "(Lumbar" → "(lumbar"). letterCondition wins and is verbatim.
describe('cover memo condition from the approved letter', () => {
  const base = {
    pathway: 'board_appeal' as const,
    veteranFullName: 'Frank Midgett',
    veteranLastName: 'Midgett',
    claimedCondition: 'lumbar_strain', // the drifted chart claim — must be OVERRIDDEN by the letter
    signer: KASKY_CREDENTIALS,
    letterDate: '2026-07-23',
    priorDecisionDate: null,
  };
  const LETTER_COND = 'Lumbar Spinal Stenosis With Radiculopathy / Spondylosis (Lumbar Back / Sciatica)';

  it('extractLetterCondition pulls the Condition line verbatim from a real letter header', () => {
    const letter = [
      'July 21, 2026',
      '',
      'RE: Independent Medical Opinion',
      'Veteran: Jesse Wafford Lovell',
      'Condition: Obstructive Sleep Apnea (OSA)',
      'I. Physician Qualifications',
    ].join('\n');
    expect(extractLetterCondition(letter)).toBe('Obstructive Sleep Apnea (OSA)');
    // No parseable line (e.g. an external_import placeholder) → null so the caller can fall back.
    expect(extractLetterCondition('RE: Independent Medical Opinion\n(no condition line)')).toBeNull();
    expect(extractLetterCondition('')).toBeNull();
    expect(extractLetterCondition(null)).toBeNull();
  });

  it('REGRESSION WITNESS: the OLD path (formatConditionLabel) mis-cases the letter label — the bug', () => {
    // This is exactly the screenshot bug: "(Lumbar" comes back "(lumbar". letterCondition avoids it.
    expect(formatConditionLabel(LETTER_COND)).toContain('(lumbar');
    expect(formatConditionLabel(LETTER_COND)).not.toContain('(Lumbar Back');
  });

  it('header uses the letter Condition VERBATIM (no re-casing) and OVERRIDES the chart claim', () => {
    const memo = buildCoverMemoText({ ...base, letterCondition: LETTER_COND });
    expect(memo).toContain(`Independent Medical Opinion regarding ${LETTER_COND}`);
    // The fix: the correctly-cased "(Lumbar Back / Sciatica)" survives; the mangled "(lumbar Back" is gone.
    expect(memo).toContain('(Lumbar Back / Sciatica)');
    expect(memo).not.toContain('(lumbar Back');
    // The drifted chart claim never appears.
    expect(memo).not.toMatch(/lumbar strain/i);
  });

  it('body uses the letter Condition lowercased for mid-sentence, acronyms preserved', () => {
    const memo = buildCoverMemoText({ ...base, letterCondition: 'Obstructive Sleep Apnea (OSA)', claimedCondition: 'ptsd' });
    // board_appeal body: "...appeal regarding <cond>..." — lowercased prose, (OSA) acronym kept.
    expect(memo).toMatch(/appeal regarding obstructive sleep apnea \(OSA\)/);
    expect(memo).not.toMatch(/appeal regarding ptsd/i);
  });

  it('NO letterCondition → falls back to formatConditionLabel(claimedCondition) (prior behavior intact)', () => {
    const memo = buildCoverMemoText({ ...base, claimedCondition: 'osa' });
    expect(memo).toContain('Independent Medical Opinion regarding Obstructive Sleep Apnea (OSA)');
    const blank = buildCoverMemoText({ ...base, claimedCondition: 'osa', letterCondition: '   ' });
    expect(blank).toContain('Independent Medical Opinion regarding Obstructive Sleep Apnea (OSA)');
  });
});

// ── Defect 1 (2026-06-28): NEVER guess a gendered honorific/pronoun when sex is unknown ───────────
// There is no Veteran.sex field and composeMemo passes no salutation, so the memo must read
// naturally WITHOUT a wrong "Mr."/"his" (e.g. Shirley Carr, a female veteran). Neutral default:
// last name alone + singular "they". An explicit salutation, when present, is still honored.
describe('buildCoverMemoText (neutral honorific)', () => {
  const base = {
    pathway: 'supplemental' as const,
    veteranFullName: 'Shirley Carr',
    veteranLastName: 'Carr',
    claimedCondition: 'ckd',
    signer: KASKY_CREDENTIALS,
    letterDate: '2026-06-11',
    priorDecisionDate: null,
  };

  it('NEVER emits "Mr."/"Ms."/"Mrs." when no salutation is on file, and refers by last name alone', () => {
    const memo = buildCoverMemoText(base);
    expect(memo).not.toMatch(/\bMr\.|\bMs\.|\bMrs\./);
    expect(memo).toContain("Carr's supplemental claim");
  });

  it('TDIU with no salutation uses neutral "their"/"them", never gendered pronouns', () => {
    const memo = buildCoverMemoText({ ...base, pathway: 'tdiu' });
    expect(memo).toMatch(/their service-connected disabilities/);
    expect(memo).toMatch(/prevent them from securing/);
    expect(memo).not.toMatch(/\bhis\b|\bhim\b|\bher\b/);
  });

  it('honors an explicit salutation when provided (Ms. → "Ms. Carr" + "her")', () => {
    const memo = buildCoverMemoText({ ...base, pathway: 'tdiu', salutation: 'Ms.' });
    expect(memo).toContain('Ms. Carr');
    expect(memo).toMatch(/her service-connected disabilities/);
    expect(memo).not.toMatch(/\btheir\b|\bhis\b/);
  });

  it('falls back to "the veteran" when neither salutation nor last name is on file', () => {
    const memo = buildCoverMemoText({ ...base, veteranFullName: '', veteranLastName: '' });
    expect(memo).toContain("the veteran's supplemental claim");
    expect(memo).not.toMatch(/\bMr\.|\bMs\.|\bMrs\./);
  });

  it('the condition acronym renders uppercase in the memo body (ckd → CKD), not "Ckd"', () => {
    const memo = buildCoverMemoText(base);
    expect(memo).toContain('supplemental claim for CKD');
    expect(memo).not.toMatch(/\bCkd\b/);
  });
});
