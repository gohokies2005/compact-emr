import './bootstrap/bigint-serialization.js'; // side-effect: BigInt -> string in JSON (must load first)
import express from 'express';
import { authenticateJwt } from './middleware/auth.js';
import { requireRole } from './auth/roles.js';
import { HttpError, isHttpError, sendError } from './http/errors.js';
import { prisma } from './db/client.js';
import { createVeteransRouter } from './routes/veterans.js';
import { createDocumentsRouter } from './routes/documents.js';
import { createCasesRouter } from './routes/cases.js';
import { createEmailsRouter } from './routes/emails.js';
import { createMailboxesRouter } from './routes/mailboxes.js';
import { createChartNotesRouter } from './routes/chart-notes.js';
import { createAdvisoryRouter } from './routes/advisory.js';
import { createStrategyPreviewRouter } from './routes/strategy-preview.js';
import { createCdsRouter } from './routes/cds.js';
import { createLookupRouter } from './routes/lookup.js';
import { createSignOffsRouter } from './routes/sign-offs.js';
import { createClarificationsRouter } from './routes/clarifications.js';
import { createViabilityRouter } from './routes/viability.js';
import { createChartReadinessRouter } from './routes/chart-readiness.js';
import { createDoctorPackRouter } from './routes/doctor-pack.js';
import { createReportsRouter } from './routes/reports.js';
import { createInternalWorkerRouter } from './routes/internal-worker.js';
import { createJotformWebhookRouter } from './routes/jotform-webhook.js';
import { createStripeWebhookRouter } from './routes/stripe-webhook.js';
import { createDeliveryPortalRouter } from './routes/delivery-portal.js';
import { createIntakesRouter } from './routes/intakes.js';
import { createDrafterClientRouter, createDrafterWorkerRouter } from './routes/drafter.js';
import { createLetterRouter } from './routes/letter.js';
import { createDeliveryRouter } from './routes/delivery.js';
import { makeRenderInvoker } from './services/letter-render-invoke.js';
import { makeSurgicalProposerFromEnv } from './services/letter-surgical-propose.js';
import { createPhysiciansRouter } from './routes/physicians.js';
import { createCaseMessagesRouter } from './routes/case-messages.js';
import { createStaffMessagesRouter } from './routes/staff-messages.js';
import { createUsersRouter } from './routes/users.js';
import { makeCognitoAdmin } from './services/cognito-admin.js';
import { S3Client } from '@aws-sdk/client-s3';
import { requireServicePrincipal } from './middleware/service-principal.js';
import { requireDrafterPrincipal } from './middleware/drafter-principal.js';
import type { AppDb } from './services/db-types.js';

export interface CreateAppOptions {
  db?: AppDb;
}

// Fail-closed: a production container must never carry the local demo/test bypasses. A leaked
// AUTH_TEST_JWT_SECRET would let anyone mint a physician/admin token; VITE_DEMO_MODE bypasses
// Cognito in the frontend. Refuse to boot rather than run a HIPAA system with auth disabled.
function assertProductionSafety(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.AUTH_TEST_JWT_SECRET) throw new Error('FATAL: AUTH_TEST_JWT_SECRET must not be set in production');
  if (process.env.VITE_DEMO_MODE === 'true') throw new Error('FATAL: VITE_DEMO_MODE must not be set in production');
  if (!process.env.COGNITO_ISSUER || !process.env.COGNITO_CLIENT_ID) throw new Error('FATAL: COGNITO_ISSUER and COGNITO_CLIENT_ID must be configured in production');
}

