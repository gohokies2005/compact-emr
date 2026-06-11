# P2 + P3 Build Plan — Physician Portal + Cases Page + Email Batch

Source of requirements: `~/OneDrive/Documents/Flat Rate Nexus/handoffs/running/20260610_RYAN_WORK_ORDER_physician_portal_and_render_lock.md` §P2, §P3 (incl. 5a-pre, 5a-pre2, 5a-bis, 5a-bis2, 5b). Ryan's words are the spec.

**Plan-only. No code in this pass.** Grounded against `C:\Users\ryank\compact-emr-work` at commit `97fcaed`. Every file/line reference below was read, not assumed.

**STANDING DESIGN RULE applies to every route/screen touched** (Ryan 2026-06-10 ~21:15): NO SILENT ERRORS, NO SHOW-STOPPING ERRORS. Every error must (a) surface the REAL API cause verbatim, (b) be visible in CloudWatch (structured warn for 4xx/5xx on mutating routes), (c) carry an actionable fix path in the message. The approve-path precedent already landed (`7ceab64`: `describeApiError` in PhysicianReviewPage + `http_error` CloudWatch line). Mirror that pattern.

---

## 0. Ground-truth corrections to the work order's continuity notes

The work order's session-state notes predate several already-shipped pieces. Confirmed on disk:

| Work-order claim | Reality on disk | Impact |
|---|---|---|
| "Default landing after physician login = Queue" (P2.1) | **ALREADY DONE** — `HomePage.tsx:96` `if (role === 'physician') return <Navigate to="/p/queue" replace />`. | P2.1 is a no-op. Add a Playwright guard so it can't regress. |
| "Bridge photo banner: put on a rotation" (P2.3/P2.5) | **Rotation infra ALREADY EXISTS** — `components/BridgeRotation.tsx` (5-min interval, random start, graceful 404 fallback) + 5 images in `public/bridge-rotation/` + `data/bridgeImages.ts`. Banner is mounted on `PhysicianQueuePage.tsx:27` and `HomePage.tsx:119`. | P2.3 shrinks to: mount the existing component on the 2 tabs missing it (Letters, Inbox), and confirm it's suppressed inside claim/letter views (it already is — those pages never mount it). NOT a "find the asset + build rotation" task. |
| "no frontend doctor-pack API yet" (P2.4) | **TRUE** — no `frontend/src/api/doctor-pack*.ts`, no `DoctorPack` reference in any `.tsx`. Backend is fully built (route + service + worker + watcher). | Chunk D is frontend-surface + selector-tuning, not a backend build. |
| Doctor-pack selector "needs tuning to 15-20pp" | Selector `page-selector.ts` ALREADY implements appeal-boilerplate exclusion, SC/grant/denial include rules, blue_button/progress_notes exclusion, small-doc-all for statements. | Chunk D curation is REFINEMENT of an existing rule set, not greenfield. The real gap is the whole-doc fallback when OCR hasn't populated `document_pages` (below). |

**Net:** P2 is much smaller than the work order implies. The substantive work is chunk D (doctor-pack surfacing + selector accuracy) and chunk E (email batch). Chunks A/B/C are mechanical.

---

## Chunk A — Physician tabs / landing / banner-rotation (frontend-only)

**Independently shippable. No backend. No migration.**

### A1 — Tab order: Queue | Letters | Inbox (P2.2)
- File: `frontend/src/layout/TopNav.tsx`.
- Current `navItems` (lines 8-25): `Inbox` is a shared row (line 13, roles include physician) that sorts BEFORE the physician-only `Queue` (23) / `Letters` (24). For a physician the rendered order is therefore **Inbox | Queue | Letters** — exactly the bug.
- The list is filtered by role then rendered in array order (`visibleItems` line 37). There is no per-role ordering today.
- **Fix:** give physicians their own ordered nav. Two options:
  - (a) Add an `order` field per item and sort `visibleItems` by it per-role. Heavier.
  - (b) Simpler + matches existing pattern: split the nav into a `physicianNav` array `[Queue(/p/queue), Letters(/p/letters), Inbox(/inbox)]` and select `role === 'physician' ? physicianNav : navItems.filter(...)`. The shared `Inbox` row stays in `navItems` for staff (its order there is fine).
- Watch: `Inbox` carries the `InboxBadge` (line 38, `item.href === '/inbox'`). Keep that conditional intact in the physician array (Inbox href is identical).

### A2 — Banner rotation on every MAIN physician tab; gone inside a claim (P2.3)
- The component is `BridgeRotation` (`caption={false}` for ambient use, per `HomePage.tsx:119`).
- ALREADY mounted: `PhysicianQueuePage.tsx:27`.
- MISSING (grep `BridgeRotation` → 0): `PhysicianLettersPage.tsx`, `inbox/InboxPage.tsx`.
- **Fix:** mount the same ambient banner block at the top of `PhysicianLettersPage` and `InboxPage`. Copy the exact wrapper from `PhysicianQueuePage.tsx:25-34` (the `<section className="relative mb-8 overflow-hidden rounded-2xl ...">` + gradient overlay) so styling is identical.
- "Banner DISAPPEARS inside a claim/letter view": `PhysicianReviewPage.tsx` and `cases/LetterEditorPage.tsx` do NOT mount `BridgeRotation` today and must NOT gain it. No code needed — just don't add it there. Add a Playwright assertion that `/p/review/:id` has no `[data-bridge]`.
  - To make that assertion clean, add `data-bridge="true"` to the `BridgeRotation` root `<div>` (`BridgeRotation.tsx:53`) so the test can assert presence/absence without coupling to class names.
- Inbox caveat: `InboxPage` is shared (admin/ops_staff/physician). The banner there will show for staff too. That's harmless (it already shows on staff `HomePage`), but confirm with Ryan it's wanted on the staff Inbox or gate it to `role==='physician'`. **(Ryan taste-decision A-1.)**

