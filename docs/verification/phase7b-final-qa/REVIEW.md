# Phase 7B-revised — Final Architect QA (Builds 1+2+3, all parts)

- **Reviewer:** Code Architect QA agent (read-only, no production code edits)
- **Date:** 2026-05-25
- **Repo:** `gohokies2005/compact-emr` main, commits `892895a` → `00124e8`
- **Working tree at review time:** clean for the in-scope commits; one uncommitted audit file (`docs/audit/2026-05-25_master_brief_gap_analysis.md`).
- **Scope:** Build 1 (`892895a`) + Build 1 follow-ups (`21fe2e7`) + Build 2 (`802dee2`) + Build 3 part 1 (`678504f`) + Build 3 part 2 (`00124e8`).

---

## Overall verdict

**MINOR FOLLOW-UP.** The contract layer is ship-ready. The two flagged gaps (SQS publish from the route + worker manifest fetch) are real and explicitly tracked; the system **will not function end-to-end until part 3 lands**, but the in-scope work is internally coherent, tested, and the security/data-model choices are sound. **APPROVED** to call Phase 7B-revised "build complete pending CDK part 3," which is your work to do.

The one item that elevates this above pure "ship it": **double-write of the queued DoctorPack S3 key** (see Finding #2) — landed in Build 1 and never revisited. Not blocking, but should get folded into the SQS-publish change in part 3.

---

## Dimension-by-dimension review

### 1. End-to-end data flow integrity

Walking a single uploaded PDF:

1. **S3 upload** → records bucket at `records/<caseId>/<documentId>/<filename>.pdf`. ✓
2. **OCR start_handler** (S3 EventBridge) → `textract.start_document_text_detection` with `JobTag=documentId`. ✓
3. **Textract async** → fires SNS on completion with `JobId` + `JobTag` + `Status`.
4. **OCR completion_handler** (SNS-triggered) → paginated `GetDocumentTextDetection`, groups LINE blocks by Page, averages confidence, POSTs to `/api/v1/internal/documents/<documentId>/pages`. ✓
5. **internal-worker route** → upserts one `document_pages` row per page in a single transaction, optionally PATCHes `Document.pageCount`. ✓ — **but see Finding #1 below**: the `documentPageCount` payload field is parsed and logged into activity_log, but **never written to the `documents.page_count` column**. The comment block at lines 14-15 of `internal-worker.ts` says it does; the code does not.
6. **doctor-pack/generate** → reads `document_pages` rows, runs `selectPages` per file, builds manifest with `coverPage` summary, persists `DoctorPack(state='queued')`, returns row. ✓
7. **SQS publish** → **MISSING (explicitly deferred to part 3).** ⚠️
8. **Doctor Pack assembler** (SQS-triggered) → renders cover via WeasyPrint, renders TOC, pulls source PDFs from `RECORDS_BUCKET`, extracts page ranges via pypdf, uploads to `DOCTOR_PACKS_BUCKET` at server-computed key, PATCHes state. ✓ (broad-except + state=failed on any exception)
9. **Physician opens** → existing `/api/v1/cases/:id/doctor-pack/latest` already returns the row; UI fetches `pdfS3Key` and presigns. ✓

**Where the chain silently breaks today:** between step 6 and step 7. The queued row sits forever with no producer enqueueing it. The UI shows "queued" indefinitely. There is no timeout / failed-after-N-minutes watchdog — a `state='queued'` row with `createdAt + 10min < now` should at minimum get flagged in a future ops surface.

**Other silent failure modes the chain does NOT surface:**
- Textract `Status != "SUCCEEDED"` in `completion_handler`: just `print(f"... skipping")` and continues. **No callback to the API marks the document as failed.** The `file_read_status` row never gets a row; the chart-readiness gate stays "we never tried this file" rather than "we tried and failed → needs manual summary."
- Encrypted/corrupted source PDFs in the assembler: caught by the broad `except`, surfaced as `state='failed'` with the Python exception class name + message (capped at 2000 chars). Physician sees a failed pack, not why. Fine for V1, worth a UI-side "failed because:" treatment later.

### 2. Build 3 known gaps — sketches

**(a) Route SQS publish.** Today the route's `db.$transaction(...)` returns the stamped DoctorPack row, then `res.status(201).json(...)`. The publish needs to happen **after** the transaction commits (so a failed publish doesn't strand an orphaned row), but **before** the response (so a publish failure surfaces as 5xx and the caller knows to retry):

