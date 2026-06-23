import { describe, it, expect } from 'vitest';
import { detectLetterLeaks, describeLetterLeaks, blockingLeaks } from '../letter-leak-detector.js';

describe('detectLetterLeaks — block content that must never appear in a nexus letter', () => {
  // The 3 real 2026-06-20 leaks (Apolito, Zodrow, Girot).
  it('catches Apolito Section III meta-critique leak', () => {
    const t = 'III. Records Reviewed\nSection III lists records as a single run-on sentence rather than the canonical format. Restructure as a numbered list of discrete record entries.';
    const leaks = detectLetterLeaks(t);
    expect(leaks.map((l) => l.code)).toEqual(expect.arrayContaining(['meta_canonical', 'meta_restructure']));
  });

  it('catches Zodrow Section VII editing-instruction leak', () => {
    const t = "is more likely than not caused by his PTSD. If the canonical Section VII template includes an aggravation prong, retain only the exact canonical language. If 'in the alternative' is not part of the locked template, rewrite as: 'and, should causation not be established...'";
    const leaks = detectLetterLeaks(t);
    expect(leaks.map((l) => l.code)).toEqual(expect.arrayContaining(['meta_canonical', 'meta_locked_template']));
    expect(blockingLeaks(leaks).length).toBeGreaterThan(0); // Zodrow MUST hard-block
  });

  it('does NOT flag an inline PMID at all (removed 2026-06-23 — cosmetic, not worth an alert)', () => {
    const t = 'McNicholas and Pevernagie, in their 2022 Journal of Sleep Research integrative disease model (PMID 35609941), provide the conceptual frame.';
    const leaks = detectLetterLeaks(t);
    expect(leaks.map((l) => l.code)).not.toContain('inline_pmid');
    expect(leaks.map((l) => l.code)).not.toContain('inline_doi');
    expect(blockingLeaks(leaks)).toHaveLength(0); // and certainly never blocks
  });

  it('a Section VIII reference list with PMIDs does NOT block (the regression Ryan hit)', () => {
    const refs = 'VIII. References\n1. Gupta MA. J Clin Sleep Med. 2015. PMID 25845906.\n2. Player MS. Ann Fam Med. 2007. PMID 17389539.';
    expect(blockingLeaks(detectLetterLeaks(refs))).toHaveLength(0);
  });

  it('editorial-meta leaks ARE blocking (canonical/restructure)', () => {
    expect(blockingLeaks(detectLetterLeaks('the canonical format')).length).toBeGreaterThan(0);
    expect(blockingLeaks(detectLetterLeaks('Restructure as a numbered list')).length).toBeGreaterThan(0);
  });

  // meta_canonical TIGHTENING (Ryan 2026-06-23): the bare-word matcher false-positived on legit medical
  // prose. It must fire ONLY in a DIRECTIVE context (canonical naming an editing object), never on ordinary
  // scientific use of "canonical".
  it('meta_canonical does NOT fire on legitimate "canonical mechanism/pathway" medical prose', () => {
    const proseSamples = [
      'The canonical mechanism by which obstructive sleep apnea aggravates hypertension is well established.',
      'This follows the canonical pathway of sympathetic activation described in the literature.',
      'Tinnitus has a canonical presentation that fits the in-service noise exposure.',
      'The canonical understanding of PTSD-related sleep disruption supports the secondary theory.',
    ];
    for (const t of proseSamples) {
      expect(detectLetterLeaks(t).map((l) => l.code)).not.toContain('meta_canonical');
      expect(detectLetterLeaks(t)).toHaveLength(0); // and nothing else false-fires on clean prose
    }
  });

  it('meta_canonical DOES fire on a real directive leak (canonical format/template/language)', () => {
    expect(detectLetterLeaks('rather than the canonical format').map((l) => l.code)).toContain('meta_canonical');
    expect(detectLetterLeaks('If the canonical Section VII template includes an aggravation prong').map((l) => l.code)).toContain('meta_canonical');
    expect(detectLetterLeaks('retain only the exact canonical language').map((l) => l.code)).toContain('meta_canonical');
  });

  // MUST NOT false-positive on legitimate nexus-letter language.
  it('does NOT flag the legitimate Section VII "in the alternative" dual-prong language', () => {
    const t = 'It is my opinion that the OSA is due to his PTSD and, in the alternative, is aggravated beyond its natural progression by that service-connected condition pursuant to 38 CFR 3.310(b).';
    expect(detectLetterLeaks(t)).toHaveLength(0);
  });

  it('does NOT flag a clean prose Section III', () => {
    const t = 'III. Records Reviewed\nI reviewed the veteran\'s DD-214, the home sleep apnea test of October 4, 2024 interpreted by Dr. Geil, and the June 25, 2024 sinus CT.';
    expect(detectLetterLeaks(t)).toHaveLength(0);
  });

  it('does NOT flag normal Section VI medical prose (author/journal/year citation, no PMID)', () => {
    const t = 'McNicholas and Pevernagie (2022, Journal of Sleep Research) describe a bidirectional integrative disease model in which comorbid conditions worsen obstructive sleep apnea.';
    expect(detectLetterLeaks(t)).toHaveLength(0);
  });

  it('clean letter → empty + empty description', () => {
    const leaks = detectLetterLeaks('A wholly clean letter with no forbidden content.');
    expect(leaks).toHaveLength(0);
    expect(describeLetterLeaks(leaks)).toBe('');
  });

  it('describeLetterLeaks names the leaks for the RN block message', () => {
    const d = describeLetterLeaks(detectLetterLeaks('the canonical format'));
    expect(d).toContain('blocked from delivery');
    expect(d.toLowerCase()).toContain('canonical');
  });
});
