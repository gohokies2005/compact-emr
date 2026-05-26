import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { sendError } from '../http/errors.js';
import { SERVICE_ACTORS } from '../services/service-actors.js';

/**
 * Drafter integration: service-principal auth for the long-running drafter Fargate task.
 *
 * The drafter wrapper posts pipeline progress + the final artifact back to compact-EMR via
 * `/api/v1/internal/drafter/*`. It is a higher-privilege caller than the OCR / Doctor Pack
 * workers — it mutates the legal letter artifact, the grade, and the operator-state that
 * decides physician routing. So it uses a SEPARATE secret from `INTERNAL_WORKER_TOKEN`.
 *
 * Blast-radius isolation: an INTERNAL_WORKER_TOKEN leak (OCR + assembler workers) cannot
 * trigger drafting or rewrite a letter. Rotation independent of the worker token.
 *
 * Header: `X-Drafter-Invoke-Token`. Env: `DRAFTER_INVOKE_TOKEN` (Secrets Manager-backed in prod).
 */

const HEADER_NAME = 'x-drafter-invoke-token';

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return timingSafeEqual(aBuf, bBuf);
}

export function requireDrafterPrincipal() {
  return (req: Request, res: Response, next: NextFunction) => {
    // Path-aware guard: this middleware only owns /internal/drafter/*. Skip everything else
    // so the request can reach its proper handler (Cognito routes or service-principal routes).
    if (!req.path.startsWith('/internal/drafter/')) return next();

    const expected = process.env['DRAFTER_INVOKE_TOKEN'];
    if (typeof expected !== 'string' || expected.length < 16) {
      return sendError(res, 503, 'internal_error', 'Drafter-principal authentication not configured on this server.');
    }
    const provided = req.header(HEADER_NAME);
    if (typeof provided !== 'string' || provided.length === 0) {
      return sendError(res, 401, 'unauthorized', 'Missing drafter-principal token.');
    }
    if (!constantTimeStringEqual(provided, expected)) {
      return sendError(res, 401, 'unauthorized', 'Drafter-principal token rejected.');
    }
    (req as Request & { user?: { sub: string; email?: string; roles: readonly ('admin' | 'physician' | 'ops_staff')[] } }).user = {
      sub: SERVICE_ACTORS.DRAFTER,
      email: 'drafter@compact-emr.internal',
      roles: ['ops_staff'],
    };
    next();
  };
}

export const DRAFTER_INVOKE_TOKEN_HEADER = HEADER_NAME;
