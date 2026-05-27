import { Router, type Request, type Response } from 'express';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import type { AppDb } from '../services/db-types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 90;

/**
 * Parse a `YYYY-MM-DD` query param into a Date. Returns undefined when absent/blank so the
 * caller can apply the default window. Throws 400 on a present-but-malformed value.
 */
function parseDateParam(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new HttpError(400, 'bad_request', `${field} must be a YYYY-MM-DD date`, { field });
  }
  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, 'bad_request', `${field} is not a valid date`, { field });
  }
  return parsed;
}

interface CostReportRow {
  caseId: string;
  veteranName: string;
  claimedCondition: string;
  status: string;
  draftCount: number;
  costUsd: number;
}

interface CostReport {
  rows: CostReportRow[];
  totalCostUsd: number;
  from: string;
  to: string;
}

/** Round a USD figure to cents (avoids float drift like 3.4200000000001 in JSON). */
function roundUsd(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Resolve the inclusive [from, to] window. `from` defaults to 90 days before `to`; `to`
 * defaults to "now". The DB filter uses `gte from` and `lt (to + 1 day)` so the `to` day is
 * inclusive of records created any time during that calendar day (UTC).
 */
function resolveWindow(query: Request['query']): { from: Date; to: Date; toExclusive: Date } {
  const fromParam = parseDateParam(query.from, 'from');
  const toParam = parseDateParam(query.to, 'to');
  const to = toParam ?? new Date();
  const from = fromParam ?? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  if (from.getTime() > to.getTime()) {
    throw new HttpError(400, 'bad_request', 'from must be on or before to', { field: 'from' });
  }
  // Make `to` inclusive: filter createdAt < (to-date + 1 day).
  const toDayStart = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  const toExclusive = new Date(toDayStart.getTime() + DAY_MS);
  return { from, to, toExclusive };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Shape we read off each case (the hand-written CaseDelegate is loosely typed; we include
// draftJobs at the query level and narrow here).
interface CaseWithDraftJobs {
  id: string;
  claimedCondition: string;
  status: string;
  veteran?: { firstName?: string | null; lastName?: string | null } | null;
  draftJobs?: Array<{ costUsd?: unknown }>;
}

async function buildCostReport(db: AppDb, query: Request['query']): Promise<CostReport> {
  const { from, to, toExclusive } = resolveWindow(query);

  const cases = (await db.case.findMany({
    where: { createdAt: { gte: from, lt: toExclusive } },
    select: {
      id: true,
      claimedCondition: true,
      status: true,
      veteran: { select: { firstName: true, lastName: true } },
      draftJobs: { select: { costUsd: true } },
    },
    orderBy: { createdAt: 'desc' },
  })) as unknown as CaseWithDraftJobs[];

  let totalCostUsd = 0;
  const rows: CostReportRow[] = cases.map((c) => {
    const jobs = c.draftJobs ?? [];
    const draftCount = jobs.length;
    const costUsd = roundUsd(
      jobs.reduce((sum, j) => {
        const v = j.costUsd;
        return v === null || v === undefined ? sum : sum + Number(v);
      }, 0),
    );
    totalCostUsd += costUsd;
    const first = c.veteran?.firstName ?? '';
    const last = c.veteran?.lastName ?? '';
    const veteranName = `${first} ${last}`.trim();
    return {
      caseId: c.id,
      veteranName,
      claimedCondition: c.claimedCondition,
      status: c.status,
      draftCount,
      costUsd,
    };
  });

  return {
    rows,
    totalCostUsd: roundUsd(totalCostUsd),
    from: isoDate(from),
    to: isoDate(to),
  };
}

/** CSV-escape a field: wrap in quotes + double internal quotes if it contains , " or newline. */
function csvField(value: string | number): string {
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildCsv(report: CostReport): string {
  const lines: string[] = [];
  lines.push('Case ID,Veteran,Condition,Status,Draft Runs,Cost USD');
  for (const r of report.rows) {
    lines.push(
      [
        csvField(r.caseId),
        csvField(r.veteranName),
        csvField(r.claimedCondition),
        csvField(r.status),
        csvField(r.draftCount),
        csvField(r.costUsd.toFixed(2)),
      ].join(','),
    );
  }
  lines.push(['TOTAL', '', '', '', '', csvField(report.totalCostUsd.toFixed(2))].join(','));
  return lines.join('\r\n') + '\r\n';
}

/**
 * Admin-only drafting-cost reporting. Groups DraftJob.costUsd per case over a created-at window.
 * Mounted under /api/v1 with authenticateJwt() in server.ts.
 */
export function createReportsRouter(db: AppDb): Router {
  const router = Router();

  router.get(
    '/reports/costs',
    requireRole(['admin']),
    asyncHandler(async (req: Request, res: Response) => {
      const report = await buildCostReport(db, req.query);
      res.json(report);
    }),
  );

  router.get(
    '/reports/costs.csv',
    requireRole(['admin']),
    asyncHandler(async (req: Request, res: Response) => {
      const report = await buildCostReport(db, req.query);
      const csv = buildCsv(report);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="drafting-costs.csv"');
      res.send(csv);
    }),
  );

  return router;
}
