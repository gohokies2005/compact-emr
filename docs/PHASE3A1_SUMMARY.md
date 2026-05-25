# Compact EMR Phase 3A-1 Summary

## Scope delivered

Backend route scaffolding for the first veteran-centric API slice:

- `GET /api/v1/me`
- `GET /api/v1/veterans`
- `POST /api/v1/veterans`
- `GET /api/v1/veterans/:id`
- `PATCH /api/v1/veterans/:id`
- `DELETE /api/v1/veterans/:id` as admin-only soft delete

Also added:

- Typed error envelope helper: `{ error: { code, message, details? } }`
- Async route wrapper
- Veteran request validation helpers
- Role-aware PATCH restrictions: ops staff cannot update veteran name or DOB
- Optimistic locking on veteran PATCH using body `version`
- Activity log writes for create, update, and soft delete
- Supertest/Vitest route tests with mocked Prisma-style DB and JWTs
- Prisma migration adding `veterans.inactive` for soft delete

## Files touched

Changed or added 10 files:

1. `backend/prisma/schema.prisma`
2. `backend/prisma/migrations/20260525030000_phase3a_veteran_inactive/migration.sql`
3. `backend/src/server.ts`
4. `backend/src/auth/roles.ts`
5. `backend/src/middleware/auth.ts`
6. `backend/src/http/errors.ts`
7. `backend/src/http/async-handler.ts`
8. `backend/src/services/db-types.ts`
9. `backend/src/services/veteran-validation.ts`
10. `backend/src/routes/veterans.ts`
11. `backend/src/__tests__/veterans-routes.test.ts`
12. `docs/verification/phase3a1-evidence/*`

## Explicitly skipped

- Conditions, problems, medications, and document endpoints: reserved for 3A-2.
- Frontend pages: reserved for 3B.
- Infra/CDK files: intentionally untouched for 3A-1.
- `package.json` / `package-lock.json`: intentionally untouched to preserve current main overrides and lockfile state.

## Assumptions

- `DELETE /api/v1/veterans/:id` required a new soft-delete field, so this patch adds `Veteran.inactive Boolean @default(false)` and a matching migration.
- Activity log details intentionally include IDs and changed field names only, not PHI values.
- `/api/v1/me` resolves `AppUser` when available but still returns Cognito claims even if the DB user row has not been bootstrapped yet.

## Test / verification status

Commands attempted in this sandbox:

- `npm ci --workspace backend` failed because the available ZIP's `package-lock.json` is out of sync with `package.json`.
- `tsc -p backend/tsconfig.json --noEmit` failed because dependencies and `@types/node` are not installed.

Evidence files are under `docs/verification/phase3a1-evidence/`.

## Known caveat

The requested `compact-emr-snapshot-20260524-205803.zip` was not visible in this sandbox file system. This patch was generated against the latest available local artifact, `compact-emr-phase2B.zip`. Review the included `phase3a1.patch` against current `main` before applying.
