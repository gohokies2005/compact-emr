import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { sendError } from '../http/errors.js';

/**
 * Phase 7B-revised Build 3: service-principal auth for worker callbacks.
 *
 * The OCR worker (Phase 7A Lambda) and Doctor Pack assembler (Phase 7A Lambda) need to POST
 * results back to the API: per-page extracted text, read-attempt outcomes, doctor-pack state
 * transitions. They are NOT Cognito-authenticated users — they are AWS service principals
 * holding a shared secret managed by Secrets Manager.
 *
 * This middleware validates the `X-Internal-Worker-Token` header against the
 * `INTERNAL_WORKER_TOKEN` env var (Secrets Manager-backed in production). Constant-time
 * compare to defend against timing attacks. On success, stamps `req.user` with a sentinel
 * service-principal identity so downstream activity-log writes have an actor.
 *
 * Why not JWT: the workers are infrastructure, not user-facing; a shared-secret with
 * Secrets Manager rotation is simpler than a second JWT issuer + key distribution. Routes
 * mounted under this middleware are only available on the internal API path
 * (`/api/v1/internal/*`), which API Gateway / Lambda authorizer can geo-restrict to the
 * worker VPC if needed.
 */

const HEADER_NAME = 'x-internal-worker-token';

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return timingSafeEqual(aBuf, bBuf);
}

export function requireServicePrincipal() {
  return (req: Request, res: Response, next: NextFunction) => {
    const expected = process.env['INTERNAL_WORKER_TOKEN'];
    if (typeof expected !== 'string' || expected.length < 16) {
      // Fail closed when the secret isn't configured. Better to 503 than to accept anything.
      return sendError(res, 503, 'internal_error', 'Service-principal authentication not configured on this server.');
    }
    const provided = req.header(HEADER_NAME);
    if (typeof provided !== 'string' || provided.length === 0) {
      return sendError(res, 401, 'unauthorized', 'Missing service-principal token.');
    }
    if (!constantTimeStringEqual(provided, expected)) {
      return sendError(res, 401, 'unauthorized', 'Service-principal token rejected.');
    }
    // Stamp a sentinel user so activity_log rows have an actor.
    (req as Request & { user?: { sub: string; email?: string; roles: readonly ('admin' | 'physician' | 'ops_staff')[] } }).user = {
      sub: 'service:worker',
      email: 'worker@compact-emr.internal',
      roles: ['ops_staff'],
    };
    next();
  };
}

export const INTERNAL_WORKER_TOKEN_HEADER = HEADER_NAME;
