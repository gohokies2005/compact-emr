import { describe, expect, it } from 'vitest';
import { resolveViewableLetterJob, type ViewableLetterJobLike } from './viewableLetter';

// CLM-A158C00C07 (Michael Dick, 2026-06-29): a Gate-2 dx-verification halt fired PRE-DRAFT — NO letter
// artifact was rendered (null artifact keys, currentVersion=0, empty S3 prefix). The OLD predicate
// (`hasPdfKey || state==='done' || state==='failed'`) matched the terminal halt job on STATE ALONE, so
// the claim page advertised View-PDF / Open-editor / Send-to-doctor affordances that 404'd against
// GET /cases/:id/letter (resolveCurrentForRead(0) → null). A letter is "viewable" ONLY when a real,
// resolvable artifact exists: a present .pdf key OR currentVersion >= 1.

function job(over: Partial<ViewableLetterJobLike> & { version: number }): ViewableLetterJobLike {
  return { state: 'done', ...over };
}

describe('resolveViewableLetterJob', () => {
  // ── THE BUG (RED on the old state-only predicate) ──────────────────────────────────────────────
  it('pre-draft halt: terminal job, NO artifact key, currentVersion=0 → NOT viewable', () => {
    // Dick: a 'done'/'failed' halt job with null keys and a v0 pointer must NOT be served as a letter.
    expect(resolveViewableLetterJob([job({ version: 1, state: 'done' })], 0)).toBeUndefined();
    expect(resolveViewableLetterJob([job({ version: 1, state: 'failed' })], 0)).toBeUndefined();
    expect(resolveViewableLetterJob([job({ version: 1, state: 'done', artifactPdfS3Key: null })], 0)).toBeUndefined();
  });

  // ── GREEN: the legit halt-with-letter path stays unchanged ─────────────────────────────────────
  it('halt-with-letter: terminal job, no PDF key but currentVersion >= 1 → viewable (txt resolves)', () => {
    // Task #96: /halt persists artifactTxtS3Key + advances currentVersion. The PDF key may be absent
    // (halt happened before PDF render) — the v>=1 pointer still resolves the txt for the editor.
    const j = job({ version: 3, state: 'done' });
    expect(resolveViewableLetterJob([j], 3)).toBe(j);
  });

  it('a real .pdf artifact key makes the job viewable regardless of currentVersion', () => {
    const j = job({ version: 2, state: 'done', artifactPdfS3Key: 'drafter-artifacts/CASE/v2/v2.pdf' });
    // even at the v0 pointer, a present openable PDF is a real artifact (S3-truth recovery serves it).
    expect(resolveViewableLetterJob([j], 0)).toBe(j);
  });

  it('stuck-watcher race: failed job, key lost, but currentVersion advanced → still viewable', () => {
    const j = job({ version: 5, state: 'failed', artifactPdfS3Key: null });
    expect(resolveViewableLetterJob([j], 5)).toBe(j);
  });

  // ── invariants preserved from the prior inline predicate ───────────────────────────────────────
  it('skips a DB-corrupt non-.pdf key in the PDF field and keeps scanning', () => {
    const corrupt = job({ version: 3, state: 'done', artifactPdfS3Key: 'drafter-artifacts/CASE/v3/v3.txt' });
    const clean = job({ version: 2, state: 'done', artifactPdfS3Key: 'drafter-artifacts/CASE/v2/v2.pdf' });
    // version-desc input; the corrupt v3 is skipped, the clean v2 wins.
    expect(resolveViewableLetterJob([corrupt, clean], 3)).toBe(clean);
  });

  it('returns the NEWEST viewable job (version-desc input, first match wins)', () => {
    const newest = job({ version: 7, state: 'done' });
    const older = job({ version: 6, state: 'done' });
    expect(resolveViewableLetterJob([newest, older], 7)).toBe(newest);
  });

  it('an in-flight (queued/running) job with no key and v0 is NOT viewable', () => {
    expect(resolveViewableLetterJob([job({ version: 1, state: 'queued' })], 0)).toBeUndefined();
    expect(resolveViewableLetterJob([job({ version: 1, state: 'running' })], 1)).toBeUndefined();
  });

  it('handles empty / undefined inputs', () => {
    expect(resolveViewableLetterJob([], 1)).toBeUndefined();
    expect(resolveViewableLetterJob(undefined, 1)).toBeUndefined();
    expect(resolveViewableLetterJob([job({ version: 1 })], null)).toBeUndefined();
    expect(resolveViewableLetterJob([job({ version: 1 })], undefined)).toBeUndefined();
  });
});
