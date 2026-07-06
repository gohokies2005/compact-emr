import { HttpError } from '../http/errors.js';
import type { YesNoUnknown, VeteranCreateInput, VeteranUpdateInput } from './db-types.js';

const YES_NO_UNKNOWN = new Set(['yes', 'no', 'unknown']);
// Ryan 2026-07-06: OPS staff (RNs) may now fix a veteran's name/DOB. Intake typos — a doubled first name,
// a wrong DOB — are exactly what RNs catch and must correct without waiting on an admin. The gate mechanism
// is kept (empty set) so a field can be re-locked later without re-adding the logic. The PATCH route is
// OPS_ROLES-gated, so this only opens name/DOB to ops_staff + admin — a physician still cannot PATCH at all.
const ADMIN_ONLY_FIELDS = new Set<string>([]);
const ALLOWED_UPDATE_FIELDS = new Set([
  'firstName',
  'lastName',
  'dob',
  'email',
  'phone',
  'address',
  'branch',
  'serviceStartYear',
  'serviceEndYear',
  'combatVeteran',
  'pactArea',
  'teraConceded',
  'heightIn',
  'weightLb',
  'noScConditionsConfirmed',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'bad_request', `${key} is required.`);
  }
  return value.trim();
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'bad_request', `${key} must be a string.`);
  return value.trim();
}

function nullableString(input: Record<string, unknown>, key: string): string | null | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, 'bad_request', `${key} must be a string or null.`);
  return value.trim();
}

function requiredInt(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new HttpError(400, 'bad_request', `${key} must be an integer.`);
  }
  return value;
}

function optionalNullableInt(input: Record<string, unknown>, key: string): number | null | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new HttpError(400, 'bad_request', `${key} must be an integer or null.`);
  }
  return value;
}


function optionalEnum(input: Record<string, unknown>, key: string): YesNoUnknown | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !YES_NO_UNKNOWN.has(value)) {
    throw new HttpError(400, 'bad_request', `${key} must be yes, no, or unknown.`);
  }
  return value as YesNoUnknown;
}

function parseDate(value: unknown, key: string): Date {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'bad_request', `${key} must be an ISO date string.`);
  }
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf())) {
    throw new HttpError(400, 'bad_request', `${key} must be a valid date.`);
  }
  return date;
}

function maybeDate(input: Record<string, unknown>, key: string): Date | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  return parseDate(value, key);
}

function optionalVersion(input: Record<string, unknown>): number {
  const value = input.version;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new HttpError(400, 'bad_request', 'version is required and must be a positive integer.');
  }
  return value;
}

