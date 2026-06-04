import { Router, type Request, type Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { asyncHandler } from '../http/async-handler.js';
import type { AppDb } from '../services/db-types.js';
import { publishJotformIngest } from '../services/jotform-ingest-queue.js';

// Constant-time secret compare. timingSafeEqual needs equal-length buffers, so compare SHA-256
// digests (fixed 32 bytes) rather than raw strings — also avoids leaking the secret length.
function secretMatches(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

/**
 * Public, secret-gated Jotform webhook (the "doorbell"). Mounted BEFORE authenticateJwt with its
 * own urlencoded parser (Jotform POSTs urlencoded/multipart). It does the minimum and returns 200
 * fast so Jotform never retries on our slowness; the ingest worker fetches the authoritative
 * submission + files by ID. See docs/JOTFORM_INTAKE_INGESTION_SPEC.md §2.
 *
 * Mount: app.use('/api/v1/jotform/webhook', urlencoded, createJotformWebhookRouter(db))
 * Full path: POST /api/v1/jotform/webhook/:secret
 */
export function createJotformWebhookRouter(db: AppDb): Router {
  const router = Router();

  router.post('/:secret', asyncHandler(async (req: Request, res: Response) => {
    const expected = process.env['JOTFORM_WEBHOOK_SECRET'];
    // Not configured or mismatch → 404 (don't reveal the endpoint exists). A spoofed call that
    // somehow guessed the path still can't get past the secret; and even if it did, the worker
    // re-validates the submissionId against the Jotform API, so a fake doorbell is a no-op.
    if (!expected || expected.length === 0 || !secretMatches(String(req.params.secret ?? ''), expected)) {
      res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const formId = String(body['formID'] ?? body['formId'] ?? '').trim();
    const submissionId = String(body['submissionID'] ?? body['submissionId'] ?? '').trim();
    if (formId.length === 0 || submissionId.length === 0) {
      res.status(400).json({ error: { code: 'bad_request', message: 'formID and submissionID are required.' } });
      return;
    }

    // Idempotent: Jotform retries on slow/non-200. create-catch-P2002 = success. The webhook writes
    // ONLY the keys + status=pending; the worker is the sole writer of the parsed fields/files.
    let intakeId = '';
    try {
      const created = await db.intake.create({
        data: { jotformFormId: formId, jotformSubmissionId: submissionId, status: 'pending' },
      });
      intakeId = (created as { id: string }).id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const existing = await db.intake.findUnique({ where: { jotformSubmissionId: submissionId } });
        intakeId = (existing as { id?: string } | null)?.id ?? '';
      } else {
        throw err;
      }
    }

    if (intakeId.length > 0) {
      // Best-effort enqueue — never blocks the 200 — but SURFACE the reason on failure (per the
      // "every catch must surface the reason" rule): log it + stamp errorMessage so the row is
      // visibly stuck-pending in the pool (RN can Retry), not a silent no-op.
      await publishJotformIngest({ intakeId, formId, submissionId }).catch(async (err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({ msg: 'jotform-webhook: enqueue failed', intakeId, submissionId, error: reason }));
        await db.intake.update({ where: { id: intakeId }, data: { errorMessage: `enqueue failed: ${reason}`.slice(0, 2000) } }).catch(() => { /* best-effort */ });
      });
    }

    // Always 200 fast. (Jotform treats non-200/slow as failure and retries → handled idempotently.)
    res.status(200).json({ ok: true });
  }));

  return router;
}
