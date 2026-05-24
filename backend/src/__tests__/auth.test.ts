import { SignJWT } from 'jose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server.js';

const secret = new TextEncoder().encode('phase1-test-secret');

async function makeJwt(groups: string[], expiresInSeconds = 3600) {
  return new SignJWT({ email: 'admin@example.test', 'cognito:groups': groups })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('test-sub-123')
    .setIssuer('compact-emr-test')
    .setAudience('compact-emr-api')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
    .sign(secret);
}

beforeEach(() => {
  process.env.AUTH_TEST_JWT_SECRET = 'phase1-test-secret';
  process.env.AUTH_TEST_ISSUER = 'compact-emr-test';
  process.env.AUTH_TEST_AUDIENCE = 'compact-emr-api';
});

describe('auth middleware', () => {
  it('allows a valid JWT and populates req.user', async () => {
    const token = await makeJwt(['admin']);
    const res = await request(createApp()).get('/api/v1/health').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ sub: 'test-sub-123', email: 'admin@example.test', roles: ['admin'] });
  });

  it('rejects an expired JWT', async () => {
    const token = await makeJwt(['admin'], -60);
    const res = await request(createApp()).get('/api/v1/health').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('rejects a JWT with no permitted route role', async () => {
    const token = await makeJwt(['billing_only']);
    const res = await request(createApp()).get('/api/v1/health').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('rejects a missing JWT', async () => {
    const res = await request(createApp()).get('/api/v1/health');
    expect(res.status).toBe(401);
  });
});