// Normalize a name to title-case so an ALL-CAPS or lower-case form entry ("WOODLEY", "travis")
// stores clean. Preserves hyphens/apostrophes (Hamilton-Dorsey, O'Brien). Ryan 2026-06-05.
export function toTitleCaseName(s: string): string {
  return s.trim().toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

export function parseVeteranCreate(body: unknown): VeteranCreateInput {
  if (!isObject(body)) throw new HttpError(400, 'bad_request', 'Request body must be an object.');
  const branch = optionalString(body, 'branch');
  const serviceStartYear = optionalNullableInt(body, 'serviceStartYear');
  const serviceEndYear = optionalNullableInt(body, 'serviceEndYear');
  const combatVeteran = optionalEnum(body, 'combatVeteran');
  const pactArea = optionalEnum(body, 'pactArea');
  const teraConceded = optionalEnum(body, 'teraConceded');
  const phone = optionalString(body, 'phone');
  const address = optionalString(body, 'address');
  const heightIn = optionalNullableInt(body, 'heightIn');
  const weightLb = optionalNullableInt(body, 'weightLb');
  return {
    id: requiredString(body, 'id'),
    lastName: toTitleCaseName(requiredString(body, 'lastName')),
    firstName: toTitleCaseName(requiredString(body, 'firstName')),
    dob: parseDate(body.dob, 'dob'),
    email: requiredString(body, 'email'),
    ...(phone !== undefined ? { phone } : {}),
    ...(address !== undefined ? { address } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(serviceStartYear !== undefined && serviceStartYear !== null ? { serviceStartYear } : {}),
    ...(serviceEndYear !== undefined && serviceEndYear !== null ? { serviceEndYear } : {}),
    ...(combatVeteran !== undefined ? { combatVeteran } : {}),
    ...(pactArea !== undefined ? { pactArea } : {}),
    ...(teraConceded !== undefined ? { teraConceded } : {}),
    ...(heightIn !== undefined && heightIn !== null ? { heightIn } : {}),
    ...(weightLb !== undefined && weightLb !== null ? { weightLb } : {}),
  };
}

export function parseVeteranPatch(body: unknown): { version: number; data: VeteranUpdateInput; changedFields: string[] } {
  if (!isObject(body)) throw new HttpError(400, 'bad_request', 'Request body must be an object.');
  const version = optionalVersion(body);
  const data: VeteranUpdateInput = {};
  const changedFields: string[] = [];

  for (const key of Object.keys(body)) {
    if (key === 'version') continue;
    if (!ALLOWED_UPDATE_FIELDS.has(key)) {
      throw new HttpError(400, 'bad_request', `${key} cannot be updated on this endpoint.`);
    }
  }

  const firstName = optionalString(body, 'firstName');
  if (firstName !== undefined) {
    data.firstName = firstName;
    changedFields.push('firstName');
  }
  const lastName = optionalString(body, 'lastName');
  if (lastName !== undefined) {
    data.lastName = lastName;
    changedFields.push('lastName');
  }
  const dob = maybeDate(body, 'dob');
  if (dob !== undefined) {
    data.dob = dob;
    changedFields.push('dob');
  }
  const email = optionalString(body, 'email');
  if (email !== undefined) {
    data.email = email;
    changedFields.push('email');
  }
  const phone = nullableString(body, 'phone');
  if (phone !== undefined) {
    data.phone = phone;
    changedFields.push('phone');
  }
  const address = nullableString(body, 'address');
  if (address !== undefined) {
    data.address = address;
    changedFields.push('address');
  }
  const branch = nullableString(body, 'branch'); // '' clears it (column is nullable) — matches phone/address
  if (branch !== undefined) {
    data.branch = branch;
    changedFields.push('branch');
  }
  if (body.serviceStartYear !== undefined) {
    data.serviceStartYear = requiredInt(body, 'serviceStartYear');
    changedFields.push('serviceStartYear');
  }
  if (body.serviceEndYear !== undefined) {
    data.serviceEndYear = requiredInt(body, 'serviceEndYear');
    changedFields.push('serviceEndYear');
  }
  const combatVeteran = optionalEnum(body, 'combatVeteran');
  if (combatVeteran !== undefined) {
    data.combatVeteran = combatVeteran;
    changedFields.push('combatVeteran');
  }
  const pactArea = optionalEnum(body, 'pactArea');
  if (pactArea !== undefined) {
    data.pactArea = pactArea;
    changedFields.push('pactArea');
  }
  const teraConceded = optionalEnum(body, 'teraConceded');
  if (teraConceded !== undefined) {
    data.teraConceded = teraConceded;
    changedFields.push('teraConceded');
  }
  const heightIn = optionalNullableInt(body, 'heightIn');
  if (heightIn !== undefined) {
    data.heightIn = heightIn;
    changedFields.push('heightIn');
  }
  const weightLb = optionalNullableInt(body, 'weightLb');
  if (weightLb !== undefined) {
    data.weightLb = weightLb;
    changedFields.push('weightLb');
  }
  if (body.noScConditionsConfirmed !== undefined) {
    if (typeof body.noScConditionsConfirmed !== 'boolean') {
      throw new HttpError(400, 'bad_request', 'noScConditionsConfirmed must be a boolean.');
    }
    data.noScConditionsConfirmed = body.noScConditionsConfirmed;
    changedFields.push('noScConditionsConfirmed');
  }

  if (changedFields.length === 0) {
    throw new HttpError(400, 'bad_request', 'At least one update field is required.');
  }

  return { version, data, changedFields };
}

export function assertPatchAllowedForRoles(changedFields: string[], roles: readonly string[]): void {
  const isAdmin = roles.includes('admin');
  if (isAdmin) return;

  const adminOnlyTouched = changedFields.filter((field) => ADMIN_ONLY_FIELDS.has(field));
  if (adminOnlyTouched.length > 0) {
    throw new HttpError(403, 'forbidden', 'Only admins can update veteran name or DOB.', { fields: adminOnlyTouched });
  }
}
