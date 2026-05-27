# Local → Cloud Port Audit — Producer↔Consumer Contract Sweep

**Date:** 2026-05-27
**Auditor:** code-architect-qa
**Cloud tree:** `C:\Users\ryank\compact-emr-work` (Express-on-Lambda + Prisma/Postgres; CDK infra; Python workers; Fargate drafter)
**Reference tree:** `flatratenexus-project` (established local FRN pipeline)
**Method:** Read both sides of every producer→consumer boundary; confirmed suspicions against live AWS staging (CloudWatch invocations, EventBridge rule pattern, SQS depth, Lambda env, DNS) rather than guessing.
**Scope:** The full real-letter data path: upload → OCR → chart-readiness → doctor pack → drafter → review/sign-off. Code/contract reading + runtime confirmation only. No code edited.

---

## TL;DR — the truth

The OCR text path was never wired, and **it is not a single bug — it is four independent breaks stacked in one chain**, any one of which alone stops OCR. The user's instinct is correct: the same class of defect (a contract that unit tests mock past) recurs in **two other deployed-but-never-invoked chains** (Doctor Pack assembler, and the OCR completion callback) and in **one shared infra fact** (the API hostname every Python worker points at does not resolve).

Runtime proof (14-day `Invocations` Sum, us-east-1 staging):

| Lambda | 14-day invocations | Verdict |
|---|---|---|
| `compact-emr-staging-ocr-start` | **0** | never triggered (prefix mismatch) |
| `compact-emr-staging-ocr-completion` | **0** | never triggered (no Textract job ever started) |
| `compact-emr-staging-doctor-pack-assembler` | **0** | never exercised on real data |
| `compact-emr-staging-stuck-job-watcher` | 569 | scheduled, firing normally |
| `compact-emr-staging-stuck-doctor-pack-watcher` | 219 | scheduled, firing normally |

The two scheduled watchers prove the account/metrics are live; the three work-driven Lambdas have **literally never run**. Both work queues (`doctor-pack-assembler.fifo`, `draft-job.fifo`) are at depth 0/0.

**The single deepest finding:** even if OCR were triggered, **a successful OCR read never produces a `file_read_status` row with `terminalStatus='read'`.** The only code that writes a `read` row is `POST /cases/:id/files/read-attempts`, and *nothing in the cloud tree calls it* (grep-confirmed: it appears only in the route definition and its tests). The OCR worker writes to a *different* table (`document_pages`) on success, and only writes `file_read_status` on *failure*. So the chart-readiness gate is **inverted**: OCR failure is visible (blocks correctly), OCR success is invisible (zero rows → empty-set → `ready=true`). That is the mechanism that got mislabeled "expected garbage-in."

---

## CRITICAL — blocks producing a correct real letter

### C1. OCR success path writes the wrong table; chart-readiness can never see a successfully-read file
**Boundary:** OCR completion Lambda → API → chart-readiness gate
**Producer (success):** `workers/ocr/handler.py:196-200` → `POST /api/v1/internal/documents/:id/pages` → `internal-worker.ts:156-207` writes `document_pages` rows + `Document.pageCount`. **No `file_read_status` row, ever.**
**Producer (failure only):** `handler.py:184-194` → `/read-attempt-failed` → `internal-worker.ts:315-399` writes `file_read_status` with `terminalStatus='manual_summary_required'`.
**Consumer:** `chart-readiness.ts:145-188 evaluateChartReadiness()` reads **only** `file_read_status`. The only writer of `terminalStatus='read'` is `chart-readiness.ts:34-114 POST /cases/:id/files/read-attempts` via `classifyReadAttempt`.
**Grep proof:** `files/read-attempts` / `classifyReadAttempt` exist only in `chart-readiness.ts` + two test files. No worker, no internal route, no client calls it.
**Root cause:** Two parallel, never-joined document-text models were ported separately: the FRN local pipeline's "read-attempt → file_read_status" model (chart-readiness.ts, mirrors `chartCompleteness.js`) and a Textract "document_pages" model (OCR worker + internal-worker /pages). The success branch feeds the second; the gate reads the first. The bridge — "on Textract SUCCESS, create a `file_read_status` row with `terminalStatus='read'`" — was never written.
**Consequence:** With C2/C3/C4 fixed so OCR runs, a clean read still produces **zero** `file_read_status` rows. `evaluateChartReadiness([])` → `ready: true` (the empty=ready hole, chart-readiness.ts:179 + doc comment "Empty file set = ready"). `POST /draft` (drafter.ts:352-359) passes the gate, the bundle's `documents[].pages` is also empty (see C5), and the pipeline halts on an empty chart — *exactly the symptom you saw, dressed up as "garbage-in."*
**Runtime confirmation:** N/A (deterministic from code + grep). Reproduces the observed mislabel.
**Fix:** On Textract SUCCESS the completion handler must register the read with the readiness gate, not only the page text. Cleanest: have `POST /internal/documents/:id/pages` *also* upsert a `file_read_status` row keyed `(caseId, document.s3Key)` with `terminalStatus='read'` inside the same `$transaction` (it already resolves `documentId`; join to `Document.caseId` + `s3Key` like the failed-read route does at internal-worker.ts:324-329). Reuse `classifyReadAttempt` on the concatenated page text so the word-count/garble thresholds still gate (a Textract "success" with 12 garbled words must NOT count as `read`). Do **not** simply flip empty=ready — that defeats the HARD-STOP.

