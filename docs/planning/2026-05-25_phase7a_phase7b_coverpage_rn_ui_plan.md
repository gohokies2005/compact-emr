# Phase 7B-cover + RN-UI + Phase 7A — End-to-end plan

**Date:** 2026-05-25
**Author:** code-architect-qa (planning only, no code edits)
**Repo HEAD at planning:** `feb5f8e fix(phase7b): apply architect QA blockers (REVIEW.md b99de30)`
**Branch:** `main`
**Working dir:** `C:\Users\ryank\compact-emr-work`
**Scope:** three sequential builds; each gets architect QA before the next starts; final pass after build 3.

---

## Sequencing — why this order

1. **Build 1 (cover-page + TOC artifact)** is pure in-process work. No new infra, no new runtime, no AWS surface. It can ship and be QA'd against a synthetic manifest before any worker exists. Worker (Build 3) consumes `coverPageJson` from the row — Build 1 produces the contract Build 3 will honor.
2. **Build 2 (RN UI)** is frontend-only on top of endpoints that are already live (Phase 5.2). Zero schema changes. It can ship in parallel with Build 1 if needed, but sequencing it second keeps the architect's review surface small per step.
3. **Build 3 (Phase 7A worker)** is the highest-risk build — new CDK stack, two Lambdas, S3+SNS+SQS wiring, IAM, secrets-broker for the DB POST-back. We do it last so the cover-page contract is locked and the RN UI is already absorbing manual-summary blockers (which the worker will create).

**Can-parallelize:** Builds 1 and 2 are independent. If schedule pressure appears, Build 2 frontend dev can start while Build 1 cover-page is in QA. Default: serial, because the architect QA cadence is the rate limiter, not implementation throughput.

**Fast-fail checkpoints** (stop and re-architect if reality diverges):
- **FFC-1 (end of Build 1):** if `coverPageJson` shape balloons past ~2 KB or starts duplicating data already on the DoctorPack row / KeyDoc rows, factoring is wrong — promote to its own `doctor_pack_cover_pages` table.
- **FFC-2 (mid Build 3):** if Lambda cold-start + Textract async setup pushes p95 OCR latency past 90 s for a 20 MB file, the polling-from-API model is wrong — switch to S3 EventBridge → SNS → SQS → consumer Lambda fan-out rather than direct SNS-subscriber Lambda.
- **FFC-3 (end of Build 3):** if the assembler Lambda exceeds 60 s for a 250-page pack on a warm container, the in-process pdf-lib approach is wrong — switch to ECS Fargate task triggered by SQS or split the pack into per-section assembly + final merge.

---

# Build 1 — Doctor Pack cover-page + TOC artifact

## 1.1 Resolved design

**Factoring decision (open Q answered).** Cover-page metadata stays on `DoctorPack.manifestJson` as a nested `coverPage` object, NOT a new column and NOT a new table. Rationale:
- `manifestJson` already captures the assembler contract — adding the cover-page block here keeps "everything the worker needs in one row" together, no JOIN, no second migration.
- Estimated payload: chart summary (~600 bytes) + TOC (~80 bytes per file × ~30 files = 2.4 KB) + verdicts (~200 bytes). Comfortably under 8 KB — Postgres JSONB handles 100s of MB. No size pressure.
- A separate `doctor_pack_cover_pages` table would force a new FK + new migration + new query in the worker for what is genuinely 1:1 ephemeral metadata that lives and dies with the DoctorPack row.
- **Fast-fail trigger (FFC-1):** if cover-page metadata ever needs to be queried independently of the pack (e.g. show prior cover pages in a UI list, regenerate cover-page without re-assembling), we promote it to its own table. Not now.

**Cover-page content scope (open Q answered).** Include chart-readiness state + viability + CDS verdicts on page 1. Rationale: this is the physician's first orientation point. Telling them "chart is 12/12 read, viability=accept (78% BVA odds), CDS=accept (Layer-A clean, Layer-B 72%)" before they touch page 2 is the entire point of the cover page. NOT scope creep — it's the load-bearing reason the cover page exists. Hide the per-file read-attempt details (those live in /rn UI); surface only the aggregate count.

**Regeneration policy (open Q answered).** Regenerate on every `POST /generate`. Cache invalidation surface = none, because every regeneration produces a fresh `coverPageJson` from current chart state. The aggregator is a pure function; idempotent for the same inputs. This matches the existing pattern where the manifest is recomputed on every Generate call. Persistence is the side-effect of the route; not a caching layer.

