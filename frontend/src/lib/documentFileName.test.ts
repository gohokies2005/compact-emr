import { describe, expect, it } from 'vitest';
import { documentFileName } from './documentFileName';

describe('documentFileName', () => {
  it('strips the directory and the uuid- prefix from a minted s3 key', () => {
    expect(documentFileName('cases/CLM-1/123e4567-e89b-42d3-a456-426614174000-Sleep_Study.pdf')).toBe('Sleep_Study.pdf');
  });

  it('is idempotent on an already-stripped name', () => {
    expect(documentFileName('Sleep_Study.pdf')).toBe('Sleep_Study.pdf');
  });

  it('falls back to the basename for legacy keys without a uuid prefix', () => {
    expect(documentFileName('records/garbled_scan.pdf')).toBe('garbled_scan.pdf');
  });

  it('does not strip non-uuid leading segments (a real filename starting with hex-ish text survives)', () => {
    expect(documentFileName('cases/CLM-1/decade-old-records.pdf')).toBe('decade-old-records.pdf');
  });
});
