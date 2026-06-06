import { createHmac, timingSafeEqual } from 'node:crypto';

// Verify a Stripe webhook signature WITHOUT the SDK (dependency-free + unit-testable). Mirrors Stripe's
// documented scheme exactly: the `Stripe-Signature` header is `t=<unix>,v1=<hexsig>[,v1=...]`; the
// signed payload is `${t}.${rawBody}`; the expected signature is HMAC-SHA256(signed_payload, secret).
// We constant-time-compare and enforce a timestamp tolerance window to block replay. CRITICAL: rawBody
// must be the EXACT bytes Stripe sent — the webhook route uses express.raw(), never express.json()
// (a re-stringified body changes whitespace/key-order and the signature fails).
export interface SigVerifyResult { readonly ok: boolean; readonly reason?: string }

export function verifyStripeSignature(
  rawBody: string,
  sigHeader: string | undefined,
  secret: string,
  nowSec: number,
  toleranceSec = 300,
): SigVerifyResult {
  if (!sigHeader) return { ok: false, reason: 'missing signature header' };
  if (!secret) return { ok: false, reason: 'no webhook secret configured' };
  const parts = sigHeader.split(',').map((p) => p.trim());
  const t = parts.find((p) => p.startsWith('t='))?.slice(2);
  const v1s = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || v1s.length === 0) return { ok: false, reason: 'malformed signature header' };
  const ts = Number.parseInt(t, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' };
  if (Math.abs(nowSec - ts) > toleranceSec) return { ok: false, reason: 'timestamp outside tolerance' };

  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest();
  const match = v1s.some((sig) => {
    let sigBuf: Buffer;
    try { sigBuf = Buffer.from(sig, 'hex'); } catch { return false; }
    return sigBuf.length === expected.length && timingSafeEqual(sigBuf, expected);
  });
  return match ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}
