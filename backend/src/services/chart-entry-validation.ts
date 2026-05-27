import { badRequest, isRecord, optionalString, requiredNonEmptyString } from './validation-helpers.js';

const ICD10_PATTERN = /^[A-Z][0-9]{2}(?:\.[A-Z0-9]{1,4})?[A-Z0-9]?$/i;
const MAX_PROBLEM_LEN = 200;
const MAX_NOTES_LEN = 500;
const MAX_DRUG_NAME_LEN = 120;
const MAX_DOSE_LEN = 60;
const MAX_FREQUENCY_LEN = 60;
const MAX_INDICATION_LEN = 120;
const MAX_CONDITION_LEN = 200;
const MAX_DC_CODE_LEN = 16;

/** Optimistic-concurrency token. Required positive integer, mirrors veteran-validation. */
function parseVersion(body: Record<string, unknown>): number {
  const value = body.version;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    badRequest('version is required and must be a positive integer', { field: 'version' });
  }
  return value as number;
}

/** Optional ISO date string (YYYY-MM-DD); returns the trimmed string as-is or null. */
function optionalDateString(body: Record<string, unknown>, field: string): string | null {
  const value = optionalString(body, field, 32);
  if (value === null) return null;
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf())) {
    badRequest(`${field} must be a valid ISO date (YYYY-MM-DD)`, { field, value });
  }
  return value;
}

/** Convert an optional ISO date string into a Date for Prisma, or null. */
function dateStringToDate(value: string | null): Date | null {
  if (value === null) return null;
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

/** Optional rating percent: integer 0-100 if present. Returns the number or null. */
function optionalRatingPct(body: Record<string, unknown>): number | null {
  const value = body.ratingPct;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
    badRequest('ratingPct must be an integer between 0 and 100', { field: 'ratingPct' });
  }
  return value;
}

export interface ParsedActiveProblemCreate {
  problem: string;
  icd10: string | null;
  notes: string | null;
}

export function parseActiveProblemCreate(body: unknown): ParsedActiveProblemCreate {
  if (!isRecord(body)) badRequest('Request body must be an object');
  const problem = requiredNonEmptyString(body, 'problem', MAX_PROBLEM_LEN);
  const icd10Raw = optionalString(body, 'icd10', 16);
  if (icd10Raw !== null && !ICD10_PATTERN.test(icd10Raw)) {
    badRequest('icd10 must match ICD-10-CM format (letter, 2 digits, optional .subcode)', { field: 'icd10', value: icd10Raw });
  }
  return {
    problem,
    icd10: icd10Raw === null ? null : icd10Raw.toUpperCase(),
    notes: optionalString(body, 'notes', MAX_NOTES_LEN),
  };
}

export interface ParsedActiveMedicationCreate {
  drugName: string;
  dose: string | null;
  frequency: string | null;
  indication: string | null;
}

export function parseActiveMedicationCreate(body: unknown): ParsedActiveMedicationCreate {
  if (!isRecord(body)) badRequest('Request body must be an object');
  return {
    drugName: requiredNonEmptyString(body, 'drugName', MAX_DRUG_NAME_LEN),
    dose: optionalString(body, 'dose', MAX_DOSE_LEN),
    frequency: optionalString(body, 'frequency', MAX_FREQUENCY_LEN),
    indication: optionalString(body, 'indication', MAX_INDICATION_LEN),
  };
}

// ====================== ScCondition create ======================

export interface ParsedScConditionCreate {
  condition: string;
  dcCode: string | null;
  ratingPct: number | null;
  grantedDate: Date | null;
}

export function parseScConditionCreate(body: unknown): ParsedScConditionCreate {
  if (!isRecord(body)) badRequest('Request body must be an object');
  return {
    condition: requiredNonEmptyString(body, 'condition', MAX_CONDITION_LEN),
    dcCode: optionalString(body, 'dcCode', MAX_DC_CODE_LEN),
    ratingPct: optionalRatingPct(body),
    grantedDate: dateStringToDate(optionalDateString(body, 'grantedDate')),
  };
}

