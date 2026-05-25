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
