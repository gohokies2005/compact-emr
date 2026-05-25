import { Router, type Request, type Response } from 'express';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import type { AppDb, CaseRecord, Role, VeteranDetailRecord } from '../services/db-types.js';
import { evaluateCds } from '../services/cdsEngine.js';

function actorSub(req: Request): string {
  const u = (req as Request & { user?: { sub: string; roles: readonly Role[] } }).user;
  if (u === undefined) throw new HttpError(401, 'unauthorized', 'Authentication required');
  return u.sub;
}

function names(rows: readonly unknown[] | undefined, field: 'condition' | 'problem'): string[] {
  return (rows ?? [])
    .map((row) => String((row as Record<string, unknown>)[field] ?? '').trim())
    .filter((s) => s.length > 0);
}

export function createCdsRouter(db: AppDb): Router {
  const router = Router();

  router.post(
    '/cases/:id/cds',
    requireRole(['admin', 'ops_staff']),
    asyncHandler(async (req: Request, res: Response) => {
      const sub = actorSub(req);
      const id = String(req.params.id);

      const caseRow = (await db.case.findFirst({
        where: { id },
        select: { id: true, veteranId: true, claimedCondition: true, claimType: true, framingChoice: true, upstreamScCondition: true },
      })) as Pick<CaseRecord, 'id' | 'veteranId' | 'claimedCondition' | 'claimType' | 'framingChoice' | 'upstreamScCondition'> | null;
      if (caseRow === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });

      const veteran = (await db.veteran.findUnique({
        where: { id: caseRow.veteranId },
        include: { scConditions: true, activeProblems: true },
      })) as VeteranDetailRecord | null;

      const result = evaluateCds({
        claimedCondition: caseRow.claimedCondition,
        claimType: caseRow.claimType,
        framingChoice: caseRow.framingChoice,
        upstreamScCondition: caseRow.upstreamScCondition,
        serviceConnectedConditions: names(veteran?.scConditions, 'condition'),
        activeProblems: names(veteran?.activeProblems, 'problem'),
      });

      await db.$transaction(async (tx) => {
        await tx.case.update({
          where: { id },
          data: {
            cdsVerdict: result.verdict,
            cdsOddsPct: result.oddsPct === null ? null : Math.round(result.oddsPct),
            cdsRationale: result,
          },
        });
        await tx.activityLog.create({
          data: { actorUserId: sub, action: 'cds_evaluated', caseId: id, veteranId: caseRow.veteranId, detailsJson: { caseId: id, verdict: result.verdict, oddsPct: result.oddsPct } },
        });
      });

      res.json({ data: result });
    }),
  );

  return router;
}
