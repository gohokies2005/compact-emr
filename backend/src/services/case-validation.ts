import { HttpError } from '../http/errors.js';
import type { CaseStatus, ClaimType } from './db-types.js';
import { isCaseStatus } from './case-status-transitions.js';
import { systemForCondition } from './conditions-catalog.js';

const MAX_CLAIMED_CONDITIONS = 10;
const MAX_CONDITION_LENGTH = 200;

const CLAIM_TYPES: readonly ClaimType[] = ['initial', 'supplemental', 'hlr', 'appeal_bva'] as const;
const PHI_PATTERN_REJECTIONS: readonly RegExp[] = [
  /\d{3}-?\d{2}-?\d{4}/,
  /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/,
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
];

export interface ParsedCaseCreate {
  id: string;
  claimedCondition: string;
  claimedConditions?: string[];
  claimType: ClaimType;
  framingChoice?: string;
  upstreamScCondition?: string;
  veteranStatement?: string;
  inServiceEvent?: string;
  assignedPhysicianId?: string;
}

export interface ParsedCasePatch {
  version: number;
  fields: {
    claimedCondition?: string;
    framingChoice?: string | null;
    upstreamScCondition?: string | null;
    veteranStatement?: string | null;
    inServiceEvent?: string | null;
    assignedPhysicianId?: string | null;
    refundEligible?: boolean;
  };
  changedFields: readonly string[];
}

export interface ParsedStatusTransition {
  from: CaseStatus;
  to: CaseStatus;
  version: number;
  transitionReason?: string;
}

export interface ParsedAssignPhysician {
  physicianId: string;
  version: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function badRequest(message: string, details?: Record<string, unknown>): never {
  throw new HttpError(400, 'bad_request', message, details);
}

function requiredNonEmptyString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    badRequest(`${field} is required`, { field });
  }
  return value.trim();
}

function optionalString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') badRequest(`${field} must be a string`, { field });
  const trimmed = value.trim();
  if (trimmed.length > maxLength) badRequest(`${field} is too long`, { field, maxLength });
  return trimmed;
}

function optionalNullableString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
): string | null | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') badRequest(`${field} must be a string`, { field });
  const trimmed = value.trim();
  if (trimmed.length > maxLength) badRequest(`${field} is too long`, { field, maxLength });
  return trimmed;
}

function positiveInteger(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    badRequest(`${field} must be a positive integer`, { field });
  }
  return value;
}

// Parse an optional claimedConditions[] (clustered claim). Each entry is a non-empty trimmed
// string (max MAX_CONDITION_LENGTH); the array holds at most MAX_CLAIMED_CONDITIONS entries.
// Returns undefined when the field is absent/null so callers can fall back to the single condition.
function optionalConditionArray(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) badRequest(`${field} must be an array of strings`, { field });
  if (value.length === 0) badRequest(`${field} must not be empty when provided`, { field });
  if (value.length > MAX_CLAIMED_CONDITIONS) {
    badRequest(`${field} has too many entries`, { field, max: MAX_CLAIMED_CONDITIONS });
  }
  const parsed: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      badRequest(`each entry in ${field} must be a non-empty string`, { field });
    }
    const trimmed = entry.trim();
    if (trimmed.length > MAX_CONDITION_LENGTH) {
      badRequest(`an entry in ${field} is too long`, { field, maxLength: MAX_CONDITION_LENGTH });
    }
    parsed.push(trimmed);
  }
  return parsed;
}

// SAME-SYSTEM GUARD: among the claimed conditions that are KNOWN catalog labels, they must all map
// to one body system (one letter argues only conditions within a single body system; a different
// system needs a separate claim). Free-text / unknown-system entries are exempt — we can't classify
// them, and an RN's escape-hatch free-text must never be blocked by this guard.
function assertSameBodySystem(conditions: readonly string[]): void {
  const systems = new Set<string>();
  for (const c of conditions) {
    const system = systemForCondition(c);
    if (system !== null) systems.add(system);
  }
  if (systems.size > 1) {
    badRequest(
      'All claimed conditions in one letter must be in the same body system; a different system needs a separate claim',
      { field: 'claimedConditions', systems: [...systems] },
    );
  }
}

