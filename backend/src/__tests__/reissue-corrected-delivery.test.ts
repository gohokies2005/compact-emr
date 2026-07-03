import { describe, expect, it, vi, beforeEach } from 'vitest';
import { reissueCorrectedDelivery } from '../services/payment-delivery.js';
import type { AppDb } from '../services/db-types.js';

const sendEmail = vi.fn(async () => ({ sent: true, messageId: 'm1' }));
vi.mock('../services/mailer.js', () => ({ sendEmail: (...a: unknown[]) => sendEmail(...(a as [])) }));

// Isolate the reissue orchestration from the byte/sign-off gate — that gate has its own suite.
type Eligibility = { eligible: boolean; details?: Record<string, unknown>; reason?: string };
const assertDeliveryEligible = vi.fn(async (): Promise<Eligibility> => ({ eligible: true, details: {} }));
vi.mock('../services/delivery-eligibility.js', () => ({ assertDeliveryEligible: (...a: unknown[]) => assertDeliveryEligible(...(a as [])) }));

interface Over {
  noCase?: boolean;
  currentVersion?: number;
  caseStatus?: string;
  latestToken?: { token: string; letterVersion: number; expiresAt: Date; createdAt: Date } | null;
  deliveredLog?: { id: string } | null;
  paidRow?: boolean;
  noEmail?: boolean;
}

function makeDb(over: Over = {}) {
  const curV = over.currentVersion ?? 8;
  const calls = {
    tokenCreate: vi.fn(async () => ({})),
    tokenUpdateMany: vi.fn(async () => ({ count: 1 })),
    caseUpdate: vi.fn(async () => ({})),
    activityCreate: vi.fn(async () => ({})),
  };
  const defaultToken = { token: 'tok-old', letterVersion: 7, expiresAt: new Date(Date.now() + 1e9), createdAt: new Date(Date.now() - 1e6) };
  const delegates = {
    case: {
      findFirst: vi.fn(async () => (over.noCase ? null : { id: 'C1', veteranId: 'V1', currentVersion: curV, status: over.caseStatus ?? 'delivered' })),
      update: calls.caseUpdate,
    },
    deliveryToken: {
      findFirst: vi.fn(async () => (over.latestToken !== undefined ? over.latestToken : defaultToken)),
      updateMany: calls.tokenUpdateMany,
      create: calls.tokenCreate,
    },
    letterRevision: { findFirst: vi.fn(async () => ({ version: curV, artifactPdfS3Key: `letter-revisions/C1/v${curV}/letter.pdf` })) },
    draftJob: { findMany: vi.fn(async () => []) },
    veteran: { findUnique: vi.fn(async () => ({ email: over.noEmail ? undefined : 'vet@example.com', firstName: 'Sam', phone: '(702) 555-1234' })) },
    payment: { findFirst: vi.fn(async () => (over.paidRow === false ? null : { id: 'P', status: 'paid' })) },
    activityLog: { findFirst: vi.fn(async () => over.deliveredLog ?? null), create: calls.activityCreate },
  };
  const db = { ...delegates, $transaction: vi.fn(async (fn: (tx: typeof delegates) => unknown) => fn(delegates)) } as unknown as AppDb;
  return { db, calls };
}

const cfg = { portalBaseUrl: 'https://emr.flatratenexus.com', s3: {} as never, bucketName: 'bucket' };
const input = { caseId: 'C1', actorUserId: 'U1' };

describe('reissueCorrectedDelivery', () => {
  beforeEach(() => {
    sendEmail.mockClear();
    assertDeliveryEligible.mockReset();
    assertDeliveryEligible.mockResolvedValue({ eligible: true, details: {} });
  });

  it('NEW corrected version → expires old, mints a corrected token, emails, returns reissued', async () => {
    const { db, calls } = makeDb({ currentVersion: 8, latestToken: { token: 'tok-old', letterVersion: 7, expiresAt: new Date(Date.now() + 1e9), createdAt: new Date() } });
    const r = await reissueCorrectedDelivery(db, input, cfg);
    expect(r.status).toBe('reissued');
    expect(r.version).toBe(8);
    expect(calls.tokenUpdateMany).toHaveBeenCalledTimes(1); // stale tokens expired
    expect(calls.tokenCreate).toHaveBeenCalledTimes(1);     // fresh corrected token minted
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('SAME version already delivered → no-op already_current (no new token, NO email)', async () => {
    const { db, calls } = makeDb({
      currentVersion: 8,
      latestToken: { token: 'tok-cur', letterVersion: 8, expiresAt: new Date(Date.now() + 1e9), createdAt: new Date() },
      deliveredLog: { id: 'L1' }, // a payment_delivered / prior publish breadcrumb exists
    });
    const r = await reissueCorrectedDelivery(db, input, cfg);
    expect(r.status).toBe('already_current');
    expect(calls.tokenCreate).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('SAME version NOT yet delivered (prior email failed) → self-heals by re-sending for the SAME token', async () => {
    const { db, calls } = makeDb({
      currentVersion: 8,
      latestToken: { token: 'tok-cur', letterVersion: 8, expiresAt: new Date(Date.now() + 1e9), createdAt: new Date() },
      deliveredLog: null, // no success breadcrumb → the token was minted but never emailed
    });
    const r = await reissueCorrectedDelivery(db, input, cfg);
    expect(r.status).toBe('reissued');
    expect(calls.tokenCreate).not.toHaveBeenCalled(); // reuse the existing token, don't mint a new one
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('no prior delivery token → no_prior_delivery (never delivers an unpaid letter)', async () => {
    const { db } = makeDb({ latestToken: null });
    const r = await reissueCorrectedDelivery(db, input, cfg);
    expect(r.status).toBe('no_prior_delivery');
  });

  it('legacy sign-off with no bound content hash (byteCheckSkipped) → ineligible (fail-CLOSED)', async () => {
    assertDeliveryEligible.mockResolvedValue({ eligible: true, details: { byteCheckSkipped: true } });
    const { db, calls } = makeDb({ currentVersion: 8 });
    const r = await reissueCorrectedDelivery(db, input, cfg);
    expect(r.status).toBe('ineligible');
    expect(calls.tokenCreate).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('ineligible sign-off (not re-signed) → ineligible, nothing minted or sent', async () => {
    assertDeliveryEligible.mockResolvedValue({ eligible: false, reason: 'signed_bytes_changed' });
    const { db, calls } = makeDb({ currentVersion: 8 });
    const r = await reissueCorrectedDelivery(db, input, cfg);
    expect(r.status).toBe('ineligible');
    expect(calls.tokenCreate).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
