# Phase 7B-revised Build 1 — Architect QA

**Reviewer:** code-architect-qa
**Plan:** `docs/planning/2026-05-25_phase7b_revised_page_selection.md` (`80caff7`)
**Build under review:** `892895a feat(phase7b-revised build 1): Doctor Pack page-selection + cover page`
**Branch / dir:** `main` / `C:\Users\ryank\compact-emr-work`
**Scope:** read-only review, no code edits.

---

## Top-line verdict

**Ship-ready with two minor follow-ups.** No blockers. Build 2 is greenlit.

Build 1 implements the plan faithfully. Migrations are idempotent. The forward-compat bridge (empty `pages: []` → `pageRanges: []` → assembler keeps legacy whole-doc behavior) works as designed. Page-selector rules cover all 20 doc types planned. 23 of 23 unit tests pass at this commit. Physician override + `needsRnReview` audit trail wired correctly.

The two follow-ups below are non-blocking; both can land before Build 3.

---

## QA dimensions — verdict per dimension

### 1. Spec compliance — PASS

Cross-checked against the seven specified deliverables in the QA brief:

- ✅ Per-docType regex rule sets — 20 types covered (plan said ~15; over-delivered).
- ✅ `HIGH_SIGNAL_FALLBACK_TYPES` set with <2-match threshold + `needsRnReview=true`.
- ✅ Physician override via `physicianIncludeAllPages`, rationale stamped `physician_override`.
- ✅ `needsRnReview` + `selectorRationale` persisted to `key_docs` via new migration.
- ✅ `rangesFromIncluded()` merges adjacent included pages into contiguous ranges (tested at `page-selector.test.ts:213`).
- ✅ Deterministic; no LLM dependency, no randomness, no time-dependence in the matcher.
- ✅ Cover page lives in `DoctorPack.manifestJson.coverPage` per FFC-1 (`doctor-pack.ts:289-293`).

**Minor drifts from the plan (acceptable):**

- Plan §"Per-docType rules" listed `progress_notes` and `blue_button` as "NONE by default (forward hook: drafter-cited pages only)". Implementation returns `pageRanges: []` and does NOT set `needsRnReview=true`. This is correct — RN doesn't need to review intentional exclusions — but the rationale string should make that explicit. The implementation's `default_exclude (...); drafter-cited pages add post-hoc` text is fine.
- Plan §"Confidence-fallback synonyms" listed 11 grant/denial phrasings. Implementation has ~8 of them as separate regexes plus 2 catch-all `\bgranted\b` / `\bdenied\b`. Net coverage is wider than the plan thanks to the catch-alls. See finding §3 below for one miss.

### 2. Forward-compatibility — PASS (data flow walked)

**Scenario:** case with 5 documents, 0 `DocumentPage` rows (Build 3 not yet shipped).

1. `POST /doctor-pack/generate` lookup of `caseWithDocs` returns 5 `documents` rows with `pageCount` populated or null.
2. `classifiedFiles` builds 5 entries, each with `documentId` + `filePath`.
3. `db.documentPage.findMany({ where: { documentId: { in: [...] } } })` returns `[]` (no rows yet).
4. `pagesByDocumentId` map is empty.
5. For each file, `selectPages()` is called with `pages: []` → returns `{ pageRanges: [], selectorRationale: 'no_per_page_text_available', needsRnReview: false }`.
6. `assembleDoctorPackManifest()` runs the legacy `selectKeyDocs()` path and returns entries with whole-doc `pageRanges`.
7. `refinedEntries` map: `if (ranges.length === 0) return entry;` — keeps the legacy whole-doc entry. ✅
8. `refinedTotalPageCount` reflects the legacy whole-doc page totals. ✅
9. `keyDoc.upsert` writes `pageRanges: refinedEntry?.pageRanges ?? sel.selection.pageRanges` (the legacy ranges win) + `selectorRationale: 'no_per_page_text_available'`.

Bridge works. Existing live cases will keep producing whole-doc packs until Build 3 fills `document_pages`, at which point the next `/generate` upgrades them to page-selected automatically. No regression risk.

**Caveat:** the route uses `f.pageCount ?? pageRows.length ?? 0` to compute the input pageCount to `selectPages`. When pageRows is empty AND `Document.pageCount` is null, that resolves to `0`, and `selectPages` early-returns the empty-pages branch *correctly*. But note that `f.pageCount ?? pageRows.length` will never actually evaluate the RHS because `?? 0` already covers null. The `?? pageRows.length` middle term is dead code — harmless, but consider simplifying in a follow-up.

