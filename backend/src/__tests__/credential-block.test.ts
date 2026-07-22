import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  renderSection1Credentials,
  renderSection1CredentialFacts,
  renderSignatureBlock,
  parseCredentialBlock,
  buildRendererCredentialLines,
  substituteSignerSentinels,
  substituteHardcodedSection1Credentials,
  findForeignSignerNames,
  signerNameAppears,
  SECTION1_CREDENTIALS_SENTINEL,
  SIGNATURE_BLOCK_SENTINEL,
  KASKY_CREDENTIALS,
  DRAFTER_HARDCODED_SECTION1_FACTS,
  type SignerCredentials,
} from '../services/credential-block.js';

const KEVIN_DPT: SignerCredentials = {
  fullNameWithCredential: 'Kevin Luiz, DPT',
  specialty: '', boardName: '', boardAbbreviation: '', licenseState: '', licenseNumber: '',
  npi: '1861292955',
};

const JANE: SignerCredentials = {
  fullNameWithCredential: 'Jane A. Doe, MD',
  specialty: 'Internal Medicine',
  boardName: 'American Board of Internal Medicine',
  boardAbbreviation: 'ABIM',
  licenseState: 'Texas',
  licenseNumber: 'MD55512',
  npi: '1999999999',
};

// Resolve the reference letter relative to this test file: src/__tests__ -> ../../prisma.
const here = dirname(fileURLToPath(import.meta.url));
// Normalize CRLF → LF: the fixture is checked out with the platform's line endings (CRLF on a
// Windows checkout); the builders emit LF, so a raw split left a trailing \r on every line and the
// byte-for-byte compare failed on Windows. Normalizing makes the round-trip OS-independent.
const demoLetter = readFileSync(join(here, '..', '..', 'prisma', 'demo-letter.txt'), 'utf8').replace(/\r\n/g, '\n');
const lines = demoLetter.split('\n');

describe('credential-block — round-trip against the Kasky reference letter', () => {
  // The spec lock: the builders, given Kasky's credentials, must reproduce demo-letter.txt's
  // Section I sentence and signature block byte-for-byte. Any wording drift fails here.

  it('renderSection1Credentials reproduces the Section I qualifications sentence verbatim', () => {
    const section1 = lines.find((l) => l.startsWith('I, Ryan J. Kasky, DO, am board-certified'));
    expect(section1, 'demo-letter.txt must contain the Section I credentials sentence').toBeDefined();
    // James Adams is male in the reference letter -> "his".
    expect(renderSection1Credentials(KASKY_CREDENTIALS, 'his')).toBe(section1);
  });

  it('renderSignatureBlock reproduces the closing signature block verbatim', () => {
    const sigIdx = lines.findIndex((l) => l.trim() === 'Respectfully submitted,');
    expect(sigIdx, 'demo-letter.txt must contain the signature block').toBeGreaterThanOrEqual(0);
    // Skip the blank line after "Respectfully submitted,"; the block is the next 4 lines.
    const sigBlock = lines.slice(sigIdx + 2, sigIdx + 6).join('\n');
    expect(renderSignatureBlock(KASKY_CREDENTIALS)).toBe(sigBlock);
  });

  it('the Section I sentence carries the locked no-treatment-relationship fragment', () => {
    // The fraud-gate substitution must never drop this locked sentence (letter-locked-blocks).
    expect(renderSection1Credentials(KASKY_CREDENTIALS, 'her')).toContain(
      'I have no treatment relationship with this veteran',
    );
  });

  it('the pronoun is veteran-specific, not baked into the builder', () => {
    expect(renderSection1Credentials(KASKY_CREDENTIALS, 'her')).toContain('purpose of her VA disability claim.');
    expect(renderSection1Credentials(KASKY_CREDENTIALS, 'their')).toContain('purpose of their VA disability claim.');
  });
});

