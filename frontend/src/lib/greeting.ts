// Shared time-of-day greeting (P4, UI sweep 2026-06-11). HomePage carried this inline; the
// physician queue hero needs the identical ladder, so it lives here once. Boundaries are
// LOCAL time: [0,12) morning, [12,18) afternoon, [18,24) evening — locked by greeting.test.ts.
export type Greeting = 'Good morning' | 'Good afternoon' | 'Good evening';

export function timeOfDayGreeting(date: Date = new Date()): Greeting {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
