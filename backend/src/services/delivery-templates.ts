/**
 * Delivery-workflow templates (backend): the ONE fixed delivery email + the appeals cover-memo
 * TEXT builder. Both mirror the local FRN source of truth:
 *   - email voice + "more likely than not (>50%)" rationale + locked FRN footer ← gmail.js Template 4/5
 *   - cover-memo blocks + signer credential block ← coverMemo.js (text-only MVP; PDF render is a
 *     follow-up — coverMemo.js's pdfkit/docx renderers are not in the cloud render Lambda, which
 *     only knows the nexus-letter shape).
 *
 * HARD CONSTRAINTS enforced here (per CLAUDE.md):
 *   - The delivery email NEVER names the claimed condition. The body is identical every time except
 *     the opinion/reference excerpt and the Stripe link.
 *   - Generic team "we"/FRN voice (staff-voice transition 2026-05-25).
 *   - The locked FOOTER is reproduced verbatim from gmail.js.
 *   - No em dashes in the cover memo (stripEmDashes), matching coverMemo.js.
 *
 * Pure + dependency-light (only credential-block, also pure) so it unit-tests without S3/Prisma.
 */

import type { SignerCredentials } from './credential-block.js';
import { formatConditionLabel } from './condition-label.js';

// ── Locked FRN footer (verbatim from app/services/gmail.js FOOTER) ──────────────────────────────
export const FRN_FOOTER = [
  '',
  'Thanks,',
  'The Flat Rate Nexus Team',
  '',
  'Flat Rate Nexus',
  'flatratenexus.com',
  '',
  'New inquiries and follow-up emails may be sent to info@flatratenexus.com, or to your assigned nurse liaison if one has been designated for your case.',
  '',
  'This communication is for general educational purposes and is not legal advice or VA claims representation. No physician-patient relationship is established. For specific claims-strategy or filing questions, a VA-accredited VSO or attorney can advise at no cost.',
].join('\n');

export const DELIVERY_FROM_ADDRESS = 'info@flatratenexus.com';
export const DELIVERY_EMAIL_SUBJECT = 'Your nexus letter is ready, invoice enclosed';

// The "more likely than not (>50%)" rationale paragraph, verbatim from gmail.js Template 4. This is
// boilerplate the veteran reads every time; it pre-empts the recurring "is this strong enough?"
// question. NEVER mentions the condition.
const PROBABILITY_RATIONALE =
  'A quick note on the wording: we use "more likely than not" rather than "at least as likely as ' +
  'not" on purpose. "At least as likely as not" is the legal floor (50-50 equipoise), where ' +
  'benefit-of-the-doubt rules under 38 CFR 3.102 and Gilbert v. Derwinski kick in. "More likely ' +
  'than not" is one step stronger. It means the medical evidence affirmatively weighs in your ' +
  'favor, so the rater does not even need to invoke benefit-of-the-doubt to grant you. If you have ' +
  'seen advice online to ask us to use "at least as likely as not," that advice would weaken your ' +
  'letter, not strengthen it.';

export interface BuildDeliveryEmailInput {
  /** Veteran first name for the greeting (falls back to "there"). NOT the condition. */
  readonly veteranFirstName?: string | null;
  /** Labeled §VII+§VIII excerpt block (from letter-opinion-excerpt). null → generic line. */
  readonly excerptBlock: string | null;
  /** The Stripe payment link, or null when Stripe is not configured (RN pastes one in). */
  readonly stripeLink: string | null;
}

export interface BuiltEmail {
  readonly subject: string;
  readonly fromAddress: string;
  readonly body: string;
}

/**
 * The ONE fixed delivery email. Identical every time except (a) the greeting name, (b) the opinion
 * excerpt, (c) the Stripe link line. NEVER names the condition in its OWN prose (the quoted §VII
 * excerpt is letter text and may — decision E-1).
 *
 * Body order (Chunk E2, work-order 5a-bis2, Ryan): greeting → intro → payment instruction + link
 * in the PARAGRAPH-2 zone → wording note → the full §VII excerpt LAST (with E1 the citations read
 * as the natural end) → questions line → footer.
 */
