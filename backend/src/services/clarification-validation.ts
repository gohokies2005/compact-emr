import { badRequest, isRecord } from './validation-helpers.js';
import type { ClarificationAudience, ClarificationStatus } from './db-types.js';

const AUDIENCES: readonly ClarificationAudience[] = ['physician', 'ops_staff', 'veteran'];
const RESOLVE_STATUSES: readonly ClarificationStatus[] = ['resolved', 'dismissed'];
const MAX_QUESTION_LEN = 800;
const MAX_RESOLUTION_LEN = 800;

export interface ParsedClarificationCreate {
  audience: ClarificationAudience;
  question: string;
}

export function parseClarificationCreate(body: unknown): ParsedClarificationCreate {
  if (!isRecord(body)) badRequest('Request body must be an object');
  const audience = body['audience'];
  if (typeof audience !== 'string' || !(AUDIENCES as readonly string[]).includes(audience)) {
    badRequest(`audience must be one of: ${AUDIENCES.join(', ')}`, { field: 'audience', allowed: AUDIENCES });
  }
  const question = body['question'];
  if (typeof question !== 'string' || question.trim().length === 0) {
    badRequest('question is required', { field: 'question' });
  }
  const trimmed = (question as string).trim();
  if (trimmed.length > MAX_QUESTION_LEN) {
    badRequest(`question exceeds ${MAX_QUESTION_LEN} characters`, { field: 'question', max: MAX_QUESTION_LEN });
  }
  return { audience: audience as ClarificationAudience, question: trimmed };
}

export interface ParsedClarificationResolve {
  status: 'resolved' | 'dismissed';
  resolution: string | null;
}

export function parseClarificationResolve(body: unknown): ParsedClarificationResolve {
  if (!isRecord(body)) badRequest('Request body must be an object');
  const status = body['status'];
  if (typeof status !== 'string' || !(RESOLVE_STATUSES as readonly string[]).includes(status)) {
    badRequest(`status must be one of: ${RESOLVE_STATUSES.join(', ')}`, { field: 'status', allowed: RESOLVE_STATUSES });
  }
  let resolution: string | null = null;
  const raw = body['resolution'];
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== 'string') badRequest('resolution must be a string', { field: 'resolution' });
    const trimmed = raw.trim();
    if (trimmed.length > MAX_RESOLUTION_LEN) {
      badRequest(`resolution exceeds ${MAX_RESOLUTION_LEN} characters`, { field: 'resolution', max: MAX_RESOLUTION_LEN });
    }
    resolution = trimmed.length === 0 ? null : trimmed;
  }
  return { status: status as 'resolved' | 'dismissed', resolution };
}
