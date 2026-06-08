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

// LAMBDA BODY PATH — the bug that 400'd every live event + why it shipped. serverless-http sets
// req.apiGateway.event and rebuilds req.body via Buffer.from(event.body,...) — a re-encode that did NOT
// reproduce Stripe's wire bytes. The supertest cases above speak straight to Express, so they NEVER
// exercised this divergence. These cases simulate it: the HTTP body (-> req.body) DIFFERS from the
// original API Gateway event body, and ONLY event.body matches the signature. The fix verifies against
// event.body; reverting it to req.body makes these go RED.
function appWithGatewayEvent(eventBody: string, isBase64Encoded: boolean) {
  process.env.STRIPE_WEBHOOK_SECRET_NAME = 'compact-emr/stripe-webhook-secret';
  const a = express();
  a.use(
    '/api/v1/stripe/webhook',
    express.raw({ type: '*/*' }),
    (req, _res, next) => { (req as unknown as { apiGateway: unknown }).apiGateway = { event: { body: eventBody, isBase64Encoded } }; next(); },
    createStripeWebhookRouter({} as never),
  );
  return a;
}

describe('stripe webhook — verifies ORIGINAL API Gateway event body, not the re-encoded req.body', () => {
  it('text event: verifies when req.body (HTTP body) differs from the signed event body', async () => {
    const { raw, header } = signed(baseSession());
    const res = await request(appWithGatewayEvent(raw, false))
      .post('/api/v1/stripe/webhook').set('stripe-signature', header).set('content-type', 'application/json')
      .send('A DIFFERENT BODY THAN WAS SIGNED -- mimics serverless-http req.body divergence');
    expect(res.status).toBe(200);
    expect(processMock).toHaveBeenCalled();
  });

  it('base64 event: base64-decodes the original event body before verifying', async () => {
    const { raw, header } = signed(baseSession());
    const b64 = Buffer.from(raw, 'utf8').toString('base64');
    const res = await request(appWithGatewayEvent(b64, true))
      .post('/api/v1/stripe/webhook').set('stripe-signature', header).set('content-type', 'application/json')
      .send('garbage req.body');
    expect(res.status).toBe(200);
    expect(processMock).toHaveBeenCalled();
  });
});
