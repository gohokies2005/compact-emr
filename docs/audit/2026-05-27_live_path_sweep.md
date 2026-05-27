# Live-Path Sweep — browser → API → DB → UI → S3 (operational path)

**Date:** 2026-05-27
**Auditor:** code-architect-qa
**Cloud tree:** `C:\Users\ryank\compact-emr-work` (Express-on-Lambda via Lambda Web Adapter; Prisma/Postgres RDS; React/Vite SPA at emr.flatratenexus.com)
**Test subject:** veteran `id="0"` (Flagg), case `CLM-2B0E1574A1` ("Lumbar / back"), 8 OCR'd docs, legacy `cdsRationale`.
**Method:** Read frontend fetch → backend route → Prisma select against the post-migration schema; pulled the API Lambda CloudWatch logs; inspected live API Gateway + S3 CORS + Lambda env + RDS reachability. RDS is VPC-private and unreachable from here, and a Cognito token can't be minted — so Flagg's exact row could not be SELECTed; the P0 is proven deterministically from code + schema + the one decisive runtime fact (the global error handler logs nothing, which is itself the reason every prior 500 was invisible). No code edited.

---

## TL;DR — the truth

**The claim-load crash is a backend 500 in `GET /cases/:id` caused by an unserializable `BigInt`.** The case-detail route eager-loads `documents` with Prisma's default scalar select, which returns `Document.sizeBytes` as a JavaScript `BigInt`. `res.json()` → `JSON.stringify` **throws `TypeError: Do not know how to serialize a BigInt`** for any case that has ≥1 document. Flagg is the first case with real uploaded documents, so she is the first to trip it. Every other case (no documents) serializes fine — which is exactly why this surfaced "one more thing per step."

**Why it was invisible in CloudWatch:** the global Express error handler (`server.ts:64-69`) maps any non-`HttpError` to `500 internal_error` **without logging the error, message, or stack**. Combined with no API Gateway access logging, a 500 leaves zero trace. This single observability hole is why CORS, the orderBy bug, and now this each had to be discovered by hand instead of read off a log. **Fixing the silent handler is as important as fixing the BigInt** — it is the reason you keep firing bugs one at a time.

**Same `BigInt` defect has a second instance on the drafter path (P1):** `drafter-bundle.ts:202` does `JSON.stringify(bundle)` where `bundle.documents` is the same default-select array carrying `BigInt sizeBytes`. The moment Flagg's chart is sent to the drafter, the bundle build throws — a fresh surprise waiting one step downstream. Fix both in the same pass.

The MRN `"0"` is a **data** problem, not a code path that's still reachable: the current `NewVeteranModal` mints `MRN-XXXXXXXX` and the create validator rejects empty ids, so nothing in the live code can produce `"0"` today. Flagg's `"0"` predates the current flow (seed / manual insert / older code). It does not by itself crash anything, but it is malformed and should be reassigned via a multi-table FK update (steps below).

---

## P0 — blocks the live workflow right now

### P0-1. `GET /cases/:id` 500s on any case with documents — BigInt is not JSON-serializable  ← THE CLAIM-LOAD CRASH
**Path:** SPA `CasesPanel` link → `CaseDetailPage` → `getCase(caseId)` → `GET /api/v1/cases/:id` → `res.json({ data: found })`.

**Failing layer (backend):** `backend/src/routes/cases.ts:220-234`. The query:
```ts
db.case.findFirst({ where: { id }, include: {
  documents: { orderBy: { uploadedAt: 'desc' }, take: 5 },   // ← default scalar select → sizeBytes: BigInt
  draftJobs: { take: 5 }, corrections: { take: 5 }, emails: { take: 5 }, payments: {},
  _count: { ... },
}});
...
res.json({ data: found });   // line 234 → JSON.stringify → throws on the BigInt
```
`Document.sizeBytes` is `BigInt` (`schema.prisma:290`). There is **no** `BigInt.prototype.toJSON` polyfill anywhere in `backend/src` (grep-confirmed zero matches). The two document routes that DO return sizeBytes both convert it explicitly — proof the team knows BigInt can't serialize:
- `documents.ts:76` `...doc, sizeBytes: doc.sizeBytes.toString()`
- `documents.ts:170` `...created, sizeBytes: created.sizeBytes.toString()`

The case-detail include skipped that conversion.

**Failing layer (frontend):** `frontend/src/api/client.ts:64` re-throws non-2xx; `CaseDetailPage.tsx:87` then renders `EmptyState "Case not found"` because `caseQuery.data` is undefined. The SPA cannot distinguish "500" from "404" — both look like "fails to load."

