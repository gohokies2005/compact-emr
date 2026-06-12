import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDeliveryPortalRouter, __resetIpThrottle } from '../routes/delivery-portal.js';
import { dobToIso, normalizeInputDob, phoneLast4, verifyIdentity, hashPassword } from '../services/delivery-token.js';
import type { AppDb } from '../services/db-types.js';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://s3.example/presigned'),
}));

// ── verifyIdentity / helpers (the UTC trap is the load-bearing case) ──────────────────────────────
describe('delivery-token identity helpers', () => {
  it('dobToIso reads the UTC calendar date (a @db.Date Date at UTC midnight never shifts a day)', () => {
    // 1980-03-15 stored as @db.Date → UTC midnight. On a Pacific (UTC-8) box, local getters would
    // say March 14 — the architect plan-gate item A bug class. ISO read must be immune.
    expect(dobToIso(new Date('1980-03-15T00:00:00.000Z'))).toBe('1980-03-15');
  });

  it('normalizeInputDob accepts only strict YYYY-MM-DD', () => {
    expect(normalizeInputDob('1980-03-15')).toBe('1980-03-15');
    expect(normalizeInputDob(' 1980-03-15 ')).toBe('1980-03-15');
    expect(normalizeInputDob('3/15/1980')).toBeNull();
    expect(normalizeInputDob('1980-3-15')).toBeNull();
    expect(normalizeInputDob(42)).toBeNull();
    expect(normalizeInputDob(undefined)).toBeNull();
  });

  it('phoneLast4 strips formatting and needs >=4 digits', () => {
    expect(phoneLast4('(702) 555-1234')).toBe('1234');
    expect(phoneLast4('+1 702 555 1234')).toBe('1234');
    expect(phoneLast4('123')).toBeNull();
    expect(phoneLast4(null)).toBeNull();
    expect(phoneLast4('')).toBeNull();
  });

  it('verifyIdentity: both factors must match; fails closed on null/garbled stored phone', () => {
    const stored = { dob: new Date('1980-03-15T00:00:00.000Z'), phone: '(702) 555-1234' };
    expect(verifyIdentity({ dob: '1980-03-15', phoneLast4: '1234' }, stored)).toBe(true);
    expect(verifyIdentity({ dob: '1980-03-16', phoneLast4: '1234' }, stored)).toBe(false);
    expect(verifyIdentity({ dob: '1980-03-15', phoneLast4: '9999' }, stored)).toBe(false);
    expect(verifyIdentity({ dob: '1980-03-15', phoneLast4: '1234' }, { ...stored, phone: null })).toBe(false);
    expect(verifyIdentity({ dob: '1980-03-15', phoneLast4: '1234' }, { ...stored, phone: '12' })).toBe(false);
    expect(verifyIdentity({ dob: undefined, phoneLast4: '1234' }, stored)).toBe(false);
    expect(verifyIdentity({ dob: '1980-03-15', phoneLast4: 1234 }, stored)).toBe(false);
  });
});

// ── Portal routes ──────────────────────────────────────────────────────────────────────────────
const VET: { id: string; dob: Date; phone: string | null } = { id: 'V1', dob: new Date('1980-03-15T00:00:00.000Z'), phone: '(702) 555-1234' };

function makeApp(token: Record<string, unknown> | null, over: { vet?: typeof VET | null } = {}) {
  const tokenUpdate = vi.fn(async () => ({}));
  const activity = vi.fn(async () => ({}));
  const db = {
    deliveryToken: {
      findUnique: vi.fn(async () => token),
      update: tokenUpdate,
    },
    case: { findFirst: vi.fn(async () => ({ veteranId: 'V1' })) },
    veteran: { findUnique: vi.fn(async () => (over.vet !== undefined ? over.vet : VET)) },
    activityLog: { create: activity },
  } as unknown as AppDb;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/delivery', createDeliveryPortalRouter(db, { bucketName: 'phi-bucket', s3: {} as never }));
  return { app, tokenUpdate, activity };
}

const future = new Date(Date.now() + 86400_000);
const identityToken = { id: 'T1', caseId: 'C1', token: 'tok1', passwordHash: null, failedAttempts: 0, lockedAt: null, expiresAt: future, pdfS3Key: 'drafter-artifacts/C1/v5/letter.pdf' };
const legacyToken = { ...identityToken, passwordHash: hashPassword('Abc234xyz') };

