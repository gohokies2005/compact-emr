# Compact-EMR — Jotform Intake Ingestion Spec (v1)

**Author:** Claude (compact-EMR builder) · **For:** Dr. Ryan · **Date:** 2026-06-04
**Status:** DRAFT for review (architect QA + Ryan) → build on approval.
**Supersedes:** the generic `flatratenexus-project/docs/COMPACT_EMR_INTAKE_FILE_HANDLING_BRIEF.md` (this is the stack-specific version, pointed at the compact-EMR on AWS — NOT the legacy local poller).

---

## 0. Architect review — verdict & required changes (incorporated)

**Verdict: SHIP-WITH-CHANGES.** Core architecture (doorbell webhook → fetch-by-ID worker → triage pool → explicit assign) is sound and reuses live patterns. Two P0 correctness gaps + several P1s must be built per below. This section is the authoritative build checklist; it corrects two wrong claims in the prose that follows.

**P0 (must fix before build):**
- **P0-1 — OCR trigger is S3-event-driven, NOT record-path-driven.** OCR fires from an **EventBridge "Object Created" rule on the `cases/` S3 prefix** → `ocr-start` Lambda, which resolves the Document by s3-key (`GET /internal/documents/by-s3-key`). A `prisma.document.create` triggers nothing. `ocr-start` **permanently skips** (404, only 2 EventBridge retries) if the Document row doesn't exist when the copy's event lands. → **Assign MUST: (1) create the Document row with the final `cases/<caseId>/<uuid>-<filename>` key FIRST, (2) THEN server-side `CopyObject` into that key** (CopyObject emits the ObjectCreated event). Order is load-bearing. (Corrects §3/§5/§6 wording below.)
- **P0-2 — "create new veteran/case" needs required fields + id-minting.** `Veteran.id`/`Case.id` have NO `@default` (app mints `VET-…`/`CLM-…`); `Veteran.dob` and `Veteran.email` are **required (non-null)**; `Case.claimType` is a required enum. A Jotform intake often lacks DOB. → The create-new path MUST go through the existing veteran/case creation **service** (not raw `prisma.create`), and the assign panel must collect DOB + email when creating a new veteran. **BLOCKER:** Ryan must confirm the minimum fields to create a veteran (esp. DOB) before the assign path is built — see §11 Q2.

**P1 (this build):**
- **P1-1 — Webhook body parser + mount order.** Jotform POSTs urlencoded/multipart; `server.ts` only has `express.json` and wraps all `/api/v1` in `authenticateJwt`. Mount the webhook **before** the JWT mounts (like the `/internal/` token routes) with its **own** small `urlencoded` parser (payload can exceed the 1 MB global json limit).
- **P1-2 — Worker sizing.** Stream download→S3 (no full buffer); Lambda timeout ≥ 10 min, memory ≥ 1024 MB; per-file size cap (mirror `MAX_UPLOAD_BYTES = 50 MB`) → oversize = flag to RN, not a worker crash→DLQ.
- **P1-3 — Content-type allow-list on assign.** Reuse the manual path's `ALLOWED_CONTENT_TYPES` (PDF/JPG/PNG/DOC/DOCX). Jotform files can be HEIC/ZIP → reject/flag with a per-file reason (don't copy an un-OCR-able file into a case where chart-readiness then blocks).
- **P1-4 — Assign atomicity contract.** Create veteran+case in one tx; then per-file **(create row → CopyObject)** recording a per-file success/failure result; set Intake `assigned` only if ≥1 file attached; persist a per-file manifest so a retry attaches only the missing files (idempotent on `Document.s3Key @unique`). Recovery for a mis-assign = the already-shipped per-row **Delete document**.
- **P1-5 — FIFO MessageGroupId = submissionId** (NOT a constant — that would serialize all intake globally). DedupId = submissionId.
- **P1-6 — Webhook idempotency race.** Use a real `upsert` / create-catch-`P2002`=success; the **worker is the sole writer of parsed fields** (webhook writes only keys + status=pending).

**P2 (note/defer):** `Intake` add `retryCount`, `webhookReceivedAt`, index `jotformFormId`, prefer a Prisma enum for `status`; `rawAnswersJson` is full PHI → include in the retention/reaping policy; API Gateway throttle on the webhook (cheap) now, **HMAC body signature = v2 hardening**; `assigned*` are non-FK staging columns (intentional).