**Runtime confirmation:** CloudWatch `/aws/lambda/compact-emr-staging-api` for the last 45 min shows only INIT/START/END/REPORT + the benign Node-20 SDK warning — **no error stack**, because `server.ts:64-69` logs nothing on 500 (see P0-2). API Gateway stage `$default` has `AccessLogSettings: null`, so no status-code trail there either. The absence of a logged 500 is consistent with — not evidence against — this diagnosis: this handler is structurally silent. The bug is deterministic from code + schema: a case with ≥1 `Document` row cannot be serialized by this route.

**Why now / why Flagg:** document-less cases serialize fine (no BigInt in the payload). Flagg is the first case carrying real `Document` rows (8 uploads), so she is the first `GET /cases/:id` that hits a BigInt. This matches "clicking the claim fails to load" exactly.

**Fix (smallest correct):** project the documents (and any BigInt) to strings before `res.json`, mirroring `documents.ts`. Concretely, after the `findFirst`:
```ts
if (found === null) throw new HttpError(404, 'not_found', 'Case not found', { caseId: id });
const serializable = {
  ...found,
  documents: found.documents.map((d) => ({ ...d, sizeBytes: d.sizeBytes.toString() })),
};
res.json({ data: serializable });
```
**Belt-and-suspenders (do this too, see P0-2/Linter):** install a global `BigInt.prototype.toJSON = function () { return this.toString(); }` once at the Lambda entry (`backend/src/lambda-placeholder.ts`, before `createApp()`), so a future route that forgets the per-field cast degrades to a string instead of a 500. Note this makes BigInt serialize as a JSON *string* — keep the explicit `.toString()` casts where the API contract documents a string so the wire shape is intentional, not accidental.

**Frontend follow-up (contract, not a crash):** `CaseDetail.documents[].sizeBytes` is typed `Document['sizeBytes']`. Confirm the SPA treats it as a string (it does not currently render it on CaseDetailPage, so no UI break — but the type should say `string` to match the wire).

---

### P0-2. The global error handler swallows every 500 — root cause of "one bug per step"
**Failing layer:** `backend/src/server.ts:64-69`.
```ts
app.use((error, _req, res, _next) => {
  if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
  return sendError(res, 500, 'internal_error', 'Unexpected server error.');   // ← no console.error(error)
});
```
Any thrown non-`HttpError` (Prisma exceptions, the BigInt TypeError, S3 SDK errors, JSON errors) returns a generic 500 with **nothing written to stdout/CloudWatch**. `asyncHandler` (`http/async-handler.ts:7`) routes all rejected promises straight here via `.catch(next)`. Prisma is configured `log: ['error']` (`db/client.ts:13`) so *query-engine* errors would print, but a serialization `TypeError` thrown by Express's `res.json` is not a Prisma error and never reaches that logger.

**Consequence:** Every live-path 500 is invisible. This is the structural reason CORS, the `createdAt→uploadedAt` orderBy, and P0-1 each had to be hand-found. It is also why this audit could not simply read the stack — there is no stack to read.

**Fix:** log before responding, with request context, no PHI:
```ts
app.use((error, req, res, _next) => {
  if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
  console.error(JSON.stringify({
    msg: 'unhandled_error', method: req.method, path: req.path,
    name: (error as Error)?.name, errMessage: (error as Error)?.message,
    stack: (error as Error)?.stack,
  }));
  return sendError(res, 500, 'internal_error', 'Unexpected server error.');
});
```
Pair with API Gateway access logging on the `$default` stage (status + path + latency) so the next 500 is one log query away. This is the highest-leverage fix in the report: it converts the entire class of "silent live-path break" into something observable.

---

## P1 — silently wrong / breaks the next step on real data

### P1-1. Drafter bundle build throws on the same BigInt (`JSON.stringify(bundle)`)
**Path:** `POST /cases/:id/draft` → `buildDrafterBundle` → `writeBundleToS3`.
**Failing layer:** `backend/src/services/drafter-bundle.ts:112-115` loads `document.findMany({ where:{caseId}, include:{ pages:{...} } })` with **default scalar select** (→ `sizeBytes: BigInt`), puts the raw array into the bundle at line 153 (`documents,`), then `writeBundleToS3` does `const body = JSON.stringify(bundle)` at line 202. For any case with documents (now Flagg), this throws the same `TypeError`. Before Flagg, no case reached the bundle with real documents, so it was masked.
**Confirmation:** deterministic from code + schema; `draft-job.fifo` has never run a real case end-to-end (prior audit).
**Fix:** map `documents` to drop/stringify `sizeBytes` before assembling the bundle, OR rely on the global `BigInt.prototype.toJSON` from P0-1 (which fixes this site for free). Prefer the global polyfill here since the drafter worker doesn't need `sizeBytes` at all — confirm the Fargate `materializeRecords` doesn't read it (it reads `d.filename`/`d.pages[].text`, per prior audit C5), so a stringified or omitted `sizeBytes` is harmless downstream.

