# Phase 4B-2 Summary — `/cases` list page

Built by Claude Code against `main` (on top of 4B-1). Frontend-only; no backend changes.

## New / modified files

- `frontend/src/api/cases.ts` (new) — `listCases(params)` + `CaseLite` / `CaseListResult` types matching the backend `CASE_LITE_SELECT` shape and the **offset** envelope `{ data, page, pageSize, total }` (the existing `types/api.ts` `CaseListResponse` assumed a cursor envelope, which does not match the real endpoint — left untouched; new types live in `api/cases.ts`).
- `frontend/src/routes/cases/CasesPage.tsx` (new) — replaces the Phase 2 stub. Filter row (status dropdown, claim-type dropdown, debounced veteran search using `listVeterans` → top-5 dropdown → `?veteranId=`, clear-filters); table (case id link → `/cases/:id`, veteran name link → `/veterans/:id`, condition, claim type, `<CaseStatusBadge>`, relative `updatedAt`, version); offset pagination (page + pageSize 25/50/100). `<EmptyState message=…>` on no results.
- `frontend/src/App.tsx` (modified) — repointed `CasesPage` import from `routes/stubs/CasesPage` to `routes/cases/CasesPage`.
- `frontend/src/routes/stubs/CasesPage.tsx` (deleted) — superseded; nothing else imported it.
- `frontend/src/__tests__/CasesPage.test.tsx` (new) — renders filters + a mocked case row + status badge.

## Notes / decisions

- Veteran search reuses the existing `listVeterans(q)` (which hits `GET /api/v1/veterans?q=`) and slices to the top 5 client-side, rather than assuming a `pageSize` query param the frontend client didn't already send.
- Filters reset to page 1 on change. Pagination derives `totalPages` from `total`.
- TanStack Query keys include the full filter set so changing any filter refetches.

## Verification (local; evidence under `docs/verification/phase4B-2-evidence/`)

- `npm run lint -w frontend` → 0 · `npm run typecheck -w frontend` → 0 · `npm run test -w frontend` → **8 files / 14 tests pass**
- `npm run lint` (root) → 0 · `npm run typecheck` (root) → 0 · `migrate:check` / `migrate:diff-check` → 0