### A3 — Rotation image set (P2.5)
- Source set already curated: Murray Morgan, Manette, Hood Canal, Aurora, Evergreen Point (`data/bridgeImages.ts`, files in `public/bridge-rotation/`).
- **No code needed** unless Ryan wants different/more photos. If he supplies new images: drop PNGs in `public/bridge-rotation/`, add `{id,name,location,src,tone,textAnchor}` rows to `bridgeImages.ts`. **(Ryan taste-decision A-2: keep current 5 or supply new set?)**

### Chunk A tests
- Unit (`frontend/src/__tests__/`): `TopNav.test.tsx` — render with `role='physician'`, assert order Queue→Letters→Inbox; render with `role='ops_staff'`, assert staff order unchanged.
- Playwright (`e2e/`): new `physician-portal.spec.ts` — (1) sign in as physician → URL is `/p/queue`; (2) nav order; (3) `[data-bridge]` present on `/p/queue`, `/p/letters`, `/inbox`; (4) `[data-bridge]` ABSENT on `/p/review/:id`.

### Chunk A risk
- Low. Pure presentational. The only trap is breaking the shared Inbox badge or staff nav order — covered by the unit test.

---

## Chunk B — Cases filters + RN-assign affordance (P3.2, P3.3, P3.4)

**Independently shippable. Backend already supports the RN filter (`assignedRnId` incl. `__none__`). One real backend gap: "me".**

### B1 — Remove the Claim-type filter (P3.2)
- File: `frontend/src/routes/cases/CasesPage.tsx`.
- Remove: the `claimType` state (line 54), the reset dep (line 63), the `...(claimType && {claimType})` spread (line 75), the filter `<label>` block (lines 133-135), `setClaimType('')` in `clearFilters` (line 83), and `CLAIM_TYPE_OPTIONS` (line 26) if now unused.
- KEEP `CLAIM_TYPE_LABELS` (line 24) — still used for the Type COLUMN (lines 38, 162) and CSV export (line 118). Only the FILTER goes.
- Backend `claimType` query param (`cases.ts:135,141`) can stay (harmless, other callers may use it) — do not rip it out; just stop sending it.

### B2 — RN-assignment dropdown-checkbox filter (P3.3)
- The marquee piece. Backend support EXISTS: `GET /cases?assignedRnId=<appUserId>` and `?assignedRnId=__none__` (unassigned) — `cases.ts:147-148`. RN roster source: `listUsers({ role: 'ops_staff' })` (`api/users.ts:47`), already used by `CaseAssignmentPanel.tsx:31`.
- **Spec'd behavior:** checkboxes `[me] [unassigned] [<each other nurse by name>] [ALL active]`. Multi-check allowed EXCEPT All (checking All clears others; exclusive). Default on RN login = only **my** cases.
- **THE GAP (🔴 blocker for "me"):** `assignedRnId` is `AppUser.id` (uuid). The frontend identity `useAuth().user.sub` is the **Cognito sub** (`AuthProvider.tsx:10,60`), and `AppUser.id !== AppUser.cognitoSub` (`schema.prisma:115-117`). There is **no `/users/me` endpoint** and `listUsers` does not return `cognitoSub`. So the client cannot map "me" → my `assignedRnId` today.
  - **Fix options (Ryan taste-decision B-1, but B-1a is the clean one):**
    - (B-1a, recommended) Add `GET /api/v1/users/me` returning the caller's `{ id, email, name, roles }` resolved by `cognitoSub = actor.sub`. Frontend resolves "me" → `meId` once, uses it as the `assignedRnId` value for the [me] checkbox + as the login default. Small, reusable, also unblocks future "my cases" surfaces. ~30 min backend.
    - (B-1b) Match by email: `listUsers({role:'ops_staff'})` includes `email`; `useAuth().user.email` is present. Find `me = users.find(u => u.email === authEmail)`. Zero backend. Fragile if a staffer's Cognito email ≠ AppUser email (they're both unique + seeded from the same value, so low risk). Acceptable fallback if B-1a is deferred.
- **Filter semantics → API:** the API takes a SINGLE `assignedRnId`. Multi-select (me + Sarah) needs either (a) repeated client-side union across N queries, or (b) a backend `assignedRnId` that accepts a comma list / `assignedRnIds[]`.
  - **Recommended:** extend `buildCaseListWhere` (`cases.ts:132-162`) to accept `assignedRnId` as a comma-separated list → `where.assignedRnId = { in: [...] }`, with `__none__` mapping to `null` and combinable via `OR` (`{ OR: [{assignedRnId: {in: ids}}, {assignedRnId: null}] }` when "unassigned" is also checked). This keeps it ONE query + ONE page count (server pagination stays correct). Doing it client-side breaks pagination totals.
  - "ALL active" = send no `assignedRnId` param (current default behavior). Checking All clears the others in UI state (exclusive) — pure frontend.
- **Default-to-mine on login:** initialize filter state to `['me']` when `role !== 'admin'` (nurses) — but only on the Cases page first mount, and let them change it. Admins default to All. **(Confirm with Ryan: should admin also default to All? — taste-decision B-2.)**
- UI shape: a small popover/checkbox group in the filter row (replacing the removed Claim-type slot keeps the row balanced). Render `[me]`, `[unassigned]`, then `listUsers` rows EXCEPT me (by `name ?? email`), then `[ALL active]`. Roster `name` is available (`StaffUser.name`, `users.ts:6`).