### C2. OCR EventBridge trigger fires on `records/`, but uploads write `cases/` — Textract never starts
**Boundary:** S3 upload → EventBridge → `ocr-start` Lambda
**Producer:** `documents.ts:99` writes key `cases/<caseId>/<uuid>-<filename>`; `s3-key-safety.ts:70-73 isCaseDocumentS3Key` enforces exactly that shape.
**Consumer:** `workers-stack.ts:180-191` EventBridge rule pattern `object.key = [{ prefix: 'records/' }]`; and `handler.py:44-49 _document_id_from_s3_key` requires `parts[0] == 'records'` and reads `documentId` from `parts[2]`.
**Root cause:** Two prefix conventions invented independently. The upload route uses `cases/`; the OCR worker + rule assume a never-produced `records/<caseId>/<documentId>/<filename>` layout (with `documentId` embedded — which the upload key does not contain; `documents.ts` mints the `Document` row id *after* the key is chosen).
**Runtime confirmation:** Live rule pattern = `{"detail":{"bucket":{"name":["...phibucket..."]},"object":{"key":[{"prefix":"records/"}]}}}`. `ocr-start` 14-day invocations = **0**. Bucket `EventBridgeConfiguration` = enabled (`{}` = on, no filter), so the bucket *does* emit; the rule simply never matches.
**Fix:** Pick ONE prefix. Recommended: change the rule prefix to `cases/` (workers-stack.ts:187) and rewrite `_document_id_from_s3_key` to resolve the `Document` by `s3Key` rather than parsing an embedded id (the key has no documentId). Since the key carries no documentId, the worker must look it up: add an internal `GET /internal/documents/by-s3-key?key=...` (or pass JobTag = a server-resolved id). See C3 for why JobTag matters.

