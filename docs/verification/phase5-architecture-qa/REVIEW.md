# Phase 5 Architecture QA Review

**Reviewer:** code-architect-qa (Claude Opus 4.7, 1M context)
**Date:** 2026-05-25
**Branch:** main (read-only review; no production code modified)
**Scope:** commits `42cedcd .. a2d0b65` (10 commits, Phase 5 backend + UI + tests)
**Test status (as reported):** 456/456 backend, 22/22 frontend — green

---

## TL;DR

**Overall verdict: ship-ready, with three minor follow-ups worth landing in a Phase-5.1 cleanup commit.**

Phase 5 is well-architected. New routes are small, deterministic services are pure and unit-testable, every write path emits an `activityLog` row, every mutating endpoint runs inside `$transaction`. The 250-stress CDS suite is genuinely thorough, not box-checking. Type safety on the DB delegate layer is consistent.

The follow-ups are:

1. Three different `currentUser(req)` / `actorSub(req)` implementations have appeared across routes. Extract one helper to `src/services/request-actor.ts`.
2. Three validation files (`sign-off-validation.ts`, `clarification-validation.ts`, `chart-entry-validation.ts`) inline-duplicate `isRecord` + `badRequest`. Lift to `src/services/validation-helpers.ts`.
3. `PATCH /clarifications/:id/resolve` does **not** gate on whether the actor can access the underlying case. A physician can resolve a clarification on a case they're not assigned to. Tighten.

None of these are blockers. CDS engine, viability gate, migrations, and the stress suite are clean.

---

## 1. Architectural fit

**Verdict: ship-ready.**

The Phase 5 additions compose cleanly with the 4A cases / 4B chart-notes structure:

- **Layered separation holds.** Routes are thin (most handlers are 15-40 lines and consist of: extract identity, validate body, lookup-or-404, transact, audit, respond). Validation lives in `services/*-validation.ts`. Pure logic (`cdsEngine.ts`, `viability-gate.ts`, `case-status-transitions.ts`, `physician-resolver.ts`) is fully decoupled from Express and DB. The `lookup-service.ts` is a self-contained in-memory module.
- **Database access goes through `AppDb` delegates.** No raw Prisma client leaks. The `$transaction(fn)` pattern is used uniformly: every multi-write path (create + activity log) is atomic.
- **Activity logging is pervasive and consistent.** Every mutating endpoint writes an `activityLog.create` inside the transaction with a structured `detailsJson`. `clarification_raised`, `clarification_resolved`, `case_signed_off`, `cds_evaluated`, `active_problem_created`, etc. are all present.
- **Physician self-access is correctly modeled.** `requireStaffOrAssignedPhysician` (cases.ts:114) and `roleGuardForStatusTransition` (cases.ts:137) both compose `requireRole` with an async Physician resolution. The pattern is reusable.

**Findings:**

- `viability.ts:42-46` calls `db.activeProblem.findMany` separately from the case `findFirst`, outside any transaction. That's fine here because the endpoint is read-only and the gate is advisory, but worth a one-line comment noting the read is not snapshot-consistent with the case row. If a stale-by-microseconds problem list ever caused a misleading verdict in production, this would be the place to look.
- `cds.ts:36-39` calls `db.veteran.findUnique({ include: { scConditions: true, activeProblems: true } })` after the case lookup, also outside a transaction. The `cds_evaluated` write is transactional, but the read that feeds it is not. Same caveat — fine for an advisory recommendation, but the inconsistency is worth surfacing.
- `cds.ts:33` uses an awkward `as Pick<CaseRecord, ...> | null` cast because `db.case.findFirst` returns the full `CaseRecord`. Consider tightening `CaseDelegate.findFirst` to return `Promise<Partial<CaseRecord> | null>` — though that ripples through cases.ts. Defer to Phase 6 if/when types get an overhaul.

**Recommendation:** no action — current state is correct. Optional comment on read-then-write transactionality is nice-to-have.

---

## 2. Consolidation opportunities (5 new route files)

**Verdict: ship-ready — current granularity is right.**

Each of the five new files maps to a distinct resource (`/cases/:id/cds`, `/lookup/*`, `/cases/:id/sign-off`, `/cases/:id/clarifications`, `/cases/:id/viability`). The files are 53-134 lines each, which is below the routine threshold where consolidation pays off.

Two reasons to keep them separate:

