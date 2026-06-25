import { describe, expect, it, vi } from 'vitest';
import { pickDisplayName, resolveActorNames } from '../services/actor-name-resolver.js';
import type { AppDb } from '../services/db-types.js';

const empty = { users: new Map(), physicians: new Map() } as const;

describe('pickDisplayName (pure formatter)', () => {
  it('prefers the physician fullName when the sub is a physician', () => {
    const sources = { users: new Map(), physicians: new Map([['DR', 'Dr. Pat Healer']]) };
    expect(pickDisplayName('DR', sources)).toBe('Dr. Pat Healer');
  });

  it('uses the app_user name when present', () => {
    const sources = { users: new Map([['U', { name: 'Nina RN', email: 'n@x' }]]), physicians: new Map() };
    expect(pickDisplayName('U', sources)).toBe('Nina RN');
  });

  it('falls back to the app_user email when there is no name', () => {
    const sources = { users: new Map([['U', { name: null, email: 'n@x' }]]), physicians: new Map() };
    expect(pickDisplayName('U', sources)).toBe('n@x');
  });

  it('returns "Staff" for an unknown sub — NEVER the raw id', () => {
    expect(pickDisplayName('deadbeef-uuid', empty)).toBe('Staff');
    expect(pickDisplayName('deadbeef-uuid', empty)).not.toContain('deadbeef');
  });

  it('returns "Staff" for null/empty/whitespace subs', () => {
    expect(pickDisplayName(null, empty)).toBe('Staff');
    expect(pickDisplayName(undefined, empty)).toBe('Staff');
    expect(pickDisplayName('   ', empty)).toBe('Staff');
  });

  it('returns "System" for a system-stamped sub', () => {
    expect(pickDisplayName('system', empty)).toBe('System');
    expect(pickDisplayName('SYSTEM', empty)).toBe('System');
  });

  it('prefers physician over a (rare) same-sub app_user collision', () => {
    const sources = { users: new Map([['X', { name: 'Ops Name', email: 'o@x' }]]), physicians: new Map([['X', 'Dr. X']]) };
    expect(pickDisplayName('X', sources)).toBe('Dr. X');
  });
});

describe('resolveActorNames (batch DB resolution)', () => {
  function makeDb(users: Array<{ cognitoSub: string; name: string | null; email: string }>, physicians: Array<{ cognitoSub: string | null; fullName: string }>): AppDb {
    return {
      appUser: { findMany: vi.fn(async (a: { where?: { cognitoSub?: { in?: string[] } } }) => {
        const w = a.where?.cognitoSub?.in ?? [];
        return users.filter((u) => w.includes(u.cognitoSub));
      }) },
      physician: { findMany: vi.fn(async (a: { where?: { cognitoSub?: { in?: string[] } } }) => {
        const w = a.where?.cognitoSub?.in ?? [];
        return physicians.filter((p) => p.cognitoSub !== null && w.includes(p.cognitoSub));
      }) },
    } as unknown as AppDb;
  }

  it('resolves both staff and physician subs in one batch and falls back to "Staff" for unknowns', async () => {
    const db = makeDb(
      [{ cognitoSub: 'RN', name: 'Nina RN', email: 'rn@x' }],
      [{ cognitoSub: 'DR', fullName: 'Dr. Pat Healer' }],
    );
    const map = await resolveActorNames(db, ['RN', 'DR', 'ghost']);
    expect(map.get('RN')).toBe('Nina RN');
    expect(map.get('DR')).toBe('Dr. Pat Healer');
    expect(map.get('ghost')).toBe('Staff');
  });

  it('dedups subs and skips empty/system inputs without querying for them', async () => {
    const appFindMany = vi.fn(async () => []);
    const physFindMany = vi.fn(async () => []);
    const db = { appUser: { findMany: appFindMany }, physician: { findMany: physFindMany } } as unknown as AppDb;
    await resolveActorNames(db, ['RN', 'RN', '', null, 'system']);
    // One query each, asking only for the single distinct real sub.
    expect(appFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { cognitoSub: { in: ['RN'] } } }));
    expect(physFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { cognitoSub: { in: ['RN'] } } }));
  });

  it('returns an empty map (no DB calls) when there are no resolvable subs', async () => {
    const appFindMany = vi.fn(async () => []);
    const physFindMany = vi.fn(async () => []);
    const db = { appUser: { findMany: appFindMany }, physician: { findMany: physFindMany } } as unknown as AppDb;
    const map = await resolveActorNames(db, ['', null, 'system']);
    expect(map.size).toBe(0);
    expect(appFindMany).not.toHaveBeenCalled();
    expect(physFindMany).not.toHaveBeenCalled();
  });
});