export function buildDeliveryEmail(input: BuildDeliveryEmailInput): BuiltEmail {
  const greetingName = (input.veteranFirstName ?? '').trim() || 'there';
  const excerpt = input.excerptBlock !== null && input.excerptBlock.trim() !== ''
    ? `\n${input.excerptBlock}\n`
    : '\nThe final opinion and the sources it relies on are contained in your full letter.\n';
  // The Stripe link line. When unconfigured we still emit a labeled placeholder so the RN sees
  // exactly where the link goes when they paste it; the route flags stripeConfigured=false so the
  // UI surfaces the amber "needs setup" note. We do NOT invent a fake URL.
  const linkLine = input.stripeLink !== null && input.stripeLink.trim() !== ''
    ? input.stripeLink.trim()
    : '[Stripe payment link will appear here once Stripe is configured]';

  const body = [
    `Hi ${greetingName},`,
    '',
    'Your nexus letter is complete and ready for delivery. Let us know if there are any errors or ' +
      'corrections you see that need to be made. The signed PDF is released to you within a few ' +
      'minutes of payment; please reply to this email if you do not receive it.',
    '',
    'To receive your signed letter, please complete payment using the secure link below:',
    '',
    linkLine,
    '',
    PROBABILITY_RATIONALE,
    excerpt,
    'If you have any questions before then, reply to this email.',
    FRN_FOOTER,
  ].join('\n');

  return { subject: DELIVERY_EMAIL_SUBJECT, fromAddress: DELIVERY_FROM_ADDRESS, body };
}

// ── Appeals cover memo (TEXT-only MVP) ──────────────────────────────────────────────────────────
// Ported from app/services/coverMemo.js block builders. Cover memo is a transmittal cover sheet,
// not an argument (LOCKED TEMPLATE Ryan 2026-04-28). Variables only: honorific+last, condition,
// prior date. Signer credentials come from the ASSIGNED physician (D2 multi-physician), NOT a
// hardcoded Kasky block.

export type CoverMemoPathway =
  | 'supplemental'
  | 'tdiu'
  | 'hlr_request'
  | 'board_appeal'
  | 'continuance';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** ISO yyyy-mm-dd → "April 28, 2026". Passes other strings through. */
export function formatDateLong(input: string | null | undefined): string {
  if (!input) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(input));
  if (m) return `${MONTH_NAMES[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${m[1]}`;
  return String(input);
}

/** Em/en dashes → comma (coverMemo.js stripEmDashes). No em dashes in FRN docs. */
function stripEmDashes(s: string): string {
  return String(s).replace(/\s*[—–]\s*/g, ', ');
}

/** Lowercase a condition for mid-sentence use, preserving all-caps acronyms (OSA/PTSD/GERD…). */
function conditionLowercase(s: string): string {
  if (!s) return '';
  return String(s).replace(/[A-Za-z][A-Za-z]*/g, (word) =>
    /^[A-Z]+$/.test(word) && word.length >= 2 && word.length <= 8 ? word : word.toLowerCase(),
  );
}

export interface BuildCoverMemoInput {
  readonly pathway: CoverMemoPathway;
  readonly veteranFullName: string;
  readonly veteranLastName: string;
  readonly salutation?: 'Mr.' | 'Mrs.' | 'Ms.' | 'Mx.';
  readonly claimedCondition: string;
  /** ISO yyyy-mm-dd. Required for supplemental/hlr_request blocks. */
  readonly priorDecisionDate?: string | null;
  /** Signer = the ASSIGNED physician's credential block (D2). */
  readonly signer: SignerCredentials;
  /** Long-format date for the header; defaults to today. */
  readonly letterDate?: string | null;
}

const PRONOUNS: Record<string, { subject: string; object: string }> = {
  'Mr.': { subject: 'his', object: 'him' },
  'Mrs.': { subject: 'her', object: 'her' },
  'Ms.': { subject: 'her', object: 'her' },
  'Mx.': { subject: 'their', object: 'them' },
};

// Sex/salutation is NOT on file for most veterans — there is no Veteran.sex field, and composeMemo
// passes no salutation — so we must NEVER guess a gendered pronoun. Singular "they" matches the
// nexus-letter renderer's own neutral default (letter.ts uses neutral "their" when sex is unknown).
const NEUTRAL_PRONOUNS = { subject: 'their', object: 'them' };