**Anything missed.** Add an `engineVersion` field to `coverPageJson` (e.g. `cover-page-1.0.0`) so the assembler can detect a contract mismatch and refuse to render an old-shape cover-page rather than crash mid-PDF. Mirrors the existing `DOCTOR_PACK_ENGINE_VERSION` pattern.

## 1.2 Data model changes

**None.** All data lives in existing `DoctorPack.manifestJson` (Json column). No migration.

If FFC-1 fires post-build, the follow-up migration would be:

```
-- HYPOTHETICAL — not part of Build 1
CREATE TABLE doctor_pack_cover_pages (
  doctor_pack_id UUID PRIMARY KEY REFERENCES doctor_packs(id) ON DELETE CASCADE,
  cover_page_json JSONB NOT NULL,
  engine_version VARCHAR(40) NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 1.3 Code surface

New service file:
- `backend/src/services/chart-summary-aggregator.ts` — pure function `buildChartSummary(input)` returns a `ChartSummary` object. No DB access — caller passes already-loaded rows. Mirrors the `doctor-pack.ts` style (pure-function service, route does I/O).

Modified files:
- `backend/src/services/doctor-pack.ts` — extend `DoctorPackManifest` to carry a `coverPage: CoverPage` field. Add `assembleDoctorPackWithCover(input)` composite helper.
- `backend/src/routes/doctor-pack.ts` — `POST /generate` handler loads the additional veteran data needed (SC conditions, active problems, active medications), builds the chart summary, attaches to `manifestJson.coverPage` before insert.

New test file:
- `backend/src/__tests__/chart-summary-aggregator.test.ts` — 8 cases covering: empty chart, full chart, missing optional fields, viability not-run, CDS not-run, no upstream SC condition, denial-to-rebut text length cap, engineVersion stamp.

**No frontend work in Build 1** — the cover page is rendered by the worker (Build 3) only. The Case Detail UI continues to show the existing manifest summary; a "Cover page generated ✓" indicator is the only optional frontend touch (defer to Build 2 if added at all).

## 1.4 API contract

`POST /api/v1/cases/:id/doctor-pack/generate` — request unchanged. Response shape unchanged at top level; `data.manifestJson` now contains:

```json
{
  "entries": [ ... existing ... ],
  "engineVersion": "doctor-pack-1.0.0",
  "coverPage": {
    "engineVersion": "cover-page-1.0.0",
    "generatedAt": "2026-05-25T16:00:00Z",
    "veteran": {
      "name": "First Last",
      "dob": "1980-01-15",
      "branch": "Army",
      "serviceYears": "2001-2010",
      "combatVeteran": "yes",
      "pactArea": "no",
      "teraConceded": "yes"
    },
    "scConditions": [
      { "condition": "OSA", "dcCode": "6847", "ratingPct": 50, "grantedDate": "2014-08-01" }
    ],
    "activeProblems": [
      { "problem": "Allergic rhinitis", "icd10": "J30.9" }
    ],
    "activeMedications": [
      { "drugName": "Fluticasone", "dose": "50 mcg", "frequency": "BID" }
    ],
    "claim": {
      "claimedCondition": "Allergic rhinitis",
      "claimType": "initial",
      "framingChoice": "secondary",
      "upstreamScCondition": "OSA",
      "denialToRebut": null
    },
    "verdicts": {
      "chartReadiness": { "ready": true, "totalFiles": 12, "readFiles": 11, "manualSummaryProvided": 1 },
      "viability": { "verdict": "viable", "rationale": "..." },
      "cds": { "verdict": "accept", "oddsPct": 72, "tier": "high" }
    },
    "toc": {
      "included": [
        { "filename": "ClaimLetter_2023.pdf", "docType": "rating_decision", "pages": "1-18", "classification": "high_signal" }
      ],
      "excluded": [
        { "filename": "Blue_Button.pdf", "reason": "bulk; cited pages will be added if drafter references them" }
      ]
    }
  }
}
```

## 1.5 Testing strategy

**Unit tests (pure functions):**
- `chart-summary-aggregator.test.ts` — all 8 cases above; assert shape, optional-field behavior, engineVersion stamp.
- Extend `doctor-pack.test.ts` (if absent, create) — `assembleDoctorPackWithCover` builds the right shape; manifest+cover are coherent (TOC `included[]` matches `entries[]`).

**Integration test:**
- New `backend/src/__tests__/doctor-pack.route.test.ts` (or extend existing) — POST `/generate`, read row back, assert `manifestJson.coverPage` is present, well-formed, and reflects the seeded veteran/case data.

**QA-passed at end of step:**
- All new tests green.
- `npm run build` clean.
- Architect reviews: factoring decision (FFC-1 trigger documented), data model unchanged, no migration drift, route handler still single-purpose.
- One curl against a real seeded case showing a non-empty `coverPage` block in the response.

## 1.6 Dependencies on prior steps

None. Phase 7B (commit `feb5f8e`) is the only prerequisite, already shipped.

## 1.7 Out of scope

- PDF rendering of the cover page (deferred to Build 3).
- A `cover_pages` table (only if FFC-1 fires).
- Cover-page regeneration without re-assembling the pack (Build 1 ties cover-page generation to `/generate`).
- Multi-language or alternate-template cover pages.
- Surfacing the cover-page in the EMR Case Detail UI (the Doctor Pack tile work — separate Phase later).

## 1.8 Estimated time

**2–3 hours of implementation + ~30 min architect QA.** Mostly mechanical aggregation + tests; no infra, no migration.

---

# Build 2 — RN manual-summary UI

## 2.1 Resolved design

**Route shape (open Q answered).** Add `/rn` as a top-level route + `/rn/cases/:caseId/files/:fileReadStatusId` as the detail subroute. NOT a tab on existing pages. Rationale:
- RN role is intentionally separate workflow ("queue of files needing my attention"), not "look inside a specific case." Sticking the queue inside Case Detail forces context-switching that the workflow doesn't need.
- When the `rn` AppRole lands later, the route gates change once; the URL surface doesn't.
- Mirrors `/p/queue` pattern already in the routing stub list.

**Cross-case endpoint (open Q answered).** YES, ship `GET /api/v1/rn/files-pending-manual` (paginated, defaults to oldest-first). Rationale: the whole point of the RN queue is "give me the next file to triage" across the case list — making the UI fan out one-query-per-case is N+1 and forces premature case-by-case routing in the UI. One endpoint, server pagination, returns `{ filePath, fileReadStatusId, caseId, caseName, lastCheckedAt, attemptCount, lastAttemptMethod }`.

**Read-attempt visibility (open Q answered).** YES, show the failed-method history. Rationale: the RN needs to know "Textract failed (garbled, ratio 0.21), Tesseract failed (only 14 words), Bedrock Data Automation failed (timeout)" to decide whether to (a) write a summary from the PDF itself or (b) escalate ("scan is unreadable, need re-upload"). Without this context the RN is flying blind. Display compact: a chip per method with a tooltip showing the rejection reason.

**Anything missed.**
- The PDF viewer needs a signed S3 URL — leverage the existing `GET /api/v1/cases/:id/documents/:docId/url` endpoint (or add one for `file_read_status` rows specifically; cleaner). The `filePath` IS the S3 key; we need a presigned-URL endpoint scoped to FileReadStatus.
- Optimistic update on POST manual-summary: invalidate `['rn', 'pending']`, `['case', caseId, 'chart-readiness']`, `['case', caseId, 'files-pending-manual']` — three keys. Document this in the UI brief so it isn't fragile.
- The role gate today is `requireRole(['admin', 'ops_staff'])` on POST manual-summary. The frontend ProtectedRoute should match. When `rn` AppRole is added (future), both flip together.

## 2.2 Data model changes

**None.** All endpoints exist or use existing rows. Frontend-only build.

**Optional new endpoint** (small backend change):
- `GET /api/v1/rn/files-pending-manual` (cross-case scan, paginated, role-gated to `admin + ops_staff`).
- `GET /api/v1/cases/:id/files/:fileReadStatusId/signed-url` (presigned PDF URL — if a similar endpoint doesn't already cover this shape).

These are two new routes (~40 LOC each), no schema changes.

## 2.3 Code surface

**Backend (small):**
- `backend/src/routes/rn.ts` — new router exposing `GET /rn/files-pending-manual` (cross-case scan with pagination + filtering). Wired in `server.ts`.
- `backend/src/routes/chart-readiness.ts` — add `GET /cases/:id/files/:fileReadStatusId/signed-url` (presigned S3 GET, 5-min TTL, KMS-encrypted matching the documents pattern).

**Frontend (the bulk of the work):**
- `frontend/src/routes/rn/RnQueuePage.tsx` — queue list (table: filename, case, veteran, last-attempt method+reason, age).
- `frontend/src/routes/rn/RnFileDetailPage.tsx` — split pane: left = PDF viewer (react-pdf or iframe of signed URL), right = read-attempt history chips + summary textarea + submit.
- `frontend/src/api/rn.ts` — `useRnPending(opts)`, `useFileReadAttempts(fileReadStatusId)`, `useSubmitManualSummary()` mutation with proper cache invalidation.
- `frontend/src/App.tsx` — add `/rn` + `/rn/cases/:caseId/files/:fileReadStatusId` routes, both `ProtectedRoute requiredRole={['admin', 'ops_staff']}`.
- `frontend/src/layout/TopNav.tsx` — RN Queue nav entry visible to admin + ops_staff with a count badge of pending files.

**Per project-memory rule [[feedback_compact_emr_gpt_ui_claude_backend_split]]:** Claude builds the backend pieces (new routes + API contract). ChatGPT builds the UI. Output of Build 2 from Claude's side = the new backend endpoints + a paste-ready GPT brief (`docs/COMPACT_EMR_PHASE7_RN_UI_BRIEF.md`) covering page structure, query keys, cache invalidation, validation, and the mock API contract.

## 2.4 API contract

**`GET /api/v1/rn/files-pending-manual?cursor=&limit=50`**
- Role gate: `admin + ops_staff`.
- Response: `{ data: FilePendingItem[], nextCursor: string | null }`.
- `FilePendingItem = { fileReadStatusId, caseId, caseLabel, veteranName, filePath, fileBaseName, lastCheckedAt, attemptCount, lastAttemptMethod, lastAttemptReason }`.
- Order: oldest `lastCheckedAt` first (longest waiting).

**`GET /api/v1/cases/:id/files/:fileReadStatusId/signed-url`**
- Role gate: `admin + ops_staff + physician`.
- Response: `{ data: { url: string, expiresAt: string } }`.

**`POST /api/v1/cases/:id/files/:fileReadStatusId/manual-summary`** — unchanged; already shipped.

**`GET /api/v1/cases/:id/files-pending-manual`** — unchanged; already shipped (per-case fallback).

## 2.5 Testing strategy

**Backend unit/integration:**
- `rn.test.ts` — pagination correctness, role-gate enforcement (physician 403s), ordering, empty-set returns `data: []`.
- `signed-url.test.ts` — URL is presigned, TTL ≤ 5 min, 404 on missing row, 403 on non-matching case.

**Frontend tests:**
- React Testing Library on `RnQueuePage` (renders the queue, pagination control fires next-cursor fetch, badge count is from server).
- `RnFileDetailPage` (PDF iframe renders, textarea ≥40-char gate disables submit, submit invalidates the three cache keys).

**QA-passed at end of step:**
- Backend tests green.
- GPT-built UI commit lands; lint clean; manual test on a seeded case proves the loop: upload a blocked PDF → row shows in /rn queue → click → write 40-char summary → submit → row disappears from queue → `/cases/:id/chart-readiness` flips `ready: true`.

## 2.6 Dependencies on prior steps

Build 1 NOT required (cover page is unrelated to the manual-summary loop). Phase 5.2 (already shipped) is the only prerequisite.

## 2.7 Out of scope

- Bulk-summary write (one row at a time only).
- Re-trigger OCR from the RN UI ("retry Textract" button) — deferred to Build 3 once the worker exists.
- Editing a previously-submitted manual_summary (one-shot only; correction path goes through admin).
- Notifications when a new file lands in the RN queue.
- The `rn` AppRole itself (deferred; current gate is `admin + ops_staff`).

## 2.8 Estimated time

**Backend: 1 hour. UI brief: 1 hour. ChatGPT UI implementation + wire-in: 2–3 hours. Architect QA: 30 min. Total ~4–5 hours wall-clock.**

---

# Build 3 — Phase 7A OCR + Doctor Pack assembler workers

## 3.1 Resolved design

**Runtime split (open Q answered).** Both workers in **Python**, not TypeScript. Rationale:
- Textract async API + Comprehend Medical have first-class Python bindings (`boto3` + `botocore`); the TypeScript SDK is feature-equivalent but ecosystem ergonomics (pypdf, pdfplumber, ReportLab, WeasyPrint for HTML→PDF) are significantly better in Python for the assembler.
- The "mixing runtimes" cost is real but small: two Lambdas in one CDK stack with separate `LayerVersion` for each. CDK has Python Lambda support that's identical in ergonomics to Node.
- The alternative — TypeScript assembler with chromium-aws-lambda + puppeteer-core for HTML→PDF + pdf-lib for concat — is 250 MB+ of bundled deps and brittle Chromium-version pinning. We avoid it.

**Auto-classification via Comprehend Medical / BDA (open Q answered).** YES, ship in this build. Rationale:
- The classifier service `classifyFileWithContentHint` already takes a `contentHint` parameter (commit `37025ff`) — the contract is in place; we just have to populate it.
- Without content classification, "back pages for va letters.pdf" misclassifies as `normal` and the rating decision lands in the bulk-exclusion tier. This is a HARD RULE violation [[feedback_records_minimalism]] equivalent (high-signal docs must be picked up by content, not just filename).
- Implementation: after Textract returns `extractedText`, the OCR worker POSTs to a new `/api/v1/cases/:id/key-docs/content-classify` endpoint with `{ filePath, contentHint: { docType, classification, confidence } }`, where the worker derives the hint via regex over the extracted text (cheap, deterministic) + Comprehend Medical for medical-entity scoring. Comprehend full-content classification is later; regex+entity hint is the v1 contract.

**Retry / DLQ strategy (open Q answered).**
- OCR Lambda: SQS `maxReceiveCount=3` + 14-day DLQ retention (already in `queue-stack.ts`).
- Assembler Lambda: same. Plus a manual-replay UX surface: `POST /api/v1/admin/doctor-pack/:id/retry` (admin-only) that re-publishes the message. Replays bump `DoctorPack.version` so optimistic locking on the worker writer doesn't conflict with a concurrent in-flight retry.
- The OCR worker's "I failed permanently" outcome is the existing FileReadStatus `manual_summary_required` terminal status — DLQ landing is the audit trail, the chart-readiness gate is the user-facing surface.

**Lambda timeout / oversized packs (open Q answered).**
- OCR Lambda: 5 min timeout (Textract async is fire-and-forget; the lambda just starts the job and exits). The SNS subscriber Lambda that handles Textract completion: 2 min, 2 GB memory.
- Assembler Lambda: 15 min timeout (the hard Lambda max), 3 GB memory. Empirical target: 250-page pack assembles in <60 s warm; even a 1000-page worst case under 10 min. **FFC-3 trigger:** if real-world warm runs exceed 60 s for 250 pages, move to ECS Fargate task triggered by the SQS message instead.
- 50 MB scan pages: handle via pdf-lib's streaming write; do not load all pages into memory at once. If a single page is >20 MB, the assembler downsamples by re-rendering through pdf2image at 150 DPI rather than 300 DPI.

**Backfill path.** Add `POST /api/v1/cases/:id/files/reprocess` (admin + ops_staff only). Side-effect: enqueues OCR messages for every Document on the case that doesn't have a `read` terminal status. Idempotent via the upsert keyed on `(caseId, filePath)`.

**Anything missed.**
- The OCR worker writes to the API via a **service principal token**, not a Cognito JWT. Need a small auth path: `middleware/auth.ts` accepts an `X-Service-Principal` header with a signed JWT from a worker-only IAM role's secret. Or: API Gateway + IAM auth for the worker-only endpoints. Pick one in implementation; brief should call out the decision.
- S3 EventBridge trigger for the OCR worker (new file lands → OCR fires). Configure in `StorageStack`; CDK update.
- DB writes from a Lambda in the API stack VPC: the worker Lambda needs VPC access to talk to RDS, OR it goes through the API. Going through the API is simpler (no VPC-attached Lambda, no NAT cost); the API becomes the single DB writer (single-source-of-truth pattern [[Morales-2026-05-08]]). Pick the API-only path.

## 3.2 Data model changes

**Migration: `20260527000000_phase7a_worker_audit`**
- `Document.textractJobId TEXT NULL` — surface the Textract async job ID so we can join logs.
- `Document.ocrCompletedAt TIMESTAMPTZ NULL` — when the worker last finished a successful extract.
- `KeyDoc.contentClassificationJson JSONB NULL` — store the content hint that drove classification (`{ source: 'comprehend-medical' | 'regex-derived', docType, classification, confidence, extractedAt }`).
- New index: `documents_textract_job_id_idx ON documents(textract_job_id) WHERE textract_job_id IS NOT NULL`.

**No new tables.** `DoctorPack` carries assembler state already (`state`, `errorMessage`, `pageCount`).

## 3.3 Code surface

**Backend:**
- `backend/src/routes/internal/worker.ts` — worker-only endpoints (auth via service principal):
  - `POST /internal/cases/:id/files/read-attempts` (alias of the existing endpoint with service-principal gate; or fold into existing route by accepting both auth types).
  - `POST /internal/cases/:id/key-docs/content-classify` — receives the content hint, upserts on the KeyDoc row.
  - `POST /internal/doctor-packs/:id/ready` — assembler PATCHes state to ready + uploads page_count.
- `backend/src/routes/admin/reprocess.ts` — `POST /api/v1/cases/:id/files/reprocess` (admin + ops_staff).
- `backend/src/middleware/service-principal.ts` — JWT-validation middleware specific to worker principals (separate audience from user pool).

**Infra (new CDK stack `WorkersStack`):**
- `infra/lib/workers-stack.ts` — Python Lambdas, SNS topics, SQS queues, IAM roles, EventBridge rule for S3 uploads.
- `infra/lambda-python/ocr_worker/` — `handler.py` (Textract async start), `requirements.txt`, build script.
- `infra/lambda-python/ocr_completion/` — `handler.py` (SNS subscriber → POST to API).
- `infra/lambda-python/assembler/` — `handler.py` (pdf-lib equivalent: pypdf2 + WeasyPrint for cover page).
- `infra/bin/compact-emr.ts` — wire WorkersStack.

**Frontend (small):**
- Add a "Retry OCR" button on the RN file-detail page (calls `POST /reprocess` scoped to one file).
- Add a "Retry Doctor Pack assembly" button on the Case Detail Doctor Pack tile (admin only).

## 3.4 API contract

**`POST /internal/cases/:id/files/read-attempts`** — same body as existing `POST /cases/:id/files/read-attempts`. Auth: `X-Service-Principal` JWT only (not Cognito).

**`POST /internal/cases/:id/key-docs/content-classify`**
```
{ filePath, contentHint: { docType, classification, confidence } }
```
Response: `{ data: keyDocRow }`. Idempotent on `(caseId, filePath)`.

**`POST /internal/doctor-packs/:id/ready`**
```
{ pdfS3Key, pageCount, generatedSourcePageCount, durationMs }
```
Response: `{ data: doctorPackRow }`. Refuses on stale `version` (optimistic lock).

**`POST /api/v1/cases/:id/files/reprocess`** — admin + ops_staff. Body: `{ filePaths?: string[] }` (all on case if omitted). Side-effect: enqueues OCR messages, writes activity log.

**`POST /api/v1/admin/doctor-pack/:id/retry`** — admin only. Side-effect: re-enqueues assembler message for the row.

## 3.5 Testing strategy

**Unit:**
- Python: `test_ocr_worker.py` (mock Textract, assert async job started + DocumentId stored).
- Python: `test_assembler.py` (mock S3 GET/PUT, assert page concatenation order matches manifest, assert cover page is page 1).
- TypeScript: `service-principal.test.ts` (JWT validation, audience check, expired token refused).
- TypeScript: `internal-routes.test.ts` (only service-principal JWTs accepted; user JWTs 401).

**Integration (LocalStack):**
- Upload a synthetic PDF to LocalStack S3 → EventBridge fires → OCR worker writes a FileReadStatus row.
- Trigger `/doctor-pack/generate` → assembler picks up SQS → assembled PDF lands in S3 → row PATCHes to ready.

**Smoke (live AWS dev env):**
- One real veteran case with 3-5 records uploaded; full pipeline runs end-to-end. Doctor Pack downloads with a cover page + TOC + correct page order.

**QA-passed at end of step:**
- All unit + LocalStack integration tests green.
- One real-data smoke run with screenshot evidence of: (a) Doctor Pack PDF with cover page rendered correctly, (b) `manualSummary` flow with a forced-failure case, (c) `reprocess` admin path successfully re-runs OCR.
- CDK stack synthesizes clean (no nag warnings).
- IAM least-privilege validated (workers can ONLY do their declared actions).

## 3.6 Dependencies on prior steps

- Build 1 must be merged — assembler reads `coverPageJson` from the manifest.
- Build 2 SHOULD be merged — when OCR generates manual_summary_required rows, the RN UI is where they get cleared. Could ship Build 3 before Build 2 in principle, but then RNs have nowhere to triage and the chart-readiness gate stays red. Order is enforcing for product reasons, not technical reasons.

## 3.7 Out of scope

- Comprehend Medical entity extraction beyond doc-type hinting (no medical-coding extraction, no SC-event inference).
- BDA (Bedrock Data Automation) — listed as a future read-attempt method on `ReadAttemptInput` but not implemented in this worker.
- Multi-region failover.
- Cost dashboarding (per-doc Textract spend tracking).
- ECS Fargate fallback for oversized packs (only if FFC-3 fires).
- Automatic re-classification on existing KeyDoc rows when classifier version bumps (manual reprocess only).

## 3.8 Estimated time

**Python Lambdas + tests: 4 hours. CDK stack: 2 hours. Backend internal routes + service-principal middleware: 2 hours. LocalStack integration test: 1 hour. Smoke run on dev AWS: 1 hour. Architect QA: 1 hour. Total ~11 hours wall-clock.**

---

# Sequencing decision tree

```
[Start]
   │
   ├─→ Build 1: Cover-page aggregator + manifest extension
   │     │
   │     ├─→ Architect QA (FFC-1 check: payload size, factoring stays in manifestJson?)
   │     │     │
   │     │     ├─ PASS → Build 2 (or parallel)
   │     │     └─ FAIL → re-architect: promote to doctor_pack_cover_pages table; loop back
   │     │
   ├─→ Build 2: RN UI (backend routes + GPT-built frontend)
   │     │
   │     ├─→ Architect QA (cache-invalidation correctness, role-gate consistency, audit-trail completeness)
   │     │     │
   │     │     ├─ PASS → Build 3
   │     │     └─ FAIL → fix flagged items; loop back
   │     │
   ├─→ Build 3: Phase 7A workers (Python Lambdas + WorkersStack)
   │     │
   │     ├─→ Architect QA (IAM least-privilege, service-principal auth, FFC-2 latency, FFC-3 assembler timeout)
   │     │     │
   │     │     ├─ PASS → Final pass (end-to-end smoke + integrated QA across all 3 builds)
   │     │     └─ FAIL → triage by FFC: re-architect appropriately
   │     │
   └─→ Final pass — full pipeline run + memory updates + INCIDENTS.md if anything emerged
