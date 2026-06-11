/**
 * Doctor-pay earnings engine (docs/DOCTOR_PAY_BUILD_PLAN_2026-06-11.md §5.1).
 *
 * ACCURACY-CRITICAL: Ryan cuts real physician checks from these numbers on the 1st of each
 * month. Pure + deterministic — no I/O. Every dedup/month/rate rule lives HERE so the full
 * adversarial matrix (plan §7) runs as cheap unit tests.
 *
 * The contract, in one line: a pay unit is a distinct payKey = (caseId, letterType) that has at
 * least one `approved_final` LetterRevision; the unit pays ONCE, at the rate snapshotted on (or
 * resolved for) its FIRST approved_final row, in the Pacific calendar month of that first row.
 *
 * Locked decisions (Ryan 2026-06-11):
 *  - Month bucketing = America/Los_Angeles calendar months (payroll runs on the 1st, Pacific).
 *  - First-approval-wins: re-approvals after corrections/editor saves NEVER re-pay and never
 *    move the unit to a later month. Closed months are stable.
 *  - Attribution = the snapshot signingPhysicianId written at approve time; live
 *    case.assignedPhysicianId is ONLY a fallback for pre-feature rows (null snapshot).
 *  - Rate-at-time capture: payCents frozen on the row at approve; null rows resolve against the
 *    effective-dated rate config AT THE COMPLETION INSTANT — a future rate change never rewrites
 *    history.
 */

/** Payroll timezone (locked: Ryan runs payroll on the 1st, Pacific). One-line change if revisited. */
export const PAY_TIMEZONE = 'America/Los_Angeles';

/** Valid billing letter types (plain strings by design — adding one needs no migration). */
export const LETTER_TYPES = ['nexus_letter', 'nexus_memo'] as const;

export interface PayRateEntry {
  letterType: string;
  rateCents: number;
  /** Rate applies to completions ON/AFTER this instant. */
  effectiveFrom: Date;
}

/**
 * The rate config: $100 nexus_letter / $50 nexus_memo, effective from epoch (covers all history).
 * Rate changes are APPENDED with a new effectiveFrom — never edit an existing entry, or
 * null-payCents historical rows would re-price (plan §4.2/§4.3; PayRate DB table is the deferred
 * P5 upgrade — payCents snapshotting makes the two forward-compatible).
 */
export const DEFAULT_PAY_RATES: readonly PayRateEntry[] = [
  { letterType: 'nexus_letter', rateCents: 10000, effectiveFrom: new Date(0) },
  { letterType: 'nexus_memo', rateCents: 5000, effectiveFrom: new Date(0) },
];

/**
 * Rate in effect for `letterType` at instant `at`: the entry with the LATEST effectiveFrom <= at.
 * Unknown letterType (or none effective yet) → 0 cents — a visible $0 row, never NaN/crash.
 */
export function resolveRateCents(
  letterType: string,
  at: Date = new Date(),
  rates: readonly PayRateEntry[] = DEFAULT_PAY_RATES,
): number {
  let best: PayRateEntry | undefined;
  for (const r of rates) {
    if (r.letterType !== letterType) continue;
    if (r.effectiveFrom.getTime() > at.getTime()) continue;
    if (best === undefined || r.effectiveFrom.getTime() > best.effectiveFrom.getTime()) best = r;
  }
  return best?.rateCents ?? 0;
}

// ───────────────────────────── Pacific calendar helpers ─────────────────────────────

interface WallClock { year: number; month: number; day: number; hour: number; minute: number; second: number; }

// Built once — Intl.DateTimeFormat construction is expensive relative to format().
const WALL_CLOCK_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: PAY_TIMEZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