### P1-2. `DraftJob.costUsd` (Prisma `Decimal`) reaches the SPA as a string; `sumDraftingCostUsd` drops it
**Path:** `GET /cases/:id` include `draftJobs` (default select) → `CaseDetailPage.sumDraftingCostUsd`.
**Failing layer:** `schema.prisma:342` `costUsd Decimal? @db.Decimal(10,4)`. Prisma returns `Decimal`, which `JSON.stringify` emits as a **string** (e.g. `"12.3400"`), not a number — and unlike BigInt it does NOT throw. But `CaseDetailPage.tsx:220` guards `if (typeof j.costUsd === 'number')`, so a string `costUsd` is silently skipped and the "Drafting cost (API)" row shows `—` even when a cost exists. (The CostsPage report is correct — `reports.ts:104` does `Number(v)`.)
**Impact:** cosmetic for Flagg now (no completed drafts) but wrong for any case post-draft. **Fix:** either coerce in the route (`costUsd: j.costUsd == null ? null : Number(j.costUsd)`) or change the frontend guard to `Number.isFinite(Number(j.costUsd))`. Pick the route-side coercion so the wire contract is "number" everywhere.

### P1-3. Veteran `id="0"` is malformed — reassignment requires a multi-table FK update
**Why it exists:** NOT producible by current code. `NewVeteranModal.tsx:27` mints `id = 'MRN-' + crypto.randomUUID()...` and `veteran-validation.ts:123` (`requiredString(body,'id')`) rejects empty/whitespace ids. So `"0"` came from the Prisma seed, a manual SQL insert, or a pre-current create path. It renders as `MRN 0` (`VeteranChart.tsx:32`) and is the parent of Flagg's case + docs.
**Is re-id safe?** `Veteran.id` is the PK referenced by FKs on `Case.veteranId`, plus `ScCondition`, `ActiveProblem`, `ActiveMedication`, `ChartNote`, `ActivityLog.veteranId`, etc. `Case → Document/DraftJob/etc.` cascade off `caseId`, not `veteranId`, so those don't move if the case keeps its id. **A bare `UPDATE veterans SET id='MRN-...' WHERE id='0'` will fail** unless every child FK is updated in the same transaction (and most FKs here are `onDelete: Cascade` but NOT `onUpdate: Cascade` in Postgres by default, so the update is rejected, not propagated).
**Safe reassignment (run as one transaction against the staging DB, admin/ops only):**
```sql
BEGIN;
-- 1. create the new veteran row by cloning "0" with a proper MRN
INSERT INTO veterans (id, /* all columns */ ...)
  SELECT 'MRN-<NEW10HEX>', /* same columns */ ... FROM veterans WHERE id='0';
-- 2. repoint every child FK
UPDATE cases             SET veteran_id='MRN-<NEW10HEX>' WHERE veteran_id='0';
UPDATE sc_conditions     SET veteran_id='MRN-<NEW10HEX>' WHERE veteran_id='0';
UPDATE active_problems   SET veteran_id='MRN-<NEW10HEX>' WHERE veteran_id='0';
UPDATE active_medications SET veteran_id='MRN-<NEW10HEX>' WHERE veteran_id='0';
UPDATE chart_notes       SET veteran_id='MRN-<NEW10HEX>' WHERE veteran_id='0';
UPDATE activity_logs     SET veteran_id='MRN-<NEW10HEX>' WHERE veteran_id='0';
-- (verify the FULL child-table list against schema.prisma before running — see note)
-- 3. delete the old "0" veteran
DELETE FROM veterans WHERE id='0';
COMMIT;
```
**Before running:** grep `schema.prisma` for every `veteranId` / `@relation(... references:[id])` pointing at `Veteran` and include each child table in step 2 — missing one will either FK-fail (safe) or orphan a row. Documents move automatically (they FK to `case_id`, and the case keeps its id). **RN-self-service note (MEMORY HARD RULE):** this is a shell/SQL op an RN cannot do. Either (a) accept `"0"` as cosmetic (it does not crash anything once P0-1 is fixed) and leave it, or (b) build an admin-only `POST /veterans/:id/reassign-mrn` endpoint that does the transaction above so it is UI-recoverable. Recommend (a) for now — fix the crash, defer the cosmetic re-id — unless `"0"` confuses billing/Stripe keys.
**Guard the future:** add a create-time assertion that `id` matches `^MRN-[A-Z0-9]{10}$` (server-side in `parseVeteranCreate`) so a malformed id can never be inserted via the API again. Seed scripts should use the same generator.

---

## P2 — works, but worth fixing on this pass

