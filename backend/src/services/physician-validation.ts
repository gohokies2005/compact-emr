// Validation for the admin physician-profile routes (Deliverable 1). Mirrors the parse +
// optimistic-concurrency style of case-validation / chart-entry-validation. NPI and license are
// physician identity fields printed on every letter — validate shape, do NOT PHI-strip them.
import { badRequest, isRecord, optionalString, requiredNonEmptyString } from './validation-helpers.js';

const MAX_NAME = 120;
const MAX_SPECIALTY = 120;
const MAX_LICENSE = 60;
const MAX_EMAIL = 200;
const MAX_PHONE = 40;
const MAX_SUB = 255;
// Credential-block fields (printed in Section I + the signature block; see credential-block.ts).
const MAX_BOARD = 160;
const MAX_BOARD_ABBR = 24;
const MAX_LICENSE_STATE = 60;
const MAX_LICENSE_NUMBER = 60;
const NPI_PATTERN = /^\d{10}$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_SIGNATURE_BYTES = 5 * 1024 * 1024;

function parseNpi(body: Record<string, unknown>): string {
  const value = requiredNonEmptyString(body, 'npi', 10);
  if (!NPI_PATTERN.test(value)) badRequest('npi must be exactly 10 digits', { field: 'npi', value });
  return value;
}

function parseEmail(body: Record<string, unknown>): string {
  const value = requiredNonEmptyString(body, 'email', MAX_EMAIL);
  if (!EMAIL_PATTERN.test(value)) badRequest('email must be a valid email address', { field: 'email', value });
  return value;
}

export interface ParsedPhysicianCreate {
  fullName: string;
  npi: string;
  specialty: string;
  medicalLicense: string;
  email: string;
  phone: string | null;
  cognitoSub: string | null;
  // Credential-block facts (required at create so the physician can sign — the fraud gate blocks
  // approve without a complete block). fullName doubles as fullNameWithCredential (e.g.
  // "Ryan J. Kasky, DO"); the route composes the block from these + name/specialty/npi.
  boardName: string;
  boardAbbreviation: string;
  licenseState: string;
  licenseNumber: string;
}

export function parsePhysicianCreate(body: unknown): ParsedPhysicianCreate {
  if (!isRecord(body)) badRequest('Request body must be an object');
  return {
    fullName: requiredNonEmptyString(body, 'fullName', MAX_NAME),
    npi: parseNpi(body),
    specialty: requiredNonEmptyString(body, 'specialty', MAX_SPECIALTY),
    medicalLicense: requiredNonEmptyString(body, 'medicalLicense', MAX_LICENSE),
    email: parseEmail(body),
    phone: optionalString(body, 'phone', MAX_PHONE),
    cognitoSub: optionalString(body, 'cognitoSub', MAX_SUB),
    boardName: requiredNonEmptyString(body, 'boardName', MAX_BOARD),
    boardAbbreviation: requiredNonEmptyString(body, 'boardAbbreviation', MAX_BOARD_ABBR),
    licenseState: requiredNonEmptyString(body, 'licenseState', MAX_LICENSE_STATE),
    licenseNumber: requiredNonEmptyString(body, 'licenseNumber', MAX_LICENSE_NUMBER),
  };
}

function parseVersion(body: Record<string, unknown>): number {
  const value = body.version;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    badRequest('version is required and must be a positive integer', { field: 'version' });
  }
  return value as number;
}

export interface ParsedPhysicianPatch {
  version: number;
  data: { fullName?: string; npi?: string; specialty?: string; medicalLicense?: string; email?: string; phone?: string | null; cognitoSub?: string | null; active?: boolean; boardName?: string | null; boardAbbreviation?: string | null; licenseState?: string | null; licenseNumber?: string | null };
  changedFields: string[];
}

export function parsePhysicianPatch(body: unknown): ParsedPhysicianPatch {
  if (!isRecord(body)) badRequest('Request body must be an object');
  const fields = isRecord(body.fields) ? body.fields : body; // accept {version, fields:{...}} or flat
  const version = parseVersion(body);
  const data: ParsedPhysicianPatch['data'] = {};
  const changed: string[] = [];

  if (fields.fullName !== undefined) { data.fullName = requiredNonEmptyString(fields, 'fullName', MAX_NAME); changed.push('fullName'); }
  if (fields.npi !== undefined) { data.npi = parseNpi(fields); changed.push('npi'); }
  if (fields.specialty !== undefined) { data.specialty = requiredNonEmptyString(fields, 'specialty', MAX_SPECIALTY); changed.push('specialty'); }
  if (fields.medicalLicense !== undefined) { data.medicalLicense = requiredNonEmptyString(fields, 'medicalLicense', MAX_LICENSE); changed.push('medicalLicense'); }
  if (fields.email !== undefined) { data.email = parseEmail(fields); changed.push('email'); }
  if (fields.phone !== undefined) { data.phone = optionalString(fields, 'phone', MAX_PHONE); changed.push('phone'); }
  if (fields.cognitoSub !== undefined) { data.cognitoSub = optionalString(fields, 'cognitoSub', MAX_SUB); changed.push('cognitoSub'); }
  // Board cert + state license are OPTIONAL and may be submitted BLANK — a Doctor of Physical
  // Therapy (DPT) carries no board certification and no state medical license, and letters render
  // NPI-only (credential-block.ts REQUIRED_CREDENTIAL_FIELDS = name + NPI). Requiring these here
  // 400'd every DPT profile save, which left the credential block null and blocked signing
  // (Kevin Luiz, DPT — 400s confirmed in the API access logs 2026-07-21). Blank is stored as '' in
  // the recomposed block; the renderer already omits the board/license lines when they are blank.
  if (fields.boardName !== undefined) { data.boardName = optionalString(fields, 'boardName', MAX_BOARD); changed.push('boardName'); }
  if (fields.boardAbbreviation !== undefined) { data.boardAbbreviation = optionalString(fields, 'boardAbbreviation', MAX_BOARD_ABBR); changed.push('boardAbbreviation'); }
  if (fields.licenseState !== undefined) { data.licenseState = optionalString(fields, 'licenseState', MAX_LICENSE_STATE); changed.push('licenseState'); }
  if (fields.licenseNumber !== undefined) { data.licenseNumber = optionalString(fields, 'licenseNumber', MAX_LICENSE_NUMBER); changed.push('licenseNumber'); }
  if (fields.active !== undefined) {
    if (typeof fields.active !== 'boolean') badRequest('active must be a boolean', { field: 'active' });
    data.active = fields.active;
    changed.push('active');
  }

  if (changed.length === 0) badRequest('At least one update field is required');
  return { version, data, changedFields: changed };
}

export interface ParsedSignaturePresign { contentType: 'image/png'; sizeBytes: number }

export function parseSignaturePresign(body: unknown): ParsedSignaturePresign {
  if (!isRecord(body)) badRequest('Request body must be an object');
  // PNG only: the render Lambda composites the signature onto the letter; a JPG prints a
  // white rectangle. Enforce transparency-capable PNG at the door.
  if (body.contentType !== 'image/png') badRequest('Signature must be a PNG (image/png)', { field: 'contentType', value: body.contentType });
  const sizeBytes = body.sizeBytes;
  if (typeof sizeBytes !== 'number' || !Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_SIGNATURE_BYTES) {
    badRequest('sizeBytes must be a positive integer up to 5 MB', { field: 'sizeBytes', maxBytes: MAX_SIGNATURE_BYTES });
  }
  return { contentType: 'image/png', sizeBytes: sizeBytes as number };
}