describe('credential-block — parseCredentialBlock validation', () => {
  it('round-trips a serialized SignerCredentials', () => {
    const fromJson = parseCredentialBlock(JSON.parse(JSON.stringify(KASKY_CREDENTIALS)));
    expect(fromJson).toEqual(KASKY_CREDENTIALS);
  });

  it('rejects null / non-object / array', () => {
    expect(parseCredentialBlock(null)).toBeNull();
    expect(parseCredentialBlock('Ryan J. Kasky, DO')).toBeNull();
    expect(parseCredentialBlock(42)).toBeNull();
    expect(parseCredentialBlock([KASKY_CREDENTIALS])).toBeNull();
  });

  it('rejects a block missing a REQUIRED field (name-with-credential or NPI)', () => {
    for (const field of ['fullNameWithCredential', 'npi'] as (keyof SignerCredentials)[]) {
      const partial: Record<string, unknown> = { ...KASKY_CREDENTIALS };
      delete partial[field];
      expect(parseCredentialBlock(partial), `missing required ${field} must be rejected`).toBeNull();
    }
  });

  it('accepts a block missing OPTIONAL board/license fields (DPT co-sign, 2026-07-20)', () => {
    for (const field of ['specialty', 'boardName', 'boardAbbreviation', 'licenseState', 'licenseNumber'] as (keyof SignerCredentials)[]) {
      const partial: Record<string, unknown> = { ...KASKY_CREDENTIALS };
      delete partial[field];
      expect(parseCredentialBlock(partial), `missing optional ${field} must still parse`).not.toBeNull();
    }
  });

  it('rejects a REQUIRED field blank/non-string; a blank OPTIONAL field is fine', () => {
    expect(parseCredentialBlock({ ...KASKY_CREDENTIALS, npi: '   ' })).toBeNull(); // required blank
    expect(parseCredentialBlock({ ...KASKY_CREDENTIALS, npi: 1073018958 })).toBeNull(); // required non-string
    expect(parseCredentialBlock({ ...KASKY_CREDENTIALS, fullNameWithCredential: '' })).toBeNull(); // required blank
    expect(parseCredentialBlock({ ...KASKY_CREDENTIALS, licenseNumber: '   ' })).not.toBeNull(); // optional blank → OK
  });

  it('parses a DPT block (name + NPI, no board/license) as COMPLETE — Kevin Luiz DPT sign path', () => {
    const dpt = {
      fullNameWithCredential: 'Kevin Luiz, DPT',
      specialty: '', boardName: '', boardAbbreviation: '', licenseState: '', licenseNumber: '',
      npi: '1861292955',
    };
    const parsed = parseCredentialBlock(dpt);
    expect(parsed, 'a DPT block with name + NPI must be COMPLETE (signable)').not.toBeNull();
    expect(parsed?.npi).toBe('1861292955');
    const lines = buildRendererCredentialLines(parsed!);
    expect(lines).toContain('Kevin Luiz, DPT');
    expect(lines).toContain('NPI: 1861292955');
    expect(lines, 'DPT renders no board-cert line').not.toContain('Board-Certified');
  });
});

describe('credential-block — substituteSignerSentinels', () => {
  it('replaces both sentinels with the rendered blocks', () => {
    const body = `${SECTION1_CREDENTIALS_SENTINEL}\n\nMiddle.\n\n${SIGNATURE_BLOCK_SENTINEL}`;
    const out = substituteSignerSentinels(body, KASKY_CREDENTIALS, 'his');
    expect(out).toContain(renderSection1Credentials(KASKY_CREDENTIALS, 'his'));
    expect(out).toContain(renderSignatureBlock(KASKY_CREDENTIALS));
    expect(out).not.toContain('[[SIGNER_');
  });

  it('is a no-op on a legacy letter with no sentinel (byte-identical pass-through)', () => {
    const legacy = 'I, Ryan J. Kasky, DO, am board-certified in Family Medicine.\n\nRyan J. Kasky, DO';
    expect(substituteSignerSentinels(legacy, JANE, 'their')).toBe(legacy);
  });

  it('is idempotent — running twice equals running once', () => {
    const body = `${SECTION1_CREDENTIALS_SENTINEL}\n\n${SIGNATURE_BLOCK_SENTINEL}`;
    const once = substituteSignerSentinels(body, KASKY_CREDENTIALS, 'their');
    expect(substituteSignerSentinels(once, KASKY_CREDENTIALS, 'their')).toBe(once);
  });

  it('replaces every occurrence of a sentinel', () => {
    const body = `${SIGNATURE_BLOCK_SENTINEL} and again ${SIGNATURE_BLOCK_SENTINEL}`;
    const out = substituteSignerSentinels(body, KASKY_CREDENTIALS, 'their');
    expect(out).not.toContain('[[SIGNER_');
    expect(out.split(renderSignatureBlock(KASKY_CREDENTIALS)).length - 1).toBe(2);
  });
});

