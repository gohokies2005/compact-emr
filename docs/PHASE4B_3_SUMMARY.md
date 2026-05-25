# Phase 4B-3 Summary — New Claim modal on VeteranChart

Built by Claude Code against `main` (on top of 4B-2). Frontend-only; no backend changes.

## New / modified files

- `frontend/src/api/cases.ts` (modified) — added `CreateCaseInput` + `createCase(veteranId, input)` → `POST /api/v1/veterans/:veteranId/cases`.
- `frontend/src/routes/cases/NewClaimModal.tsx` (new) — React Hook Form + Zod, matching the `NewVeteranModal` pattern. Fields: `id` (required), `claimedCondition` (required), `claimType` (select: initial/supplemental/hlr/appeal_bva, default initial), `framingChoice` (≤80), `upstreamScCondition` (≤200), `veteranStatement` (textarea ≤2000), `inServiceEvent` (textarea ≤2000). Empty optionals are omitted from the payload via conditional spread (avoids `exactOptionalPropertyTypes` friction). `assignedPhysicianId` intentionally skipped (Phase 7).
- `frontend/src/routes/veterans/VeteranChart.tsx` (modified, additive) — `+ New claim` button in the header card; `createCase` mutation that, on success, closes the modal, invalidates `['veteran', veteranId]`, and redirects to `/cases/:newId`.
- `frontend/src/__tests__/NewClaimModal.test.tsx` (new) — closed renders nothing; filling required fields + submit calls `onSubmit` with the parsed input (empty optionals omitted).

## Verification (local; evidence under `docs/verification/phase4B-3-evidence/`)

- `lint -w frontend` → 0 · `typecheck -w frontend` → 0 · `test -w frontend` → **9 files / 16 tests pass**
