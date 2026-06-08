import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createStripeWebhookRouter } from '../routes/stripe-webhook.js';
import { processStripePayment } from '../services/payment-delivery.js';

// Verify the route's GUARDS (signature already covered by stripe-signature.test): currency guard +
// dispatch into processStripePayment. Mock the secret read + the delivery orchestration.
vi.mock('../services/mailer.js', () => ({ readSecretByName: vi.fn(async () => 'whsec_test') }));
vi.mock('../services/payment-delivery.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, processStripePayment: vi.fn(async () => ({ status: 'delivered' })) };
});
const processMock = vi.mocked(processStripePayment);

const SECRET = 'whsec_test';

function signed(body: object): { raw: string; header: string } {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', SECRET).update(`${t}.${raw}`, 'utf8').digest('hex');
  return { raw, header: `t=${t},v1=${sig}` };
}

function app() {
  process.env.STRIPE_WEBHOOK_SECRET_NAME = 'compact-emr/stripe-webhook-secret';
  const a = express();
  a.use('/api/v1/stripe/webhook', express.raw({ type: '*/*' }), createStripeWebhookRouter({} as never));
  return a;
}

function post(body: object) {
  const { raw, header } = signed(body);
  return request(app()).post('/api/v1/stripe/webhook').set('stripe-signature', header).set('content-type', 'application/json').send(raw);
}

const baseSession = (over: Record<string, unknown> = {}) => ({
  type: 'checkout.session.completed',
  data: { object: { payment_status: 'paid', client_reference_id: 'CASE_C1', amount_total: 50000, currency: 'usd', payment_intent: 'pi_1', ...over } },
});

beforeEach(() => { processMock.mockClear(); processMock.mockResolvedValue({ status: 'delivered' }); });

describe('stripe webhook currency guard', () => {
  it('USD paid session → dispatches to processStripePayment', async () => {
    const res = await post(baseSession()).expect(200);
    expect(res.body.result).toBe('delivered');
    expect(processMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ caseId: 'C1', amountCents: 50000 }), expect.anything());
  });

  it('accepts USD case-insensitively', async () => {
    await post(baseSession({ currency: 'USD' })).expect(200);
    expect(processMock).toHaveBeenCalled();
  });

  it('non-USD currency → 200 ignored, NEVER delivers', async () => {
    const res = await post(baseSession({ currency: 'eur', amount_total: 50000 })).expect(200);
    expect(res.body.ignored).toBe('currency');
    expect(processMock).not.toHaveBeenCalled();
  });

  it('missing currency → 200 ignored, NEVER delivers', async () => {
    const s = baseSession();
    delete (s.data.object as Record<string, unknown>).currency;
    const res = await post(s).expect(200);
    expect(res.body.ignored).toBe('currency');
    expect(processMock).not.toHaveBeenCalled();
  });
});
