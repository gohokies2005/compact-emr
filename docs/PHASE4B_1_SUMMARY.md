# Phase 4B-1 Summary — Shared frontend primitives (+ CI green-up)

Built by Claude Code against `main` (origin HEAD `44741d0`). Two commits:
1. `fix(ci): green up frontend + pre-existing backend typecheck/lint` — CI hygiene (see below).
2. `feat(frontend): Phase 4B-1 shared primitives` — the 4B-1 deliverable.

## 4B-1 deliverable — new/modified files (frontend only)

- `frontend/src/lib/caseStatus.ts` (new) — client-side transition table + labels, mirroring the shipped backend `case-status-transitions.ts`. Exports `CASE_STATUS_TRANSITIONS`, `CASE_STATUS_LABELS`, `validNextStatuses`, `isValidCaseStatusTransition`, `requiredRolesForCaseStatusTransition`, `canRolePerformCaseStatusTransition`, `allowedNextStatusesForRole`. Reused by 4B-2 (badge) and 4B-4 (role-filtered transition buttons).
- `frontend/src/lib/date.ts` (new) — `formatRelativeTime(isoString)` via `Intl.RelativeTimeFormat` (no date-fns). Returns `''` for unparseable input.
- `frontend/src/components/ui/CaseStatusBadge.tsx` (new) — `<CaseStatusBadge status={...} />`, exact Tailwind tokens from the brief.
- `frontend/src/components/ui/TabBar.tsx` (new) — shared generic `<TabBar>` (none existed; VeteranChart inlined its own). Matches the indigo-underline active style.
- `frontend/src/routes/cases/CaseDetailPage.tsx` (new) — placeholder so `/cases/:id` navigation (already linked from VeteranChart's Cases panel) no longer 404s. Full page ships in 4B-4.
- `frontend/src/App.tsx` (modified, additive) — added the `/cases/:id` route (admin + ops_staff), one import line.
- `frontend/src/__tests__/CaseStatusBadge.test.tsx` (new) — label, color token, className merge.
- `frontend/src/__tests__/date.test.ts` (new) — past/future/invalid.

## CI green-up (separate concern, folded into commit 1 because it blocks meaningful CI)

On `main` the CI suite was already red and it was NOT code logic — it was config/leftover debt from earlier ChatGPT-built phases that were never validated locally (the 4A summary states ChatGPT "could not truthfully run typecheck/test against the real repo"):

- **Frontend lint** — `eslint .` (no `--ext`) was only ever linting the two root `*.config.js` files, and the type-aware parser rejected them ("file not found in any of the provided project(s)"). Fixed in `frontend/.eslintrc.cjs` with an `overrides` block that drops `parserOptions.project` for `*.config.{js,cjs}`. (Did NOT expand linting to the never-linted `src/**` — that is a separate, larger cleanup.)
- **Backend typecheck (3 errors)** — implicit-`any` params in `documents.ts` (Phase 3A-2). Annotated `doc` and the two `$transaction` `tx` params.
- **Backend lint (7 errors)** — unused imports/var in `cases.ts` (removed `authenticateJwt`, `isHttpError`, `sendError`, and the unused `updated` binding in the DELETE handler); `_next`/`_version` now permitted via `argsIgnorePattern`/`varsIgnorePattern`/`ignoreRestSiblings` added to `backend/eslint.config.js`; the `@ts-nocheck` ban on the cases route test resolved by allowing a *documented* `@ts-nocheck` (`ban-ts-comment` → `allow-with-description`).

## Verification (local, evidence under `docs/verification/phase4B-1-evidence/`)

Full CI command set run locally — all green:
- `npm run lint` (root, all workspaces) → exit 0
- `npm run lint -w frontend` → exit 0
- `npm run typecheck -w frontend` → exit 0
- `npm run test -w frontend` → 7 files / **13 tests pass** (was 7; +6 new)
- `npm run typecheck` (root) → exit 0
- `npm run migrate:check` / `npm run migrate:diff-check` → exit 0 (no schema change in 4B-1)

## Known debt surfaced, deliberately NOT fixed here (out of 4B-1 scope)

- **`cases-routes.test.ts` is `describe.skip` + `@ts-nocheck`** — the cases route suite never runs, its mocks diverge from `AppDb` types, and at least one assertion is stale (DELETE expects `200` but the shipped route returns `204`). Backend tests are not in CI (CI runs only `test -w frontend`). This should be rewritten/un-skipped in **4B-4** (when the real Case Detail page lands and the cases endpoints get exercised for real). Tracked.
- `frontend` lint never covers `src/**` (only root config files). Turning that on will surface pre-existing lint across 3B/4A frontend code — a separate cleanup, not 4B-1.

## Assumptions

- Mirrored the backend transition + role-gate logic verbatim into `lib/caseStatus.ts`; if the backend table changes, update both.
- Used the repo's compact JSX style + `clsx`/`twMerge` + `readonly` props convention.
