import type { Router } from 'express';
import express from 'express';
import { requireRole } from '../auth/roles.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError } from '../http/errors.js';
import type { AppDb, AppDbTransaction, AppUserRecord, VeteranRecord } from '../services/db-types.js';
import { assertPatchAllowedForRoles, parseVeteranCreate, parseVeteranPatch } from '../services/veteran-validation.js';
import { parseActiveMedicationCreate, parseActiveProblemCreate } from '../services/chart-entry-validation.js';

const OPS_ROLES = ['admin', 'ops_staff'] as const;

function toPositiveInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'string') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function sanitizeQuery(q: string): string {
  return q.trim().replace(/[^A-Za-z0-9@._' -]/g, ' ').replace(/\s+/g, ' ').trim();
}

function actorId(user: AppUserRecord | null, fallbackSub: string): string {
  return user?.id ?? fallbackSub;
}

async function resolveAppUser(db: AppDb, sub: string): Promise<AppUserRecord | null> {
  return db.appUser.findUnique({
    where: { cognitoSub: sub },
    include: { roles: true },
  });
}

async function writeActivity(
  tx: AppDbTransaction,
  input: { actorUserId: string; action: string; veteranId?: string; detailsJson?: Record<string, unknown> },
): Promise<void> {
  await tx.activityLog.create({
    data: {
      actorUserId: input.actorUserId,
      action: input.action,
      ...(input.veteranId !== undefined ? { veteranId: input.veteranId } : {}),
      ...(input.detailsJson !== undefined ? { detailsJson: input.detailsJson } : {}),
    },
  });
}

function conflictDetails(current: VeteranRecord): Record<string, unknown> {
  return {
    id: current.id,
    version: current.version,
    updatedAt: current.updatedAt.toISOString(),
  };
}

function buildVeteranListWhere(q: unknown): Record<string, unknown> {
  const base = { inactive: false };
  if (!hasText(q)) return base;
  const query = sanitizeQuery(q);
  if (!query) return base;
  return {
    AND: [
      base,
      {
        OR: [
          { lastName: { contains: query, mode: 'insensitive' } },
          { firstName: { contains: query, mode: 'insensitive' } },
          { email: { contains: query, mode: 'insensitive' } },
          { id: { contains: query, mode: 'insensitive' } },
        ],
      },
    ],
  };
}

export function createVeteransRouter(db: AppDb): Router {
  const router = express.Router();

  router.get(
    '/me',
    requireRole(['admin', 'ops_staff', 'physician']),
    asyncHandler(async (req, res) => {
      if (!req.user) throw new HttpError(401, 'unauthorized', 'Authentication is required.');
      const appUser = await resolveAppUser(db, req.user.sub);
      res.json({
        data: {
          sub: req.user.sub,
          email: req.user.email ?? appUser?.email ?? null,
          roles: req.user.roles,
          appUserId: appUser?.id ?? null,
        },
      });
    }),
  );

  router.get(
    '/veterans',
    requireRole([...OPS_ROLES]),
    asyncHandler(async (req, res) => {
      const limit = toPositiveInt(req.query.limit, 25, 100);
      const page = toPositiveInt(req.query.page, 1, 10_000);
      const skip = (page - 1) * limit;
      const where = buildVeteranListWhere(req.query.q);

      const [items, total] = await Promise.all([
        db.veteran.findMany({
          where,
          orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
          skip,
          take: limit,
          include: { _count: { select: { cases: true } } },
        }),
        db.veteran.count({ where }),
      ]);

      res.json({
        data: items.map((item) => ({
          id: item.id,
          lastName: item.lastName,
          firstName: item.firstName,
          dob: item.dob.toISOString().slice(0, 10),
          branch: item.branch,
          serviceStartYear: item.serviceStartYear,
          serviceEndYear: item.serviceEndYear,
          activeCases: item._count.cases,
          updatedAt: item.updatedAt.toISOString(),
          version: item.version,
        })),
        pagination: { page, limit, total, hasMore: skip + items.length < total },
      });
    }),
  );

  router.post(
    '/veterans',
    requireRole([...OPS_ROLES]),
    asyncHandler(async (req, res) => {
      if (!req.user) throw new HttpError(401, 'unauthorized', 'Authentication is required.');
      const data = parseVeteranCreate(req.body);
      const appUser = await resolveAppUser(db, req.user.sub);
      const actor = actorId(appUser, req.user.sub);

      const created = await db.$transaction(async (tx) => {
        const veteran = await tx.veteran.create({ data });
        await writeActivity(tx, {
          actorUserId: actor,
          action: 'veteran_created',
          veteranId: veteran.id,
          detailsJson: { veteranId: veteran.id },
        });
        return veteran;
      });

      res.status(201).json({ data: created });
    }),
  );

  router.get(
    '/veterans/:id',
    requireRole([...OPS_ROLES]),
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      if (!id) throw new HttpError(400, 'bad_request', 'Veteran id is required.');
      const veteran = await db.veteran.findFirst({
        where: { id, inactive: false },
        include: {
          scConditions: { orderBy: { condition: 'asc' } },
          activeProblems: { orderBy: { problem: 'asc' } },
          activeMedications: { orderBy: { drugName: 'asc' } },
          cases: { orderBy: { updatedAt: 'desc' } },
        },
      });
      if (!veteran) throw new HttpError(404, 'not_found', 'Veteran was not found.');
      res.json({ data: veteran });
    }),
  );

  router.patch(
    '/veterans/:id',
    requireRole([...OPS_ROLES]),
    asyncHandler(async (req, res) => {
      if (!req.user) throw new HttpError(401, 'unauthorized', 'Authentication is required.');
      const id = String(req.params.id);
      if (!id) throw new HttpError(400, 'bad_request', 'Veteran id is required.');
      const { version, data, changedFields } = parseVeteranPatch(req.body);
      assertPatchAllowedForRoles(changedFields, req.user.roles);
      const appUser = await resolveAppUser(db, req.user.sub);
      const actor = actorId(appUser, req.user.sub);

      const updated = await db.$transaction(async (tx) => {
        const current = await tx.veteran.findFirst({ where: { id, inactive: false } });
        if (!current) throw new HttpError(404, 'not_found', 'Veteran was not found.');
        if (current.version !== version) {
          throw new HttpError(409, 'conflict', 'Veteran was modified by another user.', conflictDetails(current));
        }
        const veteran = await tx.veteran.update({
          where: { id },
          data: { ...data, version: { increment: 1 } },
        });
        await writeActivity(tx, {
          actorUserId: actor,
          action: 'veteran_updated',
          veteranId: id,
          detailsJson: { veteranId: id, fields: changedFields },
        });
        return veteran;
      });

      res.json({ data: updated });
    }),
  );

  router.delete(
    '/veterans/:id',
    requireRole(['admin']),
    asyncHandler(async (req, res) => {
      if (!req.user) throw new HttpError(401, 'unauthorized', 'Authentication is required.');
      const id = String(req.params.id);
      if (!id) throw new HttpError(400, 'bad_request', 'Veteran id is required.');
      const appUser = await resolveAppUser(db, req.user.sub);
      const actor = actorId(appUser, req.user.sub);

      await db.$transaction(async (tx) => {
        const current = await tx.veteran.findFirst({ where: { id, inactive: false } });
        if (!current) throw new HttpError(404, 'not_found', 'Veteran was not found.');
        await tx.veteran.update({ where: { id }, data: { inactive: true, version: { increment: 1 } } });
        await writeActivity(tx, {
          actorUserId: actor,
          action: 'veteran_soft_deleted',
          veteranId: id,
          detailsJson: { veteranId: id },
        });
      });

      res.status(204).send();
    }),
  );

  // ====================== Phase 5: chart entry CRUD ======================

  router.post(
    '/veterans/:id/problems',
    requireRole([...OPS_ROLES]),
    asyncHandler(async (req, res) => {
      if (!req.user) throw new HttpError(401, 'unauthorized', 'Authentication is required.');
      const veteranId = String(req.params.id);
      if (!veteranId) throw new HttpError(400, 'bad_request', 'Veteran id is required.');
      const parsed = parseActiveProblemCreate(req.body);
      const appUser = await resolveAppUser(db, req.user.sub);
      const actor = actorId(appUser, req.user.sub);

      const created = await db.$transaction(async (tx) => {
        const veteran = await tx.veteran.findFirst({ where: { id: veteranId, inactive: false } });
        if (!veteran) throw new HttpError(404, 'not_found', 'Veteran was not found.');

        const row = await tx.activeProblem.create({
          data: {
            veteranId,
            problem: parsed.problem,
            icd10: parsed.icd10,
            notes: parsed.notes,
          },
        });
        await writeActivity(tx, {
          actorUserId: actor,
          action: 'active_problem_created',
          veteranId,
          detailsJson: { veteranId, fields: ['problem', 'icd10'] },
        });
        return row;
      });

      res.status(201).json({ data: created });
    }),
  );

  router.delete(
    '/veterans/:veteranId/problems/:problemId',
    requireRole([...OPS_ROLES]),
    asyncHandler(async (req, res) => {
      if (!req.user) throw new HttpError(401, 'unauthorized', 'Authentication is required.');
      const veteranId = String(req.params.veteranId);
      const problemId = String(req.params.problemId);
      const appUser = await resolveAppUser(db, req.user.sub);
      const actor = actorId(appUser, req.user.sub);

      await db.$transaction(async (tx) => {
        const existing = await tx.activeProblem.findFirst({ where: { id: problemId, veteranId } });
        if (!existing) throw new HttpError(404, 'not_found', 'Active problem was not found.');
        await tx.activeProblem.delete({ where: { id: problemId } });
        await writeActivity(tx, {
          actorUserId: actor,
          action: 'active_problem_deleted',
          veteranId,
          detailsJson: { veteranId, problemId },
        });
      });

      res.status(204).send();
    }),
  );

  router.post(
    '/veterans/:id/medications',
    requireRole([...OPS_ROLES]),
    asyncHandler(async (req, res) => {
      if (!req.user) throw new HttpError(401, 'unauthorized', 'Authentication is required.');
      const veteranId = String(req.params.id);
      if (!veteranId) throw new HttpError(400, 'bad_request', 'Veteran id is required.');
      const parsed = parseActiveMedicationCreate(req.body);
      const appUser = await resolveAppUser(db, req.user.sub);
      const actor = actorId(appUser, req.user.sub);

      const created = await db.$transaction(async (tx) => {
        const veteran = await tx.veteran.findFirst({ where: { id: veteranId, inactive: false } });
        if (!veteran) throw new HttpError(404, 'not_found', 'Veteran was not found.');

        const row = await tx.activeMedication.create({
          data: {
            veteranId,
            drugName: parsed.drugName,
            dose: parsed.dose,
            frequency: parsed.frequency,
            indication: parsed.indication,
          },
        });
        await writeActivity(tx, {
          actorUserId: actor,
          action: 'active_medication_created',
          veteranId,
          detailsJson: { veteranId, fields: ['drugName', 'dose'] },
        });
        return row;
      });

      res.status(201).json({ data: created });
    }),
  );

  router.delete(
    '/veterans/:veteranId/medications/:medicationId',
    requireRole([...OPS_ROLES]),
    asyncHandler(async (req, res) => {
      if (!req.user) throw new HttpError(401, 'unauthorized', 'Authentication is required.');
      const veteranId = String(req.params.veteranId);
      const medicationId = String(req.params.medicationId);
      const appUser = await resolveAppUser(db, req.user.sub);
      const actor = actorId(appUser, req.user.sub);

      await db.$transaction(async (tx) => {
        const existing = await tx.activeMedication.findFirst({ where: { id: medicationId, veteranId } });
        if (!existing) throw new HttpError(404, 'not_found', 'Active medication was not found.');
        await tx.activeMedication.delete({ where: { id: medicationId } });
        await writeActivity(tx, {
          actorUserId: actor,
          action: 'active_medication_deleted',
          veteranId,
          detailsJson: { veteranId, medicationId },
        });
      });

      res.status(204).send();
    }),
  );

  return router;
}