// ====================== Patch parsers (optimistic concurrency) ======================
//
// Each patch parser mirrors parseVeteranPatch: it pulls the required `version`, applies only the
// fields present in the body, tracks the changed field names for the activity row, and rejects an
// empty patch. The returned `data` is Prisma-update-shaped (the route adds `version: { increment }`).

export interface ParsedScConditionPatch {
  version: number;
  data: { condition?: string; dcCode?: string | null; ratingPct?: number | null; grantedDate?: Date | null };
  changedFields: string[];
}

export function parseScConditionPatch(body: unknown): ParsedScConditionPatch {
  if (!isRecord(body)) badRequest('Request body must be an object');
  const version = parseVersion(body);
  const data: ParsedScConditionPatch['data'] = {};
  const changedFields: string[] = [];

  if (body.condition !== undefined) {
    data.condition = requiredNonEmptyString(body, 'condition', MAX_CONDITION_LEN);
    changedFields.push('condition');
  }
  if (body.dcCode !== undefined) {
    data.dcCode = optionalString(body, 'dcCode', MAX_DC_CODE_LEN);
    changedFields.push('dcCode');
  }
  if (body.ratingPct !== undefined) {
    data.ratingPct = optionalRatingPct(body);
    changedFields.push('ratingPct');
  }
  if (body.grantedDate !== undefined) {
    data.grantedDate = dateStringToDate(optionalDateString(body, 'grantedDate'));
    changedFields.push('grantedDate');
  }

  if (changedFields.length === 0) {
    badRequest('At least one update field is required');
  }
  return { version, data, changedFields };
}

export interface ParsedActiveProblemPatch {
  version: number;
  data: { problem?: string; icd10?: string | null; notes?: string | null };
  changedFields: string[];
}

export function parseActiveProblemPatch(body: unknown): ParsedActiveProblemPatch {
  if (!isRecord(body)) badRequest('Request body must be an object');
  const version = parseVersion(body);
  const data: ParsedActiveProblemPatch['data'] = {};
  const changedFields: string[] = [];

  if (body.problem !== undefined) {
    data.problem = requiredNonEmptyString(body, 'problem', MAX_PROBLEM_LEN);
    changedFields.push('problem');
  }
  if (body.icd10 !== undefined) {
    const icd10Raw = optionalString(body, 'icd10', 16);
    if (icd10Raw !== null && !ICD10_PATTERN.test(icd10Raw)) {
      badRequest('icd10 must match ICD-10-CM format (letter, 2 digits, optional .subcode)', { field: 'icd10', value: icd10Raw });
    }
    data.icd10 = icd10Raw === null ? null : icd10Raw.toUpperCase();
    changedFields.push('icd10');
  }
  if (body.notes !== undefined) {
    data.notes = optionalString(body, 'notes', MAX_NOTES_LEN);
    changedFields.push('notes');
  }

  if (changedFields.length === 0) {
    badRequest('At least one update field is required');
  }
  return { version, data, changedFields };
}

export interface ParsedActiveMedicationPatch {
  version: number;
  data: { drugName?: string; dose?: string | null; frequency?: string | null; indication?: string | null };
  changedFields: string[];
}

export function parseActiveMedicationPatch(body: unknown): ParsedActiveMedicationPatch {
  if (!isRecord(body)) badRequest('Request body must be an object');
  const version = parseVersion(body);
  const data: ParsedActiveMedicationPatch['data'] = {};
  const changedFields: string[] = [];

  if (body.drugName !== undefined) {
    data.drugName = requiredNonEmptyString(body, 'drugName', MAX_DRUG_NAME_LEN);
    changedFields.push('drugName');
  }
  if (body.dose !== undefined) {
    data.dose = optionalString(body, 'dose', MAX_DOSE_LEN);
    changedFields.push('dose');
  }
  if (body.frequency !== undefined) {
    data.frequency = optionalString(body, 'frequency', MAX_FREQUENCY_LEN);
    changedFields.push('frequency');
  }
  if (body.indication !== undefined) {
    data.indication = optionalString(body, 'indication', MAX_INDICATION_LEN);
    changedFields.push('indication');
  }

  if (changedFields.length === 0) {
    badRequest('At least one update field is required');
  }
  return { version, data, changedFields };
}
