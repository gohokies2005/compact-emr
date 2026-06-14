/**
 * Pacific (America/Los_Angeles) calendar-DAY helpers (D1 dashboard, 2026-06-13).
 *
 * The dashboard's "new intakes today" tile counts intakes since Pacific midnight — Ryan and the
 * staff work a Pacific day, so "today" must roll over at Pacific midnight, NOT UTC midnight (which
 * in PST/PDT is 4-5 p.m. the prior afternoon). DST matters: the offset is -8 (PST) or -7 (PDT)
 * depending on the date, so a hardcoded offset is wrong half the year.
 *
 * This mirrors the DST-safe iterative-offset technique already proven in services/pay-earnings.ts
 * (pacificMonthStartUtc) — the doctor-pay engine buckets payroll on Pacific months the same way.
 * We keep a DAY-level sibling here (rather than exporting from pay-earnings.ts) so the dashboard
 * is self-contained and the payroll module stays single-purpose. The shared knowledge — "convert
 * a target Pacific wall-clock instant to its UTC instant by iterative offset correction" — is the
 * same; only the granularity (day vs month) differs.
 */

/** The timezone every "today" boundary on the dashboard is measured in. */
export const DASHBOARD_TIMEZONE = 'America/Los_Angeles';

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// Built once — Intl.DateTimeFormat construction is expensive relative to format().
const WALL_CLOCK_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: DASHBOARD_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** The Pacific wall-clock reading of a UTC instant. */
function pacificWallClock(d: Date): WallClock {
  const parts = WALL_CLOCK_FMT.formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  const rawHour = get('hour');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // Some ICU builds render midnight as '24' under hour12:false — normalize to 0.
    hour: rawHour === 24 ? 0 : rawHour,
    minute: get('minute'),
    second: get('second'),
  };
}

/**
 * The UTC instant at which the Pacific wall clock most recently read `00:00:00` (today's Pacific
 * midnight) for the Pacific day containing `now`. Iterative offset correction (converges in <=2
 * steps) — DST-safe with no hardcoded -8/-7.
 *
 * Pacific calendar-day midnight (00:00 local on a given date) always exists exactly once: US DST
 * transitions happen at 2 a.m. local (spring-forward skips 02:00->03:00; fall-back repeats
 * 01:00-02:00), never midnight, so there is no ambiguous/nonexistent-midnight edge to resolve.
 */
export function pacificDayStartUtc(now: Date = new Date()): Date {
  const w = pacificWallClock(now);
  // The target instant we want, expressed as if the Pacific wall clock were UTC.
  const targetAsUtc = Date.UTC(w.year, w.month - 1, w.day, 0, 0, 0);
  let guess = targetAsUtc;
  for (let i = 0; i < 3; i++) {
    const gw = pacificWallClock(new Date(guess));
    const wallAsUtc = Date.UTC(gw.year, gw.month - 1, gw.day, gw.hour, gw.minute, gw.second);
    const diff = targetAsUtc - wallAsUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}
