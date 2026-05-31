import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  renderSection1Credentials,
  renderSignatureBlock,
  parseCredentialBlock,
  substituteSignerSentinels,
  findForeignSignerNames,
  signerNameAppears,
  SECTION1_CREDENTIALS_SENTINEL,
  SIGNATURE_BLOCK_SENTINEL,
  KASKY_CREDENTIALS,
  type SignerCredentials,
} from '../services/credential-block.js';

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
const demoLetter = readFileSync(join(here, '..', '..', 'prisma', 'demo-letter.txt'), 'utf8');
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

  it('rejects a block missing any required field', () => {
    for (const field of Object.keys(KASKY_CREDENTIALS) as (keyof SignerCredentials)[]) {
      const partial: Record<string, unknown> = { ...KASKY_CREDENTIALS };
      delete partial[field];
      expect(parseCredentialBlock(partial), `missing ${field} must be rejected`).toBeNull();
    }
  });

  it('rejects a block with a blank or non-string field', () => {
    expect(parseCredentialBlock({ ...KASKY_CREDENTIALS, licenseNumber: '   ' })).toBeNull();
    expect(parseCredentialBlock({ ...KASKY_CREDENTIALS, npi: 1073018958 })).toBeNull();
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
