import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  renderSection1Credentials,
  renderSignatureBlock,
  parseCredentialBlock,
  KASKY_CREDENTIALS,
  type SignerCredentials,
} from '../services/credential-block.js';

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