describe('delivery portal — identity mode', () => {
  beforeEach(() => { vi.clearAllMocks(); __resetIpThrottle(); });

  it('GET reports mode=identity + valid for an identity token', async () => {
    const { app } = makeApp(identityToken);
    const r = await request(app).get('/api/v1/delivery/tok1');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ valid: true, mode: 'identity', locked: false });
  });

  it('GET reports mode=password for a legacy token (old links keep working)', async () => {
    const { app } = makeApp(legacyToken);
    const r = await request(app).get('/api/v1/delivery/tok1');
    expect(r.body.data.mode).toBe('password');
  });

  it('GET reports locked + invalid for a locked token', async () => {
    const { app } = makeApp({ ...identityToken, lockedAt: new Date() });
    const r = await request(app).get('/api/v1/delivery/tok1');
    expect(r.body.data).toMatchObject({ valid: false, locked: true });
  });

  it('unlock succeeds with correct DOB + phone last-4 → presigned url + counter reset', async () => {
    const { app, tokenUpdate } = makeApp(identityToken);
    const r = await request(app).post('/api/v1/delivery/tok1/unlock').send({ dob: '1980-03-15', phoneLast4: '1234' });
    expect(r.status).toBe(200);
    expect(r.body.data.url).toBe('https://s3.example/presigned');
    expect(tokenUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ failedAttempts: 0 }) }));
  });

  it('wrong factor → 401 with a message that never reveals WHICH factor failed; attempts increment', async () => {
    const { app, tokenUpdate } = makeApp(identityToken);
    const r = await request(app).post('/api/v1/delivery/tok1/unlock').send({ dob: '1980-03-15', phoneLast4: '9999' });
    expect(r.status).toBe(401);
    expect(r.body.error).not.toMatch(/phone only|dob only|date of birth was wrong/i);
    expect(tokenUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ failedAttempts: 1 }) }));
  });

  it('5th failure locks the token (lockedAt set + 423 + alert breadcrumb)', async () => {
    const { app, tokenUpdate, activity } = makeApp({ ...identityToken, failedAttempts: 4 });
    const r = await request(app).post('/api/v1/delivery/tok1/unlock').send({ dob: '1980-03-15', phoneLast4: '9999' });
    expect(r.status).toBe(423);
    expect(tokenUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ failedAttempts: 5, lockedAt: expect.any(Date) }) }));
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'delivery_unlock_locked' }) }));
  });

  it('locked token → 423 with the support fallback, no verification attempted', async () => {
    const { app, tokenUpdate } = makeApp({ ...identityToken, lockedAt: new Date() });
    const r = await request(app).post('/api/v1/delivery/tok1/unlock').send({ dob: '1980-03-15', phoneLast4: '1234' });
    expect(r.status).toBe(423);
    expect(r.body.error).toMatch(/info@flatratenexus\.com/);
    expect(tokenUpdate).not.toHaveBeenCalled();
  });

  it('expired token → 410', async () => {
    const { app } = makeApp({ ...identityToken, expiresAt: new Date(Date.now() - 1000) });
    const r = await request(app).post('/api/v1/delivery/tok1/unlock').send({ dob: '1980-03-15', phoneLast4: '1234' });
    expect(r.status).toBe(410);
  });

  it('legacy password token still unlocks with the password (and ignores identity fields)', async () => {
    const { app } = makeApp(legacyToken);
    const r = await request(app).post('/api/v1/delivery/tok1/unlock').send({ password: 'Abc234xyz' });
    expect(r.status).toBe(200);
    expect(r.body.data.url).toBe('https://s3.example/presigned');
  });

  it('legacy password token rejects a wrong password (401) and increments attempts', async () => {
    const { app, tokenUpdate } = makeApp(legacyToken);
    const r = await request(app).post('/api/v1/delivery/tok1/unlock').send({ password: 'nope' });
    expect(r.status).toBe(401);
    expect(tokenUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ failedAttempts: 1 }) }));
  });

  it('identity unlock fails closed when the veteran has no phone on file', async () => {
    const { app } = makeApp(identityToken, { vet: { ...VET, phone: null } });
    const r = await request(app).post('/api/v1/delivery/tok1/unlock').send({ dob: '1980-03-15', phoneLast4: '1234' });
    expect(r.status).toBe(401);
  });

  it('cross-token abuse: >10 unlock attempts from one IP inside a minute → 429 (per-IP throttle)', async () => {
    const { app } = makeApp(identityToken);
    let lastStatus = 0;
    for (let i = 0; i < 11; i += 1) {
      // Different token per request — the per-token lockout never trips; only the IP throttle can.
      const r = await request(app).post(`/api/v1/delivery/tok${i}/unlock`).send({ dob: '1990-01-01', phoneLast4: '0000' });
      lastStatus = r.status;
    }
    expect(lastStatus).toBe(429);
  });
});
