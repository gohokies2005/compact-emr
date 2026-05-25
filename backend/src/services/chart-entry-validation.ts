import { HttpError } from '../http/errors.js';

const ICD10_PATTERN = /^[A-Z][0-9]{2}(?:\.[A-Z0-9]{1,4})?[A-Z0-9]?$/i;
const MAX_PROBLEM_LEN = 200;
const MAX_NOTES_LEN = 500;
const MAX_DRUG_NAME_LEN = 120;
const MAX_DOSE_LEN = 60;
const MAX_FREQUENCY_LEN = 60;
const MAX_INDICATION_LEN = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function badRequest(message: string, details?: Record<string, unknown>): never {
  throw new HttpError(400, 'bad_request', message, details);
}

function requiredString(body: Record<string, unknown>, field: string, max: number): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    badRequest(`${field} is required`, { field });
  }
  const trimmed = (value as string).trim();
  if (trimmed.length > max) {
    badRequest(`${field} exceeds maximum length of ${max} characters`, { field, max });
  }
  return trimmed;
}

function optionalString(body: Record<string, unknown>, field: string, max: number): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    badRequest(`${field} must be a string`, { field });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    badRequest(`${field} exceeds maximum length of ${max} characters`, { field, max });
  }
  return trimmed;
}

export interface ParsedActiveProblemCreate {
  problem: string;
  icd10: string | null;
  notes: string | null;
}

export function parseActiveProblemCreate(body: unknown): ParsedActiveProblemCreate {
  if (!isRecord(body)) badRequest('Request body must be an object');
  const problem = requiredString(body, 'problem', MAX_PROBLEM_LEN);
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
    drugName: requiredString(body, 'drugName', MAX_DRUG_NAME_LEN),
    dose: optionalString(body, 'dose', MAX_DOSE_LEN),
    frequency: optionalString(body, 'frequency', MAX_FREQUENCY_LEN),
    indication: optionalString(body, 'indication', MAX_INDICATION_LEN),
  };
}