### B3 — RN column "+" assign affordance (P3.4)
- File: `frontend/src/routes/cases/CasesPage.tsx`, RN cell line 175: currently `{c.assignedRn?.email ?? '—'}`.
- **Fix:** when `assignedRn` is null, render a `+` button (mirror the quick-note `+` affordance pattern at lines 170-172) that opens an assign-RN popup. When assigned, show the name/email (consider switching display from `email` to a friendlier `name` if the list payload carries it — `AssignedRnLite` currently only has `{id,email}` (`api/cases.ts:12`); to show a name, extend `CASE_LITE_SELECT.assignedRn` (`cases.ts:53-58`) to include `name` + thread it through `AssignedRnLite`. Optional polish — **taste-decision B-3**).
- Popup reuses `listUsers({role:'ops_staff'})` + `assignCaseRn(c.id, { rnUserId, version: c.version })` (`api/cases.ts:155`). This is the SAME wiring `CaseAssignmentPanel` uses — real assignment on the claim, version-checked, role-validated server-side (`cases.ts:665-700`). NOT display-only.
- `stopPropagation` on the cell + popup (the row has a navigate-on-click handler, line 158) — follow the quick-note cell's `onClick={(e) => e.stopPropagation()}` (line 165).
- After success: `qc.invalidateQueries({ queryKey: ['cases'] })` (same as quick-note mut).
- Error path: `onError` → `window.alert(... describeApiError(e))` (the 409 stale-version case must surface verbatim, per the standing rule). `assignCaseRn` already throws on stale version (`cases.ts:684`).

### B4 — Reject visibility question (P3.5)
- Decision: `rejected` cases stay visible under "ALL active" but are EXCLUDED from a nurse's default "assigned-to-me" view (they're terminal; a nurse's working pool shouldn't carry them). Implement by: default filter `['me']` naturally excludes rejected-and-unassigned; rejected-and-assigned-to-me WILL show under [me] — that's correct (she may need to see her own rejected). Under "unassigned"/All they show. **No status filter on reject** — just the assignment filter does the work. Confirm this matches Ryan's intent (**taste-decision B-4**). The status dropdown still lets anyone filter to `rejected` explicitly.

### Chunk B tests
- Unit: `CasesPage.test.tsx` — claim-type filter gone; RN filter checkbox exclusivity (All clears others); `+` renders only when unassigned; assign mutation fires `assignCaseRn` with correct version.
- Backend unit (`cases-routes.test.ts`): `assignedRnId` comma-list → `{in:[...]}`; `__none__` + ids → `OR`; `/users/me` (if B-1a) returns caller's appUser id.
- Playwright (`rn-workflow.spec.ts` extension): sign in as `zzznurse` → Cases defaults to her cases; check "unassigned" → unassigned appear; click `+` on an unassigned row → assign popup → assign → row shows her; verify another nurse's cases hidden by default.

### Chunk B risks
- 🟡 Pagination correctness if multi-RN filter is done client-side. MUST be a single backend query (the `{in:[...]}` approach) or `total`/page counts lie.
- 🟡 "me" identity mapping (B1 gap). Pick B-1a or B-1b explicitly before building.
- 🟢 Display name vs email churn (B-3) — defer if pressed.

---

## Chunk C — Status audit (DEAD-status evidence) (P3.1, P3.5b)

**Audit + evidence first; code only for proven-dead statuses + the label fix. Ryan softened this to "audit, don't force-trim."**

### The 13 statuses (`schema.prisma:28-44`, enum `CaseStatus`)
`intake, records, viability, drafting, rn_review, physician_review, correction_requested, correction_review, delivered, paid, rejected, needs_rn_decision, needs_records`.

### Transition map (authoritative: `frontend/src/lib/caseStatus.ts:4-18`, mirrored from `backend/src/services/case-status-transitions.ts`)
```
intake               -> records, rejected
records              -> viability, rejected
viability            -> drafting, rejected
drafting             -> rn_review, physician_review, needs_rn_decision, needs_records, rejected
rn_review            -> physician_review, drafting, rejected
physician_review     -> correction_requested, delivered, rejected
correction_requested -> correction_review
correction_review    -> delivered, rejected
delivered            -> paid
paid                 -> (terminal)
rejected             -> (terminal)
needs_rn_decision    -> drafting, records, rejected
needs_records        -> drafting, records, rejected
```
Every status is REACHABLE in the graph (each has an inbound edge), so by static analysis none is graph-dead. The audit question is **runtime-dead**: are any never actually written by real flows?