```ts
// after the transaction, before res.json:
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
const sqs = new SQSClient({});  // hoisted module-level

const messageBody = JSON.stringify({
  doctorPackId: result.id,
  caseId,
  caseVersion: c.version,
  pdfS3Key: result.pdfS3Key,
  manifest: result.manifestJson,  // full manifest with coverPage + entries
});

try {
  await sqs.send(new SendMessageCommand({
    QueueUrl: process.env['DOCTOR_PACK_QUEUE_URL']!,
    MessageBody: messageBody,
    MessageGroupId: caseId,            // FIFO ordering per case
    MessageDeduplicationId: `${result.id}-${result.version}`,
  }));
} catch (err) {
  // Compensating: mark the row failed so it doesn't hang queued forever.
  await db.doctorPack.update({ where: { id: result.id }, data: {
    state: 'failed',
    errorMessage: `SQS publish failed: ${(err as Error).message}`.slice(0, 2000),
    version: { increment: 1 },
  }});
  throw new HttpError(503, 'queue_unavailable', 'Doctor Pack queue is unavailable; row marked failed.', { doctorPackId: result.id });
}

res.status(201).json({ data: result });
```

**Use FIFO queue** (`.fifo` suffix) — same caseId enqueued twice in quick succession should not race. The architect's `MessageDeduplicationId` from `${id}-${version}` makes re-publish idempotent if the route is retried.

**(b) SQS message schema** — the worker today already expects exactly this shape (`handler.py:198-201`). Document it as a TypeScript type colocated with the router (`backend/src/services/doctor-pack-queue.ts`) and a JSON schema dropped at `workers/doctor-pack-assembler/schema/message.schema.json`. Both sides reference the same schema in code comments. Bump a `messageSchemaVersion: 1` field on the wire so future schema evolution is detectable.

**(c) CDK WorkersStack wiring** — three Lambdas, one queue, three IAM roles:

```
- OcrStartLambda: env COMPACT_EMR_API_URL, INTERNAL_WORKER_TOKEN(secret), COMPLETION_SNS_TOPIC_ARN, TEXTRACT_SNS_ROLE_ARN
  trigger: records-bucket S3 EventBridge "Object Created" prefix=records/
  iam: textract:StartDocumentTextDetection, sns:Publish (on completion topic for Textract role)
- OcrCompletionLambda: same env minus the Textract role
  trigger: SNS subscription on completion topic
  iam: textract:GetDocumentTextDetection
- DoctorPackAssemblerLambda: env COMPACT_EMR_API_URL, INTERNAL_WORKER_TOKEN, RECORDS_BUCKET, DOCTOR_PACKS_BUCKET
  trigger: SQS event source mapping on doctor-pack queue (batchSize=1, maxConcurrency=5)
  iam: s3:GetObject on records bucket, s3:PutObject + s3:PutObjectAcl on doctor-packs bucket
  layer: weasyprint Lambda layer (build from amazonlinux:2023, includes cairo+pango+gobject)
  memory: 2048 MB; timeout: 900s; ephemeral storage: 4096 MB (for working PDFs)
- DoctorPackQueue: SQS FIFO queue with DLQ (maxReceiveCount=3), content-based dedup OFF (we send dedup id explicitly), visibility timeout=910s (> Lambda timeout)
- INTERNAL_WORKER_TOKEN: AWS Secrets Manager secret, granted Read to all three Lambda roles AND to the API task role
```

The API ECS task needs `sqs:SendMessage` IAM on the doctor-pack queue. Add to `ApiStack` as `queue.grantSendMessages(taskRole)`.

### 3. Service-principal token security

**Verdict: good enough for now, weak for a real VPC story; fine as long as it stays inside the VPC.**

What's strong: constant-time compare via `timingSafeEqual`, fail-closed (503) when unset, 16-char minimum, sentinel `service:worker` identity for audit. Header-based, not query-param. Stamps `req.user` so downstream `activityLog.create` rows have an actor.

