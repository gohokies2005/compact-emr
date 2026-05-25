import { badRequest, isRecord, optionalString, requiredNonEmptyString } from './validation-helpers.js';

const ICD10_PATTERN = /^[A-Z][0-9]{2}(?:\.[A-Z0-9]{1,4})?[A-Z0-9]?$/i;
const MAX_PROBLEM_LEN = 200;
const MAX_NOTES_LEN = 500;
const MAX_DRUG_NAME_LEN = 120;
const MAX_DOSE_LEN = 60;
const MAX_FREQUENCY_LEN = 60;
const MAX_INDICATION_LEN = 120;

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
