import { describe, expect, it } from 'vitest';
import { formatDateOnly, formatPhone } from '../lib/format';

describe('formatDateOnly', () => {
  it('trims a full ISO datetime to the date portion', () => {
    expect(formatDateOnly('1997-09-02T00:00:00.000Z')).toBe('1997-09-02');
  });
  it('passes through an already date-only value', () => {
    expect(formatDateOnly('1997-09-02')).toBe('1997-09-02');
  });
  it('returns a non-date string unchanged', () => {
    expect(formatDateOnly('unknown')).toBe('unknown');
  });
  it('returns empty string for null/undefined', () => {
    expect(formatDateOnly(null)).toBe('');
    expect(formatDateOnly(undefined)).toBe('');
  });
});

describe('formatPhone', () => {
  it('formats a bare 10-digit US number', () => {
    expect(formatPhone('4088871744')).toBe('(408) 887-1744');
  });
  it('formats an 11-digit number with leading 1', () => {
    expect(formatPhone('14088871744')).toBe('(408) 887-1744');
  });
  it('formats a +1-prefixed number', () => {
    expect(formatPhone('+1 (408) 887-1744')).toBe('(408) 887-1744');
  });
  it('returns a non-10-digit value unchanged', () => {
    expect(formatPhone('911')).toBe('911');
    expect(formatPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
  });
  it('returns empty string for null/undefined', () => {
    expect(formatPhone(null)).toBe('');
    expect(formatPhone(undefined)).toBe('');
  });
});