What's weak:
- **No rotation story.** The token is read once from `process.env` at route registration AND on every request (via `process.env[...]` inside the middleware). The latter means **rotating in Secrets Manager + bouncing the API task picks up the new token without code change**, but the workers also need the rotation broadcast. Document the rotation play: (1) generate new token in Secrets Manager, (2) deploy API with both `INTERNAL_WORKER_TOKEN` (new) and `INTERNAL_WORKER_TOKEN_PREV` (old), (3) deploy workers with new token, (4) remove the PREV variant. **This requires a 2-secret comparison in the middleware** — not shipped, file an issue.
- **No request signing** (HMAC over body + timestamp). Replay attacks are possible if anyone gets the token + can see a captured request. For this threat model (internal VPC, mTLS at the API GW edge if you put one in front), it's acceptable. If you ever expose `/internal/*` to a public endpoint by mistake, this falls open.
- **Single shared secret across both workers.** OCR worker compromised → it can write to `/internal/doctor-packs/:id` and forge state transitions, even though it has no reason to. Mild blast radius increase. The fix is per-worker tokens; the middleware would need to accept either, or you'd mount two routers each with their own middleware.

**Recommendation:** keep the shared secret for V1. **Before phase 8 or any public-network exposure**, switch to AWS IAM SigV4 signing — `requireServicePrincipal` becomes a thin wrapper around `@aws-sdk/signature-v4` verification, the workers sign requests with their Lambda IAM role, no shared secret. That's the proper VPC-internal answer.

### 4. KeyDoc upsert + 3 regeneration scenarios

`doctor-pack.ts:243-294` is the load-bearing block.

**(a) Same file, same docType, RN acked → ack survives.** ✓
- `docTypeChanged = existing.docType !== cls.docType` → `false`
- `needsRnReviewToWrite = existing.selectorAcknowledgedAt && !docTypeChanged ? false : sel.selection.needsRnReview` → `false` (ack preserved)
- The `...docTypeChanged ? { selectorAcknowledgedAt: null, ...}` spread is skipped → ack timestamp + actor survive.
- `notes` and `physicianIncludeAllPages` not in update payload → survive by omission.
- **Correct.** RN clearance is durable across re-generation when nothing semantic changed.

**(b) Same file, docType changed → ack wiped.** ✓
- `docTypeChanged = true` → `needsRnReviewToWrite = sel.selection.needsRnReview` (fresh verdict)
- Spread fires: `selectorAcknowledgedAt: null, selectorAcknowledgedBy: null` → ack cleared.
- `notes` still survives (intentional — RN's prose note about *the file* is content-neutral).
- **Correct.** A re-classified file gets a fresh review per the architect's Build 2 follow-up finding.

**(c) Same file, classifier upgrades and ack was set under old version → expected behavior?**

This is the unstated edge case. Two sub-cases:
- **(c1) Classifier version changes but docType stays the same** (e.g., classifier v2 still calls it `rating_decision` but now matches additional patterns): docTypeChanged=false, ack survives, `selectorVersion` field updates to the new version on the row. The RN's "I reviewed and this is right" decision was about the *content*, not the *selector heuristic*; preserving the ack is correct. ✓ **Working as designed.**
- **(c2) Classifier upgrades AND re-classifies the file** (rating_decision → supplemental_decision): caught by case (b), ack wiped. ✓

**However**, there's a subtle leak: **if `selectorRationale` changes meaningfully** under a same-docType classifier change (e.g., page selector v1 picked pages 3-5, v2 picks pages 3-7), the RN previously approved the v1 page set, not the v2 set. The current code preserves the ack across this. Whether that's "correct" depends on what the RN was acking. If they were acking "the right document is included," ack should survive. If they were acking "the right pages are included," ack should NOT survive. Today's implementation is the former.

**Recommendation:** explicitly document this in the migration comment + ack endpoint comment. Add `selectorVersionAtAck` column when you build the RN UI ack button so a future "force RN re-review when selector version advances" toggle is one-liner.

### 5. WeasyPrint + pypdf failure modes

The assembler is one giant `try` wrapping every PDF op with one `except Exception`. That's pragmatic but coarse.

**Known failure modes the worker handles:**
- WeasyPrint rendering exception → caught, state=failed, errorMessage='WeasyPrintError: ...' truncated to 2000 chars.
- pypdf `PdfReader` on corrupted source → caught, same path.
- S3 GetObject 404 / AccessDenied → caught, same path.
- `_patch_doctor_pack` API failure on the *final* state=ready → caught, then the secondary `_patch_doctor_pack(..., state='failed')` is attempted. If THAT fails too → `print(f"double-failure: ...")` and the message goes to DLQ on SQS retry exhaustion. Reasonable, but the user sees a stuck queued/generating state on the row until DLQ alerting catches it.

**Failure modes the worker does NOT handle gracefully:**
- **Scanned non-OCR pages in the source PDF.** pypdf will happily extract them — the physician opens the pack and sees image-only pages. The page-selector ran against extracted text (which would have been empty for those pages), so the selector probably already excluded them via `pageIsBlank`. Net effect is acceptable but invisible to the physician. **Add to the cover page:** "<X> page(s) in source documents had no extractable text; excluded from selection."
- **Encrypted PDFs.** pypdf throws on read. Caught by broad-except → state=failed. Better: detect encrypted-PDF specifically and surface "this file is encrypted; please re-upload an unlocked copy" in the errorMessage.
- **Source PDF page count < the requested page range.** `_select_pages` clamps `to_idx = min(len(reader.pages), int(pr["to"]))` so it silently truncates. If the manifest says pages 3-7 but the source has 5 pages, pages 3-5 ship and no one knows. **Add a manifest validation pass** before extraction — log if any range exceeds the source's page count.
- **Partial assembly success.** If file 1 succeeds and file 2 fails, the entire pack is marked failed. No partial pack. That's the right call for V1 (don't ship physicians half a pack pretending to be the whole), but the errorMessage doesn't say which file failed. Easy fix: wrap each entry's loop iteration in its own try and capture the offending `filePath`.

