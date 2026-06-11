import { SignJWT } from 'jose';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server.js';
import type { AppDb } from '../services/db-types.js';

/**
 * Fix 2 of the sign-off incident (2026-06-09): the error middleware returned HttpErrors with NO
 * log line, so the approve 409s (signer-name gate) were invisible in CloudWatch — the swallowed
 * frontend alert was the only trace. The middleware now console.warn's ONE structured JSON line
 * ({msg:'http_error', method, path, status, code, reason}) for HttpErrors on MUTATING routes
 * (POST/PATCH/PUT/DELETE), with NO PHI (no message prose, no details, no bodies). GETs stay quiet.
 */

const secret = new TextEncoder().encode('error-log-test-secret');

async function makeJwt(groups: string[], sub = 'test-sub-1'): Promise<string> {
  return new SignJWT({ email: 'admin@example.test', 'cognito:groups': groups })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer('compact-emr-test')
    .setAudience('compact-emr-api')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(secret);
}

// Minimal db: a physician_review case with NO sign-off recorded, so POST /letter/approve hits the
// real 409 'sign_off_required' gate (the exact class of error the incident made invisible).
function makeDb(opts: { caseRow?: Record<string, unknown> | null } = {}): AppDb {
  const caseRow = opts.caseRow === undefined
    ? {
        id: 'CASE-1', veteranId: 'VET-1', claimedCondition: 'Lumbosacral strain', status: 'physician_review',
        assignedPhysicianId: 'PHYS-001', assignedRnId: null, currentVersion: 1, version: 3,
        createdAt: new Date(), updatedAt: new Date(),
      }
    : opts.caseRow;
  return {
    case: { findFirst: async () => caseRow },
    fileReadStatus: { findMany: async () => [] },
    signOff: { findMany: async () => [] },
    draftJob: { findMany: async () => [], findFirst: async () => null },
    letterRevision: { findFirst: async () => null },
    physician: { findUnique: async () => null, findFirst: async () => null, findMany: async () => [] },
    appUser: { findUnique: async () => null },
  } as unknown as AppDb;
}

// Structural spy type — keeps this file agnostic to the vitest MockInstance generics.
interface WarnSpy { mock: { calls: unknown[][] } }

function httpErrorLines(warnSpy: WarnSpy): Array<Record<string, unknown>> {
  return warnSpy.mock.calls
    .map((call) => {
      try { return JSON.parse(String(call[0])) as Record<string, unknown>; } catch { return null; }
    })
    .filter((parsed): parsed is Record<string, unknown> => parsed !== null && parsed.msg === 'http_error');
}

let warnSpy: WarnSpy;

beforeEach(() => {
  process.env.AUTH_TEST_JWT_SECRET = 'error-log-test-secret';
  process.env.AUTH_TEST_ISSUER = 'compact-emr-test';
  process.env.AUTH_TEST_AUDIENCE = 'compact-emr-api';
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('server error middleware — structured http_error logging (no silent HttpErrors)', () => {
  it('logs ONE structured http_error line for a 409 HttpError on a MUTATING route (the approve gate)', async () => {
    const token = await makeJwt(['admin']);
    const res = await request(createApp({ db: makeDb() }))
      .post('/api/v1/cases/CASE-1/letter/approve')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('sign_off_required');

    const lines = httpErrorLines(warnSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      msg: 'http_error',
      method: 'POST',
      path: '/api/v1/cases/CASE-1/letter/approve',
      status: 409,
      code: 'conflict',
      reason: 'sign_off_required',
    });
  });

  it('carries NO PHI: the logged line has only {msg,method,path,status,code,reason} — never the human message or details', async () => {
    const token = await makeJwt(['admin']);
    await request(createApp({ db: makeDb() }))
      .post('/api/v1/cases/CASE-1/letter/approve')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    const rawWarnArgs = warnSpy.mock.calls.map((call) => String(call[0]));
    const httpErrorRaw = rawWarnArgs.find((raw) => raw.includes('"http_error"'));
    expect(httpErrorRaw).toBeDefined();
    // The human gate message ('Record the physician sign-off before approving.') can — for other
    // gates — embed physician/veteran names. It must never be logged.
    expect(httpErrorRaw).not.toContain('Record the physician');
    expect(Object.keys(httpErrorLines(warnSpy)[0]).sort()).toEqual(['code', 'method', 'msg', 'path', 'reason', 'status']);
  });

  it('omits reason when details carry none, but still logs method/path/status/code', async () => {
    const token = await makeJwt(['admin']);
    // Case not found -> HttpError(404, details: { caseId }) — no `reason` field.
    const res = await request(createApp({ db: makeDb({ caseRow: null }) }))
      .post('/api/v1/cases/NOPE/letter/approve')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(404);

    const lines = httpErrorLines(warnSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      msg: 'http_error',
      method: 'POST',
      path: '/api/v1/cases/NOPE/letter/approve',
      status: 404,
      code: 'not_found',
    });
  });

  it('GET HttpErrors stay quiet (no http_error line)', async () => {
    const token = await makeJwt(['admin']);
    const res = await request(createApp({ db: makeDb({ caseRow: null }) }))
      .get('/api/v1/cases/UNKNOWN')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(httpErrorLines(warnSpy)).toHaveLength(0);
  });
});