describe('credential-block — findForeignSignerNames (the anti-fraud assertion)', () => {
  const kaskyLetter = 'I, Ryan J. Kasky, DO, am board-certified.\n\nRyan J. Kasky, DO';
  const roster = [KASKY_CREDENTIALS.fullNameWithCredential, JANE.fullNameWithCredential];

  it('returns empty when the assigned signer is the only name present', () => {
    // Assigned = Kasky, letter names Kasky -> no foreign name.
    expect(findForeignSignerNames(kaskyLetter, roster, KASKY_CREDENTIALS.fullNameWithCredential)).toEqual([]);
  });

  it('flags the foreign name when a different physician is assigned to a Kasky-bodied letter', () => {
    // Assigned = Jane, letter still says Kasky -> Kasky is foreign.
    expect(findForeignSignerNames(kaskyLetter, roster, JANE.fullNameWithCredential)).toEqual([
      'Ryan J. Kasky, DO',
    ]);
  });

  it('never flags the assigned signer themselves and de-dupes', () => {
    const twice = `${kaskyLetter}\n\nRyan J. Kasky, DO`;
    expect(findForeignSignerNames(twice, roster, JANE.fullNameWithCredential)).toEqual(['Ryan J. Kasky, DO']);
  });

  // Hardening: whole-name matching + self-name masking (substring-name physicians).
  it('does NOT flag a roster name that is a substring of the assigned signer name', () => {
    // Assigned "Mary Jane Doe, MD"; roster also has "Jane Doe, MD"; letter names only the signer.
    const self = 'Mary Jane Doe, MD';
    const body = 'I, Mary Jane Doe, MD, am board-certified.\n\nMary Jane Doe, MD';
    expect(findForeignSignerNames(body, [self, 'Jane Doe, MD'], self)).toEqual([]);
  });

  it('does NOT match a name glued inside a longer word', () => {
    // "Doe, MD" must not match inside "Doelan, MD".
    expect(findForeignSignerNames('Reviewed by Sam Doelan, MD.', ['Doe, MD', 'Sam Doelan, MD'], 'Sam Doelan, MD')).toEqual([]);
  });
});

describe('credential-block — renderSection1CredentialFacts (the rewriteable Section I prefix)', () => {
  it('is the EXACT pronoun-independent prefix of the full Section I sentence for Kasky (byte-identity)', () => {
    const facts = renderSection1CredentialFacts(KASKY_CREDENTIALS);
    const full = renderSection1Credentials(KASKY_CREDENTIALS, 'his');
    // facts is the full sentence minus the "I have no treatment relationship … claim." tail.
    expect(full.startsWith(facts)).toBe(true);
    expect(full[facts.length]).toBe(' '); // exactly one space then the fixed tail
    expect(facts).toBe(
      'I, Ryan J. Kasky, DO, am board-certified in Family Medicine through the American Board of ' +
        'Osteopathic Family Physicians (ABOFP). I hold an active medical license in Nevada ' +
        '(License #DO2996) with NPI 1073018958.',
    );
  });

  it('appears VERBATIM in the reference letter (the string the approve path rewrites)', () => {
    expect(demoLetter).toContain(renderSection1CredentialFacts(KASKY_CREDENTIALS));
  });

  it('DPT renders a board-free, NPI-only qualifications sentence (no malformed board clause)', () => {
    expect(renderSection1CredentialFacts(KEVIN_DPT)).toBe(
      'I am Kevin Luiz, DPT. My National Provider Identifier (NPI) is 1861292955.',
    );
    expect(renderSection1CredentialFacts(KEVIN_DPT)).not.toContain('board-certified');
  });
});

