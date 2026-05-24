# Phase 1 notes — database schema + Cognito wiring + auth middleware

Phase 1 adds the Prisma schema, initial migration, local seed path, Cognito-aware JWT middleware, role helpers, Lambda-safe Prisma singleton, and a protected `/api/v1/health` route.

## Local database

```bash
cp .env.example .env
docker compose up -d postgres
npm run db:generate
npm run db:migrate
npm run db:seed
```

`npm run db:seed` inserts the three Cognito groups, one local admin user, three demo veterans, and two demo cases. The first deployed migration inserts only the Cognito groups plus a bootstrap admin placeholder controlled by DB session settings; it does not insert veterans or cases.

## Auth middleware

`backend/src/middleware/auth.ts` validates bearer JWTs. In AWS it verifies the Cognito access token against the user-pool JWKS using `COGNITO_ISSUER` and `COGNITO_CLIENT_ID`. In local tests it verifies HS256 tokens using `AUTH_TEST_JWT_SECRET`.

`backend/src/auth/roles.ts` exposes:

```ts
requireRole(['admin'])
requireRole(['admin', 'ops_staff'])
```

The middleware attaches:

```ts
req.user = { sub, email, roles }
```

## Optimistic locking

Editable tables have `updated_at` and `version`. The migration creates a shared trigger that increments `version` on updates. API handlers should use a `WHERE id = ? AND version = ?` pattern in Phase 2 mutations and return 409 if no row is updated.

## Activity log partitioning

`activity_log` is created as a RANGE-partitioned table on `ts` with a default partition in Phase 1. Monthly partition creation automation is intentionally left for a later operational task; the table is ready for monthly partitions.
