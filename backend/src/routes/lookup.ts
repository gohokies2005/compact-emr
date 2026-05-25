import { Router, type Request, type Response } from 'express';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { searchIcd10, searchMedications, lookupDatasetSizes } from '../services/lookup-service.js';

const PARSED_LIMIT_MAX = 50;

function parseLimit(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return Math.min(n, PARSED_LIMIT_MAX);
}

export function createLookupRouter(): Router {
  const router = Router();

  // All three roles (admin, ops_staff, physician) need typeahead for chart entry. No case-scoped
  // authorization needed — the data is non-PHI (CDC ICD-10 + generic drug names).
  const allowAllStaff = requireRole(['admin', 'ops_staff', 'physician']);

  router.get(
    '/lookup/icd10',
    allowAllStaff,
    asyncHandler(async (req: Request, res: Response) => {
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const limit = parseLimit(req.query.limit);
      const result = searchIcd10(q, limit);
      res.json({ data: result });
    }),
  );

  router.get(
    '/lookup/medications',
    allowAllStaff,
    asyncHandler(async (req: Request, res: Response) => {
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const limit = parseLimit(req.query.limit);
      const result = searchMedications(q, limit);
      res.json({ data: result });
    }),
  );

  router.get(
    '/lookup/health',
    allowAllStaff,
    asyncHandler(async (_req: Request, res: Response) => {
      res.json({ data: lookupDatasetSizes() });
    }),
  );

  return router;
}