```

**Hard sequencing edges:**
- Build 3 BLOCKED until Build 1 is merged (assembler reads coverPageJson).
- Build 3 SHOULD wait on Build 2 (RN queue needed to clear gate-blocking files surfaced by the worker).
- Build 1 ↔ Build 2 are independent.

**Parallelizable surface:**
- Build 2 frontend (GPT) can run while Build 1 is in architect QA.
- Build 3 CDK scaffold can be drafted (no deploy) while Build 2 is being built.

---

# Memory persistence

Post Build-3, anchor these into agent memory:
- **feedback_compact_emr_cover_page_in_manifest.md** — design decision: cover-page metadata lives in `DoctorPack.manifestJson.coverPage`, not a separate table. Why: ephemeral 1:1 metadata, 8 KB budget, no independent-query need. FFC-1 trigger documented.
- **feedback_compact_emr_workers_python.md** — design decision: OCR + assembler workers in Python, not TypeScript. Why: Textract + pdf libs ecosystem; HTML→PDF without bundling Chromium.
- **feedback_compact_emr_api_only_db_writer.md** — design decision: workers POST to API; API remains the single DB writer. Why: avoids VPC-attached Lambda + NAT, preserves single-source-of-truth audit-log pattern.
- **project_compact_emr_phase7a_phase7b_plan_2026_05_25.md** — this plan, linked from the FRN project memory.

If FFC-1, FFC-2, or FFC-3 fires during execution, write an INCIDENTS.md entry inline with date + symptom + root cause + decision + lesson.
