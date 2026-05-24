import { describe, expect, it } from 'vitest';
import { incrementVersion, OptimisticLockError } from '../db/optimistic-locking.js';

describe('optimistic locking', () => {
  it('increments version when the expected version matches', () => {
    expect(incrementVersion({ version: 3, name: 'record' }, 3)).toMatchObject({ version: 4, name: 'record' });
  });

  it('throws when the expected version is stale', () => {
    expect(() => incrementVersion({ version: 4 }, 3)).toThrow(OptimisticLockError);
  });
});