### C3. OCR `start_handler` parses an S3-notification event shape, but EventBridge delivers an EventBridge shape
**Boundary:** EventBridge → `ocr-start` Lambda payload contract
**Producer:** EventBridge "Object Created" event — fields at `detail.bucket.name` and `detail.object.key` (confirmed live: the rule's own pattern matches on `detail.bucket.name` / `detail.object.key`).
**Consumer:** `handler.py:54-66` reads `event.get("Records")` then `record["s3"]["bucket"]["name"]` / `record["s3"]["object"]["key"]` — that is the **S3→Lambda direct notification** shape, not the EventBridge shape. An EventBridge-delivered event has no top-level `Records`.
**Root cause:** Worker written against S3-direct-notification semantics; infra wired via EventBridge (`eventBridgeEnabled: true` + `events.Rule`). The two payload shapes were never reconciled.
**Consequence:** Even after C2's prefix fix, `start_handler` would iterate `event.get("Records") or []` → empty → start zero Textract jobs. A second, independent break in the same first hop.
**Runtime confirmation:** Deterministic from the rule pattern (EventBridge shape) vs handler code (Records shape). 0 invocations means it has never even gotten the chance to mis-parse.
**Fix:** Rewrite `start_handler` to read EventBridge shape: `bucket = event["detail"]["bucket"]["name"]; key = event["detail"]["object"]["key"]`. (Or change the trigger to a native S3 notification and keep the Records parser — but EventBridge is already enabled and is the better choice.)

### C4. Every Python worker points `COMPACT_EMR_API_URL` at `api.emr.flatratenexus.com`, which is NXDOMAIN
**Boundary:** OCR/Doctor-Pack worker → API callbacks (`/internal/documents/:id/pages`, `/read-attempt-failed`, `/internal/doctor-packs/:id`)
**Producer (config):** `workers-stack.ts:72` sets `apiBaseUrl = https://${config.apiDomainName}` and injects it into ocr-start, ocr-completion (lines 161, 202) and the doctor-pack assembler (line 233).
**Runtime confirmation:**
- `ocr-start` env `COMPACT_EMR_API_URL` = `https://api.emr.flatratenexus.com`
- `ocr-completion` env = `https://api.emr.flatratenexus.com`
- `doctor-pack-assembler` env = `https://api.emr.flatratenexus.com`
- `nslookup api.emr.flatratenexus.com` → **"Non-existent domain"**
- The drafter Fargate worker, by contrast, was pointed at the raw endpoint `https://nypr790pq7.execute-api.us-east-1.amazonaws.com` (drafter-stack.ts:181) which **does** resolve (13.216.184.138 / 3.211.161.11). The drafter-stack comment (lines 177-181) explicitly flags `api.emr.flatratenexus.com` as NXDOMAIN — but only the drafter stack got the workaround; the workers stack was never updated.
**Root cause:** The `api.emr` custom domain was never stood up. One stack (drafter) worked around it; the workers stack still resolves the dead hostname.
**Consequence:** Independent of C1-C3, the moment any OCR completion or Doctor Pack PATCH fires, the callback dies on DNS. `_post_pages_to_api`, `_post_failed_read_attempt`, and `_patch_doctor_pack` all raise → no page text, no failure row, no `ready` doctor pack.
**Fix:** Either (a) stand up the `api.emr.flatratenexus.com` custom domain (API Gateway custom domain + Route53/Cloudflare record) and keep `config.apiDomainName`, or (b) mirror the drafter workaround — set the workers' `COMPACT_EMR_API_URL` to the raw execute-api endpoint until the domain exists. (a) is correct long-term; (b) unblocks one real case today.

### C5. Drafter bundle `documents[].pages[]` is always empty → drafter materializes zero records
**Boundary:** `buildDrafterBundle` → S3 bundle → Fargate `drafter-worker.js` `materializeRecords`
**Producer:** `drafter-bundle.ts:105-115` fetches `document.findMany({ include: { pages: { orderBy: { pageNumber } } } })` — relation name `pages` is correct (schema.prisma:300). But `document_pages` is populated **only** by the OCR /pages callback, which never runs (C2-C4).
**Consumer:** `drafter-worker.js:193-219 materializeRecords` reads `d.pages[].text`; skips any doc with empty text (`if (text.length === 0) continue;`). Result: zero records materialized → `chart/extraction_report.json` `files: []` → the FRN pipeline's `chartCompleteness.detectRecordsChartGaps` sees no readable records.
**Secondary contract drift (same boundary):**
- `materializeRecords` reads `d.fileName || d.name || d.id` (line 202). The Prisma `Document` field is **`filename`** (lowercase, schema:289). `d.fileName` is always `undefined`; it falls through to `d.id`. Not fatal (id is a usable basename) but the intended human filename never reaches the records tree.
- `materializeChart` comment says "compact-EMR bundle schemaVersion 1" (drafter-worker.js:152) while the bundle is `schemaVersion: '2'` (drafter-bundle.ts:67). Cosmetic/stale, but a tell that the worker was written against an older bundle contract and not re-checked.
**Consequence:** This is the downstream face of C1-C4: with OCR dead, the drafter receives a chart with no record text and halts. Fixing C1-C4 fixes the data; the `d.fileName`/`filename` drift should be corrected in the same pass so filenames survive.
**Runtime confirmation:** Deterministic. `draft-job.fifo` depth 0/0 (no job has run end-to-end).
**Fix:** Fixing C1-C4 populates `document_pages`. Additionally fix `materializeRecords` to read `d.filename`. Verify the worker's `d.pages[].text` field name matches what /pages writes (`DocumentPage.text` — schema:591+, matches).

---

## HIGH — works in isolation, silently wrong on real data

### H1. Doctor-pack route never loads OCR page text (documentId is `undefined`)
**Boundary:** `doctor-pack.ts` `/generate` → page-selector
**Evidence:** `doctor-pack.ts:109-120` selects `documents: { select: { s3Key: true, pageCount: true } }` — **`id` is NOT selected.** Line 153 casts the result to `{ id, s3Key, pageCount }[]` (a lie — `id` is absent at runtime). Line 161 builds `documentId: d.id` → `undefined`. Line 179 `allDocumentIds = ...filter(id => id.length > 0)` → empty (reading `.length` on `undefined` would throw; if it doesn't due to the `?? ''` paths, it filters to empty). `document_pages` is therefore never queried (lines 180-189 guarded by `allDocumentIds.length > 0`).
**Root cause:** A `select` projection that omits the very field a downstream `map` depends on — invisible to a unit test that stubs the delegate with objects that happen to include `id`.
**Consequence:** Even once OCR populates `document_pages`, the page-selector always receives empty `pages` → falls back to whole-doc ranges for every file. Page selection (the entire point of Phase 7B) is inert.
**Fix:** Add `id: true` to the `documents` select (doctor-pack.ts:115).

### H2. Doctor Pack produces a pack with no source pages when page-selection yields empty ranges
**Boundary:** `doctor-pack.ts` manifest → assembler `handler.py`
**Evidence:** With H1 + dead OCR, `selectPages` returns empty `pageRanges`; `doctor-pack.ts:222 if (ranges.length === 0) return entry` keeps the legacy whole-doc entry — but the legacy entry's `pageRanges` may itself be empty (no per-page data). Assembler `handler.py:249 if not file_path or not page_ranges: continue` **skips any entry with empty pageRanges.** A pack whose every entry has empty ranges assembles to cover+TOC only (and with H3, not even those).
**Root cause:** "Empty pageRanges means whole document" is asserted in the route comments (doctor-pack.ts:214-215) but the **assembler does the opposite** — empty ranges = skip. Producer and consumer disagree on the meaning of empty.
**Fix:** Make the assembler treat empty `pageRanges` as "include the whole source PDF" (read `len(reader.pages)` and append all), matching the route's stated contract. Until then, the route must emit explicit full-document ranges (`from:1,to:pageCount`) rather than `[]`.

### H3. WeasyPrint layer never attached → Doctor Pack has no cover page or TOC
**Boundary:** infra → assembler
**Evidence:** `workers-stack.ts:219-222` attaches the layer only if `process.env['DOCTOR_PACK_WEASYPRINT_LAYER_ARN']` is set at synth time; otherwise `layers: undefined`. Runtime check: `doctor-pack-assembler` `Layers: null`. `handler.py:216-221` probes `import weasyprint`, catches `ImportError`, and skips cover + TOC.
**Root cause:** Layer wiring deferred to "operator deploys separately" and never done.
**Consequence:** The chart-summary cover page (the physician's at-a-glance decision surface) and the TOC never render. Combined with H1/H2, a generated pack is currently empty bytes.
**Runtime confirmation:** `Layers: null`; assembler 0 invocations.
**Fix:** Build/obtain the WeasyPrint Lambda layer, set `DOCTOR_PACK_WEASYPRINT_LAYER_ARN` before `cdk deploy compact-emr-staging-workers`. Verify `import weasyprint` succeeds in the deployed function.

### H4. Doctor-pack assembler manifest-fetch is a `NotImplementedError` stub
**Boundary:** assembler self-fetch path
**Evidence:** `handler.py:72-79 _fetch_doctor_pack_manifest` raises `NotImplementedError`. It's currently unused (the manifest rides in the SQS body, handler.py:200), so this is latent — but the SQS body path is the *only* way the manifest reaches the worker, and the message is FIFO with `maxReceiveCount: 3` → DLQ. If the SQS body is ever truncated/oversized (large manifests), there is no fallback fetch.
**Fix:** Either delete the dead stub or implement the planned `GET /api/v1/internal/doctor-packs/:id` (the FIXME at handler.py:75). Low urgency; flag so it isn't mistaken for a working fallback.

### H5. Drafter worker `COMPACT_EMR_API_URL` is a hardcoded raw endpoint with a TODO; brittle to API redeploy
**Boundary:** infra → Fargate drafter
**Evidence:** `drafter-stack.ts:181 COMPACT_EMR_API_URL: 'https://nypr790pq7.execute-api.us-east-1.amazonaws.com'` with TODO (lines 177-180). It resolves today, but the execute-api id changes if the HttpApi is recreated, and it's not derived from `ApiStack` (no prop wiring). The drafter and the workers now disagree on which URL is the API (raw vs NXDOMAIN custom domain).
**Fix:** Stand up `api.emr.flatratenexus.com`, point BOTH the drafter and the workers at `https://${config.apiDomainName}`, delete the hardcode. This also resolves C4 in one move.

---

## MEDIUM / cosmetic

### M1. `fetchCaseRowForCover` drops `cdsOddsPct` → cover page never shows the IMO win-rate badge
**Boundary:** `doctor-pack.ts fetchCaseRowForCover` → `aggregateChartSummary`
**Evidence:** `aggregateChartSummary` (`chart-summary-aggregator.ts:128-129`) reads `caseRow.cdsOddsPct`. The full-row branch of `fetchCaseRowForCover` (doctor-pack.ts:61-74) returns `cdsVerdict`, `cdsOddsPct`, `cdsRationale` — OK. But the **fallback branch** (lines 46-59) omits `cdsOddsPct` (sets `cdsVerdict`, `cdsRationale` only). If the fallback ever fires, `cdsOddsPct` is `undefined` and the assembler's `{cds_odds:.0f}%` badge silently drops. Minor; fallback "shouldn't happen."
**Fix:** Add `cdsOddsPct: null` to the fallback object for shape parity. (Cover page is also dead until H3 anyway.)

### M2. `materializeChart` seeds `claim_type` default `'secondary'`, drafter-worker line 258 default `'secondary'`, route default differs
**Boundary:** bundle → materializeChart
**Evidence:** `drafter-worker.js:160 claim_type: c.claimType || 'secondary'` and `:258 (bundle.case && bundle.case.claimType) || 'secondary'`, but the cloud `Case.claimType` default elsewhere is `'initial'` (doctor-pack.ts:54 fallback). A null claimType becomes `secondary` in the drafter, `initial` in the doctor pack — inconsistent framing default. Low impact (claimType is usually set) but a divergence worth pinning to one default.
**Fix:** Pick one default and use it in both materializers.

### M3. Stale "NOT YET DEPLOYED" / "Phase 7A ships together" comments across worker files
`handler.py` (ocr) line 20, `handler.py` (doctor-pack) line 21, `doctor-pack.ts:95` all say the worker "is not in this commit / not yet deployed." They ARE deployed (Lambdas exist). Comments now actively mislead a reader into thinking the chain is intentionally inert. Update on the fix pass.

### M4. `workers-stack.ts:248-251` comment claims the API reads queue URLs "via SSM in bin/*" — false
The API stack reads `DOCTOR_PACK_QUEUE_URL` / `DRAFT_JOB_QUEUE_URL` / tokens directly from CDK props (api-stack.ts:94-103, fed from `bin/compact-emr.ts:51-54`). The SSM comment is stale and sent me chasing a non-existent gap. Delete it. (This boundary is actually wired correctly — confirmed.)

---

## "Passes tests but cannot work on real data" — the explicit list

Every item below is green in the current suite because the test mocks the exact boundary that is broken in production:

1. **C1** — `internal-worker-routes.test.ts` asserts `/pages` writes `document_pages`; `chart-readiness*.test.ts` asserts `read-attempts` writes `read`. **No test asserts that an OCR success makes chart-readiness `ready` for that file** — because no code connects them. Each half is green; the missing seam is untested.
2. **C2/C3** — no test feeds a real EventBridge event (or a real `cases/` key) to `start_handler`. Worker unit tests (if any) would hand-craft a `Records[]` S3 event, masking both the prefix and the shape bug.
3. **C4** — every worker test mocks `urllib.request.urlopen`; DNS is never resolved, so NXDOMAIN is invisible.
4. **C5/H1** — `doctor-pack.test.ts` and `buildDrafterBundle` tests stub the Prisma delegate with objects that include `id` and non-empty `pages`, so the `select` omission (H1) and the empty-`document_pages` reality (C5) never surface.
5. **H2** — assembler `_select_pages` is tested with explicit `pageRanges`; the empty-ranges-skip behavior vs the route's "empty = whole doc" intent is never cross-checked.
6. **H3** — WeasyPrint is import-probed and skipped; tests run in the skip branch, so "no layer" looks like a graceful degrade rather than "cover page is gone."
7. **e2e** — `e2e/rn-workflow.spec.ts` stops at *"the Send to Drafter button is visible — Do NOT click it."* It asserts the UI renders. It never uploads a document, never triggers OCR, never starts a draft, never reads a `/complete`. The entire data path is outside Playwright coverage.

---

## (a) Minimum fix set to get ONE real case through upload → OCR → draft → review → sign-off

Ordered; each is necessary, none alone is sufficient.

1. **C4 (unblock callbacks):** point the workers' `COMPACT_EMR_API_URL` at the resolving raw execute-api endpoint (mirror the drafter) OR stand up `api.emr.flatratenexus.com`. Redeploy `compact-emr-staging-workers`.
2. **C2 (trigger):** change the EventBridge rule prefix `records/` → `cases/` (workers-stack.ts:187).
3. **C3 (event shape):** rewrite `start_handler` to read `event["detail"]["bucket"]["name"]` / `["object"]["key"]`; resolve `documentId` by `s3Key` lookup (the key has no embedded id), set that as the Textract `JobTag`.
4. **C1 (the seam):** on `/pages` success, upsert a `file_read_status` row `(caseId, s3Key)` with `terminalStatus='read'`, gated through `classifyReadAttempt` on the concatenated text, inside the existing transaction. This is the one fix that makes chart-readiness reflect reality.
5. **C5 (filename drift):** fix `materializeRecords` to read `d.filename`. (Page text flows once C1-C4 land.)
6. Redeploy workers + API + (re)deploy the drafter image with `desiredCount` bumped to 1 once a job is queued (drafter-stack.ts:206 scale-to-zero will spin it up on queue depth).

That set produces a real chart with real OCR'd text reaching the drafter. Doctor Pack (H1-H3) is **not** on the critical path to a letter — the drafter reads `documents[].pages`, not the doctor-pack PDF — so defer H1-H3 to the Doctor-Pack-correctness pass unless the physician-review step requires the pack.

## (b) Test-coverage gap a real e2e must assert (that smoke/Playwright today do not)

A real end-to-end test (against staging, with a fixture PDF) must assert the *seams*, not the components:

1. **Upload → OCR start:** PUT a real fixture to a `cases/<id>/...` key; within N seconds assert `ocr-start` Invocations > 0 (CloudWatch) — catches C2/C3.
2. **OCR → page text:** poll `GET /cases/:id/...` (or DB) until `document_pages` has rows for the document — catches C4 + the /pages contract.
3. **OCR success → readiness:** assert `GET /cases/:id/chart-readiness` returns `ready: true` **with `readFiles >= 1`** (not `totalFiles: 0`). The `readFiles >= 1` assertion is the one that would have caught C1 — `ready: true` alone is satisfied by the empty-set hole.
4. **Draft:** `POST /cases/:id/draft` → poll the DraftJob to `done` → assert `runComplete` and a non-empty artifact, AND assert the materialized chart had `records > 0` (drafter `/progress` manifest or a log assertion) — catches C5.
5. **Negative-control for the empty-set hole:** a case with an uploaded-but-unreadable file must yield `ready: false` (manual_summary_required), and a case with **zero** uploads must NOT be draftable as if ready — add an explicit "documents present but none read ⇒ not ready" assertion so the empty=ready behavior can never silently mask a dead OCR path again.
6. **Doctor Pack (separate suite):** generate → poll to `ready` → assert the PDF page count > (cover+TOC) and that source pages are present — catches H1/H2/H3.

The throughline: **today's tests assert that each box exists; the missing tests assert that data crosses the line between boxes.** Every CRITICAL here lives on a line between boxes.

---

## Recommended knowledge capture (for the cloud repo's own docs/INCIDENTS)

- Log this as a postmortem in the compact-emr incident log: symptom ("drafter halts on empty chart, mislabeled garbage-in"), root cause (4-stacked OCR break + the success/failure table inversion), lesson ("contract tests must assert producer→consumer seams; mocks at the seam hide the whole class").
- Add a linter/CI check analogous to the FRN pipeline-phase grep-test: a synth-time assertion that every S3-key prefix produced by a route (`cases/`) matches the prefix consumed by its EventBridge rule, and that every worker's `COMPACT_EMR_API_URL` resolves in DNS at deploy time. Both are mechanical and would have caught C2 and C4 before runtime.

**NEXT ACTION:** Apply the (a) minimum fix set in order C4 → C2 → C3 → C1 → C5, redeploy `workers` + `api`, push a real drafter image and bump `desiredCount`, then run one fixture case and assert seam #3 (`chart-readiness.readFiles >= 1`) — that single assertion proves the OCR success path is finally wired.
