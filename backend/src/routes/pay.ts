import { Router, type Request, type Response } from 'express';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import { currentActor } from '../services/request-actor.js';
import { resolveCurrentPhysician } from '../services/physician-resolver.js';
import {
  LETTER_TYPES,
  belongsToPhysician,
  computeEarnings,
  enumerateMonthsSince,
  isValidMonthKey,
  pacificYearMonth,
  resolveRateCents,
  type CompletionRow,
  type EarningRow,
} from '../services/pay-earnings.js';
import type { AppDb, PhysicianRecord } from '../services/db-types.js';

/**
 * Doctor-pay routes (docs/DOCTOR_PAY_BUILD_PLAN_2026-06-11.md §5.2/§5.4). ACCURACY-CRITICAL:
 * Ryan cuts real physician checks from these numbers.
 *
 *   GET   /pay/me?month=YYYY-MM|all      physician self-serve — identity is ALWAYS derived from
 *                                        the caller's own JWT via resolveCurrentPhysician; a
 *                                        physicianId query param is NEVER honored (matrix J).
 *   GET   /pay/months/me                 month-dropdown source (employment start → now, PT).
 *   GET   /pay/physician/:id?month=...   admin-only, same shape for any physician.
 *   PATCH /letter-revisions/:id/type     admin-only memo tag — the ENTIRE v1 "memo flow" until a
 *                                        real memo pipeline exists (plan §3.3).
 *
 * Completion event of record: LetterRevision{source:'approved_final'} (plan §1.2). All dedup /
 * month / rate math lives in services/pay-earnings.ts (pure, matrix-tested).
 */

/** Narrow projection of an approved_final revision + its case join (delegate args are loose). */
interface RevisionWithCase {
  caseId: string;
  version: number;
  createdAt: Date;
  letterType?: string | null;
  payCents?: number | null;
  signingPhysicianId?: string | null;
  case?: {
    claimedCondition?: string | null;
    assignedPhysicianId?: string | null;
    veteran?: { firstName?: string | null; lastName?: string | null } | null;
  } | null;
}

/**
 * All approved_final completion rows attributable to one physician.
 *
 * DELIBERATELY NO createdAt window (deviation from plan §5.2's sketch, forced by §2.3):
 * first-approval-wins dedup must see a payKey's FULL history — querying only one month's window
 * would surface a February re-approval of a January-paid letter as a fresh February unit and
 * double-pay it. Volume is trivial (a handful of completions per physician per month, plan §4.1),
 * so the per-physician full fetch is cheap; the month filter is applied AFTER computeEarnings.
 *
 * Attribution filter = snapshot-first with live-join fallback for pre-feature null snapshots
 * (plan §5.2 note), re-applied in memory via belongsToPhysician as defense in depth — the SQL
 * and the engine can never disagree silently.
 */
