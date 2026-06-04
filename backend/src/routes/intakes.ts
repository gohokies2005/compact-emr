import { Router, type Request, type Response } from 'express';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import type { AppDb } from '../services/db-types.js';
import { publishJotformIngest } from '../services/jotform-ingest-queue.js';

const PREVIEW_TTL_SECONDS = 300;

interface IntakesRouterDeps {
  readonly s3?: { send: (cmd: unknown) => Promise<unknown> };
  readonly bucketName?: string | undefined;
}

interface ManifestFile { readonly name?: string; readonly s3Key?: string; readonly contentType?: string; readonly sizeBytes?: number }

/**
 * Intake pool API (the RN's triage queue). list / detail(+signed previews) / dismiss / retry.
 * The ASSIGN endpoint (which creates Documents on a case — the data-plane-sensitive operation) is
 * built separately. See docs/JOTFORM_INTAKE_INGESTION_SPEC.md §6. admin/ops_staff only.
 */
export function createIntakesRouter(db: AppDb, deps: IntakesRouterDeps = {}): Router {
  const router = Router();

  // GET /intakes?status=ready&q=<name|email|phone>  — pool list, newest first.
  router.get('/intakes', requireRole(['admin', 'ops_staff']), asyncHandler(async (req: Request, res: Response) => {
    const status = typeof req.query['status'] === 'string' && (req.query['status'] as string).length > 0 ? (req.query['status'] as string) : undefined;
    const q = typeof req.query['q'] === 'string' ? (req.query['q'] as string).trim() : '';
    const where: Record<string, unknown> = {};
    if (status !== undefined) where['status'] = status;
    if (q.length > 0) {
      where['OR'] = [
        { submittedName: { contains: q, mode: 'insensitive' } },
        { submittedEmail: { contains: q, mode: 'insensitive' } },
        { submittedPhone: { contains: q } },
      ];
    }
    const rows = await db.intake.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
    res.json({ data: rows });
  }));

  // GET /intakes/:id — detail + short-TTL signed preview URLs for each downloaded file.
  router.get('/intakes/:id', requireRole(['admin', 'ops_staff']), asyncHandler(async (req: Request, res: Response) => {
    const row = await db.intake.findUnique({ where: { id: String(req.params.id) } });
    if (row === null) throw new HttpError(404, 'not_found', 'Intake not found.', { intakeId: req.params.id });
    const rawManifest = (row as { fileManifestJson?: unknown }).fileManifestJson;
    const manifest: ManifestFile[] = Array.isArray(rawManifest) ? (rawManifest as ManifestFile[]) : [];
    let files: ManifestFile[] = manifest;
    if (deps.s3 && deps.bucketName) {
      files = await Promise.all(manifest.map(async (f) => {
        if (typeof f?.s3Key !== 'string') return f;
        const url = await getSignedUrl(deps.s3 as never, new GetObjectCommand({ Bucket: deps.bucketName, Key: f.s3Key }) as never, { expiresIn: PREVIEW_TTL_SECONDS });
        return { ...f, previewUrl: url };
      }));
    }
    res.json({ data: { ...row, files } });
  }));

  // POST /intakes/:id/dismiss { reason } — spam/dupe; keep the row for audit.
  router.post('/intakes/:id/dismiss', requireRole(['admin', 'ops_staff']), asyncHandler(async (req: Request, res: Response) => {
    const reason = typeof req.body?.reason === 'string' ? (req.body.reason as string).slice(0, 500) : null;
    const row = await db.intake.findUnique({ where: { id: String(req.params.id) } });
    if (row === null) throw new HttpError(404, 'not_found', 'Intake not found.', { intakeId: req.params.id });
    const updated = await db.intake.update({ where: { id: (row as { id: string }).id }, data: { status: 'dismissed', dismissedReason: reason } });
    res.json({ data: updated });
  }));

  // POST /intakes/:id/retry — re-enqueue a failed/pending fetch (RN self-service, never a silent drop).
  router.post('/intakes/:id/retry', requireRole(['admin', 'ops_staff']), asyncHandler(async (req: Request, res: Response) => {
    const row = await db.intake.findUnique({ where: { id: String(req.params.id) } });
    if (row === null) throw new HttpError(404, 'not_found', 'Intake not found.', { intakeId: req.params.id });
    const r = row as { id: string; jotformFormId: string; jotformSubmissionId: string; retryCount?: number };
    await db.intake.update({ where: { id: r.id }, data: { status: 'pending', errorMessage: null, retryCount: (r.retryCount ?? 0) + 1 } });
    await publishJotformIngest({ intakeId: r.id, formId: r.jotformFormId, submissionId: r.jotformSubmissionId }).catch(() => { /* stays pending for a later re-enqueue */ });
    res.json({ data: { ok: true } });
  }));

  return router;
}