### 3. Page-selector rules quality — PASS with synonym gaps

The regex sets are sound. The catch-all `\bgranted\b` and `\bdenied\b` in `rating_decision.include` provide a strong safety net against phrasing drift, and the `appeal_boilerplate` exclusion fires on the appeal-rights pages cleanly in the tests.

**Synonyms that are likely to MISS (rating_decision and denial_letter specifically):**

- `rating_decision`:
  - **"continued"** without a leading "is/has been/are" — bare `\bcontinued\b` is in the plan's spirit but absent. Real VA letters say things like *"Service connection for tinnitus is continued at 10%."* — that one **does** match because of `service[\s-]?connect(ion|ed)`, but *"Continued"* as a section header on its own doesn't.
  - **"Increased rating"** / **"Decreased rating"** / **"rating reduction"** — appears in rating-decision body when this isn't the initial grant. The catch-all `\bgranted\b` will save some of these, but a denial-of-increase where the verb is "denied" works fine.
  - **"propose to sever"** — sever-of-SC decisions don't say granted or denied. These are rare (~1-2% of rating decisions) and the `high_signal_fallback` (<2 matches) will catch them as include-all + RN. So this is a latent issue, not a failure.
- `denial_letter`:
  - **"we are unable to grant"** / **"we find that the criteria are not met"** / **"insufficient evidence"** — these are common when the VA softens the denial language. None of the current regexes match the first two; `\bdenied\b` saves cases that use "denied" at least once on a hit page. `evidence considered` (which IS in the include list) often appears 2+ pages before the actual denial verb in long decisions, so range merging may capture nearby denial text but the high-signal fallback is again the load-bearing safety net here.

**Synonyms list from the plan that ARE included:** `is granted`, `we have granted`, `we granted`, `service connection is established`, `service-connected`, `granted at`, `with an evaluation of`, `is denied`, `we have denied`, `we are denying`, `is not granted`, `we cannot grant`. Coverage is good.

**DBQ rules — one synonym miss:** the regex `physician.{0,30}signature` will not match `Examiner's signature:` followed by `Provider:`. The implementation already includes `/examiner.{0,30}signature/i` so this is fine; but a separate `provider.{0,30}signature` would catch civilian-clinician DBQs. Minor.

**Recommendation:** widen the synonym list in a follow-up patch (~30 min) once Build 3 surfaces real per-page text. Do NOT do it pre-emptively — the high-signal fallback handles the long tail and the regex set is already large enough to debug pathology cases visually from `selectorRationale`.

### 4. High-signal fallback — simulated PTSD→OSA walk

**Scenario:** 18-page ClaimLetter (rating_decision), 8-page DBQ, 4-page PSG (sleep_study), 1-page DD-214, 5-page benefit_summary, 12-page progress_notes, 200-page blue_button.

Walking the actual rules against the documented case:

| Doc | Pages | Rule path | Selected | Why |
|-----|-------|-----------|----------|-----|
| ClaimLetter (rating_decision) | 18 | per-page regex + appeal-boilerplate exclusion | ~3-5 | Pages 1-3/4-5 decision+R&B match; pp.6-18 appeal-rights boilerplate excluded |
| DBQ | 8 | per-page regex (`[X]` / diagnosis / signature) | ~3-4 | Diagnosis + findings + signature pages match; blank/instruction pages don't |
| PSG (sleep_study) | 4 | `smallDocPageCutoff: 2` not triggered (pageCount=4); per-page regex | ~2-3 | Impression + AHI summary match; raw-waveform pages excluded by `pageIsBlank` |
| DD-214 | 1 | `SMALL_DOC_ALWAYS_ALL_TYPES` | 1 | always-all |
| benefit_summary | 5 | first-3-pages override | 3 | spec rule |
| progress_notes | 12 | `DEFAULT_EXCLUDE_BY_DEFAULT` | 0 | default-exclude |
| blue_button | 200 | `DEFAULT_EXCLUDE_BY_DEFAULT` | 0 | default-exclude |

**Total: ~12-16 pages.** Hits the planned 12-18 target. If the ClaimLetter has uncharacteristically long reasons-and-bases or multiple granted conditions, total can climb to ~18-20; still within tolerance.