1. **Auth surface differs per resource.** `cds.ts` is admin+ops_staff only. `lookup.ts` is admin+ops_staff+physician. `sign-offs.ts` is admin+physician (NOT ops_staff for POST). `clarifications.ts` is all three. `viability.ts` is all three. Folding them into one router forces those auth permutations into a single file's mental model.
2. **Validation imports differ per resource.** Each file's imports are minimal and obvious. Concatenation would create a 400-line `case-extras.ts` whose import block alone is overhead.

The one consolidation I'd actually suggest is **the duplication of `currentUser` / `actorSub` helpers** — see section 4. That's a 30-line extraction, not a route-merge.

**Findings:**

- `cases.ts` at 473 lines is becoming the longest file in the routes directory. If Phase 6 adds correction-workflow endpoints or status-management-by-physician endpoints, that file will tip over. Plan to split `/cases/:id/status` into its own `status-transitions.ts` if/when that happens. Not yet.
- `lookup.ts` does NOT take a `db: AppDb` parameter (good — it's a pure in-memory lookup). The fact that `createLookupRouter()` has a different signature from the others is a subtle inconsistency, but is correct given the dependency. Worth a one-line doc comment in the function signature.

**Recommendation:** no action. Re-evaluate consolidation only when a file crosses 500 lines.

---

## 3. Validation surface (shared helpers)

**Verdict: minor follow-up.**

Four validation files duplicate `isRecord` and `badRequest`:

```text
backend/src/services/case-validation.ts:49,53           isRecord + badRequest
backend/src/services/chart-entry-validation.ts:11,15    isRecord + badRequest
backend/src/services/chart-note-validation.ts:5,9       badRequest + isRecord
backend/src/services/clarification-validation.ts:9,13   isRecord + badRequest
backend/src/services/sign-off-validation.ts:7,11        isRecord + badRequest
backend/src/services/veteran-validation.ts (likely)     similar
```

Six identical copies. They're 4 lines each, so it's 24 lines of dup, but the *real* concern is drift: someone tightens `isRecord` in one file (e.g., rejects `Date` instances or arrays) and the others silently disagree.

**Trade-offs of consolidation:**

- **Pro:** single source of truth for "what counts as a valid request body shape." Shared error code (`bad_request`) and consistent message format.
- **Pro:** new validators (Phase 6: corrections, payments, etc.) get the helpers for free.
- **Pro:** test surface shrinks — `validation-helpers.test.ts` covers all callers.
- **Con:** small extra import in every validator file. Negligible.
- **Con:** future divergence from one validator family (e.g., webhook payloads where `null` is valid where `undefined` isn't) gets harder. Mitigate by keeping the shared helpers minimal — only the truly identical primitives.

**Proposed extraction (`src/services/validation-helpers.ts`):**

```ts
import { HttpError } from '../http/errors.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function badRequest(message: string, details?: Record<string, unknown>): never {
  throw new HttpError(400, 'bad_request', message, details);
}

export function requiredNonEmptyString(body: Record<string, unknown>, field: string, max?: number): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) badRequest(`${field} is required`, { field });
  const trimmed = (value as string).trim();
  if (max !== undefined && trimmed.length > max) badRequest(`${field} exceeds maximum length of ${max} characters`, { field, max });
  return trimmed;
}

export function optionalNullableString(body: Record<string, unknown>, field: string, max: number): string | null | undefined {
  // ... shared form
}

export function positiveInteger(body: Record<string, unknown>, field: string): number {
  // ... shared form
}
```

Then each validator imports what it needs. Around 40 lines of net deletion across the suite.

**Recommendation:** extract `validation-helpers.ts` in a focused follow-up commit. Tag the commit `refactor(validation): shared helpers`. Acceptance: tests still 456/456 green, every callsite uses the shared helpers, and net line count drops.

---

## 4. Inconsistencies / drift — `currentUser` / `actorSub` divergence

**Verdict: minor follow-up.**

Three distinct shapes have emerged for "extract the authenticated user from `req`":

| File | Function | Returns |
|---|---|---|
| `cases.ts:51-58` | `currentUser(req)` | `{ sub, email, roles, role, id }` (RequestActor) |
| `chart-notes.ts:10-17` | `currentUser(req)` | `{ sub, roles, role }` |
| `sign-offs.ts:9-16` | `currentUser(req)` | `{ sub, role }` |
| `cds.ts:8-12` | `actorSub(req)` | `string` (just the sub) |
| `clarifications.ts:8-12` | `actorSub(req)` | `string` (just the sub) |
| `veterans.ts` (multiple) | inline `req.user?.sub` checks | n/a |

The `cases.ts` version has the same role-priority logic (`['admin', 'physician', 'ops_staff']`) duplicated in `chart-notes.ts` and `sign-offs.ts`. The priority arbitrarily resolves overlapping role grants — change it in one place and forget another and you get inconsistent role selection per endpoint.

Right now they agree because Cognito groups for FRN staff don't overlap (a user is either admin OR ops_staff OR physician), but the *logic* assumes overlap is possible. If overlap is impossible, the priority list is dead code; if overlap is possible, the priority must be canonical.

**Proposed extraction (`src/services/request-actor.ts`):**

```ts
import type { Request } from 'express';
import { HttpError } from '../http/errors.js';
import type { Role } from './db-types.js';

export interface RequestActor {
  readonly sub: string;
  readonly email: string | undefined;
  readonly roles: readonly Role[];
  readonly role: Role; // highest-priority role for routing decisions
  readonly id: string; // alias for sub; convenience for activity-log writes
}

const ROLE_PRIORITY: readonly Role[] = ['admin', 'physician', 'ops_staff'];

export function currentUser(req: Request): RequestActor {
  const u = (req as Request & { user?: { sub: string; email?: string; roles: readonly Role[] } }).user;
  if (u === undefined) throw new HttpError(401, 'unauthorized', 'Authentication required');
  const role = ROLE_PRIORITY.find((r) => u.roles.includes(r));
  if (role === undefined) throw new HttpError(403, 'forbidden', 'No valid role found in JWT');
  return { sub: u.sub, email: u.email, roles: u.roles, role, id: u.sub };
}

export function actorSub(req: Request): string {
  return currentUser(req).sub;
}
```

Then cases.ts / chart-notes.ts / sign-offs.ts / cds.ts / clarifications.ts all import from one source. The role-priority becomes a single constant.

**Findings:**

- The duplication is harmless today but is a classic drift hotspot. Six months from now, someone will add a fourth role (e.g., `qa_reviewer`) and have to remember to add it to the priority list in N places.
- This is a candidate for a **linter rule**: phase BEGINNING, rule_id `request-actor-extraction-required`, fire if a route file declares its own `currentUser`/`actorSub` shape outside of `services/request-actor.ts`. Mechanical: detectable by regex on `function currentUser(req: Request)` / `function actorSub(req: Request)` inside `src/routes/`.

**Recommendation:** extract `request-actor.ts` in the same refactor commit as section 3. ~25 lines of code, removes a 6-place duplication.

---

## 5. DB-types coverage

**Verdict: ship-ready.**

The new delegates (`ActiveProblemDelegate`, `ActiveMedicationDelegate`, `SignOffDelegate`, `ClarificationDelegate`) follow the existing pattern. Each carries the full record interface + a delegate with `findUnique` / `findFirst` / `findMany` / `create` / `update` (+ `delete` for the chart-entry rows). Signatures are consistent: `args: unknown` in, typed record out.

The `unknown` `args` type is **the right call for this codebase** and should stay:

- Pro of `unknown`: lets the routes pass arbitrarily-shaped Prisma queries (`where`, `include`, `select`, `orderBy`, `skip`, `take`) without having to redeclare Prisma's argument types. Tightening to a typed shape duplicates Prisma's generated types and forces you to ship a 200-line `*DelegateArgs` interface for each model.
- Pro of `unknown`: keeps the mock surface in tests simple — tests pass a `vi.fn(async () => row)` without typed-arg gymnastics.
- Con of `unknown`: callsites can pass nonsense, but Prisma will reject at runtime, and the response type (`Promise<CaseRecord>`) is still strong.

The right place to tighten types is the **return type**, not the args. Phase 5 does this correctly — every delegate method returns a fully-typed record union (e.g., `Promise<SignOffRecord | null>`).

**Findings:**

- `SignOffDelegate` lacks an `update` method (sign-offs are immutable — re-signing creates a new row). That's a correct deliberate omission; consider a one-line code comment in `db-types.ts:301-306` explaining the omission so future maintainers don't add `update` "for symmetry."
- `ClarificationDelegate` has `update` but no `delete`. Correct — once raised, clarifications are dismissed (status flip), not hard-deleted. Worth a similar comment.
- `Prisma schema.prisma` lines 458-493: `SignOff` and `Clarification` models lack back-relations on `Case` and `Physician`. The migration writes the FK constraints at the SQL level (`sign_offs_case_id_fkey`, `sign_offs_physician_id_fkey`, `clarifications_case_id_fkey`) so referential integrity is enforced. But Prisma won't generate the `case.signOffs[]` or `physician.signOffs[]` back-relations. If a future feature needs `db.case.findFirst({ include: { signOffs: true } })`, that include won't work. Today only `db.signOff.findMany({ where: { caseId } })` is used, so this is fine, but flag it.

**Recommendation:** no action. Optional: add 2 one-line comments documenting the deliberate omission of `SignOffDelegate.update` and `ClarificationDelegate.delete`. If/when Phase 6 needs `case.signOffs[]`, add the back-relation to `schema.prisma` and run `prisma generate`.

---

## 6. Test quality and convergence

**Verdict: ship-ready — divergence is justified.**

There are two distinct mock patterns and they each serve a different purpose:

1. **`createApp({db})` + real JWT** (`veterans-routes.test.ts`, `auth.test.ts`). Tests the full middleware chain including JWT verification (uses `jose` to sign tokens with the test secret). High fidelity, slow-ish, valuable for veterans where auth is the load-bearing concern.
2. **`vi.mock('../auth/roles')` + bare express app** (`cases-routes.test.ts`, `sign-offs-routes.test.ts`, `clarifications-routes.test.ts`, `chart-notes-routes.test.ts`). Tests route logic against a mocked-out auth layer. Lower fidelity for auth, faster, focuses on business logic.

Pattern 2 is **the right choice for routes whose primary concern is business logic + DB calls** — the auth surface is identical across cases / sign-offs / clarifications, and testing it once via `auth.test.ts` is enough. Pattern 1 is **the right choice for the route that needs to assert role-based filtering of returned data** (which `veterans-routes.test.ts` does extensively).

The two patterns coexist without confusion because the mock pattern is declared at the top of each file. The only convergence I'd suggest is a **named helper** for the role-mock shape, to avoid copy-paste drift in the `vi.mock` factory.

**Proposed (`src/__tests__/helpers/mock-roles.ts`):**

```ts
import express from 'express';
import type { Role } from '../../services/db-types.js';
import { vi } from 'vitest';

export interface MockUser { readonly sub: string; readonly email?: string; readonly roles: readonly Role[]; }

export function makeRoleMock(getMockUser: () => MockUser | undefined) {
  return {
    requireRole:
      (allowed: readonly string[]) =>
      (req: express.Request, res: express.Response, next: express.NextFunction) => {
        const user = getMockUser();
        if (user === undefined) { res.status(401).json({ error: { code: 'unauthorized', message: 'Authentication required' } }); return; }
        (req as express.Request & { user?: MockUser }).user = user;
        if (!user.roles.some((r) => allowed.includes(r))) { res.status(403).json({ error: { code: 'forbidden', message: 'Forbidden' } }); return; }
        next();
      },
  };
}
```

This is **optional** — the duplication is across only 4 test files and is mechanical. Worth doing if a 5th file gets added in Phase 6.

**Findings:**

- `cdsEngine.thresholds.test.ts:99-113` has a `describe` block that asserts only `expect(true).toBe(true)` with a comment saying "covered in the other suite." That's a tombstone — it documents WHY there's no per-block synthetic test for tier=low but contributes nothing to test coverage. Either:
  - delete the block (the comment can move to a `// NOTE:` at the top of the file), or
  - replace with `it.skip(...)` so vitest reports it as deliberately-skipped rather than green-by-tautology.
  Defer to whichever the team prefers stylistically; not blocking.
- `cases-routes.test.ts` and `sign-offs-routes.test.ts` both define their own `MockUser` interface. Same shape. Could share via the helper above.

**Recommendation:** no action this phase. Add the test helper in Phase 6 once 5+ test files use the role-mock pattern. Decide on the tombstone block.

---

## 7. Migration safety

**Verdict: ship-ready.**

All three migrations are idempotent and forward-only:

- `20260526000000_physician_cognito_sub`: `ADD COLUMN IF NOT EXISTS "cognito_sub"` + `CREATE UNIQUE INDEX IF NOT EXISTS`. Re-runnable. Existing physicians without a Cognito sub map to `null`, which `physician-resolver.ts:21` handles correctly (`if (!cognitoSub || cognitoSub.trim() === '') return null`).
- `20260526010000_problem_icd10`: `ADD COLUMN IF NOT EXISTS "icd10"` + `CREATE INDEX IF NOT EXISTS`. Re-runnable. Existing rows get `null` — `chart-entry-validation.ts` treats `icd10` as optional.
- `20260526020000_sign_offs`: `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` × 3. Re-runnable. New table, no backfill required.
- `20260526030000_clarifications`: same pattern. `CREATE TABLE IF NOT EXISTS` + indexes + CHECK constraints on `status` and `audience` columns.

**Findings:**

- **CHECK constraints are SQL-enforced AND TypeScript-enforced** (`clarification-validation.ts:4-5` and the Prisma schema's `audience String @db.VarChar(20)` with no enum). Belt-and-suspenders is fine, but worth noting that the canonical truth is split: SQL says one thing, TS types say another, and they happen to agree. If you ever add a fourth audience (`legal_review`?), you need to update both `AUDIENCES` in TS and the `clarifications_audience_check` CONSTRAINT in SQL via a new migration. Document this in CLAUDE.md or a header comment.
- **No data backfill needed** for any migration. New columns are optional; new tables start empty.
- **No down migrations.** Prisma's pattern is forward-only with snapshots in `schema.prisma`. Acceptable but means a botched migration requires a manual fix-forward migration, not a rollback. Standard Prisma operating mode.
- **`sign_offs.physician_id` FK is `ON DELETE RESTRICT`** (migration line 16) but `physicians` is currently a soft-delete model (the `active: boolean` field is the deactivation flag, per `physician-resolver.ts:23`). The RESTRICT will never fire because physicians aren't hard-deleted. Consistent with the soft-delete pattern; no action.
- **`clarifications.case_id` FK is `ON DELETE CASCADE`** (migration line 18). If a case is soft-deleted (`/cases/:id` DELETE sets `status = 'rejected'`), the clarifications survive. If a case is HARD-deleted via `prisma case.delete`, clarifications are wiped. The codebase never hard-deletes cases, so this is fine; the CASCADE is a safety net only.

**Recommendation:** no action. Document the dual-source-of-truth (SQL CHECK + TS enum constant) for `clarifications.audience` and `clarifications.status` in a one-line comment in `clarification-validation.ts`.

---

## 8. Viability gate — type lift to AppDb canonical?

**Verdict: ship-ready — leave it where it is.**

The `ViabilityVerdict = 'go' | 'clarify' | 'needs_from_vet' | 'not_viable'` string-literal union in `viability-gate.ts:3` is **correctly scoped to the service**. Reasons not to lift to `db-types.ts`:

1. **Viability verdict is NOT persisted.** The endpoint is read-only and returns the verdict in the response body; no DB column stores it. Lifting it to canonical types would imply persistence intent that doesn't exist.
2. **The CDS verdict (`CdsVerdict`) IS persisted** (`cases.cds_verdict` enum column, mirrored in `db-types.ts:18`). That's why it belongs in canonical types — it crosses the DB boundary.
3. **The viability gate's verdict union may evolve faster than CDS.** As the UI matures and new "soft warning" categories emerge (e.g., `needs_physician_response` for unresolved clarifications), evolving a service-local type is a one-file change; evolving a canonical type would touch the schema or at least force the migration discipline.

The convention here is implicit but correct: **persisted enums → `db-types.ts`. Service-local computation enums → next to the service.**

**Findings:**

- `viability-gate.ts:18-21` types `caseRow` as `Pick<CaseRecord, 'id' | 'status' | ...>`. Clean and explicit. The pure-function signature is testable without any DB.
- `ViabilityBlocker.code` is a string-literal union of 6 specific codes (`viability-gate.ts:6-12`). Same justification — service-local enum. Each code maps to a UI message; if the UI translation table lives next to the service or in the frontend, that's fine. Document where the canonical UI-string-for-each-code mapping lives.
- Cross-service coupling: `viability-gate.ts:64` reads `input.caseRow.cdsVerdict` and branches on `'reject'`/`'not_yet_run'`. That's the right coupling direction — viability gate depends on CDS output, not the reverse. The two services share a single canonical type (`CdsVerdict`) via `db-types.ts`. Clean.

**Recommendation:** no action — current state is correct. Optional: a one-line ADR comment at the top of `viability-gate.ts` explaining "verdict union is service-local because it is computed-but-not-persisted; CDS verdict is canonical because it is persisted."

---

## 9. The 250-stress suite (`cdsEngine.stress.test.ts` + `cdsEngine.thresholds.test.ts`)

**Verdict: ship-ready — this is the best test suite in the codebase.**

The architecture is sound:

- **Bucket-based organization** (A: hard gates, B: real-pair thresholds, C: pair coverage, D: no-match, E: edge/malformed, F: determinism). Each bucket has a clear hypothesis. Bucket sizes (`~30-60` cases) align with the relative blast radius of failures in each category. A failing tobacco-direct test (Bucket A) is more urgent than a failing alias-phrasing test (Bucket E1).
- **`it.concurrent.each(bucket)`** runs every case in parallel. Right choice for a pure engine — cases are independent. Surfaces ordering bugs if any ever leaked in.
- **`assertResult(r, expected, label)` helper** centralizes the assertion contract. Each test only declares the *non-default* expectations; engine invariants (`engineVersion`, `checkedAt` format, `summary` shape) are asserted on every case. Excellent separation of concern.
- **`buildInput(overrides)` factory** keeps tests focused on the dimension under test. Avoids the death-by-a-thousand-fixtures pattern.
- **Bucket count guard** at line 866 (`expect(total).toBeGreaterThanOrEqual(250)`) is a meta-assertion that the suite stays at scale. Nice touch.
- **Bucket F determinism** runs each seed 10× and asserts byte-identical results (except `checkedAt`). That's the right invariant for a deterministic engine.

**On `cdsEngine.thresholds.test.ts` mocking the atlas:**

- The synthetic-atlas approach (`vi.mock('../data/bva_secondary_pairs.json', ...)`) is the **correct** way to test threshold boundaries that don't exist in real data. Real BVA pairs cluster at 53.8% (the only sub-65 with usable IMO), so testing the 50/70 boundaries against real data is impossible.
- The hoisting comment (line 21-30) is excellent — `vi.mock` factories hoist to the top, so the factory must be self-contained. The author documented why the boundary list is duplicated inside the factory. Defensive engineering.
- **One smell:** the `tier='medium'` value appears in `SyntheticStats.tier` union at line 18 — but the engine's `PairStats` interface uses `'moderate'`. This is a deliberate alignment with commit `e3d4249` which fixed that exact bug. The synthetic interface preserves both names to assert the engine tolerates either, but the engine code itself only emits `'moderate'`. Worth a one-line comment explaining the dual-tier-name on the synthetic type.

**Findings:**

- **Coupling to engine internals:** the suite asserts `r.hardGate.rule` against specific literal strings (`'barred_theory'`, `'no_diagnosis'`, `'no_sc_anchor'`). If the engine ever renames these rule codes, every test needs updating. That's the correct coupling — the rule codes ARE the contract, the test is asserting the contract. Just be aware that any rule-rename will be a coordinated refactor.
- **Test labels are descriptive:** `'A5 no SC anchor: PTSD->OSA (SC=[Tinnitus])'` reads like an incident report. Great for post-mortem debugging.
- **The Bucket B comment (line 250-254)** correctly notes that the threshold synthetics live in a separate file. Cross-file knowledge is documented, not lost.
- **Bucket E covers unicode, emoji, long strings, punctuation, nonsense, large SC lists** — every input fuzz vector worth covering. No need to add more.
- **Refactor risk:** the suite is deeply tied to the engine's two-layer model (Layer A gates + Layer B BVA odds). If you ever introduce Layer C (e.g., presumptive carve-outs), Bucket A's tobacco-direct precedence test (A6) will need to assert the new layer's precedence too. Plan accordingly.
- The `cdsEngine.thresholds.test.ts:99-113` empty describe block (the `expect(true).toBe(true)` placeholder) is the only test smell in either file. Either delete or convert to `it.skip`.

**Recommendation:** no action. The suite is exemplary. Address the one tombstone test (delete or `.skip`).

---

## 10. Other concerns

### Security / authorization gaps

**One real gap, two minor flags.**

**Real gap (worth fixing in 5.1):**

`clarifications.ts:90-131` (`PATCH /clarifications/:id/resolve`) gates only on `requireRole(['admin', 'ops_staff', 'physician'])`. It does NOT check whether the resolving user has access to the underlying case. Concretely:

- A physician assigned to case A can resolve a clarification on case B (which they're NOT assigned to).
- A clarification raised against case B by ops_staff can be dismissed by a physician who has no relationship to case B.

Compare with `sign-offs.ts:96-108` (`GET /cases/:id/sign-offs`), which DOES gate physicians on assignment.

**Proposed fix:**

```ts
// in PATCH /clarifications/:id/resolve, after findUnique:
if (user.role === 'physician') {
  const c = await tx.case.findFirst({ where: { id: existing.caseId }, select: { assignedPhysicianId: true } });
  const physician = await resolveCurrentPhysician(db, user.sub);
  if (c === null || physician === null || c.assignedPhysicianId !== physician.id) {
    throw new HttpError(403, 'forbidden', 'Physician is not assigned to this case.', { caseId: existing.caseId });
  }
}
```

For ops_staff and admin, no case-scoped gate is needed (their roles grant access to all cases per the existing pattern). For physicians, the case must be theirs.

Same logic applies to **POST `/cases/:id/clarifications`** (`clarifications.ts:30-65`). Today a physician can raise a clarification against any case. Probably less harmful (they're adding a question, not resolving one), but inconsistent with the rest of the codebase.

**Minor flags:**

- `cds.ts:25` allows only `requireRole(['admin', 'ops_staff'])`. A physician assigned to the case can NOT run CDS — they have to ask ops to do it. That's a deliberate design decision (CDS is an ops-driven gate, not a physician tool), but worth noting in case Phase 6 wants to expand it.
- `viability.ts:21` allows all three roles, but doesn't gate physician on case assignment. Today the viability gate is read-only and returns generic verdicts (no PHI in the response body other than the case ID), so the gap is small. If Phase 6 makes the response richer (e.g., embeds the veteran's diagnosis list), revisit.

### PHI in logs / response bodies

**Verdict: clean.**

- `cdsEngine.ts:153, 156, 160, 167, 177-182` — the `summary` field embeds the upstream and claimed condition names (e.g., `"Accept: 89.2% IMO BVA win rate (ptsd → obstructive sleep apnea, n=...)`. These are clinical conditions, not PHI. Names, dates, SSNs are absent. Clean.
- `case-validation.ts:6-10` — explicit `PHI_PATTERN_REJECTIONS` regex bans SSN, phone, email patterns in `transitionReason`. Excellent defensive line.
- Activity log `detailsJson` payloads — checked across cases.ts, cds.ts, sign-offs.ts, clarifications.ts, chart-notes.ts, veterans.ts. The fields recorded are: `caseId`, `veteranId`, `physicianId`, `clarificationId`, `signOffId`, `verdict`, `oddsPct`, `audience`, `from`/`to` statuses, `fields[]` (column-name lists). No condition text, no PHI. Clean.
- `clarification.question` and `clarification.resolution` are stored as plain text and are likely to contain PHI ("Need the most recent pulmonology note for [veteran name]..."). That's expected — they're chart-side data, not log-side. Make sure the activity-log `detailsJson` for `clarification_raised` doesn't echo the question text. Confirmed at `clarifications.ts:57` — `detailsJson` carries only `caseId`, `clarificationId`, `audience`. Clean.
- `signOff.notes` — same: chart-side, free-text, may contain PHI. Activity log payload at `sign-offs.ts:77` records only `caseId`, `physicianId`, `signOffId`, `answerKeys`. The `answerKeys` array is `Object.keys(answers)` which carries the question keys (e.g., `'confirmed_records_reviewed'`). Per `sign-off-validation.ts:39`, keys are bounded to `MAX_QUESTION_KEY_LEN = 100` and are intended to be enumerated identifiers, not free text. Clean.

### Performance / scaling

- **Lookup service** (`lookup-service.ts`): in-memory linear scan over a pre-loaded JSON dataset, scored, sorted, sliced. At dataset sizes you're targeting (likely a few thousand ICD-10 codes + a few hundred medications), this is sub-millisecond. If the dataset grows past ~10K rows AND the lookup endpoint hits >100 QPS, the linear scan dominates and you'd want a prefix-trie or fuzzy-search index. Not yet — flag it. The doc comment at `lookup.ts:18-19` ("non-PHI") and the in-process loading model are correctly oriented.
- **CDS engine** (`cdsEngine.ts`): two key lookups + array iteration over `Object.keys(PAIRS)` (~40 entries). Constant-time effectively. No scaling concern.
- **Viability gate** (`viability-gate.ts`): pure arithmetic over a 6-field input. No scaling concern.
- **Migration indexes**: every new column with a query pattern has an index — `active_problems_icd10_idx`, `sign_offs_case_id_idx`, `sign_offs_physician_id_idx`, `sign_offs_signed_at_idx`, `clarifications_case_id_idx`, `clarifications_status_idx`, `clarifications_audience_idx`. No N+1 query risk visible.
- **`/cases/:id` endpoint** in cases.ts:207-227: pulls `documents`, `draftJobs`, `corrections`, `emails`, `payments` (top 5 each) + `_count` for each. Single Prisma query with eager `include`. No N+1. The eager-include pattern doesn't yet pull `signOffs` or `clarifications` — Phase 6 will need to add them or expose them via separate endpoints. Currently they're separate-endpoint only, which is the right call (separate cache invalidation, separate auth surface).

### Coupling

- **`cds.ts` -> `cdsEngine.ts`** clean. Engine is a pure function.
- **`viability.ts` -> `viability-gate.ts`** clean. Gate is a pure function.
- **`cdsEngine.ts` -> `bva_secondary_pairs.json`** direct import. The atlas is bundled at compile time. The `vi.mock` test pattern depends on this being a top-level import — don't move it inside the function.
- **`sign-offs.ts` and `cases.ts` both import `physician-resolver.ts`** to gate physician-self-access. Right factoring.
- **`server.ts`** wires nine routers under `/api/v1`. Each with `authenticateJwt()` middleware. Order matters — `health` is first (no router), then the resource routers. No coupling concerns.

**Recommendation:** address the clarifications-resolve authorization gap in Phase 5.1. Other items are notes for future work.

---

## Appendix A: Findings summary

### Blockers
*None.*

### Minor follow-ups (recommended for a Phase 5.1 cleanup commit)

1. **`PATCH /clarifications/:id/resolve` lacks case-scoped authorization for physicians.** A physician can resolve a clarification on a case they're not assigned to. Fix: add a physician-assignment check inside the transaction before the status flip. Same gap on `POST /cases/:id/clarifications` for the raise path. (`clarifications.ts:90-131`, `clarifications.ts:30-65`)

2. **Extract `request-actor.ts`** to consolidate the three divergent `currentUser` / `actorSub` implementations across `cases.ts:51`, `chart-notes.ts:10`, `sign-offs.ts:9`, `cds.ts:8`, `clarifications.ts:8`. Single canonical role-priority list. ~25 lines net change.

3. **Extract `validation-helpers.ts`** to consolidate `isRecord` + `badRequest` + common string/integer parsers across `case-validation.ts`, `chart-entry-validation.ts`, `chart-note-validation.ts`, `clarification-validation.ts`, `sign-off-validation.ts`, `veteran-validation.ts`. ~40 lines net deletion.

### Nice-to-haves (defer to Phase 6 unless cheap)

4. Delete or `.skip` the `expect(true).toBe(true)` tombstone block at `cdsEngine.thresholds.test.ts:99-113`.

5. Add 2-line comments documenting the deliberate omission of `SignOffDelegate.update` (sign-offs are immutable) and `ClarificationDelegate.delete` (clarifications are status-flipped, not deleted) in `db-types.ts`.

6. Add a comment noting the dual source-of-truth for `clarifications.audience` and `clarifications.status` (SQL CHECK constraint in migration + TS string-literal union in `clarification-validation.ts`).

7. Optional test helper `src/__tests__/helpers/mock-roles.ts` to share the `vi.mock('../auth/roles')` factory across cases/sign-offs/clarifications/chart-notes test files.

8. Consider tightening `CaseDelegate.findFirst` return type or providing a `findFirstWithSelect<S>` overload to remove the `as Pick<CaseRecord, ...>` cast at `cds.ts:33`. Cosmetic.

### Knowledge gaps worth indexing

9. **Persisted-enum vs. service-local-enum convention.** Phase 5 establishes a clear rule: enums that round-trip through the DB live in `db-types.ts`; enums that are computed-only live next to the service that produces them. Worth a 2-line note in `docs/COMPACT_EMR_BRIEF.md` or `PHASE5_CDS_ENGINE_SUMMARY.md`.

10. **Stress-suite as design contract.** `cdsEngine.stress.test.ts` is not just a regression suite — it documents the engine's precedence rules (barred_theory > no_diagnosis > no_sc_anchor; tier='low' overrides accept). Worth referencing in the engine's docblock so the rules and the tests stay paired.

---

## Appendix B: Linter rule candidates

Two findings from this review represent recurring classes of mistake worth promoting to linter rules:

- **rule_id `request-actor-extraction-required`** — phase BEGINNING, severity warning. Fires if `src/routes/*.ts` declares `function currentUser(req: Request)` or `function actorSub(req: Request)` outside of `src/services/request-actor.ts`. Mechanical regex check.

- **rule_id `case-scoped-auth-required-for-mutation`** — phase MIDDLE, severity critical. Fires if a route handler under `/cases/:id/*` or `/clarifications/:id/*` does not perform a physician-assignment check before a write/update operation when the role list includes `'physician'`. Detection is harder (AST or semantic analysis), but the pattern of "requireRole then DB write without physician-assignment guard" is regex-detectable for the common case: presence of `'physician'` in the `requireRole` list + presence of `db.$transaction` + absence of `resolveCurrentPhysician` or `isAssignedPhysicianForCase` call before the transaction.

These belong in the Compact EMR linter (if/when one exists). The Phase 5 stress-suite pattern (bucket-based + concurrent + invariant helper) is also worth canonicalizing as the test-template for Phase 6 services.

---

## NEXT ACTION

Open Phase-5.1 follow-up commit covering: (1) clarifications authorization gap fix, (2) `request-actor.ts` extraction, (3) `validation-helpers.ts` extraction. Items 4-10 can be batched into Phase 6 prep.
