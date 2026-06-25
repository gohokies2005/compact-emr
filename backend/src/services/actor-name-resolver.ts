import type { AppDb } from './db-types.js';

// Resolve a Cognito sub (or other actor id) → a HUMAN display name for UI surfaces (staff notes,
// staff messages, handoff notes). The stored id is the source of truth and is NEVER changed; this
// only affects DISPLAY. A raw UUID must NEVER reach a screen (Ryan 2026-06-24): RNs would see a
// Cognito sub where a name belongs.
//
// Authors can live in EITHER directory:
//   • app_users  — RNs / ops_staff / admins (keyed by cognito_sub; name, falling back to email)
//   • physician  — signing physicians (keyed by cognito_sub; fullName)
// The previous inline chart-notes resolver only checked app_users, so a PHYSICIAN-authored note still
// leaked its UUID. This helper checks BOTH and is the single resolution path for every author surface.

const SYSTEM_LABEL = 'System';
const UNKNOWN_LABEL = 'Staff';

// Subs the system itself stamps (no human author) → "System" rather than a neutral "Staff".
const SYSTEM_SUBS = new Set(['system', 'SYSTEM']);

interface NameSources {
  // sub -> { name?, email? } from app_users
  readonly users: ReadonlyMap<string, { readonly name: string | null; readonly email: string }>;
  // sub -> physician fullName
  readonly physicians: ReadonlyMap<string, string>;
}

/**
 * Pure formatter: given an actor id and the looked-up sources, return the display name.
 * Priority: physician fullName → app_user name → app_user email → "System" (system sub) → "Staff".
 * Never returns the raw id.
 */
export function pickDisplayName(
  sub: string | null | undefined,
  sources: NameSources,
): string {
  if (sub === null || sub === undefined || sub.trim() === '') return UNKNOWN_LABEL;
  if (SYSTEM_SUBS.has(sub)) return SYSTEM_LABEL;

  const physicianName = sources.physicians.get(sub);
  if (physicianName && physicianName.trim() !== '') return physicianName.trim();

  const user = sources.users.get(sub);
  if (user) {
    if (user.name && user.name.trim() !== '') return user.name.trim();
    if (user.email && user.email.trim() !== '') return user.email.trim();
  }

  // Unknown / deactivated / no-longer-present account → neutral label, NEVER the raw UUID.
  return UNKNOWN_LABEL;
}

/**
 * Batch-resolve a set of actor ids → display names. One query per directory (app_users + physician),
 * filtered to only the distinct subs requested. Returns a Map(sub -> displayName) covering every input
 * sub (unresolved subs map to the neutral fallback). Use to enrich a list of notes/messages.
 */
export async function resolveActorNames(
  db: AppDb,
  subs: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const distinct = [
    ...new Set(
      subs.filter((s): s is string => typeof s === 'string' && s.trim() !== '' && !SYSTEM_SUBS.has(s)),
    ),
  ];

  if (distinct.length === 0) {
    // Still return a map so callers can uniformly resolve system/empty subs through pickDisplayName.
    return new Map();
  }

  const [users, physicians] = await Promise.all([
    db.appUser.findMany({
      where: { cognitoSub: { in: distinct } },
      select: { cognitoSub: true, name: true, email: true },
    }),
    db.physician.findMany({
      where: { cognitoSub: { in: distinct } },
      select: { cognitoSub: true, fullName: true },
    }),
  ]);

  const userMap = new Map<string, { name: string | null; email: string }>(
    users.map((u) => [u.cognitoSub, { name: u.name, email: u.email }]),
  );
  const physicianMap = new Map<string, string>(
    physicians
      .filter((p): p is typeof p & { cognitoSub: string } => typeof p.cognitoSub === 'string' && p.cognitoSub !== '')
      .map((p) => [p.cognitoSub, p.fullName]),
  );
  const sources: NameSources = { users: userMap, physicians: physicianMap };

  const out = new Map<string, string>();
  for (const sub of distinct) out.set(sub, pickDisplayName(sub, sources));
  return out;
}