**Sensitivity:** if the OCR worker produces noisy text and the rating_decision falls to <2 matches, the high-signal fallback fires → 18 pages of decision + RN flag → total ~28-32 pages. Still acceptable as a one-off; RN clears it on next pass.

### 5. Physician override + needsRnReview persistence — PASS

`doctor-pack.ts:271-274` comment is correct: the `update` block excludes `notes` and `physicianIncludeAllPages` so both survive re-generation. Verified.

**QA brief question:** "does it also need to exclude `needsRnReview` (RN may want to clear the flag manually)?"

**Answer: yes, partially.** Current implementation overwrites `needsRnReview` on every `/generate` with the selector's freshly-computed value. Scenario that breaks:

1. RN reviews a flagged doc, decides "selector was wrong; pages 5-7 are fine," sets `physicianIncludeAllPages=true` and clears `needsRnReview` in the UI (Build 2 will add the UI).
2. Ops or an automated job calls `/generate` again (re-classify after a new upload, scheduled regen, etc.).
3. The `physician_override` short-circuit at `page-selector.ts:290-297` returns `needsRnReview: false` — so the override case is **safe**.
4. BUT if the RN cleared `needsRnReview` WITHOUT setting `physicianIncludeAllPages=true` (e.g., "I reviewed, the high-signal fallback is fine, I just want it off my queue"), the next `/generate` re-fires the selector, re-computes `needsRnReview=true`, and the flag comes back.

**Severity: low** — the physician_override path covers the dominant case. But for the "I reviewed, leave it alone" UX, RN clearance is not durable. Two options:

