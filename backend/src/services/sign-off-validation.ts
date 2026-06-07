import { badRequest, isRecord } from './validation-helpers.js';

const MAX_QUESTION_KEY_LEN = 100;
const MAX_NOTES_LEN = 500;
const MAX_ANSWER_COUNT = 10;

export interface ParsedSignOff {
  answers: Record<string, boolean>;
  notes: string | null;
}

/**
 * Sign-off payload contract: a record of question_key -> boolean answers (yes/no questions
 * the popup shows the physician), plus an optional free-text note. We accept up to 10
 * questions to keep the payload bounded and to enforce the FRN HARD RULE that the sign-off
 * popup carries at most a handful of plain-English questions.
 */
export function parseSignOffCreate(body: unknown): ParsedSignOff {
  if (!isRecord(body)) badRequest('Request body must be an object');
  const rawAnswers = body['answers'];
  if (!isRecord(rawAnswers)) badRequest('answers is required (object of question_key -> boolean)', { field: 'answers' });

  const keys = Object.keys(rawAnswers);
  if (keys.length === 0) badRequest('answers must contain at least one question', { field: 'answers' });
  if (keys.length > MAX_ANSWER_COUNT) {
    badRequest(`answers exceeds maximum of ${MAX_ANSWER_COUNT} entries`, { field: 'answers', max: MAX_ANSWER_COUNT });
  }

  const answers: Record<string, boolean> = {};
  for (const key of keys) {
    if (key.length === 0 || key.length > MAX_QUESTION_KEY_LEN) {
      badRequest(`answer key has invalid length`, { field: `answers.${key}`, max: MAX_QUESTION_KEY_LEN });
    }
    const value = rawAnswers[key];
    if (typeof value !== 'boolean') {
      badRequest(`answer for "${key}" must be a boolean`, { field: `answers.${key}` });
    }
    answers[key] = value;
  }

  let notes: string | null = null;
  const rawNotes = body['notes'];
  if (rawNotes !== undefined && rawNotes !== null) {
    if (typeof rawNotes !== 'string') {
      badRequest('notes must be a string', { field: 'notes' });
    }
    const trimmed = rawNotes.trim();
    if (trimmed.length > MAX_NOTES_LEN) {
      badRequest(`notes exceeds maximum length of ${MAX_NOTES_LEN} characters`, { field: 'notes', max: MAX_NOTES_LEN });
    }
    notes = trimmed.length === 0 ? null : trimmed;
  }

  return { answers, notes };
}

/**
 * Every sign-off question is a POSITIVE attestation ("records reviewed", "diagnosis documented",
 * "nexus supported >50%", "no PHI", "PDF correct") — so a "No" on ANY means the letter is NOT ready to
 * finalize. A valid (and approvable) sign-off therefore requires every answer to be `true`. A physician
 * with a concern must resolve it or send the case back to the RN, NOT sign off against the letter.
 * (Audit 2026-06-07: the only gate before this checked the sign-off EXISTED, never its answers — a "No"
 * attestation could still finalize a signed nexus letter.) If a future question is ever informational
 * (where "No" is acceptable), replace this with an explicit blocking-keys allowlist.
 */
export function isSignOffAffirmative(answers: unknown): boolean {
  if (!isRecord(answers)) return false;
  const values = Object.values(answers);
  return values.length > 0 && values.every((v) => v === true);
}