**Data-plane caveat:** the assign path is a NEW writer into `cases/`, `documents`, `file_read_status` — the exact data the now-veteran-scoped drafter bundle reads across ALL a veteran's cases. A malformed assign pollutes every case's draft for that veteran. So P0-1/P1-3/P1-4 are correctness-of-a-shared-data-plane, not polish.

---

## 1. Goal & scope

Get veteran-submitted Jotform files into the compact-EMR **automatically** (no manual download), into a **triage pool**, where an RN **assigns** them to the right veteran/case and reviews them — with **per-veteran isolation** and **no Jotform timeouts**.

**v1 (this build):** webhook ingest → intake pool → manual "assign to (new or existing) veteran/case" → files become normal case Documents → existing OCR/chart pipeline runs.

**Explicitly deferred (not v1):** auto-match suggestions, doc-type tagging UI, missing-records checklist, email-parse backstop, fancy filename rewriting. (Each is additive later; none blocks getting off manual Jotform.)

**Non-negotiables (from Ryan's brief):** per-veteran physical isolation in S3; no manual Jotform downloading in the normal flow; resilient to Jotform being slow (no tight poll, retry/backoff); HIPAA-clean (encrypted at rest, access-controlled, audited).

---

## 2. Core design decision — webhook as a *notification*, worker fetches by ID

The webhook handler does the **minimum** and returns 200 in ~50ms; a worker does the slow work async. This is the fix for the Jotform timeout/429 pain.

```
Jotform form (submit)
   │  POST (form-encoded) — fires once per submission
   ▼
API Gateway → ingest-webhook Lambda  (PUBLIC route, secret-gated)
   │  1. verify shared secret (constant-time)
   │  2. parse ONLY formID + submissionID from payload
   │  3. upsert Intake row (status=pending, unique on jotformSubmissionId)
   │  4. enqueue SQS {intakeId, formId, submissionId}
   │  5. return 200  ← Jotform never waits on file download
   ▼
SQS (jotform-ingest.fifo) → ingest-worker Lambda
   │  1. fetch authoritative submission from hipaa-api.jotform.com by ID (API key)
   │  2. extract fields (name/email/phone/state/condition) + file URLs
   │  3. download each file → S3 intake/<intakeId>/<filename>
   │  4. update Intake: status=ready, parsed fields, file manifest
   ▼
Intake pool (EMR UI) → RN assigns → Documents on a Case → existing OCR
```

**Why notification-not-payload:** the worker re-fetching by ID from the API means (a) **one handler works for all 59 forms** (no per-form multipart parsing — they share a field schema), (b) we get the authoritative data even if the webhook payload is partial/quirky, and (c) a spoofed webhook can only cause a harmless lookup of a submission ID that won't validate. The webhook is a doorbell, not the package.

---

## 3. Why this is low-risk (reuses what's already live)

Everything here mirrors existing compact-EMR patterns — **purely additive**, touches nothing in production:

| New piece | Mirrors existing |
|---|---|
| `jotform-ingest.fifo` queue + DLQ + worker Lambda | chart-extract / doctor-pack / draft-job queues + workers |
| `Intake` Prisma table | existing tables; additive migration only |
| Assign → create `Document` rows on a case | the existing Document model + per-case S3 layout |
| OCR/chart extraction after assign | **already built** — copying a file into `cases/` emits an S3 event → `ocr-start` → DocumentPages → `maybeEnqueueChartExtract` (see P0-1: row-before-copy) |
| S3 isolation per case (`cases/<caseId>/`) | existing per-case PHI layout |
| Auth on pool/assign routes | existing Cognito + `requireRole(['admin','ops_staff'])` |

The only genuinely new surface is **one public webhook endpoint** (secret-gated). Manual upload, drafting, RN review, delivery — all unchanged.

---

## 4. Data model — `Intake` (the pool)

New table (additive migration):

```
model Intake {
  id                  String   @id @default(uuid())
  jotformFormId       String   @map("jotform_form_id")
  jotformSubmissionId String   @map("jotform_submission_id")   // UNIQUE — idempotency
  status              String   @default("pending")             // pending|ready|assigned|dismissed|failed
  // parsed from the submission (best-effort; RN confirms on assign)
  submittedName       String?  @map("submitted_name")
  submittedEmail      String?  @map("submitted_email")
  submittedPhone      String?  @map("submitted_phone")
  submittedState      String?  @map("submitted_state")
  submittedCondition  String?  @map("submitted_condition")
  rawAnswersJson      Json?    @map("raw_answers_json")         // full submission for audit/debug
  fileManifestJson    Json?    @map("file_manifest_json")       // [{name, sizeBytes, s3Key, contentType}]
  submittedAt         DateTime? @map("submitted_at")
  // assignment result
  assignedVeteranId   String?  @map("assigned_veteran_id")
  assignedCaseId      String?  @map("assigned_case_id")
  assignedAt          DateTime? @map("assigned_at")
  assignedBy          String?  @map("assigned_by")
  errorMessage        String?  @map("error_message")
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  @@unique([jotformSubmissionId], map: "intakes_submission_uq")
  @@index([status, createdAt])
}
```

**Status lifecycle:** `pending` (webhook landed, files downloading) → `ready` (files in S3, awaiting RN) → `assigned` (linked to veteran/case, files copied as Documents) → terminal. `dismissed` (RN marks spam/dupe) and `failed` (worker couldn't fetch — retried via DLQ, surfaced to RN) are side states. Nothing auto-creates veterans or cases — assignment is always a deliberate human action.

---

## 5. S3 layout & isolation

- **Pre-assignment:** `intake/<intakeId>/<originalFilename>` — isolated per submission, under no veteran. Same PHI bucket, encrypted at rest.
- **On assign:** selected files are **copied** to `cases/<caseId>/<uuid>-<filename>` (the existing per-case key pattern) and a `Document` row is created per file via the same path manual upload uses. Per-veteran isolation is guaranteed because (a) assignment requires explicitly picking the veteran/case, and (b) each file physically lands under exactly one `cases/<caseId>/` prefix.
- Intake-prefix originals are reaped by an S3 lifecycle rule after assignment/N days (the Document copy is the system of record). v1 can keep them; lifecycle is a config add.

---

## 6. API surface (new)

All under `/api/v1`. Pool/assign routes use existing Cognito + `requireRole(['admin','ops_staff'])`. The webhook is public + secret-gated.

| Method/Path | Auth | Purpose |
|---|---|---|
| `POST /jotform/webhook/:secret` | secret path segment (constant-time compare) | doorbell — upsert Intake + enqueue, return 200 fast |
| `GET /intakes?status=ready&q=<name/email>` | role | the pool list (newest first, search) |
| `GET /intakes/:id` | role | one intake: parsed fields + file manifest + signed preview URLs |
| `POST /intakes/:id/assign` | role | assign to veteran/case → create Documents |
| `POST /intakes/:id/dismiss` | role | mark spam/dupe (with reason) |
| `POST /intakes/:id/retry` | role | re-enqueue a `failed` fetch (RN self-service) |

`POST /intakes/:id/assign` body:
```
{
  veteran: { id: "VET-1" }            // existing, OR
          | { firstName, lastName, email?, phone?, state? },  // create new
  case:    { id: "CLM-..." }          // existing, OR
          | { claimedCondition, claimType },                  // create new under the veteran
  fileS3Keys: ["intake/<id>/a.pdf", ...]  // which intake files to attach (default: all)
}
```
Server (see P0-1 + P1-4): resolve/create veteran → resolve/create case (both via the existing creation **service**, not raw `prisma.create` — P0-2) → for each selected file: **create the `Document` row with the final `cases/<caseId>/<uuid>-<filename>` key FIRST, then server-side `CopyObject` into that key** (the copy emits the S3 event that drives OCR via `ocr-start`) → set Intake `assigned` only if ≥1 file attached → activity log. Per-file result manifest; retry attaches only the missing files (idempotent on `Document.s3Key @unique`).

---

## 7. UI (compact-EMR frontend)

- **New nav: "Intake" (pool)** for admin/ops_staff. Default landing for the RN's day.
  - Table: submitted name · email · condition · # files · age · status. Newest first. Search by name/email. Filter by status.
  - Row click → **intake detail drawer**: parsed fields, **inline PDF/image preview** of each file (signed URL), and an **Assign** panel.
- **Assign panel:** veteran search (by name/email/phone) with "use existing" vs "create new"; case picker (existing case under that veteran) vs "new claim (condition + type)"; file checkboxes (default all); **Assign** button. Confirm summary ("3 files → Frank, Armand / OSA claim").
- After assign: intake drops out of the `ready` pool; the files appear on the veteran/case (existing chart + the veteran-wide bundle).
- Reuses existing components: the veteran search, the case list, the document preview/presign.

---

## 8. Security, reliability, HIPAA

- **Webhook auth:** secret path segment, constant-time compared; secret stored as an AWS secret (like the others). Defense-in-depth: worker validates the submission exists + its formId is in our allow-list before acting, so a spoofed doorbell does nothing.
- **Idempotency:** `Intake.jotformSubmissionId` unique → Jotform's retries (it retries on non-200/slow) are no-ops. SQS message dedup on submissionId.
- **Reliability:** SQS visibility-timeout + DLQ (mirrors existing workers); the worker retries the Jotform API fetch with backoff. A submission that never fetches lands in DLQ → Intake `failed` → visible in the pool with a Retry button (RN self-service, never a silent drop).
- **No tight poll** anywhere — push only.
- **HIPAA:** files encrypted at rest (existing PHI bucket); access via short-TTL signed URLs (existing pattern); every assign/dismiss/view written to the activity log (who/what/when); PHI never leaves AWS.
- **No auto-create / no auto-mix:** the system never fabricates a veteran or case; the RN's explicit assign is the only path files attach to a veteran.

---

## 9. Jotform setup

- **One webhook URL** set on each of the ~59 forms (Settings → Integrations → Webhooks). I'll write a **one-time registration script** (Jotform API) to set the same webhook URL on all forms at once — no clicking through 59.
- **HIPAA API:** base `https://hipaa-api.jotform.com`; submission fetch + file download use the HIPAA API key (stored as an AWS secret). The "attachments stripped under HIPAA" caveat is about *email* notifications, not the API — but **I'll confirm with ONE real test submission** (fetch by ID + download a file) before registering all 59 forms.

---

## 10. Build plan (milestones)

1. **Migration + model** — `Intake` table.
2. **Webhook endpoint** — public, secret-gated, upsert + enqueue + 200. (+ unit tests for secret reject, idempotent upsert.)
3. **Queue + worker** — CDK `jotform-ingest.fifo` + DLQ + worker Lambda; fetch-by-ID + S3 download. (+ worker unit test with a mocked Jotform client.)
4. **Pool + assign API** — list/detail/assign/dismiss/retry. (+ assign test: existing vs new veteran/case, Documents created, OCR enqueue path hit.)
5. **Frontend** — Intake nav + pool table + detail drawer + assign panel.
6. **Jotform registration script** + the one-test-submission verification.
7. **Wire the secret** (Ryan provides the HIPAA API key + the webhook secret) → register all forms → live.

Steps 1–5 are buildable + testable **without** the live key (mocked Jotform client). The key is only needed at step 6/7 (go-live) — **I'll flag you exactly when.**

---

## 11. Open questions for Ryan

1. **Forms:** ✅ RESOLVED (2026-06-04) — register **main intake + Stage-2 condition forms first**, confirm with one test submission, then expand to the rest.
2. **Veteran identity fields:** ✅ RESOLVED (2026-06-04) — **DOB is mandatory on the Stage-1 intake, so it's always present.** Keep the veteran schema strict (DOB + email required); the assign "create new veteran" path prefills DOB/email from the intake, with an RN-entered fallback only if ever absent (e.g., creating from a Stage-2 form that lacks it). Create via the existing veteran service (id-minting), not raw `prisma.create`.
3. **Dismiss vs keep:** default = keep `dismissed` intakes (audit), not hard-delete. (Decidable at build; low-risk.)
4. **Intake retention:** default = reap `intake/<id>/` S3 originals 30 days after assign (the Document copy is the record); include `rawAnswersJson` PHI in the same reaping. (Decidable at build.)

---

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Public webhook abused | secret path + worker validates submissionId/formId; spoof = no-op; rate-limit at API Gateway |
| Jotform API slow/down | async worker + backoff + DLQ + Retry button; webhook already acked |
| Same veteran fragments across submissions | v1 = RN assigns to existing veteran via search (manual de-dup); auto-suggest later |
| File mis-assigned to wrong veteran | explicit human assign + the **delete-document** feature already shipped (per-row Delete on the veteran chart) as the fix |
| Large/odd files | reuse existing upload classifier/size limits when creating Documents |
| HIPAA API file access differs from assumption | one test submission before registering all forms |

---

**Bottom line:** a doorbell webhook → async fetch-by-ID worker → an intake pool the RN triages → explicit assign that drops files onto the right veteran/case through the machinery that already exists. Additive, isolated, resilient to Jotform, and the smallest thing that gets you off manual Jotform.