export function createApp(options: CreateAppOptions = {}) {
  assertProductionSafety();
  const app = express();
  const db = options.db ?? (prisma as unknown as AppDb);

  // The internal worker routes carry large bodies the Cognito client routes never do: the OCR
  // completion handler POSTs a whole document's OCR'd pages in one request (a 1,182-page Blue
  // Button is tens of MB), and drafter callbacks can be large too. The global 1mb parser runs
  // FIRST in mount order, so it would throw PayloadTooLargeError on those bodies before the
  // route-scoped 50mb parsers (on the /internal/ mounts below) ever run. Make the global parser
  // SKIP /api/v1/internal/* so the larger route-scoped limit is the one that applies there; all
  // Cognito client routes keep the strict 1mb cap unchanged. (Found 2026-06-03 — a real veteran's
  // 1,182-page Blue Button 500'd on POST /internal/documents/:id/pages with the 1mb global cap.)
  const globalJson = express.json({ limit: '1mb' });
  app.use((req, res, next) => {
    // /internal/* uses its own 50mb json parsers (below); /jotform/webhook uses its own urlencoded
    // parser (Jotform POSTs urlencoded, not JSON) — both must bypass the global json parser.
    if (req.path.startsWith('/api/v1/internal/') || req.path.startsWith('/api/v1/jotform/webhook') || req.path.startsWith('/api/v1/stripe/webhook')) return next();
    return globalJson(req, res, next);
  });

  app.get('/api/v1/health', authenticateJwt(), requireRole(['admin', 'ops_staff', 'physician']), (req, res) => {
    res.json({ ok: true, user: req.user });
  });

  // Internal worker routes are mounted FIRST. They authenticate via shared-secret tokens (NOT
  // Cognito) and both middlewares are path-aware (they next() through non-/internal/ traffic), so
  // mounting them ahead of the authenticateJwt client routes is safe AND necessary: the broad
  // `app.use('/api/v1', authenticateJwt(), ...)` mounts below would otherwise 401 the drafter's
  // token-only callback (`/internal/drafter/*`) before requireDrafterPrincipal ever runs. (Found
  // 2026-06-03 on the first real cloud drafter run — /complete was 401ing.)
  // Each internal mount gets its OWN 50mb JSON parser (the global parser above skips /internal/*,
  // so without these the internal routes would have no body parser at all). 50mb covers the
  // worst plausible OCR payload — the route already bounds input at 2000 pages x 100k chars, and
  // real Blue Button OCR line-text is single-digit KB/page, so a 1,182-page record lands ~3-10MB.
  const internalJson = express.json({ limit: '50mb' });
  app.use('/api/v1', internalJson, requireServicePrincipal(), createInternalWorkerRouter(db));
  // Drafter worker callbacks. renderLetter + S3 injected so /complete can BACKFILL a missing DOCX
  // (#9 Fix 4) — the mirrored LetterRevision must carry all three artifacts. When RENDER_LAMBDA_NAME
  // is unset (render-less env) backfill is unavailable; a docx-less completion then 502s rather than
  // mirroring a revision with a missing artifact (callers retry once the renderer is configured).
  const drafterRenderLambdaName = process.env.RENDER_LAMBDA_NAME;
  app.use('/api/v1', internalJson, requireDrafterPrincipal(), createDrafterWorkerRouter(db, {
    ...(drafterRenderLambdaName ? { renderLetter: makeRenderInvoker(drafterRenderLambdaName) } : {}),
    s3: new S3Client({ forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true' }),
    bucketName: process.env.PHI_BUCKET_NAME,
  }));

  // Public, secret-gated Jotform webhook (doorbell). Mounted BEFORE the authenticateJwt client
  // routes (it has no Cognito) with its OWN urlencoded parser scoped to this subtree — Jotform
  // POSTs urlencoded, and the payload can exceed the 1mb global json limit. See spec §2.
  app.use('/api/v1/jotform/webhook', express.urlencoded({ extended: true, limit: '2mb' }), createJotformWebhookRouter(db));

  // Public Stripe webhook (signature-gated, no Cognito). express.raw so the body is the EXACT bytes
  // Stripe signed — express.json would re-serialize them and break HMAC verification. (Mounted before
  // the authenticateJwt blanket; the API Gateway routes /stripe/webhook without the Cognito authorizer.)
  app.use('/api/v1/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), createStripeWebhookRouter(db));
  // Public password-protected delivery portal (token + password gated, no Cognito). The global json
  // parser above already parsed the unlock body (this path isn't in the skip list).
  app.use('/api/v1/delivery', createDeliveryPortalRouter(db, { bucketName: process.env.PHI_BUCKET_NAME, s3: new S3Client({ forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true' }) }));

  app.use('/api/v1', authenticateJwt(), createVeteransRouter(db));
  app.use('/api/v1', authenticateJwt(), createDocumentsRouter());
  app.use('/api/v1', authenticateJwt(), createCasesRouter(db));
  app.use('/api/v1', authenticateJwt(), createEmailsRouter(db, { bucketName: process.env.PHI_BUCKET_NAME, s3: new S3Client({ forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true' }) }));
  app.use('/api/v1', authenticateJwt(), createMailboxesRouter(db));
  const cognitoUserPoolId = process.env.COGNITO_USER_POOL_ID;
  app.use('/api/v1', authenticateJwt(), createUsersRouter(db, cognitoUserPoolId ? { cognito: makeCognitoAdmin(cognitoUserPoolId) } : {}));
  app.use('/api/v1', authenticateJwt(), createPhysiciansRouter(db, { bucketName: process.env.PHI_BUCKET_NAME, s3: new S3Client({ forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true' }) }));
  app.use('/api/v1', authenticateJwt(), createChartNotesRouter(db));
  app.use('/api/v1', authenticateJwt(), createAdvisoryRouter(db));
  app.use('/api/v1', authenticateJwt(), createStrategyPreviewRouter(db));
  app.use('/api/v1', authenticateJwt(), requireRole(['admin', 'ops_staff', 'physician']), createCaseMessagesRouter(db));
  // Internal staff messaging (Inbox + chart Messages tab). Same role gate; S3 for attachments.
  app.use('/api/v1', authenticateJwt(), requireRole(['admin', 'ops_staff', 'physician']), createStaffMessagesRouter(db, { s3: new S3Client({ forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true' }) as unknown as { send: (cmd: unknown) => Promise<unknown> }, bucketName: process.env.PHI_BUCKET_NAME }));
  app.use('/api/v1', authenticateJwt(), createCdsRouter(db));
  app.use('/api/v1', authenticateJwt(), createLookupRouter());
  // Sign-off byte-binding (#9 Fix 3) reads the current letter TXT from S3 to hash it; S3 + bucket
  // injected so the hash is stored at sign-off time (null when S3 is unconfigured — no byte gate).
  app.use('/api/v1', authenticateJwt(), createSignOffsRouter(db, {
    s3: new S3Client({ forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true' }),
    bucketName: process.env.PHI_BUCKET_NAME,
  }));
  app.use('/api/v1', authenticateJwt(), createClarificationsRouter(db));
  app.use('/api/v1', authenticateJwt(), createViabilityRouter(db));
  app.use('/api/v1', authenticateJwt(), createChartReadinessRouter(db));
  // Jotform intake pool (triage). Signed previews need S3; assign endpoint ships in a later batch.
  app.use('/api/v1', authenticateJwt(), createIntakesRouter(db, { s3: new S3Client({ forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true' }) as unknown as { send: (cmd: unknown) => Promise<unknown> }, bucketName: process.env.PHI_BUCKET_NAME }));
  app.use('/api/v1', authenticateJwt(), createDoctorPackRouter(db));
  // Admin-only drafting-cost report (per-claim LLM spend aggregated from DraftJob.costUsd).
  app.use('/api/v1', authenticateJwt(), createReportsRouter(db));
  // Drafter client routes (Cognito-authenticated): drafter-export + POST /draft.
  app.use('/api/v1', authenticateJwt(), createDrafterClientRouter(db));
  // Letter editor (production mount). renderLetter requires the render Lambda (RENDER_LAMBDA_NAME);
  // surgical-AI requires the Anthropic key — a literal ANTHROPIC_API_KEY (local dev) or, in prod,
  // the API_ANTHROPIC_KEY_SECRET_ARN the API Lambda can read at runtime (filled post-deploy, no
  // redeploy needed). Both fail soft to a clear 503 when absent, so local dev and a render-less env
  // stay safe and GET (view) always works.
  const renderLambdaName = process.env.RENDER_LAMBDA_NAME;
  const surgicalAiAvailable = Boolean(process.env.ANTHROPIC_API_KEY || process.env.API_ANTHROPIC_KEY_SECRET_ARN);
  app.use('/api/v1', authenticateJwt(), createLetterRouter(db, {
    renderLetter: renderLambdaName
      ? makeRenderInvoker(renderLambdaName)
      : async () => { throw new HttpError(503, 'internal_error', 'Letter render is not configured in this environment.', { reason: 'render_unavailable' }); },
    ...(surgicalAiAvailable ? { proposeSurgicalEdit: makeSurgicalProposerFromEnv() } : {}),
    s3: new S3Client({ forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true' }),
    bucketName: process.env.PHI_BUCKET_NAME,
  }));
  // Post-approval delivery workflow (RN delivery panel). Reads the finalized letter TXT from S3 for
  // the §VII+§VIII excerpt; Stripe + email transport are config-gated stubs (see delivery-config).
  app.use('/api/v1', authenticateJwt(), createDeliveryRouter(db, {
    s3: new S3Client({ forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true' }),
    bucketName: process.env.PHI_BUCKET_NAME,
  }));
  app.use((req, res) => {
    sendError(res, 404, 'not_found', 'Route was not found.');
  });

  app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) {
      return sendError(res, error.status, error.code, error.message, error.details);
    }
    // P0-2 (live-path sweep): non-HttpError 500s were mapped silently — every live 500 (CORS,
    // the BigInt serialize, the orderBy bug) was invisible in CloudWatch, forcing hand-diagnosis
    // one bug per step. Log method + path + stack so the NEXT unexpected 500 is greppable.
    console.error(JSON.stringify({
      msg: 'unhandled_error',
      method: req.method,
      path: req.originalUrl,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }));
    return sendError(res, 500, 'internal_error', 'Unexpected server error.');
  });

  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => {
    console.log(`Compact EMR API listening on :${port}`);
  });
}
