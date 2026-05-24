import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { isRole, type Role } from '../auth/roles.js';

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
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'missing_bearer_token' });
    }

    try {
      const payload = await verifyPayload(token);
      const sub = payload.sub;
      if (!sub) {
        return res.status(401).json({ error: 'missing_subject' });
      }

      req.user = {
        sub,
        email: typeof payload.email === 'string' ? payload.email : undefined,
        roles: extractRoles(payload),
      };
      return next();
    } catch {
      return res.status(401).json({ error: 'invalid_token' });
    }
  };
}
