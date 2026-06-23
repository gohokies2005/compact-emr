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
    //
    // Re-enqueue gate: on a fresh create, always enqueue. On a DUPLICATE (P2002 — same submissionId
    // already ingested), only re-enqueue if it's still pending/failed (i.e. needs processing). This
    // is what makes the hourly safety-net sweep cheap: replaying an already-ready/assigned submission
    // collapses to a no-op here, so the worker never re-fetches it (detail + files) from Jotform —
    // the exact load that previously rate-limit-locked the account. Stuck pending/failed rows DO
    // re-enqueue, so the sweep self-heals genuinely-dropped submissions.
    let intakeId = '';
    let shouldEnqueue: boolean;
    try {
      const created = await db.intake.create({
        data: { jotformFormId: formId, jotformSubmissionId: submissionId, status: 'pending' },
      });
      intakeId = (created as { id: string }).id;
      shouldEnqueue = true;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const existing = await db.intake.findUnique({ where: { jotformSubmissionId: submissionId } });
        intakeId = (existing as { id?: string } | null)?.id ?? '';
        const status = (existing as { status?: string } | null)?.status;
        shouldEnqueue = status === 'pending' || status === 'failed';
      } else {
        throw err;
      }
    }

    if (intakeId.length > 0 && shouldEnqueue) {
      // Best-effort enqueue — never blocks the 200 — but SURFACE the reason on failure (per the
      // "every catch must surface the reason" rule): log it + stamp errorMessage so the row is
      // visibly stuck-pending in the pool (RN can Retry), not a silent no-op.
      await publishJotformIngest({ intakeId, formId, submissionId }).catch(async (err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({ msg: 'jotform-webhook: enqueue failed', intakeId, submissionId, error: reason }));
        await db.intake.update({ where: { id: intakeId }, data: { status: 'failed', errorMessage: `enqueue failed: ${reason}`.slice(0, 2000) } }).catch(() => { /* best-effort */ }); // status=failed (audit 2026-06-13): surface as actionable in the pool, not as normal in-progress; the hourly sweep re-enqueues pending||failed so it still self-heals.
      });
    }

    // Observability (2026-06-05 incident): the webhook used to return 200 with no log line, so when
    // submissions stopped arriving there was NO way to tell "Jotform isn't calling us" from "we
    // dropped it" — the incident was invisible for hours. Log ONE structured line per hit. formID /
    // submissionID are opaque ids, NOT PHI; never log req.body (it carries name/dob/etc.).
    const result = !intakeId ? 'no-intake' : shouldEnqueue ? 'enqueued' : 'noop-duplicate';
    console.log(JSON.stringify({ msg: 'jotform-webhook: hit', formId, submissionId, result }));

    // Always 200 fast. (Jotform treats non-200/slow as failure and retries → handled idempotently.)
    // `result` is echoed so the SWEEP can tell a RECOVERY (it replayed a submission the real-time
    // webhook had dropped → 'enqueued') from a no-op (already ingested → 'noop-duplicate'). A
    // recovery during a sweep means the real-time doorbell silently missed a delivery — the exact
    // failure that lost Herman Charles (CKD) on 2026-06-23 and stayed invisible for ~1h. The sweep
    // turns that count into a CloudWatch alarm (JotformWebhookMissedAlarm). Real-time callers ignore
    // this field; it is NOT PHI (opaque ids only).
    res.status(200).json({ ok: true, result });
  }));

  return router;
}