async function fetchCompletionRows(db: AppDb, physicianId: string): Promise<CompletionRow[]> {
  const revs = (await db.letterRevision.findMany({
    where: {
      source: 'approved_final',
      OR: [
        { signingPhysicianId: physicianId },
        { signingPhysicianId: null, case: { assignedPhysicianId: physicianId } },
      ],
    },
    select: {
      caseId: true,
      version: true,
      createdAt: true,
      letterType: true,
      payCents: true,
      signingPhysicianId: true,
      case: {
        select: {
          claimedCondition: true,
          assignedPhysicianId: true,
          veteran: { select: { firstName: true, lastName: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })) as unknown as RevisionWithCase[];

  return revs
    .map((r): CompletionRow => {
      const first = r.case?.veteran?.firstName ?? '';
      const last = r.case?.veteran?.lastName ?? '';
      return {
        caseId: r.caseId,
        version: r.version,
        createdAt: r.createdAt,
        letterType: r.letterType ?? 'nexus_letter',
        payCents: r.payCents ?? null,
        signingPhysicianId: r.signingPhysicianId ?? null,
        caseAssignedPhysicianId: r.case?.assignedPhysicianId ?? null,
        veteranName: `${first} ${last}`.trim(),
        claimedCondition: r.case?.claimedCondition ?? '',
      };
    })
    .filter((r) => belongsToPhysician(r, physicianId));
}

/** Parse + validate ?month= (default: the current PT month — what the page lands on). */
function monthParam(req: Request): string {
  const raw = req.query.month;
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return pacificYearMonth(new Date());
  }
  if (typeof raw !== 'string' || (raw !== 'all' && !isValidMonthKey(raw))) {
    throw new HttpError(400, 'bad_request', "month must be 'all' or YYYY-MM", { field: 'month' });
  }
  return raw;
}

interface PayResponse {
  physicianId: string;
  month: string;
  rows: EarningRow[];
  totalCents: number;
  totalUsd: number;
  availableMonths: string[];
}

/** Earnings for one physician + one month key ('all' = career). Months list rides along. */
async function buildPayResponse(db: AppDb, physician: PhysicianRecord, month: string): Promise<PayResponse> {
  const completions = await fetchCompletionRows(db, physician.id);
  const { months, all } = computeEarnings(completions);
  const availableMonths = enumerateMonthsSince(physician.createdAt, new Date());
  if (month === 'all') {
    return { physicianId: physician.id, month, rows: all.rows, totalCents: all.totalCents, totalUsd: all.totalUsd, availableMonths };
  }
  const m = months.find((x) => x.monthPT === month);
  return {
    physicianId: physician.id,
    month,
    rows: m?.rows ?? [],
    totalCents: m?.totalCents ?? 0,
    totalUsd: m?.totalUsd ?? 0,
    availableMonths,
  };
}

/** Empty self-serve payload for a JWT with no Physician mapping (matrix P: 200/$0, never 500). */
function emptyPayResponse(month: string): Omit<PayResponse, 'physicianId'> {
  return { month, rows: [], totalCents: 0, totalUsd: 0, availableMonths: [pacificYearMonth(new Date())] };
}

export function createPayRouter(db: AppDb): Router {
  const router = Router();

  // ── Physician self-serve. Identity comes from the JWT ONLY — req.query.physicianId (or any
  // other param) is never read, which IS the cross-access guarantee (matrix J). Admins may call
  // it too (role-gate parity with the approve route); an admin without a Physician row gets $0.
  router.get(
    '/pay/me',
    requireRole(['admin', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentActor(req);
      const month = monthParam(req);
      const physician = await resolveCurrentPhysician(db, user.sub);
      if (physician === null) {
        // No Physician.cognitoSub mapping (mirror cases.ts behavior): empty, not 500.
        res.json({ data: emptyPayResponse(month) });
        return;
      }
      res.json({ data: await buildPayResponse(db, physician, month) });
    }),
  );

  // ── Month-dropdown source: every PT month since employment start (Physician.createdAt,
  // decision G), descending. 'All' is a frontend-side prepend, not a month key.
  router.get(
    '/pay/months/me',
    requireRole(['admin', 'physician']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentActor(req);
      const physician = await resolveCurrentPhysician(db, user.sub);
      const months =
        physician === null
          ? [pacificYearMonth(new Date())]
          : enumerateMonthsSince(physician.createdAt, new Date());
      res.json({ data: { months } });
    }),
  );

  // ── Admin-only: any physician's earnings (powers a future Compensation page, plan §6.4).
  router.get(
    '/pay/physician/:id',
    requireRole(['admin']),
    asyncHandler(async (req: Request, res: Response) => {
      const physicianId = String(req.params.id);
      const month = monthParam(req);
      const physician = await db.physician.findUnique({ where: { id: physicianId } });
      if (physician === null) throw new HttpError(404, 'not_found', 'Physician not found', { physicianId });
      res.json({ data: await buildPayResponse(db, physician, month) });
    }),
  );

  // ── Memo-tag stub (plan §5.4): the entire v1 memo "flow" — an admin manually re-types one
  // approved_final revision to nexus_memo (or back). Guard: only approved_final rows are taggable
  // (you can't bill a draft save). payCents is RE-STAMPED from the rate in effect at the row's
  // ORIGINAL completion instant (createdAt) so the unit re-values consistently with rate history
  // — month placement (first-approval-wins) is unaffected.
  router.patch(
    '/letter-revisions/:id/type',
    requireRole(['admin']),
    asyncHandler(async (req: Request, res: Response) => {
      const user = currentActor(req);
      const revisionId = String(req.params.id);
      const body = (req.body ?? {}) as { letterType?: unknown };
      const letterType = body.letterType;
      if (typeof letterType !== 'string' || !(LETTER_TYPES as readonly string[]).includes(letterType)) {
        throw new HttpError(400, 'bad_request', `letterType must be one of: ${LETTER_TYPES.join(', ')}`, { field: 'letterType' });
      }
      const rev = await db.letterRevision.findFirst({ where: { id: revisionId } });
      if (rev === null) throw new HttpError(404, 'not_found', 'Letter revision not found', { revisionId });
      if (rev.source !== 'approved_final') {
        throw new HttpError(409, 'conflict', 'Only approved_final revisions carry pay — a draft save cannot be billed.', {
          reason: 'not_a_completion',
          revisionId,
          source: rev.source,
        });
      }
      const payCents = resolveRateCents(letterType, rev.createdAt);
      const c = await db.case.findFirst({ where: { id: rev.caseId } });
      const updated = await db.letterRevision.update({ where: { id: revisionId }, data: { letterType, payCents } });
      await db.activityLog.create({
        data: {
          actorUserId: user.sub,
          action: 'letter_revision_type_changed',
          caseId: rev.caseId,
          veteranId: c?.veteranId,
          detailsJson: { revisionId, version: rev.version, from: rev.letterType ?? 'nexus_letter', to: letterType, payCents },
        },
      });
      res.json({ data: { id: updated.id, letterType, payCents } });
    }),
  );

  return router;
}