function pronounsFor(input: BuildCoverMemoInput): { subject: string; object: string } {
  if (input.salutation === undefined) return NEUTRAL_PRONOUNS;
  return PRONOUNS[input.salutation] ?? NEUTRAL_PRONOUNS;
}

// When a salutation IS provided we use it ("Ms. Carr"). When sex is UNKNOWN we must NOT guess
// "Mr."/"Ms." on a legal medical memo — a wrong honorific is worse than none — so we refer to the
// veteran by their FULL NAME ("Shirley Carr's supplemental claim...", Ryan 2026-06-28 "just drop
// gender, put first and last name"), falling back to the last name or "the veteran" if no full
// name is on file. No gendered honorific is emitted unless an explicit salutation is supplied.
function honorificLast(input: BuildCoverMemoInput): string {
  if (input.salutation === undefined) {
    return input.veteranFullName || input.veteranLastName || 'the veteran';
  }
  return input.veteranLastName ? `${input.salutation} ${input.veteranLastName}` : input.salutation;
}

function closingParagraphs(skipNieves = false): string[] {
  const lines: string[] = [];
  if (!skipNieves) {
    lines.push(
      'The opinion is independent and reflects my professional medical judgment based on full record review, consistent with the methodology described in Nieves-Rodriguez v. Peake, 22 Vet. App. 295 (2008).',
      '',
    );
  }
  lines.push(
    'This memorandum is offered solely as a medical opinion. The author is not VA-accredited and provides no representation under 38 USC 5904.',
    '',
  );
  return lines;
}

/**
 * A reliably-formatted long-format prior-decision date, or null. OWNER DIRECTIVE (2026-06-14): the
 * memo must NEVER emit a literal "[PRIOR_DECISION_DATE]" token. When no reliable date is on file we
 * DROP the date and reference the prior decision vaguely instead (see priorDecisionClause). A date
 * is "reliable" only when it parses to an ISO yyyy-mm-dd (the shape Case.priorDecisionDate produces
 * via toISOString().slice(0,10)); formatDateLong passes any other string through verbatim, which we
 * deliberately do NOT trust as a date to print.
 */
function reliablePriorDate(input: BuildCoverMemoInput): string | null {
  const raw = input.priorDecisionDate;
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(raw))) return null;
  const formatted = formatDateLong(raw);
  return formatted.trim() === '' ? null : formatted;
}

