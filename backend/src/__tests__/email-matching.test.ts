import { describe, expect, it } from 'vitest';
import { candidateAddresses, decideVeteranMatch, deriveEmailId, makeSnippet, normalizeEmailAddress } from '../services/email-matching.js';

describe('email-matching', () => {
  it('normalizes display names, angle brackets, case, and +sub-addressing', () => {
    expect(normalizeEmailAddress('"John Doe" <John.Doe+va@Example.com>')).toBe('john.doe@example.com');
    expect(normalizeEmailAddress('JANE@FOO.COM')).toBe('jane@foo.com');
    expect(normalizeEmailAddress('not-an-email')).toBe('');
  });

  it('candidateAddresses keeps only the non-FRN party, de-duped', () => {
    const c = candidateAddresses({
      from: 'vet@gmail.com',
      to: ['info@flatratenexus.com', 'Vet@gmail.com'],
      cc: ['spouse@gmail.com'],
      frnAddresses: ['info@flatratenexus.com'],
    });
    expect(c).toEqual(['vet@gmail.com', 'spouse@gmail.com']);
  });

  it('matches a single veteran', () => {
    const m = decideVeteranMatch(['vet@gmail.com'], (a) => (a === 'vet@gmail.com' ? [{ id: 'V1' }] : []));
    expect(m).toEqual({ status: 'matched', veteranId: 'V1', matchedAddress: 'vet@gmail.com' });
  });

  it('does NOT auto-assign when >1 veteran shares an address (PHI safety)', () => {
    const m = decideVeteranMatch(['shared@gmail.com'], () => [{ id: 'V1' }, { id: 'V2' }]);
    expect(m.status).toBe('unmatched');
    if (m.status === 'unmatched') expect(m.reason).toMatch(/multiple veterans/);
  });

  it('is unmatched when addresses map to different veterans', () => {
    const m = decideVeteranMatch(['a@x.com', 'b@x.com'], (a) => (a === 'a@x.com' ? [{ id: 'V1' }] : [{ id: 'V2' }]));
    expect(m.status).toBe('unmatched');
  });

  it('is unmatched when nothing matches', () => {
    expect(decideVeteranMatch(['x@y.com'], () => []).status).toBe('unmatched');
  });

  it('deriveEmailId is deterministic + prefixed (idempotent S3 key + row id)', () => {
    const a = deriveEmailId('<abc@mail.gmail.com>');
    expect(a).toBe(deriveEmailId('<abc@mail.gmail.com>'));
    expect(a).not.toBe(deriveEmailId('<def@mail.gmail.com>'));
    expect(a.startsWith('eml_')).toBe(true);
  });

  it('makeSnippet collapses whitespace + truncates', () => {
    expect(makeSnippet('hello   world\n\nthere')).toBe('hello world there');
    expect(makeSnippet('x'.repeat(200)).length).toBe(140);
  });
});