/** The Pacific wall-clock reading of a UTC instant. */
function pacificWallClock(d: Date): WallClock {
  const parts = WALL_CLOCK_FMT.formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const rawHour = get('hour');
  return {
    year: get('year'), month: get('month'), day: get('day'),
    // Some ICU builds render midnight as '24' under hour12:false — normalize to 0.
    hour: rawHour === 24 ? 0 : rawHour,
    minute: get('minute'), second: get('second'),
  };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 'YYYY-MM' of the instant in PAY_TIMEZONE. THE month-bucketing function (never UTC — plan §3.4). */
export function pacificYearMonth(d: Date): string {
  const w = pacificWallClock(d);
  return `${String(w.year).padStart(4, '0')}-${pad2(w.month)}`;
}

/**
 * The UTC instant at which the Pacific wall clock reads `year-month-01 00:00:00` (month start).
 * Iterative offset correction (converges in <=2 steps) — DST-safe with no hardcoded -8/-7:
 * month-start midnight always exists exactly once in America/Los_Angeles (US DST transitions
 * happen at 2 a.m. local, never midnight on the 1st).
 * `month` may overflow (13 → January next year) for window arithmetic.
 */
export function pacificMonthStartUtc(year: number, month: number): Date {
  const norm = new Date(Date.UTC(year, month - 1, 1));
  const y = norm.getUTCFullYear();
  const m = norm.getUTCMonth() + 1;
  const targetAsUtc = Date.UTC(y, m - 1, 1, 0, 0, 0);
  let guess = targetAsUtc;
  for (let i = 0; i < 3; i++) {
    const w = pacificWallClock(new Date(guess));
    const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    const diff = targetAsUtc - wallAsUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** True for a well-formed 'YYYY-MM' month key. */
export function isValidMonthKey(month: string): boolean {
  return MONTH_RE.test(month);
}

/** UTC [gte, lt) window covering the Pacific calendar month 'YYYY-MM'. */
export function pacificMonthWindowUtc(monthPT: string): { gte: Date; lt: Date } {
  const m = MONTH_RE.exec(monthPT);
  if (m === null) throw new Error(`invalid month key: ${monthPT} (expected YYYY-MM)`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return { gte: pacificMonthStartUtc(y, mo), lt: pacificMonthStartUtc(y, mo + 1) };
}

/**
 * Every Pacific 'YYYY-MM' from the month of `employmentStart` through the month of `now`,
 * DESCENDING (current first) — the month-dropdown source (plan §5.3; employment anchor =
 * Physician.createdAt, decision G). A start after `now` degrades to just the current month.
 */
export function enumerateMonthsSince(employmentStart: Date, now: Date = new Date()): string[] {
  const startKey = pacificYearMonth(employmentStart);
  const endKey = pacificYearMonth(now);
  const start = MONTH_RE.exec(startKey);
  const end = MONTH_RE.exec(endKey);
  if (start === null || end === null) return [endKey];
  let y = Number(end[1]);
  let m = Number(end[2]);
  const sy = Number(start[1]);
  const sm = Number(start[2]);
  const months: string[] = [];
  // Hard cap (100 years) — malformed far-past employmentStart must not hang the dropdown.
  while ((y > sy || (y === sy && m >= sm)) && months.length < 1200) {
    months.push(`${String(y).padStart(4, '0')}-${pad2(m)}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return months.length > 0 ? months : [endKey];
}

// ───────────────────────────── Attribution ─────────────────────────────

/** Attribution inputs of one approved_final row (snapshot + live-join fallback). */
export interface AttributedRow {
  /** Snapshot written at approve time; null/undefined on pre-feature rows. */
  signingPhysicianId: string | null;
  /** Live case.assignedPhysicianId join — the FALLBACK for null snapshots only. */
  caseAssignedPhysicianId: string | null;
}

/**
 * Pay attribution (plan §1.3, decision A): the snapshot signing physician WINS; the live
 * assignedPhysicianId join is consulted ONLY when the snapshot is null (pre-feature rows).
 * A case reassigned after completion therefore never moves past earnings (matrix M), and the
 * approve CLICKER (possibly an admin) is never the payee (matrix L — we never read the actor).
 */
export function belongsToPhysician(row: AttributedRow, physicianId: string): boolean {
  if (row.signingPhysicianId !== null && row.signingPhysicianId !== undefined) {
    return row.signingPhysicianId === physicianId;
  }
  return row.caseAssignedPhysicianId === physicianId;
}

// ───────────────────────────── Earnings computation ─────────────────────────────

/** One approved_final LetterRevision, pre-joined (the route maps Prisma rows into this). */
export interface CompletionRow extends AttributedRow {
  caseId: string;
  version: number;
  createdAt: Date;
  letterType: string;
  /** Rate-at-completion snapshot (cents); null on pre-feature rows → rate-config fallback. */
  payCents: number | null;
  veteranName: string;
  claimedCondition: string;
}

/** One pay unit (a deduped payKey) as rendered on the Track-pay table. */
export interface EarningRow {
  caseId: string;
  veteranName: string;
  condition: string;
  letterType: string;
  payCents: number;
  payUsd: number;
  monthPT: string;
  /** ISO instant of the unit's FIRST approved_final revision (its earning event). */
  firstApprovedAt: string;
}

export interface MonthEarnings {
  /** 'YYYY-MM' (Pacific), or 'all' for the career aggregate. */
  monthPT: string;
  rows: EarningRow[];
  totalCents: number;
  totalUsd: number;
}

export interface ComputeEarningsOptions {
  /** Pluggable rate config for null-payCents rows (defaults to DEFAULT_PAY_RATES). */
  rates?: readonly PayRateEntry[];
}

const centsToUsd = (cents: number): number => Math.round(cents) / 100;

/**
 * The engine. Group rows by payKey=(caseId,letterType); keep the EARLIEST createdAt row per key
 * (tie → lowest version); value it payCents ?? rate-config(letterType, firstCreatedAt); bucket it
 * into the Pacific month of that first row. `all` = every unit (career) — by construction
 * all.totalCents === sum(months[].totalCents) (matrix I).
 *
 * Correction cycles producing 2nd/3rd approved_final rows at higher versions — even in LATER
 * months — collapse into the first row's month at the first row's value (matrix C; decision C).
 */
export function computeEarnings(
  rows: readonly CompletionRow[],
  opts: ComputeEarningsOptions = {},
): { months: MonthEarnings[]; all: MonthEarnings } {
  // Dedup: first approved_final wins per payKey.
  const firstByKey = new Map<string, CompletionRow>();
  for (const row of rows) {
    const key = `${row.caseId}\u0000${row.letterType}`;
    const prev = firstByKey.get(key);
    if (
      prev === undefined ||
      row.createdAt.getTime() < prev.createdAt.getTime() ||
      (row.createdAt.getTime() === prev.createdAt.getTime() && row.version < prev.version)
    ) {
      firstByKey.set(key, row);
    }
  }

  const units: EarningRow[] = [];
  for (const first of firstByKey.values()) {
    const cents = first.payCents ?? resolveRateCents(first.letterType, first.createdAt, opts.rates ?? DEFAULT_PAY_RATES);
    units.push({
      caseId: first.caseId,
      veteranName: first.veteranName,
      condition: first.claimedCondition,
      letterType: first.letterType,
      payCents: cents,
      payUsd: centsToUsd(cents),
      monthPT: pacificYearMonth(first.createdAt),
      firstApprovedAt: first.createdAt.toISOString(),
    });
  }
  // Stable render order: newest earning first; ties by veteran then caseId then letterType.
  units.sort((a, b) =>
    b.firstApprovedAt.localeCompare(a.firstApprovedAt) ||
    a.veteranName.localeCompare(b.veteranName) ||
    a.caseId.localeCompare(b.caseId) ||
    a.letterType.localeCompare(b.letterType),
  );

  const byMonth = new Map<string, EarningRow[]>();
  for (const u of units) {
    const bucket = byMonth.get(u.monthPT);
    if (bucket === undefined) byMonth.set(u.monthPT, [u]);
    else bucket.push(u);
  }
  const sum = (xs: readonly EarningRow[]): number => xs.reduce((acc, r) => acc + r.payCents, 0);
  const months: MonthEarnings[] = [...byMonth.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([monthPT, monthRows]) => ({ monthPT, rows: monthRows, totalCents: sum(monthRows), totalUsd: centsToUsd(sum(monthRows)) }));
  const all: MonthEarnings = { monthPT: 'all', rows: units, totalCents: sum(units), totalUsd: centsToUsd(sum(units)) };
  return { months, all };
}
