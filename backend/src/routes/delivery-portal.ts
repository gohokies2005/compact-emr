import { Router, type Request, type Response } from 'express';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { asyncHandler } from '../http/async-handler.js';
import { verifyPassword } from '../services/delivery-token.js';
import type { AppDb } from '../services/db-types.js';

// PUBLIC password-protected delivery portal (no Cognito — the token + password ARE the auth). The
// veteran visits /d/<token>, the page checks validity (GET), then submits the emailed password (POST)
// to receive a short-lived presigned S3 URL to the signed letter PDF.
export function createDeliveryPortalRouter(db: AppDb, deps: { bucketName?: string; s3?: S3Client }): Router {
  const router = Router();
  const PRESIGN_TTL = 300;

  router.get('/:token', asyncHandler(async (req: Request, res: Response) => {
    const t = await db.deliveryToken.findUnique({ where: { token: String(req.params.token) }, select: { id: true, expiresAt: true } as never });
    if (t === null) { res.status(404).json({ data: { valid: false, reason: 'not_found' } }); return; }
    const expired = new Date(t.expiresAt).getTime() < Date.now();
    res.json({ data: { valid: !expired, expired } });
  }));

  router.post('/:token/unlock', asyncHandler(async (req: Request, res: Response) => {
    const token = String(req.params.token);
    const body = (req.body ?? {}) as { password?: unknown };
    const password = typeof body.password === 'string' ? body.password : '';
    const t = await db.deliveryToken.findUnique({ where: { token } });
    if (t === null) { res.status(404).json({ error: 'invalid link' }); return; }
    if (new Date(t.expiresAt).getTime() < Date.now()) { res.status(410).json({ error: 'this link has expired' }); return; }
    if (!verifyPassword(password, t.passwordHash)) { res.status(401).json({ error: 'incorrect password' }); return; }
    if (!deps.s3 || !deps.bucketName) { res.status(503).json({ error: 'delivery storage not configured' }); return; }
    const url = await getSignedUrl(deps.s3, new GetObjectCommand({ Bucket: deps.bucketName, Key: t.pdfS3Key }), { expiresIn: PRESIGN_TTL });
    await db.deliveryToken.update({ where: { token }, data: { downloadCount: { increment: 1 }, lastAccessedAt: new Date() } });
    res.json({ data: { url } });
  }));

  return router;
}
