import { Router, type Request, type Response } from 'express';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { asyncHandler } from '../http/async-handler.js';
import { verifyPassword, verifyIdentity } from '../services/delivery-token.js';
import type { AppDb } from '../services/db-types.js';

// PUBLIC delivery portal (no Cognito — the token IS the link auth). Two unlock modes
// (HIPAA audit APP-1 fix, Ryan 2026-06-11):
//   identity (passwordHash NULL):  veteran proves DOB + phone last-4 — data they already know;
//                                  the email carries ONLY the link, nothing secret in transit.
//   password (passwordHash set):   legacy tokens minted before the fix — still honored.
// Lockout: 5 failed unlocks → locked_at set → 423 with the out-of-band support path. The counter
// resets on success so a fat-fingered veteran never ratchets toward a permanent lock.
const LOCKOUT_THRESHOLD = 5;

// Coarse in-process IP throttle on /unlock (architect plan-gate item C): per-token lockout alone
// leaves cross-token abuse unthrottled — a script could walk lockouts across many tokens. In-memory
// fixed window, fail-open on cold start; proportionate for FRN volume (no WAF exists).
const IP_WINDOW_MS = 60_000;
const IP_MAX_ATTEMPTS = 10;
const ipHits = new Map<string, { count: number; windowStart: number }>();
/** Test hook: the throttle map is module state and would make suites order-dependent. */
export function __resetIpThrottle(): void { ipHits.clear(); }
function ipThrottled(ip: string): boolean {
  const now = Date.now();
  const h = ipHits.get(ip);
  if (h === undefined || now - h.windowStart >= IP_WINDOW_MS) {
    ipHits.set(ip, { count: 1, windowStart: now });
    if (ipHits.size > 10_000) ipHits.clear(); // unbounded-growth guard; throttle is best-effort
    return false;
  }
  h.count += 1;
  return h.count > IP_MAX_ATTEMPTS;
}

const SUPPORT_FALLBACK =
  'For your security this link is now locked. Reply to your delivery email or write to info@flatratenexus.com and our team will verify your identity and help you download your letter.';

export function createDeliveryPortalRouter(db: AppDb, deps: { bucketName?: string; s3?: S3Client }): Router {
  const router = Router();
  const PRESIGN_TTL = 300;

  router.get('/:token', asyncHandler(async (req: Request, res: Response) => {
    const t = await db.deliveryToken.findUnique({ where: { token: String(req.params.token) } });
    if (t === null) { res.status(404).json({ data: { valid: false, reason: 'not_found' } }); return; }
    const expired = new Date(t.expiresAt).getTime() < Date.now();
    const locked = t.lockedAt !== null;
    res.json({
      data: {
        valid: !expired && !locked,
        expired,
        locked,
        // Drives which unlock form the SPA renders (DOB+phone vs legacy password).
        mode: t.passwordHash === null ? 'identity' : 'password',
      },
    });
  }));

  router.post('/:token/unlock', asyncHandler(async (req: Request, res: Response) => {
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.ip || 'unknown';
    if (ipThrottled(ip)) { res.status(429).json({ error: 'Too many attempts. Please wait a minute and try again.' }); return; }

    const token = String(req.params.token);
    const body = (req.body ?? {}) as { password?: unknown; dob?: unknown; phoneLast4?: unknown };
    const t = await db.deliveryToken.findUnique({ where: { token } });
    if (t === null) { res.status(404).json({ error: 'invalid link' }); return; }
    if (new Date(t.expiresAt).getTime() < Date.now()) { res.status(410).json({ error: 'this link has expired' }); return; }
    if (t.lockedAt !== null) { res.status(423).json({ error: SUPPORT_FALLBACK }); return; }

    let ok: boolean;
    let failMessage: string;
    if (t.passwordHash === null) {
      // Identity mode: BOTH factors verified constant-time against the Veteran row. The failure
      // message never reveals WHICH factor was wrong.
      const c = await db.case.findFirst({ where: { id: t.caseId }, select: { veteranId: true } as never }) as { veteranId: string } | null;
      const vet = c !== null
        ? await db.veteran.findUnique({ where: { id: c.veteranId } }) as { dob: Date; phone: string | null } | null
        : null;
      ok = vet !== null && verifyIdentity({ dob: body.dob, phoneLast4: body.phoneLast4 }, { dob: vet.dob, phone: vet.phone });
      failMessage = 'That information doesn’t match what we have on file. Please check your date of birth and the last 4 digits of your phone number.';
    } else {
      const password = typeof body.password === 'string' ? body.password : '';
      ok = verifyPassword(password, t.passwordHash);
      failMessage = 'incorrect password';
    }

    if (!ok) {
      const attempts = t.failedAttempts + 1;
      const lock = attempts >= LOCKOUT_THRESHOLD;
      await db.deliveryToken.update({
        where: { token },
        data: { failedAttempts: attempts, ...(lock ? { lockedAt: new Date() } : {}) },
      });
      if (lock) {
        // Loud breadcrumb: staff sees the lock and reaches out (the legitimate veteran may be the
        // one fat-fingering — or someone with the link is guessing). No PHI in the details.
        await db.activityLog.create({
          data: { actorUserId: 'service:delivery-portal', action: 'delivery_unlock_locked', caseId: t.caseId, detailsJson: { tokenId: t.id, attempts } },
        }).catch(() => undefined);
        res.status(423).json({ error: SUPPORT_FALLBACK });
        return;
      }
      res.status(401).json({ error: failMessage });
      return;
    }

    if (!deps.s3 || !deps.bucketName) { res.status(503).json({ error: 'delivery storage not configured' }); return; }
    const url = await getSignedUrl(deps.s3, new GetObjectCommand({ Bucket: deps.bucketName, Key: t.pdfS3Key }), { expiresIn: PRESIGN_TTL });
    await db.deliveryToken.update({
      where: { token },
      data: { downloadCount: { increment: 1 }, lastAccessedAt: new Date(), failedAttempts: 0 },
    });
    res.json({ data: { url } });
  }));

  return router;
}
