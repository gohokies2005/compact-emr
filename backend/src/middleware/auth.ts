import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { isRole, type Role } from '../auth/roles.js';
import { sendError } from '../http/errors.js';

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function getBearerToken(req: Request): string | undefined {
  const header = req.header('authorization') ?? req.header('Authorization');
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim();
}

function extractRoles(payload: JWTPayload): Role[] {
  const groupsClaim = payload['cognito:groups'];
  const groups = Array.isArray(groupsClaim) ? groupsClaim : [];
  return groups.filter((value): value is Role => typeof value === 'string' && isRole(value));
}

async function verifyPayload(token: string): Promise<JWTPayload> {
  if (process.env.AUTH_TEST_JWT_SECRET) {
    const secret = new TextEncoder().encode(process.env.AUTH_TEST_JWT_SECRET);
    const { payload } = await jwtVerify(token, secret, {
      issuer: process.env.AUTH_TEST_ISSUER,
      audience: process.env.AUTH_TEST_AUDIENCE,
    });
    return payload;
  }

  const issuer = process.env.COGNITO_ISSUER;
  const audience = process.env.COGNITO_CLIENT_ID;
  if (!issuer || !audience) {
    throw new Error('COGNITO_ISSUER and COGNITO_CLIENT_ID must be set when AUTH_TEST_JWT_SECRET is not configured.');
  }

  jwks ??= createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  const { payload } = await jwtVerify(token, jwks, { issuer, audience });
  return payload;
}

export function authenticateJwt() {
  return async (req: Request, res: Response, next: NextFunction) => {
    // /internal/* routes use service-principal token guards (requireServicePrincipal,
    // requireDrafterPrincipal), not Cognito JWT. authenticateJwt is registered at the
    // /api/v1 prefix on every Cognito-bearing route, so without this skip it would 401
    // every internal-worker request before its real guard could run. Belt-and-suspenders
    // is at API Gateway (authorizer) — this middleware is local defense-in-depth.
    if (req.path.startsWith('/internal/')) return next();

    const token = getBearerToken(req);
    if (!token) {
      return sendError(res, 401, 'unauthorized', 'Missing bearer token.');
    }

    try {
      const payload = await verifyPayload(token);
      const sub = payload.sub;
      if (!sub) {
        return sendError(res, 401, 'unauthorized', 'JWT subject is missing.');
      }

      req.user = {
        sub,
        email: typeof payload.email === 'string' ? payload.email : undefined,
        roles: extractRoles(payload),
      };
      return next();
    } catch {
      return sendError(res, 401, 'unauthorized', 'JWT is invalid or expired.');
    }
  };
}