export function parseCaseCreate(body: unknown): ParsedCaseCreate {
  if (!isRecord(body)) badRequest('Request body must be an object');
  if ('veteranId' in body) badRequest('veteranId comes from the URL, not the request body', { field: 'veteranId' });

  const id = requiredNonEmptyString(body, 'id');
  const claimedConditionsInput = optionalConditionArray(body, 'claimedConditions');

  // Primary (singular) = first claimedConditions entry when provided, else the single field.
  // claimedConditions is ALWAYS populated in the output (derived from the single field if absent).
  let claimedCondition: string;
  let claimedConditions: string[];
  if (claimedConditionsInput !== undefined) {
    claimedConditions = claimedConditionsInput;
    claimedCondition = claimedConditionsInput[0]!;
    assertSameBodySystem(claimedConditions);
  } else {
    claimedCondition = requiredNonEmptyString(body, 'claimedCondition');
    claimedConditions = [claimedCondition];
  }

  const claimType = body.claimType;
  if (typeof claimType !== 'string' || !CLAIM_TYPES.includes(claimType as ClaimType)) {
    badRequest('claimType is invalid', { field: 'claimType', allowedValues: CLAIM_TYPES });
  }

  return {
    id,
    claimedCondition,
    claimedConditions,
    claimType: claimType as ClaimType,
    ...(optionalString(body, 'framingChoice', 80) !== undefined && { framingChoice: optionalString(body, 'framingChoice', 80) }),
    ...(optionalString(body, 'upstreamScCondition', 200) !== undefined && { upstreamScCondition: optionalString(body, 'upstreamScCondition', 200) }),
    ...(optionalString(body, 'veteranStatement', 2000) !== undefined && { veteranStatement: optionalString(body, 'veteranStatement', 2000) }),
    ...(optionalString(body, 'inServiceEvent', 2000) !== undefined && { inServiceEvent: optionalString(body, 'inServiceEvent', 2000) }),
    ...(optionalString(body, 'assignedPhysicianId', 200) !== undefined && { assignedPhysicianId: optionalString(body, 'assignedPhysicianId', 200) }),
  };
}

export function parseCasePatch(body: unknown): ParsedCasePatch {
  if (!isRecord(body)) badRequest('Request body must be an object');

  const blocked = ['status', 'cdsVerdict', 'cdsOddsPct', 'cdsRationale', 'currentVersion'];
  const blockedField = blocked.find((field) => field in body);
  if (blockedField !== undefined) badRequest(`${blockedField} cannot be patched from this endpoint`, { field: blockedField });

  const version = positiveInteger(body, 'version');
  const fields: ParsedCasePatch['fields'] = {};

  const setString = (field: keyof ParsedCasePatch['fields'], maxLength: number): void => {
    const parsed = optionalNullableString(body, field, maxLength);
    if (parsed !== undefined) fields[field] = parsed as never;
  };

  setString('claimedCondition', 500);
  setString('framingChoice', 80);
  setString('upstreamScCondition', 200);
  setString('veteranStatement', 2000);
  setString('inServiceEvent', 2000);
  setString('assignedPhysicianId', 200);

  if ('refundEligible' in body) {
    if (typeof body.refundEligible !== 'boolean') badRequest('refundEligible must be boolean', { field: 'refundEligible' });
    fields.refundEligible = body.refundEligible;
  }

  const changedFields = Object.keys(fields).sort();
  if (changedFields.length === 0) badRequest('No patchable fields provided');

  return { version, fields, changedFields };
}

/**
 * Parses a case status transition request.
 *
 * transitionReason is for ops audit metadata only. NEVER include veteran name,
 * condition text, symptoms, dates, or any PHI. Examples of acceptable values:
 * "per supervisor approval", "records gathered", "physician requested redraft",
 * "awaiting prior denial letter".
 */
export function parseStatusTransition(body: unknown): ParsedStatusTransition {
  if (!isRecord(body)) badRequest('Request body must be an object');
  if (!isCaseStatus(body.from)) badRequest('from must be a valid case status', { field: 'from' });
  if (!isCaseStatus(body.to)) badRequest('to must be a valid case status', { field: 'to' });
  const version = positiveInteger(body, 'version');

  const transitionReason = optionalString(body, 'transitionReason', 200);
  if (transitionReason !== undefined) {
    const rejected = PHI_PATTERN_REJECTIONS.some((pattern) => pattern.test(transitionReason));
    if (rejected) {
      badRequest('transitionReason may contain only operational audit metadata and must not contain PHI-like values', {
        field: 'transitionReason',
      });
    }
  }

  return {
    from: body.from,
    to: body.to,
    version,
    ...(transitionReason !== undefined && { transitionReason }),
  };
}

export function parseAssignPhysician(body: unknown): ParsedAssignPhysician {
  if (!isRecord(body)) badRequest('Request body must be an object');
  return {
    physicianId: requiredNonEmptyString(body, 'physicianId'),
    version: positiveInteger(body, 'version'),
  };
}