**Physician UX when assembly partially fails:** today they see "Doctor Pack: failed (PdfReadError: PDF starts with '%PDF' but cannot be parsed)" in the Doctor Pack panel. Useful for an ops_staff debugging session. Useless for the physician. **Add an Ops/Admin "Doctor Pack failures" surface** that shows the errorMessage + a Retry button (creates a new DoctorPack row from the same source documents).

### 6. /rn cross-case queue security

**Today:** `requireRole(['admin', 'ops_staff'])` — visible to all admin + ops_staff users. Within a single-org deployment, fine.

**If Compact EMR ever multi-tenants:** this leaks across tenants instantly. The route's `db.fileReadStatus.findMany({ where: { terminalStatus: 'manual_summary_required' } })` has no tenant scope, no caseOwner filter, no veteranAssigned filter.

**Worth flagging now?** YES, with a one-line code comment, not a code fix. The cost of adding `tenantId` filtering retroactively across the codebase is meaningful; you should not do it until you actually multi-tenant. But document the assumption explicitly so the next architect/developer doesn't assume the filter is intentional. Suggested comment block on the `/rn/files-pending-manual` handler:

```ts
// Single-tenant assumption: this route returns ALL pending files across every case in the
// database. The current deployment is one-org-per-RDS-instance, so admin + ops_staff
// visibility is by design. If Compact EMR is ever multi-tenanted (shared DB, tenant column
// per row), this query MUST add a tenant filter from req.user.tenantId.
```

### 7. Migration ordering safety

Six new migrations this session, plus three from earlier in Phase 5/6:

```
20260526010000_problem_icd10
20260526020000_sign_offs
20260526030000_clarifications
20260526040000_file_read_status
20260526050000_key_docs
20260526060000_doctor_pack_fixes
20260526070000_document_pages
20260528000000_key_docs_physician_override   # adds columns to key_docs
20260528100000_key_doc_rn_acknowledgement    # adds columns to key_docs
```

**Dependency graph:**
- `20260526050000_key_docs` creates the `key_docs` table.
- `20260526060000_doctor_pack_fixes` (existing, pre-this-session) modifies it — assumed safe.
- `20260528000000_key_docs_physician_override` adds 4 columns (`physician_include_all_pages`, `needs_rn_review`, `selector_version`, `selector_rationale`) — must run AFTER `key_docs`. ✓ (28 > 26 timestamp ordering)
- `20260528100000_key_doc_rn_acknowledgement` adds 2 columns (`selector_acknowledged_at`, `selector_acknowledged_by`) — must run AFTER physician_override migration semantically (the acknowledgement codepaths reference needs_rn_review which physician_override created). ✓ (28100000 > 28000000)
- `20260526070000_document_pages` creates new table with FK to `documents` — `documents` table exists from Phase 1 schema. ✓

