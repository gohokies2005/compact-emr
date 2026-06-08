import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildStripeLink } from '../services/delivery-config.js';

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
