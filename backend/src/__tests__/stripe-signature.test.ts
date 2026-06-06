import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyStripeSignature } from '../services/stripe-signature.js';
import { generatePassword, generateToken, hashPassword, verifyPassword } from '../services/delivery-token.js';

function sign(body: string, secret: string, t: number): string {
  const sig = createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex');
  return `t=${t},v1=${sig}`;
}

describe('stripe signature verification', () => {
  const secret = 'whsec_test_abc123';
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const now = 1_700_000_000;

  it('accepts a correctly-signed payload', () => {
    expect(verifyStripeSignature(body, sign(body, secret, now), secret, now).ok).toBe(true);
  });
  it('rejects the WRONG secret', () => {
    const r = verifyStripeSignature(body, sign(body, 'whsec_other', now), secret, now);
    expect(r.ok).toBe(false); expect(r.reason).toMatch(/mismatch/);
  });
  it('rejects a TAMPERED body (signature was over the original)', () => {
    const header = sign(body, secret, now);
    expect(verifyStripeSignature(body + 'X', header, secret, now).ok).toBe(false);
  });
  it('rejects a STALE timestamp (replay window)', () => {
    const r = verifyStripeSignature(body, sign(body, secret, now - 10_000), secret, now);
    expect(r.ok).toBe(false); expect(r.reason).toMatch(/tolerance/);
  });
  it('rejects a missing / malformed header', () => {
    expect(verifyStripeSignature(body, undefined, secret, now).ok).toBe(false);
    expect(verifyStripeSignature(body, 'garbage', secret, now).ok).toBe(false);
  });
});

describe('delivery token + password', () => {
  it('mints unguessable, distinct tokens', () => {
    const a = generateToken(); const b = generateToken();
    expect(a).not.toBe(b); expect(a.length).toBeGreaterThan(40);
  });
  it('generates a password from the unambiguous alphabet (no 0/O/1/l/I)', () => {
    const pw = generatePassword(12);
    expect(pw).toHaveLength(12); expect(pw).not.toMatch(/[0O1lI]/);
  });
  it('verifies the right password and rejects the wrong one (constant-time)', () => {
    const pw = generatePassword();
    const hash = hashPassword(pw);
    expect(verifyPassword(pw, hash)).toBe(true);
    expect(verifyPassword(`${pw}x`, hash)).toBe(false);
    expect(verifyPassword(pw, 'not-hex-garbage')).toBe(false);
  });
});
