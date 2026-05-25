# Phase 5 UI — CDS panel (shipped 2026-05-25)

The CDS endpoint (`POST /api/v1/cases/:id/cds`) and persistence fields
(`cdsVerdict`, `cdsOddsPct`, `cdsRationale`) were shipped earlier in Phase 5
(commit `5edcbd4`). This change adds the physician-facing UI surface that runs
and renders that engine's output on the Case Detail page.

## What shipped

- **`frontend/src/api/cases.ts`** — additive `CdsResult` interface (matches the
  backend `cdsRationale` shape) and a `runCds(id)` helper that POSTs to the
  Phase 5 endpoint.
- **`frontend/src/components/CdsPanel.tsx`** — new component. Renders verdict
  badge (emerald / amber / rose / slate), `XX%` IMO win rate display with BVA
  sub-line (`upstream → claimed, n=N, tier T`), the engine's summary string, a
  prominent hard-gate callout when triggered, and a recommendation caption on
  `reject`. The Run / Re-run button calls `runCds(id)` via TanStack Query
  mutation and invalidates `['case', id]` on success.
- **`frontend/src/routes/cases/CaseDetailPage.tsx`** — additive change. Imports
  `CdsPanelForCase` and renders `<CdsPanelForCase c={c} />` between the header
  card and the TabBar. No other markup touched.
- **`frontend/src/__tests__/CdsPanel.test.tsx`** — 4 unit tests covering the
  not-yet-run state, accept rendering with odds + BVA sub-line, hard-gate
  reject with the confirmation caption, and the Re-run mutation calling
  `runCds` with the correct case id.

## Constraints honored

- TypeScript strict + `exactOptionalPropertyTypes` clean (no `any`). Optional
  props use `T | undefined` to satisfy `exactOptionalPropertyTypes`.
- Tailwind only. Reused `Card`, `Button`, `Spinner` primitives.
- TanStack Query mutation + `['case', id]` invalidation pattern (same as the
  rest of the page).
- Additive only — `CaseDetailPage.tsx` gained one import and one component
  insertion; no existing markup was rewritten.
- `reject` reads as a recommendation: caption "Recommendation — confirm before
  any veteran-facing action." No emails/refunds/status changes are triggered
  from this panel.
- No PHI in `console.log`.
- `formatRelativeTime` reused for `checkedAt` (same surface the rest of the
  page uses).

## Verification

- `npm run typecheck -w frontend` → exit 0. (`docs/verification/phase5-ui-evidence/typecheck.txt`)
- `npm run test -w frontend -- --run` → 12 test files / 22 tests passing (4
  new CdsPanel tests + 18 prior). (`docs/verification/phase5-ui-evidence/test-output.txt`)
- `npm run lint -w frontend` → exit 0, zero warnings.
- Patch of the four touched files: `docs/verification/phase5-ui-evidence/phase5-ui.patch`.

## Verdict / odds mapping

| Backend value | Badge label | Tailwind tone |
| --- | --- | --- |
| `accept` | Accept | emerald |
| `caution` | Caution | amber |
| `reject` | Likely not supportable | rose |
| `not_yet_run` | Not yet run | slate |

`oddsPct` renders as `Math.round(oddsPct)%` when non-null, with the BVA
sub-line showing `upstream → claimed, n=N, tier T` when the engine matched a
pair. When `oddsPct` is null and no pair matched, the panel shows "No BVA
pair data — refer to clinical review."

## What still belongs to Claude Code (backend lane)

The CDS engine + endpoint are already shipped. Open items on the backend lane:
- Wire `physician-resolver` into existing routes (`GET/PATCH /cases/:id`,
  `/cases/:id/status`, `/cases/:id/corrections`) so a physician self-resolves
  to their own cases.
- Sign-off backend (POST route, signature timestamp, activity row).
- Clarification queue model + routes.
