import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrafterWorkerRouter, type DrafterWorkerRouterDeps } from '../routes/drafter.js';
import { isHttpError, sendError } from '../http/errors.js';
import type { AppDb } from '../services/db-types.js';

/**
 * Coverage for GET /api/v1/internal/drafter/resolve-case (plain-speaking name+condition -> caseId
 * resolver, 2026-07-22). Exactly-one -> 200 { data }, multiple -> 409 ambiguous + candidates, none ->
 * 404 no_match. READ-ONLY: it must never write. RDS is the source of truth (resolves a letterless case).
 */

interface VetRowT { id: string; firstName: string; lastName: string; inactive: boolean }
interface CaseRowT { id: string; veteranId: string; claimedCondition: string; claimedConditions: string[]; status: string; assignedPhysicianId: string | null }
interface PhysRowT { id: string; fullName: string }

function makeDb(opts: { vets?: VetRowT[]; cases?: CaseRowT[]; physicians?: PhysRowT[] } = {}) {
  const vets = opts.vets ?? [];
  const cases = opts.cases ?? [];
  const physicians = opts.physicians ?? [];
  const writeSpy = vi.fn();

  // A tiny in-memory matcher that honors the two shapes the resolver passes:
  //   veteran.findMany({ where: { inactive:false, AND:[{OR:[{firstName:{contains,mode}},{lastName:{…}}]}] } })
  //   case.findMany({ where: { veteranId:{in:[…]}, archivedAt:null } })
  //   physician.findMany({ where: { id:{in:[…]} } })
  function vetMatches(v: VetRowT, and: Array<{ OR: Array<Record<string, { contains: string }>>}>): boolean {
    return and.every((clause) => clause.OR.some((o) => {
      const field = Object.keys(o)[0] as 'firstName' | 'lastName';
      return String(v[field]).toLowerCase().includes(o[field].contains.toLowerCase());
    }));
  }

  const store = {
    veteran: {
      findMany: vi.fn(async (args: { where: { inactive?: boolean; AND: Array<{ OR: Array<Record<string, { contains: string }>> }> } }) => {
        const and = args.where.AND ?? [];
        return vets.filter((v) => !v.inactive && vetMatches(v, and));
      }),
    },
    case: {
      findMany: vi.fn(async (args: { where: { veteranId: { in: string[] } } }) => {
        const ids = new Set(args.where.veteranId.in);
        return cases.filter((c) => ids.has(c.veteranId));
      }),
      update: writeSpy,
      create: writeSpy,
    },
    physician: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
        const ids = new Set(args.where.id.in);
        return physicians.filter((p) => ids.has(p.id));
      }),
    },
  };
  const db = { ...store } as unknown as AppDb;
  return { db, store, writeSpy };
}

function errorMw(error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) {
  if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
  return sendError(res, 500, 'internal_error', 'Unexpected server error.');
}
function appFor(db: AppDb, d: DrafterWorkerRouterDeps = {}) {
  const app = express();
  app.use('/api/v1', createDrafterWorkerRouter(db, d));
  app.use(errorMw);
  return app;
}
const URL = '/api/v1/internal/drafter/resolve-case';

beforeEach(() => { vi.clearAllMocks(); });

