import type { AppDb, PhysicianRecord } from './db-types.js';

/**
 * Resolve the Physician record linked to the currently-authenticated Cognito user.
 *
 * Returns null when:
 *  - cognitoSub is missing
 *  - no Physician row has the supplied cognito_sub mapped
 *  - the matched Physician is inactive
 *
 * Use this when an endpoint needs to gate behavior on "physician is acting on
 * their own assigned case." Pair the result with the case's `assignedPhysicianId`.
 *
 * Mapping is established by an admin editing the Physician profile and writing
 * the Cognito sub (added in Phase 5; see migration 20260526000000_physician_cognito_sub).
 */
export async function resolveCurrentPhysician(
  db: AppDb,
  cognitoSub: string | undefined,
): Promise<PhysicianRecord | null> {
  if (!cognitoSub || cognitoSub.trim() === '') return null;
  const physician = await db.physician.findUnique({ where: { cognitoSub } });
  if (!physician) return null;
  if (!physician.active) return null;
  return physician;
}

/**
 * True when the cognito-user resolves to a physician AND that physician is
 * the assigned physician on the case. Common gate for physician-self-access.
 */
export async function isAssignedPhysicianForCase(
  db: AppDb,
  cognitoSub: string | undefined,
  assignedPhysicianId: string | null,
): Promise<boolean> {
  if (!assignedPhysicianId) return false;
  const physician = await resolveCurrentPhysician(db, cognitoSub);
  if (!physician) return false;
  return physician.id === assignedPhysicianId;
}