function bodyForPathway(input: BuildCoverMemoInput): string[] {
  const v = honorificLast(input);
  // Canonicalize the raw slug ("osa") to the proper label FIRST, then lowercase the prose words while
  // conditionLowercase PRESERVES the acronym → "obstructive sleep apnea (OSA)", not "osa" (Ryan
  // 2026-06-14: the body first sentence still read lowercase "osa"). The header uses the title-case label.
  const cond = conditionLowercase(formatConditionLabel(input.claimedCondition));
  const priorDate = reliablePriorDate(input);
  const p = pronounsFor(input);

  switch (input.pathway) {
    case 'supplemental': {
      // With a reliable date: "...at the time of the prior decision dated June 14, 2026 and...".
      // Without: drop the date, reference the prior decision vaguely (no bracket, no placeholder).
      const supplementalDecisionClause = priorDate !== null
        ? `It was not of record at the time of the prior decision dated ${priorDate} and reflects an independent medical analysis based on full record review.`
        : 'It was not of record at the time of the prior decision and reflects an independent medical analysis based on full record review.';
      return [
        `The attached Independent Medical Opinion is submitted in support of ${v}'s supplemental claim for ${cond}. The opinion is offered as new and relevant evidence under 38 CFR 3.2501 and 38 USC 5108. ${supplementalDecisionClause}`,
        '',
        'I respectfully request that the rater review the attached opinion as new evidence on the merits of the medical analysis it contains.',
        '',
        ...closingParagraphs(),
      ];
    }
    case 'tdiu':
      return [
        `The attached Independent Medical Opinion is submitted in support of ${v}'s claim for Total Disability based on Individual Unemployability under 38 CFR 4.16. The opinion describes the functional effects of ${p.subject} service-connected disabilities on ${p.subject} capacity for substantially gainful employment.`,
        '',
        `Per Geib v. Shinseki, 733 F.3d 1350 (Fed. Cir. 2013), the medical examiner's role is to describe functional effects; the ultimate determination of unemployability remains with the rating agency. Per Van Hoose v. Brown, 4 Vet. App. 361 (1993), the dispositive question is whether ${p.subject} service-connected disabilities prevent ${p.object} from securing or following substantially gainful employment given ${p.subject} individual education, training, and work history.`,
        '',
        'I respectfully request that the rater review the attached opinion as evidence on the merits of the functional analysis it contains.',
        '',
        ...closingParagraphs(),
      ];
    case 'hlr_request': {
      const hlrDecisionRef = priorDate !== null
        ? `the prior decision dated ${priorDate}`
        : 'the prior decision';
      return [
        `The attached Independent Medical Opinion is part of the record for ${v}'s request for Higher-Level Review of ${hlrDecisionRef}.`,
        '',
        'I respectfully request that the senior reviewer consider the attached opinion as evidence on the merits of the medical analysis it contains, consistent with the duty-to-assist provisions of 38 CFR 3.159.',
        '',
        ...closingParagraphs(),
      ];
    }
    case 'board_appeal':
      return [
        `The attached Independent Medical Opinion is submitted for ${v}'s appeal regarding ${cond}. The opinion is offered under the probative-value standards described in Nieves-Rodriguez v. Peake, 22 Vet. App. 295 (2008): factual accuracy, full articulation, and sound reasoning.`,
        '',
        // Restored 2026-07-02 (Ryan): the memo must ask the Board to consider the opinion as new and
        // significant evidence that was not of record at the time of the original submission.
        'I respectfully request that the Board consider the attached opinion as new and significant evidence that was not of record at the time of the original submission, and review it on the merits of the medical analysis it contains.',
        '',
        ...closingParagraphs(true),
      ];
    case 'continuance':
      return [
        `The attached Independent Medical Opinion is submitted in support of maintaining ${v}'s current rating for ${cond}.`,
        '',
        'Per 38 CFR 3.344, ratings stabilized for five years or more cannot be reduced unless the entire record establishes sustained material improvement under ordinary conditions of life. The attached opinion addresses that question.',
        '',
        'I respectfully request that the rater review the attached opinion as evidence on the merits of the medical analysis it contains.',
        '',
        ...closingParagraphs(),
      ];
    default: {
      const _exhaustive: never = input.pathway;
      return _exhaustive;
    }
  }
}

/**
 * Build the cover-memo TEXT (MVP). Signer block uses the ASSIGNED physician's credentials, so a
 * DPT-authored / co-signed case shows the right name (not hardcoded Kasky). No em dashes.
 */
export function buildCoverMemoText(input: BuildCoverMemoInput): string {
  const letterDateLong = input.letterDate
    ? formatDateLong(input.letterDate)
    : formatDateLong(new Date().toISOString().slice(0, 10));
  // Subject line is HEADER context → properly-cased label ("OSA", "Obstructive Sleep Apnea (OSA)"),
  // never the raw lowercased slug ("osa"). Mirrors coverMemo.js formatConditionTitleCase + the EMR
  // UI's formatConditionLabel. (E4 bug fix 2026-06-14: header was emitting the raw lowercased value.)
  const conditionTitle = formatConditionLabel(input.claimedCondition) || input.claimedCondition.trim();
  const header = [
    'PHYSICIAN COVER MEMORANDUM',
    '',
    '',
    `Date: ${letterDateLong}`,
    '',
    `Re: ${input.veteranFullName || input.veteranLastName}`,
    `    Independent Medical Opinion regarding ${conditionTitle}`,
    '',
    'To Whom It May Concern:',
    '',
  ];
  const body = bodyForPathway(input);
  const closing = [
    'Respectfully submitted,',
    '',
    '[SIGNATURE]',
    '',
    input.signer.fullNameWithCredential,
    `NPI: ${input.signer.npi}`,
  ];
  const memo = [
    header.join('\n').replace(/\n+$/, ''),
    body.join('\n').replace(/\n+$/, ''),
    closing.join('\n'),
  ].join('\n\n');
  return stripEmDashes(memo);
}