### P2-1. No API Gateway access logging on the `$default` stage
Live check: `get-stages` → `AccessLogSettings: null`. No per-request status/path/latency record exists anywhere. Stand up an access log group + JSON format on the stage. Cheap, and it would have shown the P0-1 500 immediately.

### P2-2. The API Lambda is named `...PlaceholderApiLambda...` and the entry file is `lambda-placeholder.ts` / `placeholder-lambda.ts`
Two entry files exist: `lambda-placeholder.ts` (Express `.listen(:3000)` for the Lambda Web Adapter — this is the live one, hence the "listening on :3000" log per cold start) and `placeholder-lambda.ts` (`serverless-http`, apparently unused). The "placeholder" naming is a leftover that misleads readers into thinking the API is a stub. Rename on a cleanup pass and delete the unused `serverless-http` entry to remove ambiguity about which adapter is live.

### P2-3. Node 20 runtime deprecation warning on every cold start
CloudWatch shows the AWS SDK v3 "requires node >=22 after Jan 2027" warning each init. Not breaking now; schedule a runtime bump to `nodejs22.x` before that date. Cosmetic log noise until then.

### P2-4. `documents.ts` download path — CORS is correct for the current consumer, verify it stays that way
`VeteranChart.tsx:134` opens the presigned GET via `window.open(...)` (top-level navigation — CORS does not apply). The PHI bucket CORS (live-verified) now allows `GET, HEAD, PUT` from `https://emr.flatratenexus.com` + `http://localhost:5173`, so even a future `fetch()`-to-blob download would work. No action needed; noted so a future "download via fetch" change isn't assumed broken.

---

## OCR → drafter on Flagg's real pages (item 6) — assessment

With the prior audit's C1-C4 fixes shipped (`ab06c47`), `document_pages` is now populated (user confirms 8 docs OCR'd, 0 errors). `buildDrafterBundle` loads `documents` with `include:{ pages:{ orderBy:{ pageNumber:'asc' } } }` (`drafter-bundle.ts:112-115`) — the relation name `pages` and the page `text` field match what the OCR `/pages` callback writes, and the Fargate `materializeRecords` reads `d.pages[].text` + `d.filename`. So the data shape will materialize correctly **once P1-1 (the bundle BigInt throw) is fixed** — that is the only thing standing between Flagg's OCR'd pages and a real drafter run. Fix P1-1 and the upload→OCR→draft seam is clear for the first time.

---

## "Passes tests but breaks on Flagg" — the seam the suite never asserts

`backend/src/__tests__/documents.test.ts:41-44` mocks `document.findMany` to return a `BigInt(12)` and asserts `res.body.data[0].sizeBytes === '12'` — i.e. the **documents** route's BigInt handling IS tested. But **no test fetches `GET /cases/:id` for a case that has documents** — the case-detail tests stub the delegate without document rows, so the un-cast BigInt in the include never serializes in a test. Same pattern as the prior audit's whole finding: each box is tested, the line between boxes is not. The missing assertion: `GET /cases/:id` with ≥1 document returns 200 and `data.documents[0].sizeBytes` is a string.

---

## Recommended linters / CI guards (mechanical, would have caught these)

1. **BigInt-serialization guard (BEGINNING/static):** a CI grep/AST check that every Prisma `include`/`findMany` whose result is passed to `res.json` either (a) projects BigInt fields to string, or (b) the entry installs `BigInt.prototype.toJSON`. Phase: BEGINNING (static, pre-deploy). Would have caught P0-1 and P1-1.
2. **No-silent-500 lint (BEGINNING/static):** assert the global Express error handler calls `console.error`/logger with the error before `sendError(...500...)`. Phase: BEGINNING. Would have made P0-1 self-reporting.
3. **MRN-shape assertion (MIDDLE/runtime):** server-side `^MRN-[A-Z0-9]{10}$` check in `parseVeteranCreate` + a one-off data-quality query flagging any `veterans.id` not matching. Phase: MIDDLE. Prevents future `"0"`.
4. **Seam e2e (END):** the staging e2e from the prior audit's section (b) — upload → OCR → `chart-readiness.readFiles>=1` → draft — plus a new assertion that `GET /cases/:id` returns 200 for a case **with documents**. Phase: END.

---

## NEXT ACTION
Apply P0-1 (cast `documents[].sizeBytes` to string in `cases.ts:234`) **and** P0-2 (log the error in `server.ts:64-69`) **and** install `BigInt.prototype.toJSON` at the Lambda entry — that one polyfill also fixes P1-1 (drafter bundle). Redeploy the API + drafter, then click Flagg's claim and confirm `GET /api/v1/cases/CLM-2B0E1574A1` returns 200 with `data.documents[].sizeBytes` as strings. Leave MRN `"0"` as cosmetic for now; revisit P1-3 only if billing/Stripe keys off the veteran id.
