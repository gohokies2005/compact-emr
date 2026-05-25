import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from '../lib/date';

describe('formatRelativeTime', () => {
  it('formats a recent past time in hours', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(threeHoursAgo)).toBe('3 hours ago');
  });

  it('formats a future time', () => {
    const inTwoDays = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(inTwoDays)).toBe('in 2 days');
  });

  it('returns empty string for an unparseable input', () => {
    expect(formatRelativeTime('not-a-date')).toBe('');
  });
});