All ALTER TABLE statements use `IF NOT EXISTS`. All CREATE statements use `IF NOT EXISTS`. **On a partial-existing DB** (e.g., production has the first 5 migrations applied but not the last 4), Prisma will apply the remaining 4 in order and the ALTERs will not collide. ✓

**One real concern:** `20260528000000_key_docs_physician_override` adds `physician_include_all_pages BOOLEAN NOT NULL DEFAULT false`. On a populous `key_docs` table, this is a full-table rewrite on most PostgreSQL versions (Postgres 11+ supports fast default for NOT NULL with a constant DEFAULT, so this should be O(1) metadata change, not a rewrite — verify your prod is Postgres 11+; the brief says Postgres 16, so you're fine).

**Recommendation:** add a `migration-ordering.test.ts` that applies migrations 1-by-1 on a fresh DB AND on a DB with random subsets of prior migrations skipped, and asserts the schema converges. Cheap insurance.

### 8. Architectural coherence — is the build still coherent?

**Yes, with three soft refactor candidates:**

**(a) `doctor-pack.ts` route file is now 438 lines and growing.** The `/generate` handler alone is ~250 lines, with 4 distinct responsibilities: (1) fetch case + documents, (2) chart-readiness check, (3) page-selector pass + KeyDoc upsert, (4) DoctorPack row creation + manifest persistence. Extract steps 2 and 3 into the existing `services/doctor-pack.ts` (`runChartReadinessGate` and `upsertKeyDocsWithPageSelection`); the route becomes orchestration only. Same pattern as `services/chart-readiness.ts` already follows.

**(b) The "cast through unknown" pattern for Prisma includes shows up in 2-3 places** (`fetchCaseRowForCover`, `aggregateChartSummary`, the `caseWithDocs` block). Each one re-asserts the include shape. **Build a tiny typed-query helper** that wraps the include + cast pattern once. Prevents drift; cosmetic.

**(c) `chart-summary-aggregator.ts` and `doctor-pack.ts` (the service, not the route) both build manifest-ish structures.** The cover-page summary lives on `manifestJson.coverPage`; the entries live on `manifestJson.entries`. If the cover-page schema grows (CDS rationale, physician notes, prior letters), the worker's `_render_cover_page` and the aggregator's TypeScript type need to evolve in lockstep. **Generate the schema once** (zod schema in TS → JSON schema dropped at `workers/doctor-pack-assembler/schema/cover-page.schema.json` → loaded + validated in the Python worker). Same pattern as the SQS message schema recommendation in §2.

**No services should be deleted.** No routes should be consolidated. The structure is fine; it's earning its modularity.

---

## Top 5 findings ranked across all 3 builds

### 🔴 1. (Build 3 part 1) `documents.page_count` is parsed but never written

`internal-worker.ts:122-162` parses `documentPageCount` from the request body, includes it in the activity-log detailsJson, and returns it in the response payload. **It is never used to update `Document.pageCount`.** The doc comment block lines 14-15 claims "Also optionally patches the parent Document's `pageCount` field" — the code does no such thing.

Impact: the page-selector's `pageCount` parameter falls back to `pageRows.length` (line 204 of doctor-pack.ts) when `f.pageCount` is null, which works in steady state but is fragile (an OCR partial extraction would mis-bound page selection).

**Fix:** add inside the transaction in `internal-worker.ts:127-158`:

```ts
if (parsed.documentPageCount !== null) {
  await tx.document.update({
    where: { id: documentId },
    data: { pageCount: parsed.documentPageCount, version: { increment: 1 } },
  });
}
```

Verify the `document` delegate is on `AppDb` (it should be — `documents` model exists since Phase 1).

### 🟡 2. (Build 1) Double-write of `pdfS3Key` inside the create transaction

`doctor-pack.ts:296-322` creates the DoctorPack row, then *immediately* updates it with the deterministic S3 key (because the id is only known post-create). Two DB writes in one transaction, version increments twice (1 → 2 → 3 by the time the route returns). The activity_log row references id `stamped.id` correctly.

**Fix options:**
- (a) Generate the row id client-side as a UUID v4 and use `db.doctorPack.create` with explicit id. One write, version=1 at return. Cleanest.
- (b) Compute `pdfS3Key` after the transaction commits, then a single update. Two writes but split across commits — strictly worse.

Recommend (a). Touches one file, ~5 lines.

### 🟡 3. (Build 3 part 1) OCR `Status != "SUCCEEDED"` silently dropped

`workers/ocr/handler.py:156-158`: a Textract job that fails (`Status='FAILED'` or `'PARTIAL_SUCCESS'`) is logged to stdout and skipped. No callback to the API. The `file_read_status` row for the underlying document never transitions to `manual_summary_required`; the chart-readiness gate continues to report the file as "no read attempt yet."

**Fix:** on `Status != 'SUCCEEDED'`, POST a synthetic read attempt to `/api/v1/cases/<caseId>/files/read-attempts` with method='textract', extractedText='', note=f"textract job failed: {status}". The route's `classifyReadAttempt` will route it to `manual_summary_required` and the RN queue picks it up.

Requires: the SNS message either carries the caseId (it doesn't — only documentId via JobTag) OR the API needs an internal endpoint to map documentId → caseId. Add `GET /api/v1/internal/documents/:id/case-id` (returns `{ caseId }`) to the internal-worker router.

### 🟢 4. (Build 3 part 2) Manifest fetch stub is misleading

`doctor-pack-assembler/handler.py:72-79`: `_fetch_doctor_pack_manifest` raises `NotImplementedError`. **It's never called** — the handler reads manifest from the SQS body (line 200). The function exists as a forward-looking placeholder. Leaving an unreachable raise-NotImplementedError in production code is a footgun: a future refactor that calls it explodes mysteriously.

**Fix:** delete `_fetch_doctor_pack_manifest` entirely. Add the same FIXME comment in module-level docstring instead: "Worker reads manifest from SQS message body. If the message ever exceeds 256KB (SQS limit), add /api/v1/internal/doctor-packs/:id and fetch via API."

The 256KB SQS limit is real. A 250-page pack manifest with full rationales could approach that. Mitigation: the manifest in the message body should be the *minimal* shape the worker needs (filePath, pageRanges, docType, pageCount, plus coverPage). Don't include `selectorRationale` (audit trail; already on the KeyDoc row) or the entire CDS object. **Today's `manifestJson` field is already minimal**, but lock that in with a schema (see §2 sketch (b)).

### 🟢 5. (Build 2) RN UI has no ack button for "selector is wrong about this file"

The Build 1 follow-up shipped the backend ack endpoint (`POST /key-docs/:id/acknowledge`). The Build 2 RN page (`RnQueuePage.tsx`) shows the *manual-summary* queue but **not the *needs-RN-review* KeyDoc queue**. There's no UI surface to clear `needsRnReview` flags from the page-selector.

This is a known gap (Build 1 commit message says "the new ack route has no tests yet — they ship with the RN UI wiring of the ack button in a follow-up"). Not blocking — the chart-readiness gate doesn't depend on `needsRnReview` — but the RN ack endpoint is currently unreachable from the UI.

**Fix:** add a second tab on `/rn` ("Files needing selector review") that lists KeyDoc rows where `needsRnReview = true`. Reuse the queue pane. Each row gets an "Acknowledge as correct" button calling `POST /key-docs/:id/acknowledge`.

---

## Critical path: "before first real case ships"

For a real veteran's data to flow through this end-to-end successfully, all of these must be true:

1. **CDK WorkersStack deployed** (your part 3) — OCR start + completion Lambdas + Doctor Pack assembler Lambda + SQS FIFO queue + DLQ + WeasyPrint Lambda layer + IAM roles.
2. **SQS publish from `/generate`** (Finding from §2(a) above) — the route must enqueue a message after the transaction commits. **Without this, every Doctor Pack stays queued forever.**
3. **`INTERNAL_WORKER_TOKEN` in Secrets Manager** + injected into both the API ECS task and all three Lambda environments. Token must be ≥16 chars.
4. **S3 EventBridge wiring** on the records bucket → OcrStartLambda. Prefix `records/` and suffix `.pdf`.
5. **SNS topic + Textract role** that lets Textract publish completion notifications to the topic. OcrCompletionLambda subscribes.
6. **Finding #1 fix** — `documents.page_count` write — so the page-selector has accurate bounds. Without it, page-selection may over-include or under-include the actual document length.
7. **Finding #3 fix** — Textract-failed → `manual_summary_required` callback — so failed OCR doesn't silently leave files in limbo.
8. **One end-to-end smoke test on staging** with a real (de-identified) rating decision PDF. The path is too many integration points to trust without one wet run before live veteran data.
9. **DLQ alerting** — CloudWatch alarm on the SQS DLQ depth ≥ 1. The first stuck pack should page someone.

Items 1, 3, 4, 5 are your CDK part 3 work. Items 2, 6, 7 are small backend changes (one PR, ~50 lines combined). Item 8 is operational. Item 9 is CloudWatch config.

**Bare minimum to ship the first veteran:** items 1-7. Items 8+9 are best-practice but not strictly blocking if you watch the first 3-5 cases manually.

---

## Approval

**APPROVED** — Phase 7B-revised is build-complete in the repo, modulo:

- Your CDK part 3 work (WorkersStack + SQS + S3 events + SNS + IAM + Lambda layers).
- Finding #1 (documents.page_count write) — small, fold into the part 3 PR.
- Finding #3 (Textract failure callback) — small, fold into the part 3 PR.
- Findings #2, #4, #5 — non-blocking polish; defer to next session.

The Build 1 + Build 2 + Build 3 (parts 1+2) sequence is internally coherent. The 3-tier durability story for KeyDoc state (page-selector verdict → RN ack → docType-change unwind) is the right design. The service-principal middleware is V1-correct, with a documented escalation path to SigV4 for phase 8.

**Pre-real-case checklist** above is the only thing standing between this and a live veteran's data flowing through end-to-end.

---

## Master brief gap analysis — what this session moved

The uncommitted `docs/audit/2026-05-25_master_brief_gap_analysis.md` was written against HEAD `4b8bfdf`, *before* the five commits in this session's scope. Items it flagged that this session meaningfully moved:

| Brief section | Audit status | This session |
|---|---|---|
| §13 SQS draft queue: "no worker, no producer endpoint" | PARTIAL → still PARTIAL but closer | Doctor Pack worker source shipped; SQS producer + CDK still pending part 3 |
| §21 OCR HARD-STOP | SHIPPED at audit time | RN UI escape valve activated (Build 2) — the gate is now operationally clearable, not just a backend wall |
| §17 Physician 3-page experience | NOT SHIPPED at audit time | Cover page + TOC + page-selection delivered the *content* shape of "what the physician sees"; the React UI for the 3-page experience itself is still NOT SHIPPED |
| Doctor Pack page-selection logic | not in original brief | NEW capability beyond brief — physician pack is now page-selected, not whole-document |
| §18 Templates inventory data | STUB | unchanged |
| `/admin/*` and `/p/*` route stubs | STUB | unchanged |

**Net brief progress this session:** Phase 7B-revised closed the "Doctor Pack assembler" gap from §13 (worker source) and §17 (content shape) of the brief, and added a capability (page-selection) the brief never described. Physician-facing UI work (§17 React surface) remains the biggest open gap.

**Recommend:** commit the gap analysis as-is (it's still useful as a baseline), and add a short follow-up note at the top: "Session 2026-05-25 shipped commits 892895a..00124e8; see docs/verification/phase7b-final-qa/REVIEW.md for what moved."

---

## Knowledge capture (for next session's MEMORY.md)

Suggested one-line entries:

- `compact-emr` worker contract is service-principal-token via `X-Internal-Worker-Token`; mounted at `/api/v1/internal/*`; sentinel actor `service:worker` for activity_log. SigV4 migration deferred to phase 8.
- KeyDoc upsert preserves RN ack across re-generation EXCEPT when docType changes (Build 2 finding) — content-neutral selector changes also preserve ack (Build 1 design). `selectorVersionAtAck` column not yet shipped.
- Doctor Pack SQS publish from `/generate` is NOT YET WIRED — queued rows sit forever until CDK part 3 ships the queue + the route's `SendMessage` call.
- Page-selector deterministic regex-only; high-signal docTypes (rating/denial/supplemental/DBQ/C&P) fall back to "include all + needsRnReview=true" if <2 page matches.

NEXT ACTION: address Findings #1 (documents.page_count write) and #3 (Textract-failure callback) in the same PR as the CDK WorkersStack + route SQS publish (part 3). Land them together; smoke-test on staging before first real-case ingestion.