describe('credential-block — substituteHardcodedSection1Credentials (legacy Kasky → assigned signer)', () => {
  it('c0 BYTE-IDENTICAL: Kasky signing a Kasky letter is an exact no-op over the whole reference letter', () => {
    // The single most important guarantee: the thousands of Kasky letters are unchanged.
    expect(substituteHardcodedSection1Credentials(demoLetter, KASKY_CREDENTIALS, null)).toBe(demoLetter);
  });

  it('c0 BYTE-IDENTICAL even if a co-signer is (mis)configured while the primary IS Kasky', () => {
    // replacement === hardcoded short-circuits BEFORE any concurrence append.
    expect(substituteHardcodedSection1Credentials(demoLetter, KASKY_CREDENTIALS, 'Ada Owner, MD')).toBe(demoLetter);
  });

  it('passes an unrelated letter (no hardcoded Kasky facts) through untouched — never manufactures a pass', () => {
    const other = 'The veteran has a chronic back condition documented in the record.';
    expect(substituteHardcodedSection1Credentials(other, KEVIN_DPT, null)).toBe(other);
    // The name gate would then still (correctly) fail — the substitution invented nothing.
    expect(signerNameAppears(other, KEVIN_DPT.fullNameWithCredential)).toBe(false);
  });

  it('DPT primary + Kasky co-sign: Section I names the DPT + NPI + a Kasky concurrence, and PASSES both gates', () => {
    const out = substituteHardcodedSection1Credentials(demoLetter, KEVIN_DPT, 'Ryan J. Kasky, DO');
    expect(out).not.toBe(demoLetter);
    // Assigned signer is named (positive name gate passes) …
    expect(signerNameAppears(out, 'Kevin Luiz, DPT')).toBe(true);
    expect(out).toContain('1861292955');
    // … a Kasky concurrence is present …
    expect(out).toContain('This opinion has been independently reviewed and concurred in by Ryan J. Kasky, DO.');
    // … the locked treatment-relationship tail survived …
    expect(out).toContain('I have no treatment relationship with this veteran');
    // … Kasky is NO LONGER the primary author, and the DPT carries no bogus board certification.
    expect(out).not.toContain('I, Ryan J. Kasky, DO, am board-certified');
    expect(out).not.toContain('board-certified in Family Medicine');
    // Foreign-name gate, mirroring the caller: the co-signer (Kasky) is excused; every other
    // physician is still checked. The DPT is self. → no foreign name.
    const rosterMinusCoSigner = ['Kevin Luiz, DPT', 'Ryan J. Kasky, DO'].filter((n) => n !== 'Ryan J. Kasky, DO');
    expect(findForeignSignerNames(out, rosterMinusCoSigner, 'Kevin Luiz, DPT')).toEqual([]);
  });

  it('full-MD (board + license) primary, no co-sign: Section I becomes a correct board sentence for the new signer', () => {
    const out = substituteHardcodedSection1Credentials(demoLetter, JANE, null);
    expect(out).toContain(
      'I, Jane A. Doe, MD, am board-certified in Internal Medicine through the American Board of ' +
        'Internal Medicine (ABIM). I hold an active medical license in Texas (License #MD55512) ' +
        'with NPI 1999999999.',
    );
    expect(out).not.toContain('I, Ryan J. Kasky, DO, am board-certified');
    expect(signerNameAppears(out, 'Jane A. Doe, MD')).toBe(true);
  });
});

