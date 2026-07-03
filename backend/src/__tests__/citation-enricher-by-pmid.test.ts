import { describe, expect, it, vi } from 'vitest';
import {
  makeResolveCitationByPmid,
  insertVerifiedCitations,
  type PmidVerifier,
  type VerifyResult,
} from '../services/citation-enricher.js';
import { diffCitationsSanctioned } from '../services/letter-citation-integrity.js';

/**
 * DIRECT-PMID resolver (Feature B complement, 2026-07-02). The physician types an exact PubMed ID;
 * resolveCitationByPmid fetches + VERIFIES it against NCBI (real, non-retracted, grounded) and maps
 * it to a preview candidate. The NCBI layer (verifyPmidById) is INJECTED so these run without network.
 *
 * The keystone assertions:
 *   - a real PMID → a candidate whose EVERY field is from NCBI (never fabricated from the input);
 *   - a non-existent PMID → { status: 'pmid_not_found' } (no candidate, no fabrication);
 *   - a retracted PMID → { status: 'retracted' } (rejected);
 *   - the resolver calls the verifier WITHOUT a condition (the on-topic gate is SKIPPED — the
 *     physician's explicit choice is the relevance authority);
 *   - a verified by-PMID citation, inserted, PASSES diffCitationsSanctioned (it is sanctioned because
 *     it was NCBI-verified), while the SAME insertion with an EMPTY sanctioned set FAILS the guard
 *     (proving an unverified PMID insertion is still caught — anti-fabrication is not weakened).
 */

const VERIFIED: VerifyResult = {
  verified: true,
  pmid: '31393195',
  title: 'Obstructive sleep apnea and PTSD among veterans',
  journal: 'J Clin Sleep Med',
  year: '2019',
  killer_finding: 'OSA prevalence was 69% among veterans with PTSD.',
  full_citation: 'Colvonen PJ, et al. Obstructive sleep apnea and PTSD among veterans. J Clin Sleep Med. 2019;15(2):165-175',
};

function stubVerifier(map: Record<string, VerifyResult>): PmidVerifier {
  return vi.fn(async (pmid: string): Promise<VerifyResult> => {
    const clean = String(pmid).replace(/\D/g, '');
    return map[clean] ?? { verified: false, pmid: clean, title: '', journal: '', year: '', killer_finding: '', reason: 'no_summary' };
  });
}

describe('resolveCitationByPmid', () => {
  it('a real PMID → an ok candidate built ENTIRELY from the NCBI metadata', async () => {
    const resolve = makeResolveCitationByPmid(stubVerifier({ '31393195': VERIFIED }));
    const r = await resolve('31393195');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.candidate.pmid).toBe('31393195');
    expect(r.candidate.title).toBe(VERIFIED.title);
    expect(r.candidate.journal).toBe(VERIFIED.journal);
    expect(r.candidate.year).toBe('2019');
    expect(r.candidate.killer_finding).toContain('69%');
    expect(r.candidate.pubmedUrl).toBe('https://pubmed.ncbi.nlm.nih.gov/31393195/');
  });

  it('normalizes a messy input ("PMID: 031393195") to the bare-digit id', async () => {
    const resolve = makeResolveCitationByPmid(stubVerifier({ '31393195': VERIFIED }));
    const r = await resolve('PMID: 031393195');
    expect(r.status).toBe('ok');
  });

  it('calls the verifier WITHOUT a condition (on-topic gate skipped — physician chose the paper)', async () => {
    const verify = stubVerifier({ '31393195': VERIFIED });
    await makeResolveCitationByPmid(verify)('31393195');
    expect(verify).toHaveBeenCalledWith('31393195');
    // exactly one arg — no condition was passed
    expect((verify as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(1);
  });

  it('a non-existent PMID (no NCBI summary) → pmid_not_found (no candidate, no fabrication)', async () => {
    const resolve = makeResolveCitationByPmid(stubVerifier({}));
    const r = await resolve('99999999');
    expect(r.status).toBe('pmid_not_found');
    if (r.status === 'ok') throw new Error('must not resolve');
    expect(r.pmid).toBe('99999999');
  });

  it('a retracted PMID → retracted (rejected)', async () => {
    const resolve = makeResolveCitationByPmid(stubVerifier({
      '12345678': { verified: false, pmid: '12345678', title: '', journal: '', year: '', killer_finding: '', reason: 'retracted' },
    }));
    const r = await resolve('12345678');
    expect(r.status).toBe('retracted');
  });

  it('a real paper with no groundable abstract → not_grounded (consistent with apply-time re-verify)', async () => {
    const resolve = makeResolveCitationByPmid(stubVerifier({
      '22222222': { verified: false, pmid: '22222222', title: 'X', journal: 'Y', year: '2001', killer_finding: '', reason: 'no_grounded_stat' },
    }));
    const r = await resolve('22222222');
    expect(r.status).toBe('not_grounded');
  });

  it('empty/garbage input → invalid_pmid (never calls NCBI)', async () => {
    const verify = stubVerifier({});
    const r = await makeResolveCitationByPmid(verify)('not-a-pmid');
    expect(r.status).toBe('invalid_pmid');
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('by-PMID citation satisfies the sanctioned-citation guard', () => {
  const LETTER = [
    'VI. Medical Reasoning',
    'The mechanism is established.',
    '',
    'VIII. References',
    '1. Existing A. A study. J Test. 2010. PMID: 11111111.',
  ].join('\n');

  it('inserting a verified by-PMID citation PASSES diffCitationsSanctioned (it is sanctioned)', async () => {
    const resolve = makeResolveCitationByPmid(stubVerifier({ '31393195': VERIFIED }));
    const r = await resolve('31393195');
    if (r.status !== 'ok') throw new Error('expected ok');
    // Apply inserts the VERIFIED citation (which carries full_citation for house format). The insert
    // adds ONLY the PMID; the sanctioned set is exactly the inserted PMID → the guard permits it.
    const { newText, insertedPmids } = insertVerifiedCitations(LETTER, [{
      pmid: r.candidate.pmid, title: r.candidate.title, journal: r.candidate.journal,
      year: r.candidate.year, killer_finding: r.candidate.killer_finding, full_citation: VERIFIED.full_citation,
    }]);
    expect(insertedPmids).toEqual(['31393195']);
    const diff = diffCitationsSanctioned(LETTER, newText, insertedPmids);
    expect(diff.added).toHaveLength(0); // the by-PMID citation is allowed BECAUSE it was verified
    // House-format §VIII entry, numbered after the existing reference.
    expect(newText).toMatch(/2\. Colvonen PJ, et al\..*PMID: 31393195\./);
  });

  it('the SAME insertion with an EMPTY sanctioned set FAILS the guard (unverified PMID is caught)', async () => {
    const resolve = makeResolveCitationByPmid(stubVerifier({ '31393195': VERIFIED }));
    const r = await resolve('31393195');
    if (r.status !== 'ok') throw new Error('expected ok');
    const { newText } = insertVerifiedCitations(LETTER, [{
      pmid: r.candidate.pmid, title: r.candidate.title, journal: r.candidate.journal,
      year: r.candidate.year, killer_finding: r.candidate.killer_finding, full_citation: VERIFIED.full_citation,
    }]);
    // With NO sanctioned PMIDs, the net-new PMID is treated as fabrication → returned in `added`.
    const diff = diffCitationsSanctioned(LETTER, newText, []);
    expect(diff.added.some((t) => t.key === 'pmid:31393195')).toBe(true);
  });
});
