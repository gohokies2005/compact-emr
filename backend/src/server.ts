import express from 'express';
import { authenticateJwt } from './middleware/auth.js';
import { requireRole } from './auth/roles.js';
import { isHttpError, sendError } from './http/errors.js';
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
import { createInternalWorkerRouter } from './routes/internal-worker.js';
import { createDrafterClientRouter, createDrafterWorkerRouter } from './routes/drafter.js';
import { requireServicePrincipal } from './middleware/service-principal.js';
import { requireDrafterPrincipal } from './middleware/drafter-principal.js';
import type { AppDb } from './services/db-types.js';

export interface CreateAppOptions {
  db?: AppDb;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express();
  const db = options.db ?? (prisma as unknown as AppDb);

  app.use(express.json({ limit: '1mb' }));

  app.get('/api/v1/health', authenticateJwt(), requireRole(['admin', 'ops_staff', 'physician']), (req, res) => {
    res.json({ ok: true, user: req.user });
  });

  app.use('/api/v1', authenticateJwt(), createVeteransRouter(db));
  app.use('/api/v1', authenticateJwt(), createDocumentsRouter());
  app.use('/api/v1', authenticateJwt(), createCasesRouter(db));
  app.use('/api/v1', authenticateJwt(), createChartNotesRouter(db));
  app.use('/api/v1', authenticateJwt(), createCdsRouter(db));
  app.use('/api/v1', authenticateJwt(), createLookupRouter());
  app.use('/api/v1', authenticateJwt(), createSignOffsRouter(db));
  app.use('/api/v1', authenticateJwt(), createClarificationsRouter(db));
  app.use('/api/v1', authenticateJwt(), createViabilityRouter(db));
  app.use('/api/v1', authenticateJwt(), createChartReadinessRouter(db));
  app.use('/api/v1', authenticateJwt(), createDoctorPackRouter(db));
  // Drafter client routes (Cognito-authenticated): drafter-export + POST /draft.
  app.use('/api/v1', authenticateJwt(), createDrafterClientRouter(db));
  // Service-principal routes for OCR + Doctor Pack assembler workers (Phase 7B-revised Build 3).
  // Mounted at /api/v1/internal/* with a shared-secret token guard — NOT Cognito-authenticated.
  app.use('/api/v1', requireServicePrincipal(), createInternalWorkerRouter(db));
  // Drafter worker routes: SEPARATE token (DRAFTER_INVOKE_TOKEN) so a worker-token leak can't
  // mutate the legal letter artifact or trigger metered Anthropic spend.
  app.use('/api/v1', requireDrafterPrincipal(), createDrafterWorkerRouter(db));

  app.use((req, res) => {
    sendError(res, 404, 'not_found', 'Route was not found.');
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) {
      return sendError(res, error.status, error.code, error.message, error.details);
    }
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