// ── THE REGRESSION THAT SHIPPED (Kevin Luiz DPT, 2026-07-21) ──────────────────────────────────────
// The prior anchor re-derived the Kasky prefix from KASKY_CREDENTIALS (license form) and matched only
// the stale demo-letter.txt fixture — NEVER the NPI-only Section I the live Fargate drafter actually
// bakes (app/services/claude.js `lockedSectionI`). So the substitution silently no-op'd on every real
// letter and Kevin could not sign. These tests pin the fix against the REAL production Section I string.
describe('credential-block — substitution against the REAL drafter (NPI-form) Section I', () => {
  // The exact Section I the live drafter emits (claude.js lockedSectionI + the fixed treatment tail),
  // as it appears in Tomek's actual letter. This is what the anchor MUST match — not demo-letter.txt.
  const realDrafterLetter =
    'July 15, 2026\n\nRE: Independent Medical Opinion\nVeteran: Lawrence Tomek\n' +
    'I. Physician Qualifications\n\n' +
    'I, Ryan J. Kasky, DO, am board-certified in Family Medicine through the American Board of ' +
    'Osteopathic Family Physicians (ABOFP). My National Provider Identifier (NPI) is 1073018958. ' +
    'I have no treatment relationship with this veteran. This letter is an independent medical opinion ' +
    'prepared for the purpose of his VA disability claim.\n\nII. Methodology\n\n(body continues)';

  it('SANITY: the real drafter letter actually contains the drafter-anchor constant verbatim', () => {
    // If this fails, the anchor constant has drifted from the drafter and the whole fix is moot.
    expect(realDrafterLetter).toContain(DRAFTER_HARDCODED_SECTION1_FACTS);
  });

  it('RED→GREEN: Kevin Luiz DPT assigned → the REAL letter names the DPT (this no-op\'d before the fix)', () => {
    const out = substituteHardcodedSection1Credentials(realDrafterLetter, KEVIN_DPT, null);
    expect(out, 'the substitution must actually change the letter, not no-op').not.toBe(realDrafterLetter);
    expect(signerNameAppears(out, 'Kevin Luiz, DPT')).toBe(true);
    expect(out).toContain('I am Kevin Luiz, DPT. My National Provider Identifier (NPI) is 1861292955.');
    expect(out).toContain('1861292955');
    // Kasky's authorship line is gone; the locked treatment tail survives.
    expect(out).not.toContain('I, Ryan J. Kasky, DO, am board-certified');
    expect(out).toContain('I have no treatment relationship with this veteran');
    // The approve name gate (the thing that 409'd Kevin) now passes on the real letter.
    expect(signerNameAppears(out, 'Kevin Luiz, DPT')).toBe(true);
  });

  it('c0 BYTE-IDENTICAL: Kasky signing the REAL NPI-form letter is an exact no-op (NPI-identity guard)', () => {
    // The critical guarantee under the NEW identity-keyed no-op: a real Kasky letter is untouched even
    // though renderSection1CredentialFacts(KASKY) yields the *license* form (≠ the baked NPI form).
    expect(substituteHardcodedSection1Credentials(realDrafterLetter, KASKY_CREDENTIALS, null)).toBe(realDrafterLetter);
    expect(substituteHardcodedSection1Credentials(realDrafterLetter, KASKY_CREDENTIALS, 'Ada Owner, MD')).toBe(realDrafterLetter);
  });

  it('DPT primary + Kasky co-sign on the REAL letter → DPT named + Kasky concurrence, gates pass', () => {
    const out = substituteHardcodedSection1Credentials(realDrafterLetter, KEVIN_DPT, 'Ryan J. Kasky, DO');
    expect(signerNameAppears(out, 'Kevin Luiz, DPT')).toBe(true);
    expect(out).toContain('This opinion has been independently reviewed and concurred in by Ryan J. Kasky, DO.');
    expect(out).not.toContain('I, Ryan J. Kasky, DO, am board-certified');
    // Foreign-name gate mirrors the approve caller: co-signer Kasky excused, DPT is self → no foreign.
    expect(findForeignSignerNames(out, ['Kevin Luiz, DPT'], 'Kevin Luiz, DPT')).toEqual([]);
  });

  it('still substitutes on a LEGACY license-form letter (fallback anchor) — no old letter is orphaned', () => {
    const legacyLetter = demoLetter; // demo-letter.txt carries the old Nevada license form
    const out = substituteHardcodedSection1Credentials(legacyLetter, KEVIN_DPT, null);
    expect(out).not.toBe(legacyLetter);
    expect(signerNameAppears(out, 'Kevin Luiz, DPT')).toBe(true);
  });
});

describe('credential-block — signerNameAppears (whole-name positive check)', () => {
  it('matches a credentialed name bounded by punctuation/whitespace/edges', () => {
    expect(signerNameAppears('I, Ryan J. Kasky, DO, am board-certified.', 'Ryan J. Kasky, DO')).toBe(true);
    expect(signerNameAppears('...\n\nRyan J. Kasky, DO', 'Ryan J. Kasky, DO')).toBe(true);
  });

  it('does not match when the name is glued to surrounding letters or absent', () => {
    expect(signerNameAppears('Ryan J. Kasky, DOx is here', 'Ryan J. Kasky, DO')).toBe(false);
    expect(signerNameAppears('The veteran has a back condition.', 'Ryan J. Kasky, DO')).toBe(false);
  });
});
