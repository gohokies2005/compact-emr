# RN workflow UI gaps — integration notes

Integration of four pre-authored UI chunks closing RN/physician workflow gaps.

## Gap 1 + 2 — Send to Drafter, mock default, build footer
- `src/api/chart-readiness.ts` — `getChartReadiness(caseId)` wrapping `GET /api/v1/cases/:id/chart-readiness`.
- `src/components/SendToDrafterPanel.tsx` — Card with a "Send to Drafter" button gated on chart readiness; calls `postDraft(caseId)`; surfaces ConflictError vs generic drafter errors.
- `src/build-info.ts` + `src/components/BuildStatusFooter.tsx` — footer showing API mode + short commit sha; rendered by `AppShell`.
- `src/env.ts` — `VITE_USE_MOCK_API` default flipped `true` -> `false` (live API by default).
- `src/routes/cases/CaseDetailPage.tsx` — renders `SendToDrafterPanel` for admin/ops_staff when no draft is in flight and none has completed.

## Gap 4 — Home dashboard
- `src/routes/HomePage.tsx` — replaced placeholder grid with live dashboard tiles (today's work, RN queue, pre-draft cases, physician review, veterans, case list) + an RN workflow card. Physicians redirect to `/p/queue`.

## Gap 6 — Physician pages
- `src/routes/physician/PhysicianQueuePage.tsx`, `PhysicianReviewPage.tsx`, `PhysicianLettersPage.tsx` — live pages replacing the Phase-2 stubs.
- `src/App.tsx` — `/p/queue`, `/p/review/:caseId`, `/p/letters` wired to the new pages with `requiredRole={['physician','admin']}`.
- Physician disclosure region carries zero A/B decision buttons (hard rule preserved via `PhysicianLetterReadyPanel`).

## Chunk 4 — RN checklist
- `src/components/RnWorkflowChecklist.tsx` — reusable 4-step checklist with links.

## Tests added
- `SendToDrafterPanel.test.tsx`, `HomePage.test.tsx`, `PhysicianQueuePage.test.tsx`, `PhysicianReviewPage.test.tsx`, `RnWorkflowChecklist.test.tsx`, `BuildStatusFooter.test.tsx`.

The old physician stubs (`src/routes/stubs/PQueuePage.tsx`, `PReviewPage.tsx`, `PLettersPage.tsx`) are no longer imported but left on disk.
