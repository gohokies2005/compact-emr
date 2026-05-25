# Phase 3B Summary — Veteran pages + document upload UI

## Files touched

Changed/added files in this patch package:

- `frontend/src/App.tsx` — wires `/veterans` and `/veterans/:id` to real pages.
- `frontend/src/api/client.ts` — removes Phase 2 mock delegation and adds POST/PATCH/DELETE helpers plus conflict error.
- `frontend/src/api/veterans.ts` — typed veteran, related-record, and document API calls.
- `frontend/src/routes/veterans/*` — Veterans page, New Veteran modal, VeteranChart.
- `frontend/src/__tests__/VeteransPage.test.tsx` and `VeteranChart.test.tsx` — frontend smoke tests for the new screens.
- `frontend/src/styles/globals.css` — shared `.input` Tailwind utility.
- `frontend/.env.example` — flips `VITE_USE_MOCK_API=false`.
- `frontend/README.md` — adds HIPAA no-PHI-logging convention.
- `docs/verification/phase3B-evidence/*` — verification notes/output.
- `phase3B.patch` — unified patch for review/application against current main.

## Explicitly skipped

- Case detail remains a stub; links point to `/cases/:id` for Phase 4.
- No CDS, Stripe, Gmail, physician workflow, or admin pages.
- No backend code in this ZIP; document endpoints come from Phase 3A-2.

## Assumptions

- The backend returns envelopes in the shape `{ data: ... }` for item responses and `{ data: [...] }` for list responses.
- `Document.sizeBytes` is serialized as a string because Prisma `BigInt` cannot safely round-trip through JSON as a JS number.
- Document upload is attached to a case because the Prisma schema requires `documents.caseId`.

## Tests

- Added React tests for VeteransPage and VeteranChart with mocked API calls.
- Evidence is in `docs/verification/phase3B-evidence/`.

## Ryan should test first

1. Confirm staging GitHub variable `VITE_USE_MOCK_API=false`.
2. Sign in as admin/ops and open `/veterans`.
3. Create `TEST-001`, open the chart, add condition/problem/medication.
4. Upload a PDF under a test case and verify the document metadata row appears.