describe('resolve-case', () => {
  it('400 when vet is missing', async () => {
    const { db } = makeDb();
    const res = await request(appFor(db)).get(URL);
    expect(res.status).toBe(400);
  });

  it('exactly one match -> 200 { data } with caseId, veteranName, condition, status, assignedPhysician', async () => {
    const { db, writeSpy } = makeDb({
      vets: [{ id: 'VET-1', firstName: 'John', lastName: 'Smith', inactive: false }],
      cases: [{ id: 'CLM-A', veteranId: 'VET-1', claimedCondition: 'Obstructive Sleep Apnea', claimedConditions: [], status: 'rn_review', assignedPhysicianId: 'PHY-1' }],
      physicians: [{ id: 'PHY-1', fullName: 'Ryan J. Kasky, DO' }],
    });
    const ok = await request(appFor(db)).get(URL).query({ vet: 'John Smith' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({
      caseId: 'CLM-A',
      veteranName: 'John Smith',
      condition: 'Obstructive Sleep Apnea',
      status: 'rn_review',
      assignedPhysician: 'Ryan J. Kasky, DO',
    });
    expect(writeSpy).not.toHaveBeenCalled(); // READ-ONLY
  });

  it('condition loose-match narrows to exactly one', async () => {
    const { db } = makeDb({
      vets: [{ id: 'VET-1', firstName: 'John', lastName: 'Smith', inactive: false }],
      cases: [
        { id: 'CLM-A', veteranId: 'VET-1', claimedCondition: 'Sleep apnea', claimedConditions: ['obstructive sleep apnea'], status: 'physician_review', assignedPhysicianId: null },
        { id: 'CLM-B', veteranId: 'VET-1', claimedCondition: 'Tinnitus', claimedConditions: [], status: 'rn_review', assignedPhysicianId: null },
      ],
    });
    const res = await request(appFor(db)).get(URL).query({ vet: 'Smith', condition: 'apnea' });
    expect(res.status).toBe(200);
    expect(res.body.data.caseId).toBe('CLM-A');
    expect(res.body.data.assignedPhysician).toBeNull();
  });

  it('multiple matches -> 409 ambiguous with the candidate list', async () => {
    const { db } = makeDb({
      vets: [{ id: 'VET-1', firstName: 'John', lastName: 'Smith', inactive: false }],
      cases: [
        { id: 'CLM-A', veteranId: 'VET-1', claimedCondition: 'Sleep apnea', claimedConditions: [], status: 'rn_review', assignedPhysicianId: null },
        { id: 'CLM-B', veteranId: 'VET-1', claimedCondition: 'Tinnitus', claimedConditions: [], status: 'rn_review', assignedPhysicianId: null },
      ],
    });
    const res = await request(appFor(db)).get(URL).query({ vet: 'Smith' });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('ambiguous');
    expect(res.body.error.details.candidates).toHaveLength(2);
    expect(res.body.error.details.candidates.map((c: { caseId: string }) => c.caseId).sort()).toEqual(['CLM-A', 'CLM-B']);
  });

  it('no veteran match -> 404 no_match', async () => {
    const { db } = makeDb({ vets: [{ id: 'VET-1', firstName: 'John', lastName: 'Smith', inactive: false }] });
    const res = await request(appFor(db)).get(URL).query({ vet: 'Nobody' });
    expect(res.status).toBe(404);
    expect(res.body.error.details.reason).toBe('no_match');
  });

  it('name matches but condition excludes all -> 404 no_match + nameMatches hint', async () => {
    const { db } = makeDb({
      vets: [{ id: 'VET-1', firstName: 'John', lastName: 'Smith', inactive: false }],
      cases: [{ id: 'CLM-A', veteranId: 'VET-1', claimedCondition: 'Tinnitus', claimedConditions: [], status: 'rn_review', assignedPhysicianId: null }],
    });
    const res = await request(appFor(db)).get(URL).query({ vet: 'Smith', condition: 'apnea' });
    expect(res.status).toBe(404);
    expect(res.body.error.details.reason).toBe('no_match');
    expect(res.body.error.details.nameMatches).toHaveLength(1);
    expect(res.body.error.details.nameMatches[0].caseId).toBe('CLM-A');
  });

  it('an inactive veteran is excluded from the match', async () => {
    const { db } = makeDb({
      vets: [{ id: 'VET-1', firstName: 'John', lastName: 'Smith', inactive: true }],
      cases: [{ id: 'CLM-A', veteranId: 'VET-1', claimedCondition: 'Sleep apnea', claimedConditions: [], status: 'rn_review', assignedPhysicianId: null }],
    });
    const res = await request(appFor(db)).get(URL).query({ vet: 'Smith' });
    expect(res.status).toBe(404);
  });
});
