import { describe, expect, it } from 'vitest';
import {
  extractCitationTokens,
  extractCitationTokenMap,
  diffCitations,
} from '../services/letter-citation-integrity.js';

// Guided Revision, 2026-06-13 — the citation-integrity guard is the key new safety. Hard unit tests:
// a false ALLOW ships a fabricated citation; a false BLOCK just makes the doctor refine. We bias to
// capture every cited fact (so a reworded form is not falsely "net-new") while still flagging a
// genuinely new token.

describe('letter-citation-integrity — extraction', () => {
  it('extracts PMIDs (with/without colon, leading-zero normalized)', () => {
    const keys = extractCitationTokens('See PMID: 12345678 and PMID 012345678 and PMID:99.').map((t) => t.key);
    expect(keys).toContain('pmid:12345678');
    expect(keys).toContain('pmid:99');
    // "012345678" normalizes to "12345678" (leading zero stripped) → same token, de-duped.
    expect(keys.filter((k) => k === 'pmid:12345678')).toHaveLength(1);
  });

  it('extracts author-year and treats "et al."/"and" connectives as the same cite', () => {
    const a = extractCitationTokenMap('Dell\'Isola 2021 found an effect.');
    const b = extractCitationTokenMap('Dell\'Isola et al. 2021 found an effect.');
    const c = extractCitationTokenMap('Dell\'Isola and Jones 2021 found an effect.');
    expect([...a.keys()]).toContain("ay:dell'isola:2021");
    // reworded citation form (et al. / and Jones) must share identity → no false net-new
    expect([...b.keys()]).toContain("ay:dell'isola:2021");
    expect([...c.keys()]).toContain("ay:dell'isola:2021");
  });

  it('extracts hyphenated surnames (El-Serag 2014)', () => {
    expect([...extractCitationTokenMap('El-Serag 2014 reported erosions.').keys()]).toContain('ay:el-serag:2014');
  });

  it('extracts statistics: percent, OR/RR/HR, n=, CI — with numeric normalization', () => {
    const keys = extractCitationTokens('prevalence 18% (OR 11.7, 95% CI 1.07-1.60), n = 548,681, RR of 1.60').map((t) => t.key);
    expect(keys).toContain('pct:18');
    expect(keys).toContain('ratio:or:11.7');
    expect(keys).toContain('ci:1.07:1.6'); // trailing-zero normalized 1.60 → 1.6
    expect(keys).toContain('n:548681'); // commas stripped
    expect(keys).toContain('ratio:rr:1.6');
  });

  it('"18 percent" and "18%" are the same stat token', () => {
    expect([...extractCitationTokenMap('18 percent of veterans').keys()]).toContain('pct:18');
  });

  it('empty / non-string input yields no tokens (never throws)', () => {
    expect(extractCitationTokens('')).toHaveLength(0);
    expect(extractCitationTokens(undefined as unknown as string)).toHaveLength(0);
  });
});

describe('letter-citation-integrity — diffCitations', () => {
  it('a NET-NEW PMID in the revised passage shows as added (=> route REJECTS)', () => {
    const before = 'The mechanism is well established in the literature.';
    const after = 'The mechanism is well established (PMID: 31234567).';
    const diff = diffCitations(before, after);
    expect(diff.added.map((t) => t.key)).toContain('pmid:31234567');
    expect(diff.removed).toHaveLength(0);
  });

  it('a NET-NEW statistic shows as added', () => {
    const diff = diffCitations('a strong association', 'a strong association (OR 3.1)');
    expect(diff.added.map((t) => t.key)).toContain('ratio:or:3.1');
  });

  it('a DROPPED citation shows as removed (=> route WARNS, not rejects)', () => {
    const before = 'Dell\'Isola 2021 showed HR 1.60 in n = 548,681.';
    const after = 'The literature shows a meaningful association.';
    const diff = diffCitations(before, after);
    const removedKeys = diff.removed.map((t) => t.key);
    expect(removedKeys).toContain("ay:dell'isola:2021");
    expect(removedKeys).toContain('ratio:hr:1.6');
    expect(removedKeys).toContain('n:548681');
    expect(diff.added).toHaveLength(0);
  });

  it('pure rewording that keeps the SAME cited facts produces no added and no removed', () => {
    const before = 'Smith 2019 reported a 22% prevalence (OR 2.4).';
    const after = 'A prevalence of 22% was reported by Smith et al. 2019, with an OR of 2.4.';
    const diff = diffCitations(before, after);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });
});
