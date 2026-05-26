# Phase 7B-revised Build 2 — Architect QA Review

**Scope:** RN manual-summary UI shipped at `802dee2`, follow-up fixes at `21fe2e7`.
**Reviewer:** code-architect-qa subagent
**Date:** 2026-05-25
**Verdict:** **Minor follow-up** — ship Build 3 in parallel; address P1 items inline.

---

## Top-line

Build 2 is structurally sound. The cross-case queue route is correctly scoped, two-layer 40-char enforcement is justified (not redundant), the read-attempt history surface is sufficient for v1, and the architect-finding follow-ups (post-refinement counts + `selectorAcknowledgedAt`) are correctly implemented. There are three non-blocking gaps that should be addressed but do not need to gate Build 3 (OCR worker contracts + Python Lambdas).

---

## Validation against the 8 review questions

### 1. Cross-case queue scope (`GET /rn/files-pending-manual`)

**Verdict:** Correct for v1, narrow when multi-office lands.

- `requireRole(['admin', 'ops_staff'])` excludes `physician` — correct. Physicians should not be triaging garbled scans; that is RN/ops work, and exposing every case's pending files to a physician violates least-privilege.
- All ops_staff (eventually all RNs) see every case is acceptable while FRN is single-office. When multi-office/multi-tenant lands, scope by `office_id` or `assignedPhysicianId.officeId`. **Mark as known scaling cliff in ARCHITECTURE.md, not a Build 2 blocker.**
- `limit` parsing is defensive (NaN-safe, capped at 200). `total: rows.length` is the unfiltered count — good for "12 of 200" UX.
- **Minor:** `rows.slice(0, limit)` after `findMany()` pulls every matching row from the DB. At current scale this is fine; if the queue ever crosses ~10k rows, push `take: limit` into the Prisma call. Not a Build 2 blocker.

### 2. Two-layer 40-char minimum

**Verdict:** Correct, not redundant. Keep both.

- Frontend (`trimmedLength >= 40`) is a UX affordance — disables the button, shows live count, prevents wasted round-trips.
- Backend (`parseManualSummary` enforcing `MANUAL_SUMMARY_MIN_LEN`) is the contract enforcement — any caller (worker, future RN mobile app, curl) hits the same gate.
- This is the canonical "validate at the boundary, hint at the input" pattern. Stripping one layer would either lose UX feedback or lose API integrity. Keep both.

### 3. Read-attempt history surface

**Verdict:** Sufficient for v1; flag two additions for the RN UX pass.

Currently shows: `method · words=N · corrupted-ratio=X · note`. That answers "why did the machine give up" cleanly.

**Gaps for the RN reading the file:**

- **No source PDF link.** The RN has nothing to *read* in the UI. They need a `View source PDF` button that opens `cases/<caseId>/records/<filePath>` in a new tab. Without it, the RN must context-switch to a different tool (S3 console, filesystem) before writing the summary. **This is the highest-friction gap in the flow.** See question #8.
- **No upload date / page count / sha256.** Not strictly needed to write the summary, but the RN may want to know "this is an old scan" or "this is 200 pages, I am going to skim". Lightweight add: pull from `Document` table by `caseId + filePath`. Defer to Build 3 sidecar UI work, not Build 2 blocker.

### 4. 409 ConflictError handling

**Verdict:** Message clear, refresh-on-409 is a worthwhile add.

- The error message "This file is no longer awaiting manual summary (another user may have cleared it)" is plain English and actionable.
- **Missing:** the UI does not refresh the queue when 409 fires. RN sees the message but the stale row sits in the left pane until they manually reload. Fix in `onError`:

  ```tsx
  if (error instanceof ConflictError) {
    setErrorMessage('This file is no longer awaiting manual summary (another user may have cleared it).');
    queryClient.invalidateQueries({ queryKey: ['rn', 'files-pending-manual'] });
    return;
  }
  ```

- **Edge case the backend currently does NOT cover:** the route 409s when `terminalStatus === 'read'` (machine win), but it accepts a second POST when `terminalStatus === 'manual_summary_provided'` (another RN already wrote one). The second call silently overwrites the first RN's summary. Either reject (`409`) or document overwrite as intentional. Recommend reject for non-admin, allow for admin (overrule path). **Backend-side P1.**

### 5. `selectorAcknowledgedAt` durability across regens

**Verdict:** Correct for same-classification case. Has a known gap on docType change.

The fix is right: `existing?.selectorAcknowledgedAt ? false : sel.selection.needsRnReview` preserves the RN's clearance when the doc reclassifies identically. The note in the update payload comment ("`selectorAcknowledgedAt` and `selectorAcknowledgedBy` are intentionally NOT in the update payload") correctly preserves the timestamp+actor across regens.

**Unwind path on docType change is NOT handled.** If the classifier upgrades and the same `filePath` re-classifies from `RatingDecision` to `ServiceTreatmentRecords`, the old RN ack still applies — the RN cleared the file under different semantics. Two options:

- **Option A (safe):** on upsert update, if `cls.docType !== existing.docType`, clear `selectorAcknowledgedAt` and `selectorAcknowledgedBy`, and let `needsRnReview` recompute. Add to the upsert update path.
- **Option B (loud):** keep the ack, but write an activity row `key_doc_ack_carried_across_doctype_change` so it is auditable. Less safe but lower-friction.

