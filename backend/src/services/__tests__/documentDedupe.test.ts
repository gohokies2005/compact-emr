import { describe, it, expect } from 'vitest';
import { computeDuplicateOf, type DedupeDocInput } from '../documentDedupe.js';

const doc = (id: string, sizeBytesStr: string, leadingText: string, uploadedAt: string, sizeBytesPositive = true): DedupeDocInput =>
  ({ id, sizeBytesStr, sizeBytesPositive, leadingText, uploadedAt: new Date(uploadedAt) });

describe('computeDuplicateOf (byte-identical duplicate badge)', () => {
  it('flags a byte-identical re-upload as a duplicate of the EARLIEST one (Woodley Misc_2==Misc_3)', () => {
    const earlier = doc('A', '1500000', 'VA Blue Button page 1 ...', '2026-06-01T10:00:00Z');
    const later = doc('B', '1500000', 'VA Blue Button page 1 ...', '2026-06-02T10:00:00Z');
    const m = computeDuplicateOf([later, earlier]); // list order shouldn't matter
    expect(m.get('A')).toBeNull();   // earliest = primary
    expect(m.get('B')).toBe('A');    // later flagged as duplicate of A
  });

  it('does NOT flag files with the same size but DIFFERENT leading text', () => {
    const m = computeDuplicateOf([
      doc('A', '1500000', 'Rating decision ...', '2026-06-01T10:00:00Z'),
      doc('B', '1500000', 'Sleep study report ...', '2026-06-02T10:00:00Z'),
    ]);
    expect(m.get('A')).toBeNull();
    expect(m.get('B')).toBeNull();
  });

  it('does NOT flag distinct files of different sizes', () => {
    const m = computeDuplicateOf([
      doc('A', '1500000', 'same text', '2026-06-01T10:00:00Z'),
      doc('B', '1500001', 'same text', '2026-06-02T10:00:00Z'),
    ]);
    expect(m.get('A')).toBeNull();
    expect(m.get('B')).toBeNull();
  });

  it('zero-byte / no-real-bytes docs never participate (no spurious grouping)', () => {
    const m = computeDuplicateOf([
      doc('A', '0', '', '2026-06-01T10:00:00Z', false),
      doc('B', '0', '', '2026-06-02T10:00:00Z', false),
    ]);
    expect(m.get('A')).toBeNull();
    expect(m.get('B')).toBeNull();
  });

  it('three identical copies → the two later ones both point to the earliest primary', () => {
    const m = computeDuplicateOf([
      doc('C', '900', 'x', '2026-06-03T10:00:00Z'),
      doc('A', '900', 'x', '2026-06-01T10:00:00Z'),
      doc('B', '900', 'x', '2026-06-02T10:00:00Z'),
    ]);
    expect(m.get('A')).toBeNull();
    expect(m.get('B')).toBe('A');
    expect(m.get('C')).toBe('A');
  });
});
