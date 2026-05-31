import './bootstrap/bigint-serialization.js'; // side-effect: BigInt -> string in JSON (must load first)
import express from 'express';
import { authenticateJwt } from './middleware/auth.js';
import { requireRole } from './auth/roles.js';
import { HttpError, isHttpError, sendError } from './http/errors.js';
import { prisma } from './db/client.js';
import { createVeteransRouter } from './routes/veterans.js';
import { createDocumentsRouter } from './routes/documents.js';
import { createCasesRouter } from './routes/cases.js';
import { createChartNotesRouter } from './routes/chart-notes.js';
import { createCdsRouter } from './routes/cds.js';
import { createLookupRouter } from './routes/lookup.js';
import { createSignOffsRouter } from './routes/sign-offs.js';
import { createClarificationsRouter } from './routes/clarifications.js';
import { createViabilityRouter } from './routes/viability.js';
import { createChartReadinessRouter } from './routes/chart-readiness.js';
import { createDoctorPackRouter } from './routes/doctor-pack.js';
import { createReportsRouter } from './routes/reports.js';
import { createInternalWorkerRouter } from './routes/internal-worker.js';
import { createDrafterClientRouter, createDrafterWorkerRouter } from './routes/drafter.js';
import { createLetterRouter } from './routes/letter.js';
import { makeRenderInvoker } from './services/letter-render-invoke.js';
import { makeSurgicalProposer } from './services/letter-surgical-propose.js';
import { createPhysiciansRouter } from './routes/physicians.js';
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

  app.use(express.json({ limit: '1mb' }));

  app.get('/api/v1/health', authenticateJwt(), requireRole(['admin', 'ops_staff', 'physician']), (req, res) => {
    res.json({ ok: true, user: req.user });
  });

  app.use('/api/v1', authenticateJwt(), createVeteransRouter(db));
  app.use('/api/v1', authenticateJwt(), createDocumentsRouter());
  app.use('/api/v1', authenticateJwt(), createCasesRouter(db));
  app.use('/api/v1', authenticateJwt(), createPhysiciansRouter(db, { bucketName: process.env.PHI_BUCKET_NAME, s3: new S3Client({ forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true' }) }));
  app.use('/api/v1', authenticateJwt(), createChartNotesRouter(db));
  app.use('/api/v1', authenticateJwt(), createCdsRouter(db));
  app.use('/api/v1', authenticateJwt(), createLookupRouter());
  app.use('/api/v1', authenticateJwt(), createSignOffsRouter(db));
  app.use('/api/v1', authenticateJwt(), createClarificationsRouter(db));
  app.use('/api/v1', authenticateJwt(), createViabilityRouter(db));
  app.use('/api/v1', authenticateJwt(), createChartReadinessRouter(db));
  app.use('/api/v1', authenticateJwt(), createDoctorPackRouter(db));
  // Admin-only drafting-cost report (per-claim LLM spend aggregated from DraftJob.costUsd).
  app.use('/api/v1', authenticateJwt(), createReportsRouter(db));
  // Drafter client routes (Cognito-authenticated): drafter-export + POST /draft.
  app.use('/api/v1', authenticateJwt(), createDrafterClientRouter(db));
  // Letter editor (production mount). renderLetter requires the render Lambda (RENDER_LAMBDA_NAME);
  // surgical-AI requires the Anthropic key (ANTHROPIC_API_KEY, sourced from Secrets Manager in prod).
  // Both fail soft to a clear 503 when absent, so local dev and a render-less env stay safe and GET
  // (view) always works. Per-signer credential wiring into the render input lands with D2.
  const renderLambdaName = process.env.RENDER_LAMBDA_NAME;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  app.use('/api/v1', authenticateJwt(), createLetterRouter(db, {
    renderLetter: renderLambdaName
      ? makeRenderInvoker(renderLambdaName)
      : async () => { throw new HttpError(503, 'internal_error', 'Letter render is not configured in this environment.', { reason: 'render_unavailable' }); },
    ...(anthropicKey ? { proposeSurgicalEdit: makeSurgicalProposer(anthropicKey) } : {}),
    s3: new S3Client({ forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true' }),
    bucketName: process.env.PHI_BUCKET_NAME,
  }));
  // Service-principal routes for OCR + Doctor Pack assembler workers (Phase 7B-revised Build 3).
  // Mounted at /api/v1/internal/* with a shared-secret token guard — NOT Cognito-authenticated.
  app.use('/api/v1', requireServicePrincipal(), createInternalWorkerRouter(db));
  // Drafter worker routes: SEPARATE token (DRAFTER_INVOKE_TOKEN) so a worker-token leak can't
  // mutate the legal letter artifact or trigger metered Anthropic spend.
  app.use('/api/v1', requireDrafterPrincipal(), createDrafterWorkerRouter(db));

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
