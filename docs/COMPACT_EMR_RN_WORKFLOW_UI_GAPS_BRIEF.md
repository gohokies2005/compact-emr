# Compact-EMR — RN Workflow UI Gaps Brief (for ChatGPT UI builder)

**Date:** 2026-05-26 · **Author:** Claude (backend/infra side) · **Audience:** ChatGPT (UI side), per the GPT-UI / Claude-backend build split.

## Context — backend + worker are LIVE, the RN UI is the gap
The compact-EMR backend (605 tests), all 9 AWS stacks, and the **Fargate drafter worker are deployed and healthy** (worker confirmed long-polling the DraftJob queue on its first cloud run). The API is live at `https://nypr790pq7.execute-api.us-east-1.amazonaws.com` (Cognito-protected; `/api/v1/cases` returns 401 unauthenticated = working). Frontend is live at `https://emr.flatratenexus.com` (CloudFront + S3).

**What blocks real operation is the RN-facing UI workflow.** When walking the actual operator path (create veteran → open chart → upload records → create case → review → send to drafter → physician review), several steps are missing, stubbed, or have footguns. This brief enumerates them so they can be built/fixed. The backend endpoints for all of this already exist.

---

## GAP 1 — CRITICAL: No "Send to Drafter" action for a fresh case
**Symptom:** there is no way, in the UI, to start the *first* draft of a case.
**Root cause (verified in source):** the drafter trigger `postDraft(caseId)` (`frontend/src/api/drafter.ts:16` → `POST /api/v1/cases/:id/draft`) is wired into **exactly one place** — `OpsHeldPanel.tsx:66`, as a *"re-run the drafter"* button that only renders for a case already in a held/ops state. A brand-new chart-ready case has **no button** to enqueue its first draft.
**What to build:** a primary **"Send to Drafter"** action on `CaseDetailPage` (Overview tab and/or a header CTA), visible to `admin`/`ops_staff`, enabled when the case is chart-ready and has no in-flight or completed draft. It calls the existing `postDraft(caseId)`. Disable + explain when chart isn't ready (see the chart-readiness endpoint). Show the in-flight panel (`InFlightDrafterPanel`) once enqueued. This is THE blocker for end-to-end operation.

## GAP 2 — HIGH: Mock-mode default is a footgun
**Verified:** `frontend/src/env.ts:8` — `VITE_USE_MOCK_API: z.enum(['true','false']).default('true')`. The mock module (`mockApi.ts`) was removed in Phase 3 and now *throws*. So any build/deploy that forgets to set `VITE_USE_MOCK_API=false` either runs against a dead mock or behaves inconsistently. (Today's deploy fixed it by adding `frontend/.env.production` with `=false`, confirmed inlined in the live bundle.)
**What to change:** flip the default to `'false'`, OR make a production build *fail loudly* if mock is requested. Also: surface a small **build-version / commit SHA + "live API" indicator** in the footer so stale-bundle vs fresh-bundle is obvious at a glance (this would have immediately explained the "Veteran not found" confusion — see Gap 5).

## GAP 3 — HIGH: End-to-end RN workflow completeness
Trace and complete the full operator path. Backend endpoints exist for each; confirm the UI covers them:
1. **Veterans** → create (`NewVeteranModal`) / open chart (`/veterans/:id`, `VeteranChart`). ✅ exists.
2. **Upload documents** — on the veteran chart (`/veterans/:id#documents`). Confirm the presign → S3 PUT → record flow works in-browser (`presignDocument` / `uploadToPresignedUrl` / `recordDocument` in `api/veterans.ts`), and that **OCR/FileReadStatus** progress is surfaced (Textract callback flips status; CaseDetail already polls every 8s in pre-draft states).
3. **Create a Case** for the veteran (`NewClaimModal`, `/cases`). Confirm reachable + that it lands the case in the right initial status.
4. **RN file review** (`/rn`, `RnQueuePage`) — the summarize-each-file step. Confirm it's wired to the case.
5. **Send to Drafter** — Gap 1.
6. **Track drafting** → `physician_review` on ship.

## GAP 4 — MEDIUM: Home dashboard advertises "Coming in Phase X"
`HomePage.tsx:8-13` renders placeholder cards ("Open intake — Coming in Phase 3", "Physician queue — Coming in Phase 4", etc.) even though the nav tabs route to real, working pages. This makes the app look unbuilt and confused the operator. Replace the cards with real links + live counts (today's cases, physician queue size, etc.), or remove them.

## GAP 5 — INVESTIGATE: Veteran detail "Veteran not found"
**Observed:** clicking a veteran row navigated to `/veterans/ZZZTest` and showed "Veteran not found." **Most likely cause: stale browser cache** (operator was on the pre-deploy bundle; mock/stale veterans don't exist in the real DB). Backend list + detail both filter `inactive:false` (default false) and key on the same `id`, so there's no obvious server bug. **Action:** confirm it reproduces on a hard-refreshed (fresh) bundle with a freshly-created veteran. If it still 404s, it's a real list-vs-detail id bug to fix; if not, Gap 2's version indicator prevents the confusion recurring.

## GAP 6 — MEDIUM: Physician review pages are stubs
`/p/queue`, `/p/review/:caseId`, `/p/letters` are stubs (`routes/stubs/*`). The physician needs these to see a completed letter, review the ≤3 disclosure cards (the `PhysicianLetterReadyPanel` component exists), open the PDF, and sign. Needed before the loop closes (RN sends → drafter → physician reviews/signs → delivers).

---

## Notes for the UI builder
- All API shapes are in `frontend/src/api/*.ts` (already typed) and `frontend/src/types/prisma.ts`. Backend routes in `backend/src/routes/`.
- Auth: Cognito (pool `us-east-1_z8OFZyBiS`, client `6oqus36g485ebaj61hjem6q43s`). Roles: `admin`, `ops_staff`, `physician`.
- HARD RULE (physician experience): the physician disclosure region must contain **zero A/B decision buttons** — read-only cards + Open PDF + "Send back to RN" only. (`PhysicianLetterReadyPanel.test.tsx` already asserts 0 buttons in the disclosure region — keep it green.)
- Deploy: `npm run build -w frontend` (needs `frontend/.env.production` with the real `VITE_*` values, `VITE_USE_MOCK_API=false`) → `aws s3 sync dist/ s3://<frontend-bucket> --delete` → CloudFront invalidation on `ET4XMMK4EKSW6`.
