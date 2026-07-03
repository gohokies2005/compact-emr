import { describe, it, expect } from 'vitest';
import { diffLetters, splitUnits, diffUnits } from './letter-change-diff.js';

describe('splitUnits', () => {
  it('splits into sentences and drops blank lines', () => {
    expect(splitUnits('First sentence. Second one!\n\nThird?')).toEqual([
      'First sentence.',
      'Second one!',
      'Third?',
    ]);
  });
  it('keeps a terminator-less line as one unit', () => {
    expect(splitUnits('RE: Independent Medical Opinion')).toEqual(['RE: Independent Medical Opinion']);
  });
});

describe('diffLetters', () => {
  it('identical text → no change', () => {
    const t = 'The veteran served in the Navy. He was exposed to noise. Tinnitus followed.';
    const d = diffLetters(t, t);
    expect(d.changed).toBe(false);
    expect(d.addedCount).toBe(0);
    expect(d.removedCount).toBe(0);
    expect(d.segments.every((s) => s.kind === 'unchanged')).toBe(true);
  });

  it('added sentence → one addition, order preserved', () => {
    const oldT = 'The veteran served in the Navy. Tinnitus followed.';
    const newT =
      'The veteran served in the Navy. His loud snoring was corroborated by fellow servicemembers. Tinnitus followed.';
    const d = diffLetters(oldT, newT);
    expect(d.changed).toBe(true);
    expect(d.addedCount).toBe(1);
    expect(d.removedCount).toBe(0);
    const added = d.segments.filter((s) => s.kind === 'added');
    expect(added).toHaveLength(1);
    expect(added[0]!.text).toContain('corroborated by fellow servicemembers');
    // the surrounding sentences stay unchanged and in order
    const kinds = d.segments.map((s) => s.kind);
    expect(kinds).toEqual(['unchanged', 'added', 'unchanged']);
  });

  it('removed sentence → one removal', () => {
    const oldT = 'One. Two. Three.';
    const newT = 'One. Three.';
    const d = diffLetters(oldT, newT);
    expect(d.addedCount).toBe(0);
    expect(d.removedCount).toBe(1);
    expect(d.segments.find((s) => s.kind === 'removed')!.text).toBe('Two.');
  });

  it('reworded sentence → removed old + added new (both surfaced)', () => {
    const oldT = 'Snoring was noted. Diagnosis confirmed.';
    const newT = 'Snoring was corroborated by his spouse and a buddy statement. Diagnosis confirmed.';
    const d = diffLetters(oldT, newT);
    expect(d.addedCount).toBe(1);
    expect(d.removedCount).toBe(1);
    expect(d.segments.find((s) => s.kind === 'removed')!.text).toBe('Snoring was noted.');
    expect(d.segments.find((s) => s.kind === 'added')!.text).toContain('buddy statement');
    // the unchanged tail is still aligned
    expect(d.segments.some((s) => s.kind === 'unchanged' && s.text === 'Diagnosis confirmed.')).toBe(true);
  });

  it('whitespace / re-wrap only → NOT flagged as a change', () => {
    const oldT = 'The veteran served honorably.   Tinnitus followed.';
    const newT = 'The veteran served honorably.\nTinnitus followed.';
    const d = diffLetters(oldT, newT);
    expect(d.changed).toBe(false);
  });

  it('a real case change IS flagged (not lowercased away)', () => {
    const d = diffLetters('the va conceded exposure.', 'The VA conceded exposure.');
    expect(d.changed).toBe(true);
  });

  it('empty baseline → everything added', () => {
    const d = diffLetters('', 'Alpha. Beta.');
    expect(d.removedCount).toBe(0);
    expect(d.addedCount).toBe(2);
    expect(d.changed).toBe(true);
  });

  it('is deterministic (same inputs → identical segments)', () => {
    const oldT = 'A. B. C. D.';
    const newT = 'A. X. C. D. E.';
    expect(diffLetters(oldT, newT)).toEqual(diffLetters(oldT, newT));
  });
});

describe('diffUnits pathological guard', () => {
  it('handles oversized input without building a giant DP table', () => {
    const big = Array.from({ length: 2100 }, (_, k) => `s${k}`);
    const out = diffUnits(big, []);
    expect(out).toHaveLength(2100);
    expect(out.every((s) => s.kind === 'removed')).toBe(true);
  });
});
