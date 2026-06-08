import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { verifyStripeSignature } from '../services/stripe-signature.js';
import { readSecretByName } from '../services/mailer.js';
import { parseCaseRef, processStripePayment } from '../services/payment-delivery.js';
import type { AppDb } from '../services/db-types.js';

// PUBLIC Stripe webhook (no Cognito; the SIGNATURE is the auth). Mounted with express.raw() so the body
// is the exact bytes Stripe signed. Verifies the signature against the operator-populated webhook secret
// (Secrets Manager, read by NAME at runtime), then hands a paid checkout session to the delivery
// orchestration. Always returns 200 on a handled event so Stripe doesn't retry a non-error no-op.
export function createStripeWebhookRouter(db: AppDb): Router {
  const router = Router();
  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : (typeof req.body === 'string' ? req.body : '');
    const secret = await readSecretByName(process.env.STRIPE_WEBHOOK_SECRET_NAME);
    const verify = verifyStripeSignature(raw, req.header('stripe-signature'), secret, Math.floor(Date.now() / 1000));
    if (!verify.ok) { res.status(400).json({ error: 'signature verification failed', reason: verify.reason }); return; }

    let event: { type?: string; data?: { object?: Record<string, unknown> } };
    // Signature already verified above, so a parse failure is bizarre — return 200 (not 400) so Stripe
    // doesn't retry an unparseable event for 3 days. (architect)
    try { event = JSON.parse(raw); } catch { res.json({ received: true, reason: 'unparseable body' }); return; }
    if (event.type !== 'checkout.session.completed') { res.json({ received: true, ignored: event.type ?? 'unknown' }); return; }

    const session = event.data?.object ?? {};
    if (session['payment_status'] !== undefined && session['payment_status'] !== 'paid') { res.json({ received: true, reason: 'not paid' }); return; }
    // CURRENCY GUARD: amount_total is in the smallest unit of `currency`. We only recognize fixed USD
    // cent amounts (50000/35000/5000). A non-USD session whose smallest-unit amount happens to equal
    // one of those (e.g. 50000 in another currency) must NEVER auto-deliver a PDF. Require USD before
    // treating the amount as valid; otherwise 200-and-ignore (Stripe must not retry a deliberate no-op).
    const currency = typeof session['currency'] === 'string' ? (session['currency'] as string).toLowerCase() : undefined;
    if (currency !== 'usd') {
      console.warn(`[stripe-webhook] ignoring non-USD session: currency=${currency ?? 'missing'} ref=${String(session['client_reference_id'] ?? '')}`);
      res.json({ received: true, ignored: 'currency', reason: `unrecognized currency: ${currency ?? 'missing'}` });
      return;
    }
    const caseId = parseCaseRef(session['client_reference_id'] as string | undefined);
    const amountCents = typeof session['amount_total'] === 'number' ? (session['amount_total'] as number) : 0;
    const chargeId = String(session['payment_intent'] ?? session['id'] ?? '');
    if (!caseId || !chargeId) { res.json({ received: true, reason: 'missing case ref or charge id' }); return; }

    const result = await processStripePayment(db, { caseId, amountCents, chargeId }, {
      portalBaseUrl: process.env.DELIVERY_PORTAL_BASE_URL ?? 'https://emr.flatratenexus.com',
      ...(process.env.DELIVERY_ADMIN_BCC ? { adminBcc: process.env.DELIVERY_ADMIN_BCC } : {}),
    });
    res.json({ received: true, result: result.status });
  }));
  return router;
}