### 🔴 Already-found defect (independent of the audit): the status FILTER validator is missing 3 statuses
- `parseOptionalCaseStatus` (`backend/src/routes/cases.ts:108-126`) only allows: `intake, records, viability, drafting, physician_review, correction_requested, correction_review, delivered, paid, rejected`.
- **MISSING:** `rn_review`, `needs_rn_decision`, `needs_records`.
- Effect: `GET /cases?status=rn_review` (or the two Gate-2 halts) throws **HTTP 400 "status filter is invalid"**. The Cases dropdown (`CasesPage.tsx:131`, built from `CASE_STATUS_LABELS` = all 13) OFFERS these options, so selecting them 400s. This is a live bug AND it pollutes the dead-status audit (you can't filter-count them via the API).
- **Fix:** add the 3 missing statuses to the `statuses` array in `parseOptionalCaseStatus`. Trivial, ship in chunk C regardless of audit outcome. (Also a candidate to source the array from a single shared const so it can't drift from the enum again — see C-lint below.)

### Dead-status evidence queries (read-only; run against staging DB)
Run via the staging API auth helper (`C:\Users\ryank\.frn-tmp\staging-auth.py`) or a read-only psql session. **Live counts per status:**
```sql
-- C-Q1: case count per status (the core evidence)
SELECT status, COUNT(*) AS n,
       MIN(created_at) AS first_seen, MAX(updated_at) AS last_touched
FROM cases
GROUP BY status
ORDER BY n DESC;

-- C-Q2: has any case EVER transited INTO each status? (activity log is the history of record)
-- action names written by the status route — confirm the exact action string first:
SELECT details_json->>'to' AS to_status, COUNT(*) AS transitions
FROM activity_logs
WHERE action = 'case_status_changed'      -- VERIFY this string in cases.ts status handler
GROUP BY to_status ORDER BY transitions DESC;

-- C-Q3: corrections flow specifically (suspected low-use)
SELECT COUNT(*) FROM cases WHERE status IN ('correction_requested','correction_review');
SELECT COUNT(*) FROM corrections;   -- is the correction workflow used at all?

-- C-Q4: Gate-2 halt statuses (new; may legitimately be 0 if Gate-2 rarely halts)
SELECT COUNT(*) FROM cases WHERE status IN ('needs_rn_decision','needs_records');
```
- **Classification rule (Ryan's):** a status is DEAD only if (n=0 in C-Q1) AND (0 inbound transitions in C-Q2) AND (no code path writes it). A status with 0 rows but a real writer (e.g. Gate-2 halts on a young system) is LIVE-but-unused → KEEP.
- Code-writer trace (grep, to pair with the counts): search backend for each enum value as a write target: `Grep "status: 'needs_records'"`, etc. `needs_rn_decision`/`needs_records` are written by the Gate-2 halt receiver (drafter lane); `correction_*` by the physician send-back flow. Confirm each has a live writer before declaring dead.
- **Likely outcome (hypothesis, must be confirmed by data):** all 13 have writers; the corrections pair and the Gate-2 pair may be 0-count but LIVE. Expected recommendation: **remove nothing**, fix the filter validator (above), fix the label (5b, below). This matches Ryan's "if they're all live, leave it."

### 5b — "Delivered" label bug (status label, pre-payment) (P3.5b)
- `delivered` is the approve-transition target (`physician_review -> delivered`, `caseStatus.ts:10`; set by the letter approve flow). At that point NOTHING has gone to the veteran (delivery email + Stripe come AFTER). The label "Delivered" (`CASE_STATUS_LABELS.delivered = 'Delivered'`, `caseStatus.ts:29`) is wrong/confusing.
- **Fix (display-only, cheap + safe — Ryan's preferred):** change the LABEL only: `delivered: 'Ready for delivery'` (or 'Ready to invoice' / 'Finalized' — **Ryan taste-decision C-1: pick the wording**). Do NOT rename the enum value (`delivered`) — it's referenced in the transition map, the delivery route's `DELIVERY_STATUSES` set (`delivery.ts:40`), payment reconciliation, and tests. An enum rename is a migration + cross-repo change for zero functional gain.
- Apply the label in BOTH mirrors: `frontend/src/lib/caseStatus.ts:29` AND the `CaseStatusBadge` component (verify it reads from `CASE_STATUS_LABELS`; if it has its own copy, fix both). Grep `'Delivered'` and `delivered:` across frontend to catch any hardcoded copy.
- The deeper "should `delivered` mean delivered-to-veteran" question folds into the status audit (#1) — but the label fix ships independently NOW.

### Chunk C tests
- Backend unit: `cases-routes.test.ts` — `GET /cases?status=rn_review` returns 200 (not 400) after the validator fix; same for the 2 Gate-2 statuses.
- Frontend unit: `caseStatus.test.ts` (create if absent) — `CASE_STATUS_LABELS.delivered === 'Ready for delivery'` (or chosen wording); every enum value has a label + a transition entry (a "no orphan status" test).
- C-lint (knowledge-capture, see below): a test that asserts `parseOptionalCaseStatus`'s allowed-list === the Prisma enum, so a future status can't be added to the enum without the filter learning it.

### Chunk C risks
- 🟢 Audit is read-only — zero prod risk. The validator + label fixes are tiny.
- 🟡 The "delivered" label appears in CSV export (`CasesPage.tsx:118`) and any veteran-facing surface — confirm the new label is never shown to a veteran (it's internal Cases-page only; the veteran sees email copy, not the status enum). Verified: status enum is staff-internal.

---

## Chunk D — Doctor Pack surfacing + curation tuning (P2.4)

**The "we've worked on this 10 times" item. Backend is built; frontend surface is missing; selector needs accuracy tuning to Ryan's content spec.**

### What exists (do NOT rebuild)
- Route: `backend/src/routes/doctor-pack.ts` — `POST /cases/:id/doctor-pack/generate`, `GET /cases/:id/doctor-pack/latest`, `GET /cases/:id/key-docs`, RN review queue, ack.
- Manifest service: `backend/src/services/doctor-pack.ts` (`selectKeyDocs`, `buildManifest`).
- Per-page selector: `backend/src/services/page-selector.ts` (`selectPages` — the curation brain).
- Classifier: `backend/src/services/key-docs-classifier.ts` (filename + content-hint → docType + tier + importance).
- Worker: `workers/doctor-pack-assembler/handler.py` (pypdf page-extraction + WeasyPrint cover/TOC).
- Watcher: `backend/src/lambdas/stuck-doctor-pack-watcher.ts` (recovers stuck queued/generating).
- **MISSING:** any frontend `api/doctor-pack.ts` client, and any surface on `PhysicianReviewPage.tsx` (it shows the letter panel + advisory only — no docs list, no pack).

### D1 — Surface BOTH on the physician review page (P2.4a + P2.4b)
- New `frontend/src/api/doctorPack.ts`:
  - `getLatestDoctorPack(caseId)` → `GET /cases/:id/doctor-pack/latest` (returns the `DoctorPack` row: `{state, pdfS3Key, pageCount, keyDocCount, ...}` or null).
  - `listKeyDocs(caseId)` → `GET /cases/:id/key-docs` (the per-doc classification rows — the "all case documents" list with docType + importance + pageRanges).
  - `generateDoctorPack(caseId)` → `POST /cases/:id/doctor-pack/generate` (kick off / regenerate).
  - A signed-URL fetch for the pack PDF. **GAP:** the route returns `pdfS3Key` but there's no presign endpoint for the pack in `doctor-pack.ts`. The letter PDF uses `getArtifactPdfUrl` (`api/drafter.ts`, used at `PhysicianReviewPage.tsx:65`). **Need:** add `GET /cases/:id/doctor-pack/:id/pdf-url` (presign, mirror the letter-artifact presign) OR confirm an existing generic presign covers `doctor-packs/...` keys. (Investigate `api/drafter.ts` getArtifactPdfUrl's backend route + S3 key scoping — **D-investigate-1**.)
- New component `frontend/src/components/DoctorPackPanel.tsx` mounted in `PhysicianReviewPage.tsx` (between the letter panel and the advisory panel, ~line 146):
  - **(a) All-documents list:** render `listKeyDocs` rows — file name, docType (human label), classification chip, page count selected. This is "list of ALL case documents."
  - **(b) Doctor Pack download:** show `getLatestDoctorPack` state. If `ready` → "Open Doctor Pack ({pageCount}pp)" button (opens presigned PDF). If `queued`/`generating` → spinner + poll (reuse the `refetchInterval` pattern; stop when terminal). If `failed` → show `errorMessage` verbatim + a "Regenerate" button (standing-rule: real cause surfaced). If null/absent → "Generate Doctor Pack" button.
  - Poll cadence: `refetchInterval` while state ∈ {queued, generating}, else false. The watcher flips stuck→failed after 15 min so the UI won't spin forever.
- Role: route GETs allow `physician` (`doctor-pack.ts:381,400`); POST /generate is `admin, ops_staff` only (`doctor-pack.ts:100`). So a physician can VIEW + open but not generate. **Decision (D-2, Ryan taste):** should the physician be able to trigger generation, or only RN/admin? If physician should regenerate, widen the POST role to include `physician`. Default: keep generation RN/admin (the RN preps the pack before sending to the doctor), physician view-only. Surface a clear "ask your RN to (re)generate" message if no pack exists rather than a dead button.

### D2 — Curation tuning to Ryan's content spec (the real "perfect it" work)
Ryan's content spec (P2.4, verbatim intent): the pack is 10-15pp (max ~20) and contains ONLY:
1. VA-letter pages showing **SC grants/denials/reasons** — NOT every page, NOT appeal-instruction boilerplate.
2. Most recent/pertinent **office visit notes and/or imaging**.
3. **Buddy statements**.
4. **Personal statement** (statement in support), if made.
5. **In-service documentation** if it exists (military/personnel records, STRs, CO letter).
6. NO "500 blue button pages."

**Where each rule lives + the gap analysis** (against `page-selector.ts` + `key-docs-classifier.ts` + `doctor-pack.ts`):

| Ryan's rule | Current behavior | Gap / tuning |
|---|---|---|
| VA letters: SC/denial pages only, drop appeal boilerplate | `page-selector.ts` RULES for `rating_decision`/`denial_letter`/`supplemental_decision` include SC/grant/denial/reasons regex + EXCLUDE appeal-rights/NOD/Form-9/appellate-review. Plus a doc-wide `pageHasAppealBoilerplate` drop (`page-selector.ts:253-260`). **This already implements the rule.** | TUNE: widen include regex for real-world VA letter phrasings seen in test charts (e.g. "Entitlement to ... is established", "Evaluation of ... is continued", "We have made a decision on your claim", "Reasons for Decision"). Tighten boilerplate threshold if any decision page is being dropped. Needs REAL VA letters to tune against (Ryan's test cases — Hatfield CLM-472D122997 etc.). |
| Recent/pertinent visit notes + imaging | `progress_notes` is DEFAULT-EXCLUDE (`page-selector.ts:41-44`, `DEFAULT_EXCLUDE_BY_DEFAULT`). Imaging has no dedicated docType. | **GAP.** Ryan WANTS recent pertinent visit notes + imaging IN. Two sub-gaps: (1) `progress_notes` excluded entirely → need a "most recent N pages / most recent encounter" inclusion rule, OR a content rule that pulls pages mentioning the claimed condition. (2) No `imaging`/`radiology` docType — add classifier patterns (`/\b(MRI|CT|x-?ray|radiolog|imaging|ultrasound)\b/`) → a new `imaging` docType, small-doc-all or impression-page selection. **This is the biggest curation gap.** |
| Buddy statements | `buddy_statement` docType (classifier:78) + `SMALL_DOC_ALWAYS_ALL` (page-selector:26-39) → all pages included. ✓ | Already correct. Confirm classifier catches "lay statement", "statement in support of claim" filenames. |
| Personal/veteran statement | `statement_in_support` + `lay_statement` → small-doc-all. ✓ | Already correct. |
| In-service docs (military/personnel/STR/CO letter) | `personnel_record` (importance 75, has a CONTENT rule keying on MOS/deployment/combat/injury — page-selector:167-178), `service_treatment_record_summary` (condition-keyword rule:179-188), `dd_214` (small-doc-all), `separation_exam`/`entrance_exam` (small-doc-all). | Mostly covered. GAP: "CO letter" (commanding-officer statement) has no docType — likely falls to `unspecified` (first-8-pages + RN flag, page-selector:339-354). Add a classifier pattern for command/CO/buddy-from-command letters → treat as a statement (small-doc-all). |
| NO blue-button dump | `blue_button` → `bulk` tier (classifier:81-83) → DEFAULT-EXCLUDE in selector (page-selector:41-44) → empty ranges, EXCLUDED. ✓ | Already correct. This is the "500 pages" guard working. |
| 10-15pp target (max ~20) | `PACK_PAGE_TARGET = 250` (doctor-pack.ts:38) — that's the COMPRESSION flag threshold, not Ryan's curation target. There is NO 15-20pp soft cap in the selector. | **GAP.** Add a pack-level page budget. After per-doc selection, if total > ~20pp, the selector/route should rank-trim (keep highest-importance docs + the SC-decision pages; flag `needsRnReview` when trimming drops content). This is the "10x worked, never perfected" crux — without a budget the pack bloats. Implement as a post-selection trim pass in `assembleDoctorPackManifest` or the route, with `aboveTarget` re-keyed to the ~20pp goal. **(Ryan taste-decision D-3: exact target — 15? 20? hard cap or soft flag?)** |

**🔴 The whole-doc fallback trap (the silent bloat source):**
- `selectKeyDocs` (`doctor-pack.ts:68-107`) sets `includePages = pageCount` (ALL pages) for high_signal when there's no per-page refinement.
- The route refines via `selectPages` ONLY when `document_pages` rows exist (`doctor-pack.ts:183-230`). `selectPages` returns empty ranges (`no_per_page_text_available`) when no per-page text, and the route then KEEPS the legacy whole-doc range (`doctor-pack.ts:226-227`: `if (ranges.length === 0) return entry`).
- **So if OCR/Textract hasn't populated `document_pages` for a VA letter, the pack includes the ENTIRE letter — every appeal-boilerplate page — exactly the bloat Ryan hates.** The curation only works when per-page text is present.
- **Action:** confirm the OCR worker populates `document_pages` for the test charts (it's the precondition for all curation). If it's not reliably populated, that's the actual root cause of "never perfected," not the selector rules. **(D-investigate-2: verify `document_pages` is populated for Hatfield's VA letters before tuning regex.)** Possibly the OCR worker (`workers/ocr/`) or chart-extract isn't writing per-page rows in staging.

### D3 — Curation classifier signals per doc type (concrete, for the page-selector tuning)
For the assembler's per-doc page selection, the classifier + selector signals to implement/tune:

- **VA decision letter** (`rating_decision`/`denial_letter`/`supplemental_decision`): INCLUDE a page if it matches any of: service-connection grant/denial verbs (`is granted|denied|established|continued`, `we (have )?granted|denied`), `reasons? (for|and) (decision|bases)`, `evidence considered`, an evaluation percent (`\b\d{1,3}\s?%`, `with an evaluation of`), or the condition name. EXCLUDE a page if dominated by appeal boilerplate (`how to appeal`, `your rights`, `notice of disagreement`, `VA Form 9`, `appellate review`, `board of veterans' appeals`) — threshold ≥3 phrase hits OR boilerplate density (page-selector:253-260). Net: the SC/denial reasoning pages survive; the standard ~10-15pp appeal-instructions tail drops.
- **Imaging/radiology** (NEW docType): classify on filename (`MRI|CT|x-?ray|radiolog|ultrasound|imaging`) + content (`impression:|findings:|technique:`). Select the impression/findings page(s); small-doc-all if ≤2pp.
- **Office/progress notes** (recent pertinent): classify `progress_notes` but CHANGE selection from default-exclude to: include pages whose text mentions the claimed condition OR are within the most-recent encounter date. Needs the claimed condition passed into the selector (it currently isn't — `PageSelectorInput` has no condition field; **add `claimedCondition` to the input** so notes/imaging can be condition-filtered). This is a selector signature change.
- **DBQ / C&P exam**: include pages with checked boxes (`[X]`/`☒`), `diagnosis:`, `medical opinion`, `rationale`, signature; small-doc-all ≤2pp. (Already implemented, page-selector:119-148.)
- **Statements** (buddy/lay/personal/CO): small-doc-all (whole doc — they're short). Add CO-letter filename pattern.
- **Service records** (personnel/STR/DD-214/separation/entrance): condition-keyword + injury/MOS/deployment content rule; small-doc-all for DD-214/exams. (Mostly implemented.)
- **Blue Button / full health record**: EXCLUDE (bulk). (Implemented.)

### Chunk D tests
- Backend unit (`page-selector.test.ts` — extend): per-docType fixtures with realistic VA-letter page text → assert SC-decision pages IN, appeal-boilerplate pages OUT; imaging impression page selected; progress note mentioning the condition IN, unrelated note OUT (requires the new `claimedCondition` input); blue_button → empty; pack-budget trim keeps highest-importance under the ~20pp cap.
- Backend unit (`doctor-pack.test.ts` — extend): the whole-doc fallback no longer ships an entire VA letter when per-page text IS present; `aboveTarget` keyed to the new budget.
- Playwright (`physician-letter-flow.spec.ts` extension or new `doctor-pack.spec.ts`): on a physician review page with a ready pack → all-docs list renders, "Open Doctor Pack" opens a PDF; failed pack shows the real error + Regenerate.

### Chunk D risks
- 🔴 The `document_pages`-not-populated fallback (D2 trap) — if unaddressed, all regex tuning is moot. Verify FIRST.
- 🟡 Selector signature change (`claimedCondition` input) touches `selectPages` callers (`doctor-pack.ts:206`) + tests. Contained but real.
- 🟡 Pack-budget trim must be DETERMINISTIC (the assembler relies on same-input→same-output for idempotency, page-selector.ts header). Rank-trim by (classification tier, importance, page-in-doc order) — no randomness.
- 🟢 Presign endpoint for the pack PDF (D-investigate-1) may already exist generically.

---

## Chunk E — Email + render hygiene batch (P3 5a-pre, 5a-pre2, 5a-bis, 5a-bis2, 5b-adjacent + P0 fix #4)

**All share the `delivery.ts` / delivery-templates touch. Independently shippable as a unit.**

### E1 — Full Section VII in the invoice email (5a-bis)
- File: `backend/src/services/letter-opinion-excerpt.ts`.
- Today `extractOpinionSentence` (line 37-53) returns ONLY the bolded sentence (`**...**` pair after the VII header). Ryan wants the bolded sentence PLUS the supporting paragraph(s) after it, through the end of Section VII (before Section VIII).
- **Fix:** add `extractOpinionFull(letterText)` that slices from the VII header to the VIII header (the bound is already computed at lines 44-46), strips the header, and returns the full section prose (bold sentence + following paragraphs), whitespace-normalized per paragraph, `**` markers stripped. Keep `extractOpinionSentence` for any caller that needs just the line. `buildOpinionExcerpt` (line 81) switches its `Opinion:` block to use the full section.
- Watch: the "ANCHOR GOTCHA" (Peppers incident, header comment lines 11-18) — must still anchor PAST the "VII. Opinion" header so the first content isn't the header itself. The existing slice logic (44-47) already handles this; reuse it.
- Watch: don't pull the §VIII references into the opinion block (bound at the VIII header — already handled). References stay their own block.

### E2 — Payment line + Stripe link MOVE UP to paragraph 2 (5a-bis2)
- File: `backend/src/services/delivery-templates.ts`, `buildDeliveryEmail` (line 69-99).
- Current body order (lines 81-96): greeting → intro → PROBABILITY_RATIONALE → excerpt → "To receive your signed letter..." + link → closing → footer. Link is near the BOTTOM, and with the full §VII excerpt (E1) the citations now read as the natural END.
- **Fix (Ryan's order):** greeting → **para 2 = payment info + link** → wording note (PROBABILITY_RATIONALE) → opinion excerpt/citations LAST → footer.
- New body array:
  ```
  `Hi ${greetingName},`
  ''
  <intro: letter complete + corrections invite + signed PDF within minutes of payment>
  ''
  'To receive your signed letter, please complete payment using the secure link below:'
  ''
  linkLine
  ''
  PROBABILITY_RATIONALE
  excerpt                      // full §VII + references, now last
  'If you have any questions before then, reply to this email.'
  FRN_FOOTER
  ```
- Keep the HARD CONSTRAINT: the email NEVER names the claimed condition (the excerpt block is condition-free by construction; verify the full-§VII extract doesn't leak the condition into the email prose — it may, since §VII prose can name the condition. **🔴 Check:** Ryan's hand-added Hatfield version included §VII text — confirm whether the condition appearing INSIDE the quoted opinion is acceptable (it's a QUOTE from the letter, arguably fine) vs the email's own prose naming it (banned). The constraint is about the email's framing prose, not the quoted excerpt. Confirm with Ryan — **taste-decision E-1**. The existing `excerpt` already quotes the bolded opinion which can name the condition, so this isn't a new leak.)

### E3 — Wire the invoice email SEND to SES (5a-pre2)
- File: `backend/src/routes/delivery.ts`, `POST /cases/:id/delivery/send` (line 180-339).
- Today the route COMPOSES + persists the Email row with `status:'queued'`, `sentAt:null`, and NEVER calls a transport (lines 244-275, 317-319 `emailSent = false`). The amber "Email sending is not configured" banner (`DeliveryPanel.tsx:134`) and "pending send" copy come from `isEmailTransportConfigured()` being false.
- The post-payment delivery email ALREADY uses `mailer.sendEmail` (SES, forwarding-mode aware) — `services/payment-delivery.ts` is the precedent.
- **Fix:** after persisting the Email row, call `sendEmail({ to: toAddress, subject: DELIVERY_EMAIL_SUBJECT, textBody: emailBody })` (`services/mailer.ts:18`). On success: set the row `status:'sent'`, `sentAt: now`, return `emailSent:true` + the real messageId; surface `redirectedFrom` when SES-sandbox forwarding fired (it will — `EMAIL_REDIRECT_ALL_TO=info@` is live per session state, so the invoice lands in info@ as `[FWD to vet]` until SES production access). On failure: keep the row `queued`, return `emailSent:false` + the REAL SES error verbatim (standing rule), CloudWatch warn.
- **🔴 Config-gate mismatch (must fix together):** `isEmailTransportConfigured()` (`delivery-config.ts:37-46`) checks `DELIVERY_EMAIL_TRANSPORT`/`SES_REGION`/`RESEND_API_KEY`/`GMAIL_REFRESH_TOKEN`, but `mailer.sendEmail` gates on `SES_FROM_ADDRESS` (`mailer.ts:19-20`). These disagree — the panel could say "configured" while `sendEmail` no-ops, or vice-versa. **Align them:** make `isEmailTransportConfigured()` return true iff `SES_FROM_ADDRESS` is set (the actual thing `sendEmail` needs), so the UI banner and the real send agree. Verify `SES_FROM_ADDRESS` is set on the API Lambda env (the post-payment path works in prod, so it should be — confirm).
- Idempotency preserved: re-send of an already-`sent` row should NOT re-transmit. Guard: if `out.savedEmail?.status === 'sent'`, skip the `sendEmail` call (return the existing). The current reuse logic (lines 230-274) handles the row; add the status guard around the new send.
- Until wired (or if SES errors), the editable preview (`DeliveryPanel.tsx:125`) remains the manual copy-paste fallback — that's the current behavior, just now with a real send attempt first.

### E4 — Cover memo verify → PDF (5a-pre / P0 fix #4)
- Today: `DeliveryPanel.tsx:84-88` renders `data.memo.text` as raw `<pre>` text (looks unfinished). Ryan wants "Verify the cover memo" to open a PDF like the letter does.
- The letter PDF is produced by the render Lambda (`letter-render-invoke.ts` → `letter.ts` RenderInvokeInput, which takes `letterText` + `keys{txtKey,pdfKey,docxKey}` and renders the **nexus-letter shape** with signature compositing + credential substitution).
- **🔴 The render Lambda "only knows the nexus-letter shape"** (`delivery-templates.ts:5-8` comment; confirmed by `RenderInvokeInput` — it composites a signature image and assumes letter chrome). Passing memo text as `letterText` risks injecting letter headers/signature blocks into a memo.
- **Options (Ryan taste-decision E-2 + D-investigate):**
  - (E-4a) Investigate whether the render Lambda (FRN repo `Dockerfile.render`) has a memo/doc mode or can render arbitrary text without letter chrome. If it can take a "plain document" mode, add a `kind: 'memo'` to `RenderInvokeInput` and a memo-render endpoint. Cross-repo (FRN render image) — coordinate via outbox. Heaviest, most correct.
  - (E-4b) Add a lightweight server-side memo→PDF (e.g. a minimal pdf generation of `buildCoverMemoText` output) in the EMR backend, independent of the render Lambda. Avoids the cross-repo render-image change. The cover memo is plain prose (no signature composite needed in the same way — it ends with `[SIGNATURE]` placeholder + credential block). A small `pdfkit`/`pdf-lib` render in a new `services/memo-render.ts` + `GET /cases/:id/delivery/memo-pdf` (presigned or streamed) is self-contained.
  - (E-4c, interim) Render the memo text into a print-styled HTML/PDF view client-side (open a formatted print view) — cheap, no backend, but not a true PDF artifact.
- **Recommendation:** E-4b (backend memo→PDF, self-contained) — it matches the standing "PDF is the verification artifact" rule, avoids the FRN render-image cross-repo dependency, and the memo is simple enough that a minimal renderer is low-risk. Wire `DeliveryPanel`'s "Verify the cover memo" button to open the PDF (presigned URL, new-tab) instead of toggling the `<pre>`.
- Investigate first (E-investigate-1): does FRN's render Lambda already accept a non-letter doc? If yes, E-4a is cleaner long-term. Check the FRN `Dockerfile.render` handler's accepted payload `kind`/shape via the drafter lane / outbox.

### E5 — P0 fix #4 hygiene (invoice email transport wiring) — folded into E3
- The work order's P0 queued fix #4 ("invoice email transport wiring" + "cover memo verify→PDF") is exactly E3 + E4. They share the `delivery.ts` touch, so they ship together in chunk E. No separate work.

### Chunk E tests
- Backend unit (`letter-opinion-excerpt.test.ts` — extend): `extractOpinionFull` returns bold sentence + following paragraphs, stops at §VIII, strips `**`, handles missing §VII (null), handles the anchor gotcha (no §I header leakage).
- Backend unit (`delivery-templates.test.ts` — extend): `buildDeliveryEmail` body order = greeting → payment+link → rationale → excerpt last; never names a condition in the email's OWN prose; footer verbatim.
- Backend unit (`delivery-routes.test.ts` — extend): `/delivery/send` calls `sendEmail` (stubbed) and flips the row to `sent`+`sentAt` on success; on `sendEmail` throw, row stays `queued` and the REAL error surfaces; already-`sent` rows don't re-transmit; SES-forwarding `redirectedFrom` surfaces.
- Backend unit (`delivery-config.test.ts` — extend): `isEmailTransportConfigured()` now keys on `SES_FROM_ADDRESS` and agrees with `mailer`.
- Backend unit (new `memo-render.test.ts` if E-4b): memo text → non-empty PDF bytes; deterministic.
- Playwright (`rn-workflow.spec.ts` extension): on a delivered case → DeliveryPanel "Verify the cover memo" opens a PDF (not raw text); email preview shows payment link in para 2 + full §VII at the end; "Send" reports sent (or the real forwarding message).

### Chunk E risks
- 🔴 Condition-leak check (E-1) — confirm the email's own prose stays condition-free after moving the full §VII excerpt.
- 🔴 Config-gate mismatch (E3) — align `isEmailTransportConfigured` with `mailer`'s actual `SES_FROM_ADDRESS` gate or the UI lies.
- 🟡 Memo render path (E4) — cross-repo (E-4a) vs self-contained (E-4b) decision. Recommend E-4b.
- 🟡 Idempotent re-send guard — don't double-email on a retry/double-click.

---

## Cross-cutting: knowledge capture (linter-ization / index)

For findings that are a recurring class:
- **C-lint (status-enum drift):** the `parseOptionalCaseStatus` allow-list silently diverged from the 13-value enum (missing 3). Add a test that asserts the filter allow-list === the Prisma `CaseStatus` enum (single source). Phase: MIDDLE (it's a contract test). Prevents the next status addition from 400-ing its own dropdown.
- **E-lint (transport-gate truthfulness):** `isEmailTransportConfigured()` claimed "configured" on a different signal than `sendEmail` actually needs. Add a test binding the gate to `mailer`'s real precondition. Phase: MIDDLE.
- **D-note (doctor-pack whole-doc fallback):** the "perfected 10 times, never works" symptom is likely the `document_pages`-empty → whole-doc bloat, not the selector regex. Worth an INCIDENTS.md / memory note once confirmed, so the 11th attempt starts at the OCR-population precondition, not the regex.
- **A-note (already-shipped vs work-order-asks):** P2.1 (landing) and P2.3 (rotation infra) were already done — the work order's continuity notes were stale. Cheap lesson: grep the codebase before estimating "build X" from a handoff.

---

## Ryan taste-decisions (collect before building)
- **A-1:** Banner on the staff Inbox too (shared page), or physician-only?
- **A-2:** Keep the current 5 bridge images, or supply a new/larger set?
- **B-1:** "me" identity mapping — add `GET /users/me` (B-1a, recommended) or match by email (B-1b)?
- **B-2:** Do admins also default to "All" on the Cases page, or to their own assigned?
- **B-3:** Show RN friendly name (extend payload) or keep email in the RN column?
- **B-4:** Confirm reject-visibility behavior (visible under All, hidden from a nurse's default).
- **C-1:** "Delivered" relabel wording — "Ready for delivery" / "Ready to invoice" / "Finalized"?
- **D-2:** Can physicians trigger Doctor Pack (re)generation, or RN/admin only?
- **D-3:** Doctor Pack page target — 15? 20? soft flag or hard trim?
- **E-1:** Is the claimed condition appearing inside the QUOTED §VII opinion acceptable (vs the email's own prose)?
- **E-2:** Memo→PDF via FRN render Lambda (cross-repo, E-4a) or self-contained EMR renderer (E-4b, recommended)?

## Investigations to run before/within build
- **D-investigate-1:** Is there a presign route for `doctor-packs/...` S3 keys, or must one be added (mirror letter-artifact presign)?
- **D-investigate-2 (🔴 do FIRST in chunk D):** Are `document_pages` rows populated for the test charts' VA letters in staging? If not, curation regex is moot and the OCR worker is the real fix.
- **E-investigate-1:** Does FRN's render Lambda accept a non-letter/plain-doc payload (`kind`)? Decides E-4a vs E-4b.

## Suggested ship order
1. **Chunk C** (status filter 400 fix + Delivered label) — tiny, fixes a live 400 + a confusing label, unblocks the audit.
2. **Chunk A** (tabs/banner) — mechanical, low risk, visible win.
3. **Chunk E** (email batch) — Ryan hand-did Hatfield tonight; this stops the manual work recurring. Highest near-term leverage.
4. **Chunk B** (cases filters + assign) — needs the B-1 identity decision first.
5. **Chunk D** (doctor pack) — largest; gated on D-investigate-2 (OCR population). Do the investigation early even if the build lands last.

Every chunk: architect-plan (done here) → build → mid-build architect check → final QA → Playwright smoke. PDF is the verification artifact for any letter/memo-content claim.
