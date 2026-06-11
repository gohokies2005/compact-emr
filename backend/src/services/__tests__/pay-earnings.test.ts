/**
 * Doctor-pay ADVERSARIAL TEST MATRIX (docs/DOCTOR_PAY_BUILD_PLAN_2026-06-11.md §7).
 * Pure-function tests against pay-earnings.ts — no DB, no routes. Every scenario letter below
 * maps to the plan's matrix. ACCURACY-CRITICAL: these encode the rules Ryan's checks are cut by.
 *
 * Timezone facts used (America/Los_Angeles, 2026): PST = UTC-8 through Mar 8; PDT = UTC-7
 * Mar 8 – Nov 1; PST again after Nov 1. All test instants are constructed as explicit UTC (Z)
 * strings so the suite is machine-timezone-independent (the engine pins PAY_TIMEZONE via Intl).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAY_RATES,
  belongsToPhysician,
  computeEarnings,
  enumerateMonthsSince,
  isValidMonthKey,
  pacificMonthStartUtc,
  pacificMonthWindowUtc,
  pacificYearMonth,
  resolveRateCents,
  type CompletionRow,
  type PayRateEntry,
} from '../pay-earnings.js';

function row(over: Partial<CompletionRow> = {}): CompletionRow {
  return {
    caseId: 'CASE-1',
    version: 2,
    createdAt: new Date('2026-01-10T20:00:00Z'),
    letterType: 'nexus_letter',
    payCents: 10000,
    signingPhysicianId: 'PHYS-X',
    caseAssignedPhysicianId: 'PHYS-X',
    veteranName: 'Robert Testcase',
    claimedCondition: 'Lumbosacral strain',
    ...over,
  };
}

describe('Pacific month bucketing (matrix A/B/B2 — the UTC trap)', () => {
  it('A: Jan 31 23:59 PT (= Feb 1 07:59 UTC) lands in January', () => {
    expect(pacificYearMonth(new Date('2026-02-01T07:59:00Z'))).toBe('2026-01');
  });

  it('B: Feb 1 00:01 PT (= Feb 1 08:01 UTC) lands in February, not January', () => {
    expect(pacificYearMonth(new Date('2026-02-01T08:01:00Z'))).toBe('2026-02');
  });

  it('B2: Jan 31 18:00 PT (= Feb 1 02:00 UTC — UTC date already February) lands in January', () => {
    // The regression guard against copying reports.ts UTC bucketing (plan §3.4).
    expect(pacificYearMonth(new Date('2026-02-01T02:00:00Z'))).toBe('2026-01');
  });

  it('computeEarnings buckets the boundary rows into the correct PT months', () => {
    const { months, all } = computeEarnings([
      row({ caseId: 'C-A', createdAt: new Date('2026-02-01T07:59:00Z') }), // Jan 31 23:59 PT
      row({ caseId: 'C-B', createdAt: new Date('2026-02-01T08:01:00Z') }), // Feb 1 00:01 PT
      row({ caseId: 'C-B2', createdAt: new Date('2026-02-01T02:00:00Z') }), // Jan 31 18:00 PT
    ]);
    const jan = months.find((m) => m.monthPT === '2026-01');
    const feb = months.find((m) => m.monthPT === '2026-02');
    expect(jan?.rows.map((r) => r.caseId).sort()).toEqual(['C-A', 'C-B2']);
    expect(jan?.totalCents).toBe(20000);
    expect(feb?.rows.map((r) => r.caseId)).toEqual(['C-B']);
    expect(feb?.totalCents).toBe(10000);
    expect(all.totalCents).toBe(30000);
  });

  it('month UTC windows are PT-anchored and DST-correct (PST -8 / PDT -7)', () => {
    // January (PST both edges).
    expect(pacificMonthWindowUtc('2026-01')).toEqual({
      gte: new Date('2026-01-01T08:00:00Z'),
      lt: new Date('2026-02-01T08:00:00Z'),
    });
    // March: starts PST (-8), ends after spring-forward → April starts PDT (-7).
    expect(pacificMonthWindowUtc('2026-03')).toEqual({
      gte: new Date('2026-03-01T08:00:00Z'),
      lt: new Date('2026-04-01T07:00:00Z'),
    });
    // November: starts PDT (-7; fall-back happens 2 a.m. Nov 1, after midnight), ends PST (-8).
    expect(pacificMonthWindowUtc('2026-11')).toEqual({
      gte: new Date('2026-11-01T07:00:00Z'),
      lt: new Date('2026-12-01T08:00:00Z'),
    });
    // Month-13 overflow arithmetic → January next year.
    expect(pacificMonthStartUtc(2026, 13)).toEqual(new Date('2027-01-01T08:00:00Z'));
  });

  it('rejects malformed month keys', () => {
    expect(isValidMonthKey('2026-06')).toBe(true);
    for (const bad of ['2026-13', '2026-0', '2026-00', '202606', 'all', 'June 2026']) {
      expect(isValidMonthKey(bad)).toBe(false);
    }
    expect(() => pacificMonthWindowUtc('2026-13')).toThrow();
  });
});

describe('first-approval-wins dedup (matrix C/D/H — re-approval NEVER re-pays)', () => {
  it('C: two approved_final rows for one payKey (v3 Jan 10, v5 Jan 20) pay ONCE, $100, in January', () => {
    const { months, all } = computeEarnings([
      row({ version: 3, createdAt: new Date('2026-01-10T20:00:00Z') }),
      row({ version: 5, createdAt: new Date('2026-01-20T20:00:00Z') }),
    ]);
    expect(all.rows).toHaveLength(1);
    expect(all.totalCents).toBe(10000); // NOT 20000
    expect(months).toHaveLength(1);
    expect(months[0]!.monthPT).toBe('2026-01');
    expect(all.rows[0]!.firstApprovedAt).toBe('2026-01-10T20:00:00.000Z');
  });

  it('C (cross-month): first approved Jan 28, correction re-approved Feb 10 → pays in January ONLY; February adds $0', () => {
    const { months, all } = computeEarnings([
      row({ version: 3, createdAt: new Date('2026-01-28T20:00:00Z') }),
      row({ version: 6, createdAt: new Date('2026-02-10T20:00:00Z') }),
    ]);
    expect(all.totalCents).toBe(10000);
    expect(months.map((m) => m.monthPT)).toEqual(['2026-01']); // no February bucket at all
    // Ryan's Feb-1 January run already showed this unit; the Feb re-approval moved nothing.
  });

  it('C (value freeze): the unit is valued by its FIRST row even if a later row carries different payCents', () => {
    const { all } = computeEarnings([
      row({ version: 3, createdAt: new Date('2026-01-10T20:00:00Z'), payCents: 10000 }),
      row({ version: 5, createdAt: new Date('2026-03-20T19:00:00Z'), payCents: 12500 }), // post-raise re-approval
    ]);
    expect(all.totalCents).toBe(10000);
  });

  it('D: an editor-save/re-sign cycle ending in ONE approved_final pays $100 once (non-approved sources never enter the engine)', () => {
    // CompletionRow is BY CONTRACT only approved_final rows — the route's where clause enforces
    // source='approved_final' (asserted in pay-routes.test.ts). The v43-style edit storm
    // therefore reduces to its single approved_final row here.
    const { all } = computeEarnings([row({ version: 45 })]);
    expect(all.totalCents).toBe(10000);
    expect(all.rows).toHaveLength(1);
  });

  it('H: two nexus_memo approved_final rows on one case dedup to ONE $50 unit', () => {
    const { all } = computeEarnings([
      row({ letterType: 'nexus_memo', payCents: 5000, version: 7, createdAt: new Date('2026-01-12T20:00:00Z') }),
      row({ letterType: 'nexus_memo', payCents: 5000, version: 9, createdAt: new Date('2026-01-19T20:00:00Z') }),
    ]);
    expect(all.rows).toHaveLength(1);
    expect(all.totalCents).toBe(5000);
  });

  it('equal-timestamp tie breaks to the LOWEST version (deterministic)', () => {
    const t = new Date('2026-01-10T20:00:00Z');
    const { all } = computeEarnings([
      row({ version: 5, createdAt: t, payCents: 11111 }),
      row({ version: 3, createdAt: t, payCents: 10000 }),
    ]);
    expect(all.rows).toHaveLength(1);
    expect(all.totalCents).toBe(10000);
  });
});

describe('pay-unit multiplicity (matrix E/F/G/N)', () => {
  it('E: two DIFFERENT cases for the same veteran pay TWICE ($200, two rows)', () => {
    const { all } = computeEarnings([
      row({ caseId: 'CASE-1', claimedCondition: 'Lumbosacral strain' }),
      row({ caseId: 'CASE-2', claimedCondition: 'Tinnitus', createdAt: new Date('2026-01-15T20:00:00Z') }),
    ]);
    expect(all.rows).toHaveLength(2);
    expect(all.totalCents).toBe(20000);
  });

  it('F: memo + letter on the SAME claim = $150, two rows, same veteran/condition', () => {
    const { all } = computeEarnings([
      row({ letterType: 'nexus_letter', payCents: 10000 }),
      row({ letterType: 'nexus_memo', payCents: 5000, version: 4, createdAt: new Date('2026-01-22T20:00:00Z') }),
    ]);
    expect(all.rows).toHaveLength(2);
    expect(all.totalCents).toBe(15000);
    expect(new Set(all.rows.map((r) => r.veteranName)).size).toBe(1);
  });

  it('G: memo alone = $50, one row (null payCents resolves via the rate config)', () => {
    const { all } = computeEarnings([row({ letterType: 'nexus_memo', payCents: null })]);
    expect(all.rows).toHaveLength(1);
    expect(all.totalCents).toBe(5000);
    expect(all.rows[0]!.payUsd).toBe(50);
  });

  it('N: a clustered multi-condition claim is still ONE case = ONE $100 unit showing the primary condition', () => {
    // claimedConditions=[a,b,c] are argued in ONE letter → one approved_final → one unit.
    const { all } = computeEarnings([row({ claimedCondition: 'GERD (primary of clustered claim)' })]);
    expect(all.rows).toHaveLength(1);
    expect(all.totalCents).toBe(10000);
    expect(all.rows[0]!.condition).toBe('GERD (primary of clustered claim)');
  });
});

describe('zero month + All===sum invariant (matrix Z/I)', () => {
  it('Z: no completions → empty months, $0 all, no NaN', () => {
    const { months, all } = computeEarnings([]);
    expect(months).toEqual([]);
    expect(all.rows).toEqual([]);
    expect(all.totalCents).toBe(0);
    expect(all.totalUsd).toBe(0);
    expect(Number.isNaN(all.totalUsd)).toBe(false);
  });

  it('I (fixed): Jan $200 + Feb $50 → All = $250 exactly', () => {
    const { months, all } = computeEarnings([
      row({ caseId: 'C1', createdAt: new Date('2026-01-10T20:00:00Z') }),
      row({ caseId: 'C2', createdAt: new Date('2026-01-20T20:00:00Z') }),
      row({ caseId: 'C3', letterType: 'nexus_memo', payCents: 5000, createdAt: new Date('2026-02-10T20:00:00Z') }),
    ]);
    expect(all.totalCents).toBe(25000);
    expect(months.reduce((s, m) => s + m.totalCents, 0)).toBe(25000);
    expect(months.map((m) => m.monthPT)).toEqual(['2026-02', '2026-01']); // descending
  });

  it('I (property): for randomized row sets, all.totalCents === sum(months) and unit count === distinct payKeys', () => {
    // Deterministic LCG so failures reproduce.
    let seed = 1234567;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let trial = 0; trial < 25; trial++) {
      const rows: CompletionRow[] = [];
      const n = 1 + Math.floor(rand() * 40);
      for (let i = 0; i < n; i++) {
        const caseId = `CASE-${1 + Math.floor(rand() * 8)}`;
        const letterType = rand() < 0.3 ? 'nexus_memo' : 'nexus_letter';
        // Random instants across 2025-12 .. 2026-11 including DST months and month edges.
        const t = Date.UTC(2025, 11, 1) + Math.floor(rand() * 350 * 24 * 3600 * 1000);
        const payCents = rand() < 0.25 ? null : letterType === 'nexus_memo' ? 5000 : 10000;
        rows.push(row({ caseId, letterType, payCents, version: 1 + Math.floor(rand() * 50), createdAt: new Date(t) }));
      }
      const { months, all } = computeEarnings(rows);
      expect(all.totalCents).toBe(months.reduce((s, m) => s + m.totalCents, 0));
      expect(all.rows.length).toBe(months.reduce((s, m) => s + m.rows.length, 0));
      const distinctKeys = new Set(rows.map((r) => `${r.caseId}|${r.letterType}`)).size;
      expect(all.rows.length).toBe(distinctKeys);
    }
  });
});

describe('rate snapshot + historical resolution (matrix K/K2)', () => {
  const RAISED: readonly PayRateEntry[] = [
    ...DEFAULT_PAY_RATES,
    { letterType: 'nexus_letter', rateCents: 12500, effectiveFrom: new Date('2026-03-01T08:00:00Z') },
  ];

  it('K: a January unit with payCents=10000 snapshot stays $100 after a March rate raise to $125', () => {
    const { all } = computeEarnings(
      [row({ payCents: 10000, createdAt: new Date('2026-01-10T20:00:00Z') })],
      { rates: RAISED },
    );
    expect(all.totalCents).toBe(10000); // closed-month immutability — never re-priced to 12500
  });

  it('K2: a null-payCents historical row resolves to the rate in effect AT createdAt, not now', () => {
    const { all } = computeEarnings(
      [row({ payCents: null, createdAt: new Date('2026-01-10T20:00:00Z') })],
      { rates: RAISED },
    );
    expect(all.totalCents).toBe(10000); // pre-raise instant → old rate, even though "now" is post-raise
  });

  it('K2 (post-raise): a null-payCents row completed AFTER the raise resolves to the new rate', () => {
    const { all } = computeEarnings(
      [row({ payCents: null, createdAt: new Date('2026-04-10T19:00:00Z') })],
      { rates: RAISED },
    );
    expect(all.totalCents).toBe(12500);
  });

  it('resolveRateCents: defaults $100/$50; unknown type → $0 (visible, never NaN)', () => {
    expect(resolveRateCents('nexus_letter', new Date('2026-01-10T20:00:00Z'))).toBe(10000);
    expect(resolveRateCents('nexus_memo', new Date('2026-01-10T20:00:00Z'))).toBe(5000);
    expect(resolveRateCents('mystery_type', new Date('2026-01-10T20:00:00Z'))).toBe(0);
  });
});

describe('attribution (matrix L/M — snapshot wins; the clicker is never the payee)', () => {
  it('L: a row snapshotted to Dr. X counts for Dr. X regardless of who clicked approve (actor is never an input)', () => {
    // belongsToPhysician takes NO actor — the ActivityLog clicker cannot influence pay.
    const r = row({ signingPhysicianId: 'DR-X', caseAssignedPhysicianId: 'DR-X' });
    expect(belongsToPhysician(r, 'DR-X')).toBe(true);
    expect(belongsToPhysician(r, 'ADMIN-USER')).toBe(false);
  });

  it('M: case reassigned to Dr. Y AFTER completion stays Dr. X via the snapshot', () => {
    const r = row({ signingPhysicianId: 'DR-X', caseAssignedPhysicianId: 'DR-Y' }); // live join moved
    expect(belongsToPhysician(r, 'DR-X')).toBe(true);
    expect(belongsToPhysician(r, 'DR-Y')).toBe(false);
  });

  it('historical fallback: null snapshot falls back to the live assignedPhysicianId join', () => {
    const r = row({ signingPhysicianId: null, caseAssignedPhysicianId: 'DR-Y' });
    expect(belongsToPhysician(r, 'DR-Y')).toBe(true);
    expect(belongsToPhysician(r, 'DR-X')).toBe(false);
  });
});

describe('month enumeration (matrix Q — dropdown source)', () => {
  it('Q: employment start 2026-04-15 PT, now 2026-06-11 PT → [2026-06, 2026-05, 2026-04] descending', () => {
    const start = new Date('2026-04-15T19:00:00Z'); // Apr 15 12:00 PT
    const now = new Date('2026-06-11T19:00:00Z'); // Jun 11 12:00 PT
    expect(enumerateMonthsSince(start, now)).toEqual(['2026-06', '2026-05', '2026-04']);
  });

  it('PT-vs-UTC edge: a createdAt that is Jan 1 UTC but Dec 31 PT starts the enumeration in December', () => {
    const start = new Date('2026-01-01T02:00:00Z'); // Dec 31 2025 18:00 PT
    const now = new Date('2026-01-15T20:00:00Z');
    expect(enumerateMonthsSince(start, now)).toEqual(['2026-01', '2025-12']);
  });

  it('physician created this month → exactly one month', () => {
    const start = new Date('2026-06-02T19:00:00Z');
    const now = new Date('2026-06-11T19:00:00Z');
    expect(enumerateMonthsSince(start, now)).toEqual(['2026-06']);
  });

  it('degenerate future start → current month only (never an empty dropdown)', () => {
    const start = new Date('2027-01-15T20:00:00Z');
    const now = new Date('2026-06-11T19:00:00Z');
    expect(enumerateMonthsSince(start, now)).toEqual(['2026-06']);
  });
});
