import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { GetObjectCommand, CopyObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { requireRole } from '../auth/roles.js';
import type { AppDb } from '../services/db-types.js';
import { publishJotformIngest } from '../services/jotform-ingest-queue.js';
import { parseVeteranCreate } from '../services/veteran-validation.js';
import { parseCaseCreate } from '../services/case-validation.js';
import { assignChartFilenames } from '../services/chart-filename.js';
import { fillIntakeDerived } from '../services/intake-derive.js';
import { renderIntakeSummaryPdf } from '../services/intake-summary-pdf.js';

const PREVIEW_TTL_SECONDS = 300;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
// Mirror the manual-upload allow-list (documents.ts). Jotform files can be HEIC/ZIP/etc — those are
// flagged per-file on assign, never copied into a case as an un-OCR-able Document. (Spec P1-3.)
const ASSIGN_ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || 'file';
}

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

  // Annotate intake rows with whether a veteran PROFILE already exists for the submitted email (the
  // pool's "Profile" column + the drawer's auto-match for returning customers, who then need no DOB).
  async function withVeteranMatch(rows: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
    const emails = [...new Set(rows.map((r) => (typeof r['submittedEmail'] === 'string' ? (r['submittedEmail'] as string) : '')).filter(Boolean))];
    if (emails.length === 0) return rows.map((r) => ({ ...r, veteranMatch: null }));
    let byEmail = new Map<string, { id: string; name: string }>();
    try {
      const vets = await db.veteran.findMany({ where: { email: { in: emails } } });
      byEmail = new Map((vets as Array<{ id: string; email?: string; firstName?: string; lastName?: string }>).map((v) => [
        (v.email ?? '').toLowerCase(), { id: v.id, name: `${v.firstName ?? ''} ${v.lastName ?? ''}`.trim() },
      ]));
    } catch { /* match is best-effort — never block the pool list on it */ }
    return rows.map((r) => ({ ...r, veteranMatch: byEmail.get((typeof r['submittedEmail'] === 'string' ? (r['submittedEmail'] as string) : '').toLowerCase()) ?? null }));
  }

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
    // Self-heal DOB/state/claim-type from rawAnswersJson for rows ingested before the worker wrote them.
    const derived = rows.map((r) => fillIntakeDerived(r as unknown as Record<string, unknown>));
    res.json({ data: await withVeteranMatch(derived) });
  }));

  // GET /intakes/:id — detail + short-TTL signed preview URLs for each downloaded file.
  router.get('/intakes/:id', requireRole(['admin', 'ops_staff']), asyncHandler(async (req: Request, res: Response) => {
    const rawRow = await db.intake.findUnique({ where: { id: String(req.params.id) } });
    if (rawRow === null) throw new HttpError(404, 'not_found', 'Intake not found.', { intakeId: req.params.id });
    // Self-heal DOB/state/claim-type from rawAnswersJson so the assign drawer prefills even for rows
    // ingested before the worker wrote those columns (the "DOB wasn't prefilling" fix).
    const row = fillIntakeDerived(rawRow as unknown as Record<string, unknown>);
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
    const [withMatch] = await withVeteranMatch([row]);
    res.json({ data: { ...withMatch, files } });
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

  // POST /intakes/:id/assign — the data-plane-sensitive operation. Resolve/create the veteran +
  // case in ONE transaction (no S3 inside a DB tx), THEN per file: create the Document row FIRST
  // and CopyObject into cases/<caseId>/ SECOND — so the S3 ObjectCreated event → ocr-start resolves
  // the row by s3-key (a 404 there is a permanent skip). On copy failure, delete the orphan row.
  // Set the intake 'assigned' only if ≥1 file actually attached. (Spec §6 + architect P0-1/P1-3/P1-4.)
  router.post('/intakes/:id/assign', requireRole(['admin', 'ops_staff']), asyncHandler(async (req: Request, res: Response) => {
    if (deps.s3 === undefined || deps.bucketName === undefined || deps.bucketName.length === 0) {
      throw new HttpError(503, 'internal_error', 'Document storage is not configured.', { reason: 'no_bucket' });
    }
    const intakeId = String(req.params.id);
    const intake = await db.intake.findUnique({ where: { id: intakeId } });
    if (intake === null) throw new HttpError(404, 'not_found', 'Intake not found.', { intakeId });
    const intakeRow = intake as { id: string; status: string; fileManifestJson?: unknown };
    if (intakeRow.status !== 'ready') {
      throw new HttpError(409, 'conflict', `Intake is '${intakeRow.status}', not ready to assign.`, { intakeId, status: intakeRow.status });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const actor = (req as { user?: { sub?: string } }).user?.sub ?? 'unknown';

    // 1) Resolve/create veteran + case in ONE transaction (veteran.create / case.create are typed on
    // the tx). No S3 here — S3 ops can't join a DB transaction.
    const { veteranId, caseId, lastName, condition } = await db.$transaction(async (tx) => {
      let vId: string; let last: string;
      if (typeof body['veteranId'] === 'string' && (body['veteranId'] as string).length > 0) {
        const v = await tx.veteran.findUnique({ where: { id: body['veteranId'] as string } });
        if (v === null) throw new HttpError(404, 'not_found', 'Veteran not found.', { veteranId: body['veteranId'] });
        vId = body['veteranId'] as string;
        last = (v as { lastName?: string }).lastName ?? '';
      } else if (body['newVeteran'] !== undefined && body['newVeteran'] !== null) {
        const data = parseVeteranCreate(body['newVeteran']); // validates id (MRN-) + firstName + lastName + dob + email
        const created = await tx.veteran.create({ data: data as never });
        vId = (created as { id: string }).id;
        last = (data as { lastName?: string }).lastName ?? '';
      } else {
        throw new HttpError(400, 'bad_request', 'Provide veteranId (existing) or newVeteran (create).');
      }

      let cId: string; let cond: string;
      if (typeof body['caseId'] === 'string' && (body['caseId'] as string).length > 0) {
        const c = await tx.case.findFirst({ where: { id: body['caseId'] as string, veteranId: vId } });
        if (c === null) throw new HttpError(404, 'not_found', 'Case not found for this veteran.', { caseId: body['caseId'], veteranId: vId });
        cId = body['caseId'] as string;
        cond = (c as { claimedCondition?: string }).claimedCondition ?? '';
      } else if (body['newCase'] !== undefined && body['newCase'] !== null) {
        const parsed = parseCaseCreate(body['newCase']);
        const created = await tx.case.create({ data: { ...parsed, veteranId: vId } as never });
        cId = (created as { id: string }).id;
        cond = (parsed as { claimedCondition?: string }).claimedCondition ?? '';
      } else {
        throw new HttpError(400, 'bad_request', 'Provide caseId (existing) or newCase (create).');
      }
      return { veteranId: vId, caseId: cId, lastName: last, condition: cond };
    });

    // 2) Per-file: row FIRST, then CopyObject. `document` is not on AppDb — cast (as drafter-bundle does).
    const docDb = db as unknown as {
      document: { create: (a: { data: Record<string, unknown> }) => Promise<{ id: string }>; delete: (a: { where: { id: string } }) => Promise<unknown> };
    };
    const s3 = deps.s3 as { send: (cmd: unknown) => Promise<unknown> };
    const rawManifest = intakeRow.fileManifestJson;
    const manifest: ManifestFile[] = Array.isArray(rawManifest) ? (rawManifest as ManifestFile[]) : [];
    const requested: Set<string> | null = Array.isArray(body['fileS3Keys']) ? new Set((body['fileS3Keys'] as string[])) : null;

    const attached: { name: string; s3Key: string }[] = [];
    const failed: { name?: string; reason: string }[] = [];

    // First pass: filter to attachable files (content-type + size), flagging the rest with reasons.
    const candidates: { srcKey: string; original: string; contentType: string; sizeBytes: number }[] = [];
    for (const f of manifest) {
      if (typeof f?.s3Key !== 'string') continue;
      if (requested !== null && !requested.has(f.s3Key)) continue;
      const contentType = typeof f.contentType === 'string' ? f.contentType : '';
      if (!ASSIGN_ALLOWED_CONTENT_TYPES.has(contentType)) {
        failed.push({ name: f.name, reason: `unsupported content-type: ${contentType || 'unknown'}` });
        continue;
      }
      const sizeBytes = typeof f.sizeBytes === 'number' ? Math.round(f.sizeBytes) : 0;
      if (sizeBytes <= 0 || sizeBytes > MAX_UPLOAD_BYTES) {
        failed.push({ name: f.name, reason: 'file is empty or larger than 50 MB' });
        continue;
      }
      candidates.push({ srcKey: f.s3Key, original: f.name ?? 'file', contentType, sizeBytes });
    }

    // Consistent chart names (Lastname_Condition_DocType, combined→Misc, collisions numbered).
    const chartNames = assignChartFilenames(lastName, condition, candidates.map((c) => c.original));

    // Second pass: row FIRST, then CopyObject (so ocr-start can resolve the Document by key; a 404
    // there is a permanent OCR skip). On copy failure, delete the orphan row.
    for (let i = 0; i < candidates.length; i += 1) {
      const c = candidates[i]!;
      const chartName = chartNames[i] ?? sanitizeFilename(c.original);
      const finalKey = `cases/${caseId}/${randomUUID()}-${sanitizeFilename(chartName)}`;
      let docId: string;
      try {
        const doc = await docDb.document.create({
          data: { caseId, filename: chartName, sizeBytes: BigInt(c.sizeBytes), contentType: c.contentType, s3Key: finalKey, uploadedBy: actor },
        });
        docId = doc.id;
      } catch (err) {
        failed.push({ name: c.original, reason: `could not create document row: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      try {
        await s3.send(new CopyObjectCommand({ Bucket: deps.bucketName, CopySource: `${deps.bucketName}/${c.srcKey}`, Key: finalKey, MetadataDirective: 'COPY' }));
        attached.push({ name: chartName, s3Key: finalKey });
      } catch (err) {
        await docDb.document.delete({ where: { id: docId } }).catch(() => { /* best-effort */ });
        failed.push({ name: c.original, reason: `copy failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    // 2b) ALWAYS attach an Intake Summary PDF rendered from the submitted answers — so the FULL intake
    // Q&A (Stage 1 AND Stage 2: service history, diagnosis/onset answers, prior-denial reason, the
    // "why connected" narrative) reaches the chart, even when the submission carried no file uploads.
    // Same row-first-then-write discipline as the file copies so ocr-start resolves it by s3-key.
    const rawAnswers = (intake as { rawAnswersJson?: unknown }).rawAnswersJson;
    if (rawAnswers && typeof rawAnswers === 'object') {
      const summaryKey = `cases/${caseId}/${randomUUID()}-${sanitizeFilename(`${lastName || 'Veteran'}_Intake_Summary.pdf`)}`;
      let summaryDocId: string | undefined;
      try {
        const im = intake as unknown as { submittedName?: string | null; submittedFormTitle?: string | null; submittedAt?: Date | string | null };
        const submittedAt = im.submittedAt instanceof Date ? im.submittedAt.toISOString().slice(0, 10) : (typeof im.submittedAt === 'string' ? im.submittedAt : undefined);
        const pdf = await renderIntakeSummaryPdf(rawAnswers, {
          veteranName: im.submittedName ?? lastName,
          condition,
          formTitle: im.submittedFormTitle ?? undefined,
          submittedAt,
        });
        const doc = await docDb.document.create({
          data: { caseId, filename: 'Intake_Summary.pdf', sizeBytes: BigInt(pdf.byteLength), contentType: 'application/pdf', s3Key: summaryKey, uploadedBy: actor },
        });
        summaryDocId = doc.id;
        await s3.send(new PutObjectCommand({ Bucket: deps.bucketName, Key: summaryKey, Body: Buffer.from(pdf), ContentType: 'application/pdf', ServerSideEncryption: 'aws:kms' }));
        attached.push({ name: 'Intake_Summary.pdf', s3Key: summaryKey });
      } catch (err) {
        if (summaryDocId) await docDb.document.delete({ where: { id: summaryDocId } }).catch(() => { /* best-effort */ });
        failed.push({ name: 'Intake_Summary.pdf', reason: `could not generate intake summary: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    // 3) Mark 'assigned' once the work is genuinely complete — but DON'T silently swallow a total
    // copy failure. A Stage-1/2 submission often carries NO uploads; its value is the veteran + claim,
    // so 0 files must still assign. Rule:
    //  - a NEW veteran/case was created → MUST mark assigned (the tx already committed; leaving it
    //    'ready' would let a retry create DUPLICATE profiles). Failed files are surfaced for re-upload
    //    onto the now-existing case.
    //  - ≥1 file attached → assigned.
    //  - no attachable files at all (0 uploads, or all unsupported/oversized — a retry can't fix those)
    //    → assigned (the deliverable is the veteran + claim).
    // The single case left 'ready' for a lossless retry: real files were selected but EVERY copy
    // failed (e.g. transient S3) on an EXISTING veteran + case, where re-assigning duplicates nothing.
    const createdNewProfile = body['newVeteran'] != null || body['newCase'] != null;
    const markAssigned = createdNewProfile || attached.length > 0 || candidates.length === 0;
    if (markAssigned) {
      await db.intake.update({
        where: { id: intakeId },
        data: { status: 'assigned', assignedVeteranId: veteranId, assignedCaseId: caseId, assignedAt: new Date(), assignedBy: actor },
      });
    }

    res.json({ data: { veteranId, caseId, assigned: markAssigned, attached, failed } });
  }));

  return router;
}
