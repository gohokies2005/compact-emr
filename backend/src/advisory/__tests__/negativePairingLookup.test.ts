import { describe, it, expect } from 'vitest';
import {
  lookupNegativePairing,
  lookupNegativePairings,
  formatNegativePairingBlock,
} from '../negativePairingLookup.js';
import { NEGATIVE_PAIRINGS } from '../negativePairings.generated.js';
import { answerQuestion, type AnswerDeps } from '../advisoryAnswer.js';
import { stubRetrieve } from '../retrieveContract.js';

describe('negative pairings — generated const integrity', () => {
  it('carries the 5 curated entries, each with upstream+claimed+reason+counterargument+PMIDs', () => {
    expect(NEGATIVE_PAIRINGS.length).toBe(5);
    for (const p of NEGATIVE_PAIRINGS) {
      expect(p.upstream.length).toBeGreaterThan(0);
      expect(p.claimed.length).toBeGreaterThan(0);
      expect(p.reason.length).toBeGreaterThan(0);
      expect(p.counterargument.length).toBeGreaterThan(0);
      expect(p.pmids.length).toBeGreaterThanOrEqual(1);
      for (const pmid of p.pmids) expect(pmid).toMatch(/^\d{4,9}$/);
      expect(p.verdict).toBe('not_supportable');
    }
  });
  it('reason field is clean (no leftover bold markers)', () => {
    for (const p of NEGATIVE_PAIRINGS) {
      expect(p.reason.startsWith('*')).toBe(false);
      expect(p.counterargument.startsWith('*')).toBe(false);
    }
  });
});

describe('lookupNegativePairing — direction + aliases + fail-open', () => {
  it('MATCHES the authored negative direction (claimed secondary-to upstream)', () => {
    expect(lookupNegativePairing('obstructive sleep apnea', 'tinnitus')).not.toBeNull();
    expect(lookupNegativePairing('obstructive sleep apnea', 'migraine')).not.toBeNull();
    expect(lookupNegativePairing('hypertension', 'ischemic heart disease')).not.toBeNull();
    expect(lookupNegativePairing('GERD', 'obstructive sleep apnea')?.caution).toBe(true);
    expect(lookupNegativePairing('migraine', 'tinnitus')).not.toBeNull();
  });
  it('is alias-aware via precomputed variants', () => {
    // "ringing in ears" is a stored tinnitus variant; "coronary artery disease" an IHD variant.
    expect(lookupNegativePairing('obstructive sleep apnea', 'ringing in ears')).not.toBeNull();
    expect(lookupNegativePairing('high blood pressure', 'coronary artery disease')).not.toBeNull();
  });
  it('does NOT block the VIABLE reverse direction (doc rule)', () => {
    expect(lookupNegativePairing('tinnitus', 'obstructive sleep apnea')).toBeNull();
    expect(lookupNegativePairing('ischemic heart disease', 'hypertension')).toBeNull();
    expect(lookupNegativePairing('tinnitus', 'migraine')).toBeNull();
  });
  it('returns null for unrelated / genuinely-viable pairings', () => {
    expect(lookupNegativePairing('obstructive sleep apnea', 'PTSD')).toBeNull();
    expect(lookupNegativePairing('knee osteoarthritis', 'lumbar spine')).toBeNull();
  });
  it('fail-open on empty / null inputs (never throws)', () => {
    expect(lookupNegativePairing('obstructive sleep apnea', '')).toBeNull();
    expect(lookupNegativePairing('', 'tinnitus')).toBeNull();
    expect(lookupNegativePairing(null, null)).toBeNull();
    expect(lookupNegativePairing(undefined, undefined)).toBeNull();
  });
});

describe('lookupNegativePairings — multi-upstream, deduped', () => {
  it('collects one record per matched upstream, skips non-matches', () => {
    const recs = lookupNegativePairings('obstructive sleep apnea', ['tinnitus', 'migraine', 'PTSD', 'obesity']);
    expect(recs.length).toBe(2); // tinnitus + migraine hit; PTSD/obesity (viable) do not
  });
  it('dedupes duplicate upstreams', () => {
    const recs = lookupNegativePairings('obstructive sleep apnea', ['tinnitus', 'tinnitus']);
    expect(recs.length).toBe(1);
  });
  it('empty upstream list -> []', () => {
    expect(lookupNegativePairings('obstructive sleep apnea', [])).toEqual([]);
  });
});

describe('formatNegativePairingBlock — recommendation-only, internal-strategy labeled', () => {
  it('returns null when nothing matched', () => {
    expect(formatNegativePairingBlock([])).toBeNull();
  });
  it('formats a self-describing, non-blocking advisory block with reason + counterargument + PMIDs', () => {
    const rec = lookupNegativePairing('obstructive sleep apnea', 'tinnitus')!;
    const block = formatNegativePairingBlock([rec])!;
    expect(block).toContain('NEGATIVE PAIRING PRE-CHECK');
    expect(block).toContain('NOT SUPPORTABLE');
    expect(block).toMatch(/NEVER a hard block|never a hard block/i);
    expect(block).toContain(rec.reason.slice(0, 20));
    expect(block).toContain(rec.pmids[0]);
    // internal-strategy discipline: the block warns the PMIDs are not for the letter
    expect(block).toMatch(/do not quote|INTERNAL/i);
  });
  it('marks the weak/caution class', () => {
    const rec = lookupNegativePairing('GERD', 'obstructive sleep apnea')!;
    const block = formatNegativePairingBlock([rec])!;
    expect(block).toMatch(/caution/i);
  });
});

describe('advisoryAnswer wiring — negativePairingBlock is prepended, recommendation-only', () => {
  const baseDeps = (capture: { userContent?: string }): AnswerDeps => ({
    retrieve: stubRetrieve,
    buildChartSlice: async () => ({ found: true, text: 'Claim: OSA', claimedCondition: 'OSA', conditions: ['OSA'] }),
    invoke: async (_s: string, u: string) => { capture.userContent = u; return { text: 'ANSWER', costUsd: 0.01, stopReason: 'end_turn', usage: {} }; },
    systemPrompt: 'SYS',
  });

  it('prepends the negative-pairing block above the corpus when present', async () => {
    const cap: { userContent?: string } = {};
    const block = formatNegativePairingBlock([lookupNegativePairing('obstructive sleep apnea', 'tinnitus')!])!;
    const out = await answerQuestion(baseDeps(cap), {
      caseId: 'c1',
      question: 'is OSA secondary to tinnitus viable?',
      negativePairingBlock: block,
    });
    expect(out.ok).toBe(true);
    expect(cap.userContent).toBeDefined();
    // block appears, and BEFORE the reference material
    expect(cap.userContent!.indexOf('NEGATIVE PAIRING PRE-CHECK')).toBeGreaterThanOrEqual(0);
    expect(cap.userContent!.indexOf('NEGATIVE PAIRING PRE-CHECK'))
      .toBeLessThan(cap.userContent!.indexOf('REFERENCE MATERIAL'));
  });

  it('is inert when absent (today\'s behavior — no block in the prompt)', async () => {
    const cap: { userContent?: string } = {};
    const out = await answerQuestion(baseDeps(cap), { caseId: 'c1', question: 'anything', negativePairingBlock: null });
    expect(out.ok).toBe(true);
    expect(cap.userContent!.includes('NEGATIVE PAIRING PRE-CHECK')).toBe(false);
  });
});
