# Phase 4B-6 Summary — Chart notes frontend panel

Built by Claude Code against `main` (on top of 4B-5). Frontend-only; no backend changes.

## New / modified files

- `frontend/src/api/chart-notes.ts` (new) — `ChartNote` type + `listChartNotes`, `createChartNote`, `patchChartNote`, `deleteChartNote`.
- `frontend/src/routes/veterans/ChartNotesPanel.tsx` (new) — panel rendered on VeteranChart:
  - "Chart notes" header + add textarea (max 5000) + Save button.
  - Notes list, newest-first (server orders by createdAt desc), body with preserved newlines, `Added by <createdBy> · <relative time>` via `formatRelativeTime`.
  - Edit pencil shown when `user.role === 'admin'` OR `note.createdBy === user.sub` (own-only for ops_staff); inline edit, optimistic-lock via `version`, **409 → refetch + alert**.
  - Delete (admin only) behind a confirm dialog.
  - Empty state: "No notes yet. Add the first one above."
- `frontend/src/routes/veterans/VeteranChart.tsx` (modified, additive) — `<ChartNotesPanel>` mounted **between the Documents panel and the Cases panel**; added `id="documents"` to the Documents `<section>` so the Case Detail "Open veteran documents" link (`/veterans/:id#documents`) anchors correctly.
- `frontend/src/__tests__/ChartNotesPanel.test.tsx` (new) — renders existing note + author + add box + admin edit/delete affordances.
- `frontend/src/__tests__/VeteranChart.test.tsx` (modified) — added `useAuth` + `api/chart-notes` mocks (the panel now pulls auth context + notes; without the mocks the existing test threw "useAuth must be used inside AuthProvider").

## Verification (local; evidence under `docs/verification/phase4B-6-evidence/`)

- `lint` (root) → 0 · `typecheck` (root) → 0 · `migrate:diff-check` → 0 (no schema change)
- `test -w frontend` → **11 files / 18 tests pass**

## Note

- The chart-notes UI will only return data after the **4B-5 migration is applied** (CodeBuild `compact-emr-staging-prisma-migrate-deploy`); until then the panel loads but lists nothing (the `GET` returns an empty set or 500 if the table is absent). See PHASE4B_5_SUMMARY.
