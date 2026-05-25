# Phase 4B-4 Summary — `/cases/:id` Case Detail page (+ un-skip the cases backend test)

Built by Claude Code against `main` (on top of 4B-3).

## New / modified files

- `frontend/src/api/cases.ts` (modified) — added `getCase`, `patchCase`, `transitionCaseStatus`, `deleteCase`, `listDraftJobs`, `listCorrections`, plus `CaseDetail` / `PatchCaseInput` / `TransitionInput` types.
- `frontend/src/routes/cases/CaseDetailPage.tsx` (replaces the 4B-1 placeholder) — full page:
  - Header card: condition + `<CaseStatusBadge>`, case id, claim type, veteran link, relative updatedAt, row version.
  - **Role-filtered** status transition buttons via `allowedNextStatusesForRole(role, status)` — mirrors the backend role gate, so an ops_staff user on a `physician_review` case sees only `Move to rejected`; an admin sees delivered/correction_requested too.
  - Transition modal: optional `transitionReason` (audit-note placeholder), Confirm/Cancel. On **409** → "modified, retry"; on **400 PHI rejection** → inline server message.
  - Admin-only `Reject + soft delete` (DELETE → 204) behind a confirm dialog.
  - Tabs (shared `<TabBar>`): **Overview** (inline-edit rows for framingChoice / upstreamScCondition / veteranStatement / inServiceEvent, optimistic-lock via `version`, 409 → refetch + alert), **Draft jobs** (read-only), **Corrections** (read-only; maps `correctionReason`/`billingTier`), **Documents** (card linking to `/veterans/:id#documents`, no embedded panel), **Activity** (placeholder).
- `frontend/src/__tests__/CaseDetailPage.test.tsx` (new) — admin sees header + `Move to delivered` + `Reject + soft delete`.
- `backend/src/__tests__/cases-routes.test.ts` (rewritten) — **un-skipped** (`describe.skip` → `describe`) and made type-correct: removed the `@ts-nocheck`, fixed the `req.user` mock shape (JWT claims `{ sub, email?, roles }` — the old mock used `AppUserRecord`, which lacks `sub` and types `roles` as `{role}[]`), completed `baseCase` to a full `CaseRecord`, injected `req.user` in `appFor` (the suite never set it before), and **corrected the stale DELETE assertion (was `200`, route returns `204`)**. Now **15 tests pass**.

## Verification (local; evidence under `docs/verification/phase4B-4-evidence/`)

- `lint` (root) → 0 · `typecheck` (root) → 0
- `test -w frontend` → **17 pass** · `test -w backend` → **21 pass** (cases suite now runs)
- frontend + backend `tsc --noEmit` → exit 0

## Notes

- The DELETE/`Reject + soft delete` button is shown only to admins; it sets `status = rejected` (the case stays visible). The status-transition `Move to rejected` reaches the same end state via the transition endpoint — both are intentionally present (the brief specifies the admin destructive action; transition-to-rejected is the role-gated path for the rest).
- Physicians still cannot reach this page (route is admin + ops_staff per the 4A retro); physician sign-off in-UI lands in Phase 5.
