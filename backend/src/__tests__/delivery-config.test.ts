import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildStripeLink, isEmailTransportConfigured } from '../services/delivery-config.js';
import { sendEmail } from '../services/mailer.js';

const orig = { l500: process.env.STRIPE_LINK_500, l350: process.env.STRIPE_LINK_350 };

beforeEach(() => {
  process.env.STRIPE_LINK_500 = 'https://buy.stripe.com/link500';
  process.env.STRIPE_LINK_350 = 'https://buy.stripe.com/link350';
});
afterEach(() => {
  if (orig.l500 === undefined) delete process.env.STRIPE_LINK_500; else process.env.STRIPE_LINK_500 = orig.l500;
  if (orig.l350 === undefined) delete process.env.STRIPE_LINK_350; else process.env.STRIPE_LINK_350 = orig.l350;
});

describe('buildStripeLink fee routing', () => {
  it('defaults to the $500 link with client_reference_id appended', () => {
    expect(buildStripeLink('C1')).toBe('https://buy.stripe.com/link500?client_reference_id=CASE_C1');
  });

  it('fee=350 → uses STRIPE_LINK_350', () => {
    expect(buildStripeLink('C1', 350)).toBe('https://buy.stripe.com/link350?client_reference_id=CASE_C1');
  });

  it('fee=500 → uses STRIPE_LINK_500', () => {
    expect(buildStripeLink('C1', 500)).toBe('https://buy.stripe.com/link500?client_reference_id=CASE_C1');
  });

  it('returns null when the matching link env is unset', () => {
    delete process.env.STRIPE_LINK_350;
    expect(buildStripeLink('C1', 350)).toBeNull();
    expect(buildStripeLink('C1', 500)).not.toBeNull();
  });
});

// ── E3 gate truthfulness: the UI banner gate must key on EXACTLY the precondition the real
// transport (mailer.sendEmail) needs — SES_FROM_ADDRESS — so the banner can never lie.
describe('isEmailTransportConfigured agrees with mailer.sendEmail', () => {
  const origEnv = {
    from: process.env.SES_FROM_ADDRESS,
    transport: process.env.DELIVERY_EMAIL_TRANSPORT,
    sesRegion: process.env.SES_REGION,
    resend: process.env.RESEND_API_KEY,
    gmail: process.env.GMAIL_REFRESH_TOKEN,
  };
  afterEach(() => {
    const restore = (key: string, val: string | undefined) => {
      if (val === undefined) delete process.env[key]; else process.env[key] = val;
    };
    restore('SES_FROM_ADDRESS', origEnv.from);
    restore('DELIVERY_EMAIL_TRANSPORT', origEnv.transport);
    restore('SES_REGION', origEnv.sesRegion);
    restore('RESEND_API_KEY', origEnv.resend);
    restore('GMAIL_REFRESH_TOKEN', origEnv.gmail);
  });

  it('is true iff SES_FROM_ADDRESS is set (the precondition sendEmail checks)', () => {
    delete process.env.SES_FROM_ADDRESS;
    expect(isEmailTransportConfigured()).toBe(false);
    process.env.SES_FROM_ADDRESS = 'info@flatratenexus.com';
    expect(isEmailTransportConfigured()).toBe(true);
    process.env.SES_FROM_ADDRESS = '   ';
    expect(isEmailTransportConfigured()).toBe(false);
  });

  it('legacy transport envs (DELIVERY_EMAIL_TRANSPORT/SES_REGION/RESEND_API_KEY/GMAIL_REFRESH_TOKEN) no longer flip the gate', () => {
    delete process.env.SES_FROM_ADDRESS;
    process.env.DELIVERY_EMAIL_TRANSPORT = 'ses';
    process.env.SES_REGION = 'us-east-1';
    process.env.RESEND_API_KEY = 're_test';
    process.env.GMAIL_REFRESH_TOKEN = 'tok';
    // sendEmail would no-op in this state, so the gate must say NOT configured.
    expect(isEmailTransportConfigured()).toBe(false);
  });

  it('when the gate says NOT configured, the REAL sendEmail no-ops loudly (sent:false, reason)', async () => {
    delete process.env.SES_FROM_ADDRESS;
    expect(isEmailTransportConfigured()).toBe(false);
    // The real mailer (no mocks): with SES_FROM_ADDRESS unset it returns before touching SES.
    const r = await sendEmail({ to: 'vet@example.com', subject: 's', textBody: 'b' });
    expect(r.sent).toBe(false);
    expect(r.reason).toContain('SES_FROM_ADDRESS');
  });
});