- (a) Add `needsRnReview` to the update-block exclusion list (RN clearance becomes sticky; downside: a future selector improvement that *should* re-flag the doc won't).
- (b) Add a `selector_acknowledged_at TIMESTAMPTZ` column; if non-null AND `selectorVersion` matches current, suppress the flag in the UI. Selector-version bump re-flags automatically.

Recommend (b) when Build 2's RN UI lands. Not a blocker for Build 1 ship.

### 6. Cover-page aggregator — PASS, two suggested additions

`chart-summary-aggregator.ts` includes: veteran demographics, service dates, combat/PACT/TERA flags, case row (claim + framing), SC conditions list, active problems, active medications, CDS verdict + odds + rationale, veteran statement, in-service event. Solid coverage.

**Suggested additions (Build 2-companion, not blockers):**

- **Allergies** — clinically load-bearing for the physician's medication decisions. Not in the current schema (no Veteran.allergies relation visible). Defer.
- **Denials-to-rebut summary** — if this is a supplemental/appeal claim, surface "VA denied this claim on YYYY-MM-DD; reason cited: [rationale snippet]". Aggregator has access to `KeyDoc` rows where `docType='denial_letter'` or `'rating_decision'`; pulling the first 200 chars of the `selectorRationale` text for those rows would give the physician the denial context inline. **Recommend adding before Build 3** — the page-selector now produces the rationale, so wiring it into the cover page is cheap.
- **Pending claims / open conditions** — derivable from `Case` rows where `veteranId = X AND status != 'shipped'`. Useful one-liner.

**Fields included that are NOT noise:** the CDS rationale Record can be large; the assembler should truncate when rendering to PDF, but storing the full object in `manifestJson.coverPage` is fine (Postgres JSONB cost is negligible).

### 7. Test coverage — PASS with one specific gap

23 tests cover: physician override, empty pages, always-all (4 types), default-exclude (2), rating_decision (3 incl. fallback), denial_letter, DBQ (2), C&P, sleep_study, benefit_summary (2), unspecified (2), range merging, invariants (2).

**Gaps:**

- **Appeal-boilerplate detector edge case** — the brief asks specifically: "a page that's 50% appeal-rights + 50% decision text — does my heuristic include or exclude it correctly?"

  Tracing `pageHasAppealBoilerplate()`: it returns true on `hits >= 3` OR `hits >= 1 && text.length < 2000 && hits/6 >= 0.4` (≥3 hits in a <2000-char page).

  - **Short page (1500 chars) with 3 appeal phrases + decision text:** `hits=3` → boilerplate-true → page EXCLUDED. Decision text on this page is dropped.
  - **Long page (5000 chars) with 3 appeal phrases + extensive decision text:** `hits=3` → boilerplate-true → page EXCLUDED. Same drop.
  - **Long page with 2 appeal phrases + decision text:** `hits=2` → boilerplate-false → falls through to per-page rule match → if decision text matches an include regex, INCLUDED.

  The heuristic is biased toward exclusion on `hits >= 3`. The 50/50 page with 3 appeal phrases is **dropped** even if the other 50% is the granted-disposition statement. **In practice this is rare** (real VA letters segregate boilerplate to dedicated pages) but it's a correctness gap worth a test:

  ```
  test('mixed page with decision text + 3 appeal phrases: dropped (known limitation)')
  ```

  Document the behavior. If field data shows this fires, swap the OR clause to AND, or require that `hits` outnumbers the include-rule hits on the same page.

- **Range merging edge cases:** what about non-monotone input? `rangesFromIncluded` sorts before merging, so unordered input works — but no test asserts it. One-liner test would add confidence.

- **Excluded-doctype + small-doc cutoff interaction:** a 1-page progress_notes should still return `pageRanges: []` (default_exclude wins). Tested only at 1 page implicitly; explicit edge case worth covering.

### 8. Migration safety — PASS

Both migrations are idempotent:

- `20260526070000_document_pages/migration.sql` — `CREATE TABLE IF NOT EXISTS` + `CREATE UNIQUE INDEX IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`. Re-runnable. The `page_number >= 1` CHECK constraint is sound. FK has `ON DELETE CASCADE` — correct (deleting a Document drops its pages).
- `20260528000000_key_docs_physician_override/migration.sql` — `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` × 4, all with safe defaults (`false` for booleans, `NULL` for strings). Existing rows get the default. Re-runnable.

**One minor schema mismatch:** the plan's hypothetical migration in §"Data model addition" did NOT include `created_at` / `updated_at` on `document_pages`. The shipped migration does. **The added timestamps are correct** — they match the codebase pattern for every other table and Prisma's `@updatedAt` directive needs the column. Not a divergence, an improvement.

**Schema-prisma vs SQL alignment:** Prisma model `DocumentPage` declares the columns and indexes consistently with the SQL. No drift.

### 9. Blocker bugs — NONE

Closest-to-blocker (still non-blocker): activity-log stale stats. See finding #2 below.

---

## Top 3 findings (ranked)

### 🟡 1. RN clearance of `needsRnReview` is not durable (see §5)

**Severity:** medium. Affects only the "RN reviewed, leave the flag alone" UX path. Physician override path is unaffected.

**Fix:** add `selectorAcknowledgedAt` column + suppress UI flag when `acknowledgedAt != null AND selectorVersion == current`. Land with Build 2's RN UI.

### 🟡 2. Activity log writes pre-refinement manifest stats, not post-refinement

`doctor-pack.ts:314-318` writes `manifest.keyDocCount` / `manifest.totalPageCount` / `manifest.aboveTarget`. These are the LEGACY whole-doc-path numbers. After page selection narrows the included page set, the row in `doctor_packs.page_count` is `refinedTotalPageCount` (correct), but the audit log reflects the legacy 41-page count rather than the selected 12-18.

**Fix:** replace with `refinedEntries.length` and `refinedTotalPageCount`. Add a one-line `selectedPageCount` field to the details JSON for clarity. ~3 lines, 5 minutes.

### 🟢 3. Appeal-boilerplate heuristic over-excludes mixed pages (see §7)

**Severity:** low. Documented limitation; the high-signal fallback catches the symptom (decision-text drop → <2 matches → include all). Worth one test asserting current behavior + a follow-up if Build 3 field data shows the symptom.

---

## PTSD→OSA simulated page count

**~12-16 pages** under Build 1 rules (see §4 walk). Matches the plan's 12-18 target. If the rating_decision is anomalously long or the high-signal fallback fires on the ClaimLetter, can climb to ~28-32 — still tolerable, RN flag in the queue.

---

## Greenlight for Build 2

✅ **Proceed.** Build 2 (RN manual-summary UI) is orthogonal to page selection. The two follow-ups above can land alongside Build 2 without blocking it.

When Build 2 wires the RN UI, fold in:
- `selectorAcknowledgedAt` column + suppression logic (finding #1).
- The 5-min activity-log refined-stats fix (finding #2).
- One test for the appeal-boilerplate mixed-page edge case (finding #3).

Build 3 (OCR worker) is unblocked because Build 1's `document_pages` schema + empty-pages fallback are in place.

---

**Reviewer note:** No code edits made. No tests added. Test suite not re-run (per QA brief constraint).