Recommend Option A. The semantic contract of `selectorAcknowledgedAt` should be "this RN cleared *this classification*, not this file path forever." **Backend-side P1, address before Build 3 OCR worker calls `/generate` repeatedly.**

### 6. `POST /key-docs/:id/acknowledge` correctness

**Verdict:** 404 correct, idempotency unclear, notes handling correct. Tests required before relying on the route.

- **404 on missing:** `existing === null` → `HttpError(404, 'not_found', ...)`. Correct.
- **Already-acknowledged:** route does NOT 409 or no-op — it re-stamps `selectorAcknowledgedAt = new Date()`, re-stamps `selectorAcknowledgedBy = actor.sub`, bumps `version`, and writes a fresh `key_doc_rn_acknowledged` activity row. **This is not idempotent.** Two RNs both clicking ack within seconds will produce two activity rows and overwrite the original RN's timestamp+sub. Recommend: if `existing.selectorAcknowledgedAt !== null`, return `200` with the existing row and skip the update + activity write. Or document the re-stamp behavior as intentional. **Architecturally cleaner to short-circuit.**
- **Notes:** `typeof notesRaw === 'string' && notesRaw.trim().length > 0` correctly distinguishes "omit notes" from "clear notes". The `.slice(0, 2000)` cap is correct. Empty-string notes silently drop — acceptable.
- **No tests.** Commit message acknowledges this. Build 3 must not depend on the ack route until tests exist (route handler is simple enough to test in ~30 lines: 404, happy path, already-acked behavior, notes truncation).

### 7. Activity log field naming for refined counts

**Verdict:** Field names clear; one improvement worth making.

`keyDocCount` + `pageCount` are post-refinement (physician-facing) — correct. `preRefinementKeyDocCount` + `preRefinementPageCount` for diff audit — correct.

**Tiny improvement:** `aboveTarget: refinedTotalPageCount > 250` is now post-refinement, but a downstream consumer reading old activity rows may not know whether `aboveTarget` is pre or post. Either:

- Rename to `aboveTargetPostRefinement` and add `aboveTargetPreRefinement: manifest.aboveTarget` for symmetry, or
- Add a sibling `engineVersion: DOCTOR_PACK_ENGINE_VERSION` (already present — good) plus a one-line comment that the activity_log schema flipped at this version.

The current shape is interpretable; making it self-describing protects future readers. Defer to a follow-up commit, not a Build 2 blocker.

### 8. RN flow gaps — the source PDF link is the big one

Walk-through:

1. RN logs in → `/rn` ✓
2. Sees 12 files in queue ✓
3. Clicks one → reads attempts ✓ (clear surface)
4. **Opens file** — *no UI affordance. This is the critical gap.* The RN must know the case ID, switch to another tool, locate `cases/<caseId>/records/<filePath>`, open it. Every file in this queue is by definition a file the machine cannot read — the RN MUST read it in a viewer. The UI gives them no path to do that.
5. Writes summary ✓
6. Saves ✓

**Other smaller gaps:**

- No way to skip / defer a file (RN sees a 200-page legal brief and wants to come back to it). Acceptable for v1 — FIFO ordering handles natural queue draining.
- No keyboard navigation between rows. Acceptable.
- `formatRelativeTime` for `lastCheckedAt` is good, but "Awaiting since 4 hours ago" can be misleading if `lastCheckedAt` flips on every worker retry. Verify by reading the worker's behavior in Build 3 — should the queue surface `createdAt` (original failure) or `lastCheckedAt` (most recent retry)? Probably the former for triage staleness.

---

## Top 3 findings ranked

1. **Source PDF viewer link in `ManualSummaryForm`** *(P0, UX)*. Without it the RN cannot do their job inside the UI. Add `<a href={pdfUrl(row.caseId, row.filePath)} target="_blank">View source PDF</a>` next to the file path heading.
2. **DocType-change unwind for `selectorAcknowledgedAt`** *(P1, correctness)*. If `cls.docType !== existing.docType`, clear the ack — the RN cleared the file under different semantics. Add to upsert update path in `doctor-pack.ts`.
3. **Idempotency on `/key-docs/:id/acknowledge` + auto-refresh on 409 in `RnQueuePage`** *(P1, polish)*. Route should short-circuit on already-acked rows; UI should invalidate the queue query when a 409 fires.

---

## Build 3 greenlight

**GREENLIGHT.** Build 3 (OCR worker contracts + Python Lambdas) does not depend on the three findings above. The OCR worker writes via `POST /cases/:id/files/read-attempts` (Build 2 verified) and reads via `GET /chart-readiness` (Build 2 verified). The acknowledge route + RN UI polish are RN-facing surface, not worker-facing.

**Must address before Build 3 ships:**

- Finding #2 (docType-change unwind) — Build 3 will run the classifier on every upload, so docType churn becomes real.

**Can address in parallel with Build 3:**

- Finding #1 (PDF viewer link)
- Finding #3 (ack idempotency + 409 refresh)
- Activity log naming polish from question #7
- Tests for `/key-docs/:id/acknowledge`

**Deferrable past Build 3:**

- Multi-office scoping on `/rn/files-pending-manual`
- Page count / upload date / sha256 in the read-attempt surface
- DB-level `take: limit` in `findMany`

---

## NEXT ACTION

Wire the source-PDF viewer link into `ManualSummaryForm` and ship the docType-change unwind in `doctor-pack.ts`'s upsert update path before Build 3 lands. Build 3 may start in parallel.
