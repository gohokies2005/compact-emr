import { describe, expect, it } from 'vitest';
import {
  extractCitationTokens,
  extractCitationTokenMap,
  diffCitations,
  diffCitationsSanctioned,
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

// Feature B (Citation Enricher, 2026-06-24) — the SANCTIONED variant is the safety keystone. A
// net-new citation is allowed ONLY if its PMID is in the server-re-verified sanctioned set; anything
// else is still rejected, and the NORMAL surgical/guided path (diffCitations, no sanctioned set) is
// UNCHANGED. These tests pin all three properties.
describe('letter-citation-integrity — diffCitationsSanctioned (Feature B keystone)', () => {
  // The reference lines below carry ONLY a PMID token (no "Word Year" author-year surface form), so
  // the tests isolate the PMID-sanctioning behavior — exactly what buildReferenceLine emits
  // ("<N>. <title>. <journal>. <year> PMID: <id>." — the deterministic insertion is PMID-anchored).
  it('ALLOWS a verified net-new PMID (its id is in the sanctioned set)', () => {
    const before = 'References. See PMID: 11111111.';
    const after = 'References. See PMID: 11111111. See also PMID: 22222222.';
    const diff = diffCitationsSanctioned(before, after, ['22222222']);
    expect(diff.added).toHaveLength(0); // sanctioned → not flagged
    expect(diff.removed).toHaveLength(0);
  });

  it('REJECTS a net-new PMID that is NOT in the sanctioned set (the client tried to slip one in)', () => {
    const before = 'References. See PMID: 11111111.';
    const after = 'References. See PMID: 11111111. See also PMID: 99999999.';
    // The verified set only sanctions 22222222 — 99999999 was never re-verified.
    const diff = diffCitationsSanctioned(before, after, ['22222222']);
    expect(diff.added.map((t) => t.key)).toEqual(['pmid:99999999']);
  });

  it('REJECTS a net-new statistic even when a PMID is sanctioned (insertion never adds a bare stat)', () => {
    const before = 'References. See PMID: 11111111.';
    const after = 'The risk was OR 5.7. See PMID: 22222222.';
    const diff = diffCitationsSanctioned(before, after, ['22222222']);
    // The PMID is sanctioned (not flagged) but the net-new OR 5.7 is fabrication → rejected.
    expect(diff.added.map((t) => t.key)).toContain('ratio:or:5.7');
    expect(diff.added.map((t) => t.key)).not.toContain('pmid:22222222');
  });

  it('REJECTS a net-new author-year even with a sanctioned PMID (enricher inserts PMIDs only)', () => {
    const before = 'References. See PMID: 11111111.';
    const after = 'As Jones 2021 found. See PMID: 22222222.';
    const diff = diffCitationsSanctioned(before, after, ['22222222']);
    expect(diff.added.map((t) => t.key)).toContain('ay:jones:2021');
  });

  // sanctionedTexts exemption (by-PMID apply, 2026-07-02): a real paper's TITLE can carry a %/ratio.
  it('ALLOWS a %/ratio that appears in a SANCTIONED verified-citation string (real paper title), not fabrication', () => {
    const before = 'VIII. References\n1. Old A. Prior. J. 2019. PMID: 11111111.';
    // The inserted reference line is the verbatim NCBI full_citation whose TITLE contains "30%".
    const insertedCitation = '2. Smith B, Lee C. A 30% reduction in adjacent-segment disease after fusion. Spine J. 2021;21(4):64-72. PMID: 22222222.';
    const after = `${before}\n${insertedCitation}`;
    const diff = diffCitationsSanctioned(before, after, ['22222222'], [insertedCitation]);
    expect(diff.added).toHaveLength(0); // the "30%" is part of a verified citation string → exempt
  });

  it('STILL REJECTS a stat that is NOT in any sanctioned-citation string, even when sanctionedTexts is provided', () => {
    const before = 'References. See PMID: 11111111.';
    const after = 'The body now claims a fabricated 42% rate. See PMID: 22222222.';
    // A verified citation string is provided, but "42%" does not appear in it → still fabrication.
    const diff = diffCitationsSanctioned(before, after, ['22222222'], ['2. Smith B. Some title with no stat. J. 2021. PMID: 22222222.']);
    expect(diff.added.map((t) => t.key)).toContain('pct:42');
  });

  it('an EMPTY sanctioned set behaves exactly like diffCitations (no net-new allowed)', () => {
    const before = 'The mechanism is established.';
    const after = 'The mechanism is established (PMID: 33333333).';
    expect(diffCitationsSanctioned(before, after, []).added.map((t) => t.key)).toEqual(['pmid:33333333']);
    // identical to the un-sanctioned guard:
    expect(diffCitations(before, after).added.map((t) => t.key)).toEqual(['pmid:33333333']);
  });

  it('normalizes zero-padded / "PMID:"-prefixed sanctioned ids to the bare-digit identity', () => {
    const before = 'References. See PMID: 11111111.';
    const after = 'References. See PMID: 11111111. See also PMID: 22222222.';
    // Sanctioned set given as a formatted/padded form must still match.
    expect(diffCitationsSanctioned(before, after, ['PMID: 022222222']).added).toHaveLength(0);
  });

  it('GUARD INTACT: the normal surgical/guided path (diffCitations) still rejects a net-new cite', () => {
    // diffCitationsSanctioned does NOT replace diffCitations — the normal paths keep using
    // diffCitations with no sanctioned set, so their guard is unchanged. (Belt-and-suspenders pin.)
    const before = 'No citations here.';
    const after = 'Now with Smith 2019 and PMID: 44444444.';
    const normal = diffCitations(before, after);
    expect(normal.added.map((t) => t.key)).toEqual(expect.arrayContaining(['ay:smith:2019', 'pmid:44444444']));
  });
});

// ── BUG 4 (Spring, 2026-06-25): guided-revision CROSS-REFERENCE allowance ─────────────────────────
// The guided-revision integrity guard (letter.ts) now builds its allowed-PMID set from EVERY PMID
// already present in the CURRENT FULL LETTER (especially the numbered §VIII references a physician just
// added via the Citation Enricher) and passes it to diffCitationsSanctioned. A PMID new to the edited
// PASSAGE but already in §VIII is a legitimate internal cross-reference, NOT a fabrication. A PMID that
// is NOWHERE in the letter is still rejected. This block models that exact wiring.
describe('letter-citation-integrity — guided-revision cross-reference (Bug 4)', () => {
  // The §VIII reference the physician added via the enricher (PMID 31393195 = the Spring case).
  const FULL_LETTER = [
    'VI. Medical Reasoning',
    'The mechanism is established.',
    '',
    'VIII. References',
    '1. Existing A. A study. J Test. 2010. PMID: 11111111.',
    '2. Spring B, et al. A grounded study. J Sleep. 2019;5(2):100-110. PMID: 31393195.',
  ].join('\n');

  // Helper mirroring letter.ts: allowed PMIDs = every PMID already in the full current letter.
  const lettersPmids = (letter: string) =>
    [...extractCitationTokenMap(letter).values()].filter((t) => t.kind === 'pmid').map((t) => t.key.replace(/^pmid:/, ''));

  it('ALLOWS referencing a PMID already in §VIII into a §VI passage (the Spring case)', () => {
    const passageBefore = 'The mechanism is established.';
    const passageAfter = 'The mechanism is established, consistent with the peer-reviewed literature (PMID: 31393195).';
    const diff = diffCitationsSanctioned(passageBefore, passageAfter, lettersPmids(FULL_LETTER));
    // 31393195 is already a §VIII reference → not flagged as invented. This is the bug fix.
    expect(diff.added).toHaveLength(0);
  });

  it('STILL REJECTS a PMID that is NOWHERE in the letter (real fabrication guard intact)', () => {
    const passageBefore = 'The mechanism is established.';
    const passageAfter = 'The mechanism is established (PMID: 87654321).'; // never added anywhere
    const diff = diffCitationsSanctioned(passageBefore, passageAfter, lettersPmids(FULL_LETTER));
    expect(diff.added.map((t) => t.key)).toEqual(['pmid:87654321']);
  });

  it('STILL REJECTS a net-new author-year or statistic even when cross-referencing a §VIII PMID', () => {
    const passageBefore = 'The mechanism is established.';
    // Legit cross-ref to §VIII PMID 31393195, but the model also slipped in "Jones 2021" + "OR 4.2".
    const passageAfter = 'As Jones 2021 found (OR 4.2), this is consistent (PMID: 31393195).';
    const diff = diffCitationsSanctioned(passageBefore, passageAfter, lettersPmids(FULL_LETTER));
    const keys = diff.added.map((t) => t.key);
    expect(keys).toContain('ay:jones:2021');
    expect(keys).toContain('ratio:or:4.2');
    expect(keys).not.toContain('pmid:31393195'); // the cross-ref itself is allowed
  });
});
