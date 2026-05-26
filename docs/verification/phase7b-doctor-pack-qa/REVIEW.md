# Phase 7B — Doctor Pack architecture review

**Reviewer:** code-architect-qa (Claude Opus 4.7, 1M context)
**Date:** 2026-05-25
**Commits reviewed:** `7bb6ee3` (Doctor Pack — KeyDocs classifier + assembly manifest), `37025ff` (OCR spec compliance)
**Branch:** `main` @ `gohokies2005/compact-emr`
**Scope:** read-only architectural review of the shipped slice. The PDF assembly worker (Phase 7A Lambda) is explicitly **out of scope** — only the in-process classifier, manifest builder, route, and migration were reviewed.

This document has two lenses.

- **Lens 1 — Filing/architectural fit:** standard QA against the existing Compact-EMR layering (Prisma + Express router + pure services + Vitest).
- **Lens 2 — Simulated doctor:** what a physician opening this pack on day one actually gets, and whether that's enough to draft a nexus letter.

---

## Lens 1 — Filing / architectural fit

### Verdict: **minor follow-up** (one runtime-broken route, three correctness issues, otherwise solid)

The classifier + manifest layering is clean, the path-traversal guard is well-constructed, and the migration is idempotent. There is **one outright runtime bug** in the route's document query that would crash the first real request, plus three smaller correctness gaps that should land before any case actually hits this endpoint.

### Findings

#### CRITICAL: route reads `documents` off the wrong model

**File:** `backend/src/routes/doctor-pack.ts:78-83`

```ts
const documents = await db.veteran.findUnique({
  where: { id: (c as { veteranId: string }).veteranId },
  include: { documents: true },
});
```

Per `backend/prisma/schema.prisma:140-174`, the `Veteran` model has **no `documents` relation**. Documents relate to `Case`, not `Veteran` (see `Document.caseId` at `schema.prisma:269` and the `Case.documents Document[]` relation at `schema.prisma:251`). Prisma will throw a runtime error here on the first real call, because the include shape doesn't match the schema.

Additionally, the same block reads `d.pageCount` from each document (`doctor-pack.ts:84-91`), but the `Document` model has **no `pageCount` field** (the only `pageCount` column in the schema is on `DoctorPack` itself at `schema.prisma:544`). Even if the include were fixed, every row would resolve to `null` and the entire pack would fall through to the `MAX_PAGES_PER_FILE=80` cap regardless of how short the file actually is.

**Why the tests didn't catch it:** the unit tests for `selectKeyDocs` and `assembleDoctorPackManifest` (in `backend/src/__tests__/doctor-pack.test.ts`) bypass the route entirely and pass in already-classified file objects. There is no integration / Supertest coverage of the route itself.

**Fix:**

1. Query documents through `Case`, not `Veteran`:
   ```ts
   const caseWithDocs = await db.case.findUnique({
     where: { id: caseId },
     include: { documents: true },
   });
   ```
2. Add a `pageCount Int?` column to `Document` (or compute it from the OCR HARD-STOP worker's attempt metadata and stash it there). Without it the manifest's per-file cap is silently lossy.
3. Add a Supertest integration test for `POST /cases/:id/doctor-pack/generate` that actually hits the live router with a seeded case + documents. This class of bug should never reach `main` again.

#### CRITICAL: no uniqueness on `(case_id, case_version)` in `doctor_packs`

**File:** `backend/prisma/migrations/20260526050000_key_docs/migration.sql:31-49`

The migration creates only an *index* on `(case_id, case_version)`, not a unique constraint. Two near-simultaneous `POST /generate` requests for the same case will:

1. Both pass the chart-readiness gate.
2. Both `deleteMany({ where: { caseId } })` against `key_docs`, then race on upserts.
3. Both insert separate `doctor_packs` rows in `state='queued'` for the same `(caseId, caseVersion)`.
4. The downstream Lambda worker (Phase 7A) will pick both up and write to two different `pdfS3Key` paths.

The current `GET /latest` query papers over the duplicate-row symptom, but the work has already doubled and `key_docs` is mid-race.

**Fix:** add a partial unique index on `(case_id, case_version)` filtered to `state IN ('queued', 'generating')`:

```sql
CREATE UNIQUE INDEX "doctor_packs_active_uq"
  ON "doctor_packs" ("case_id", "case_version")
  WHERE state IN ('queued', 'generating');
```

This lets historical `ready`/`failed` rows accumulate (the audit trail we want) while preventing two concurrent assemblies. The route should then catch the unique-violation and return `409 conflict, doctor_pack_in_progress` instead of creating a second row.

#### IMPORTANT: state machine has no retry / no terminal-only guard

**File:** `backend/prisma/schema.prisma:538-558` + route entirely

The `DoctorPack.state` check constraint allows `queued | generating | ready | failed` but the migration has **no transition rules**. Specifically:

- Nothing prevents the worker (or a stray manual UPDATE) from going `ready -> queued`, which would re-trigger assembly.
- A `failed` row can be `POST /generate`d again, but there's no explicit "retry" — the route always creates a *new* row, which is fine, but the failure context (errorMessage, when it failed) is then orphaned unless the UI surfaces history. There's also no `attemptCount` on the row, so a flapping failure won't be visible in a single row.
- There's no row-level lock or `WHERE state = 'queued'` claim mechanism for the worker — when Phase 7A lands, the worker needs `UPDATE ... WHERE state = 'queued' RETURNING id` or SKIP LOCKED semantics.

**Fix recommendation (defer to Phase 7A worker, but bake the contract in now):**

1. Add a `claimedAt TIMESTAMPTZ` + `claimedBy VARCHAR` pair so the worker can claim a row with a single conditional UPDATE.
2. Add a check constraint: `state IN ('queued') OR (state = 'generating' AND claimed_at IS NOT NULL) OR (state IN ('ready','failed') AND generated_at IS NOT NULL)`.
3. Make the explicit "retry" UI action `POST /cases/:id/doctor-pack/generate` (current behavior) but stamp `previousDoctorPackId` on the new row so the history reads as a chain.

For now, ship the partial unique index above and call retry-handling out as Phase 7A scope.

#### IMPORTANT: KeyDoc reclassification destroys notes

**File:** `backend/src/routes/doctor-pack.ts:101-128`

The transaction does `await tx.keyDoc.deleteMany({ where: { caseId } })` and then upserts. Two consequences:

1. The `KeyDoc.notes` field is nuked on every regeneration. If an RN annotated a doc ("scanned upside-down, page 4 is illegible"), that note disappears the next time someone clicks Generate.
2. The unique constraint `key_docs_case_file_uq` makes the delete-then-upsert pattern functionally equivalent to a straight upsert. The delete buys nothing except wiped notes.

**Fix:** drop the `deleteMany` and do a single upsert pass. To handle "doc was removed from the case" (the stated reason for the delete), do it explicitly:

```ts
const livePaths = new Set(classifiedFiles.map((f) => f.filePath));
const existing = await tx.keyDoc.findMany({ where: { caseId }, select: { id: true, filePath: true } });
const orphanIds = existing.filter((e) => !livePaths.has(e.filePath)).map((e) => e.id);
if (orphanIds.length) await tx.keyDoc.deleteMany({ where: { id: { in: orphanIds } } });
// Then upsert the live set — notes survive.
```

#### IMPORTANT: `classifyFileWithContentHint` is dead code

**File:** `backend/src/services/key-docs-classifier.ts:143-161`

`classifyFileWithContentHint` is exported but **nothing in the codebase calls it**. The route uses `classifyFile(f.filePath)` directly at line 106. The ingest-spec / content-hint path the function was written for hasn't been wired through yet — the worker hasn't shipped, and the route ignores the function.

Two options:

1. **Recommended:** leave the helper in place but add a JSDoc `@internal — wired in Phase 7A worker only` tag, and **add a TODO at the route** that flags the path that needs to call it once Phase 7A ships. Currently the only signal that content-hint is coming is a comment block — make it a code-level breadcrumb.
2. Remove the helper until the worker actually consumes it. YAGNI; bring it back when needed.

Your question — "is the +5 importance boost the right way to express that content-classified docs are more trustworthy than filename?" — I think the answer is no. Conflating *trust* with *importance* is a future-debug headache: if you tune the +5 to (say) +20 to make content-classified docs win more aggressively in sort, you've also shifted them across inclusion thresholds. Better separation:

```ts
interface ClassificationResult {
  classification: KeyDocClassification;
  docType: KeyDocType;
  importance: number;
  source: 'filename' | 'content' | 'manual_override';   // <-- new
  confidence: number;                                    // <-- new, 0..1
  matchedPattern: string | null;
}
```

Then sort/include decisions can branch on `source` and `confidence` explicitly. The +5 fudge hides the policy inside a magic number.

#### IMPORTANT: composite helper JSDoc says "returns null" but doesn't

**File:** `backend/src/services/doctor-pack.ts:140-153`

```
* Composite helper: classify + select + build, used by the route to populate the DoctorPack
* row on POST /generate. Returns null when there are no eligible files (RN attention needed).
```

The function never returns null — it returns `DoctorPackManifest` with `keyDocCount: 0` instead. Stale doc-comment from an earlier draft. Either:
- Update the comment to reflect the actual contract ("returns a manifest with `keyDocCount === 0` when nothing is eligible"), OR
- Actually return null + have the route 409 instead of saving an empty pack.

The route currently 409s on `classifiedFiles.length === 0` before this is called, so an empty pack never reaches the DB. But future callers (e.g. a "preview pack contents" endpoint) might want to call this directly and get the empty-manifest signal cleanly. Updating the comment is the cheapest correct move.

#### MINOR: path-traversal guard is solid, with one quibble

**File:** `backend/src/routes/doctor-pack.ts:17-33`

`isSafeS3Key` checks: `string type` -> no `..` -> no leading `/` -> matches `^doctor-packs/[a-zA-Z0-9_-]+/v\d+/[a-f0-9-]+\.pdf$`.

`buildDoctorPackS3Key` sanitizes the caseId via `replace(/[^a-zA-Z0-9_-]/g, '_')` BEFORE construction, then re-runs `isSafeS3Key` on the assembled key. Belt-and-suspenders, and the regex anchors with `^...$` so injection via terminator characters is out.

The one quibble: **the comment claims caseId is "constrained by the case-create validator (no slashes, no '..')"**, but `parseCaseCreate` at `backend/src/services/case-validation.ts:104` only checks `requiredNonEmptyString(body, 'id')` — there's no charset constraint on the case ID itself. A POST with `id: "../etc"` would get accepted by case-create. The post-construction `isSafeS3Key` check catches it, but the comment is misleading. Either tighten `parseCaseCreate` to enforce `^[A-Z0-9_-]+$` (recommended) or update the comment to say "we sanitize because case-create accepts arbitrary strings — don't trust the input upstream."

The doctorPackId is a Prisma `@default(uuid())` so the `[a-f0-9-]+` regex is safe.

**No bypass path identified.** Path-traversal hole from Task #107 is closed.

#### MINOR: migration is idempotent, indexed, and cascades correctly

`backend/prisma/migrations/20260526050000_key_docs/migration.sql`:

- `CREATE TABLE IF NOT EXISTS` + `CREATE [UNIQUE] INDEX IF NOT EXISTS` throughout → re-runnable.
- `ON DELETE CASCADE` on both `case_id` FKs → consistent with the rest of the schema (`schema.prisma:279`, `:299`, `:322`, `:368`, etc.) and with the rule that a case deletion removes all its dependent rows.
- CHECK constraints on `classification` and `state` enums → good, since the Prisma enum-as-VARCHAR-with-CHECK pattern is what the rest of the schema does.
- Indexes on `(case_id)`, `(classification)`, `(doc_type)`, `(importance)` for `key_docs`; `(case_id)`, `(state)`, `(case_id, case_version)` for `doctor_packs` → covers the actual query patterns in the route.

One small **note, not a finding**: `key_docs.importance` is indexed by itself, but the only query that uses it is `findMany({ where: { caseId }, orderBy: [{ importance: 'desc' }, ...] })` — that wants a composite `(case_id, importance DESC)` index for the sort step. Postgres will probably use the `(case_id)` index + sort-in-memory, which is fine for the expected row counts (<50 per case). Leave it; revisit if a case ever has 500+ documents.

#### MINOR: route role gates are correct but uneven

- `POST /generate` → `requireRole(['admin', 'ops_staff'])` ✓ — physicians don't trigger assembly.
- `GET /latest` → `requireRole(['admin', 'ops_staff', 'physician'])` ✓ — physicians read.
- `GET /key-docs` → `requireRole(['admin', 'ops_staff', 'physician'])` ✓.

Consistent with the role model elsewhere. No issue.

#### Architectural fit assessment

The classifier-as-pure-function + manifest-as-pure-function + thin-router pattern is **exactly** the same shape as the chart-readiness gate (`evaluateChartReadiness`) and the OCR HARD-STOP layer (`classifyReadAttempt`). The composition feels right:

- `key-docs-classifier.ts` is pure and testable in isolation.
- `doctor-pack.ts` consumes the classifier and is also pure (no DB, no IO).
- `routes/doctor-pack.ts` does the IO + DB + chart-readiness gate composition.
- The route's first move is `evaluateChartReadiness(readStatuses)` → 409 → no leak past the OCR HARD-STOP.

The integration with Phase 5.2 chart-readiness is correct: doctor-pack.ts:99 calls `assembleDoctorPackManifest` only *after* the readiness check passes at line 67-72, so the spec's "no Doctor Pack until every file is read or manual-summarized" contract is honored at the route level.

The defense-in-depth in `selectKeyDocs` (line 77-78 of doctor-pack.ts) — excluding `manual_summary_required` files even if they leak past the route's readiness gate — is the right paranoia. Same defensive shape as the chart-readiness aggregator's "claims provided but summary too short → treat as required" branch.

### Lens 1 recommendation

Before this hits a real case, fix the two CRITICAL items (route querying wrong model + missing unique constraint) and the dead-code/notes-loss issue. The rest can land as follow-ups in a "phase7b-followups" commit.

---

## Lens 2 — Simulated doctor: PTSD → OSA secondary case

### Verdict: **ship-ready as Phase 1, but missing the cover sheet**

I imagined opening this pack as a physician on day one of the rollout, for a PTSD → OSA secondary nexus case with the record set Ryan described: DD-214, ClaimLetter rating decision, PTSD DBQ 2023, recent PSG, audiogram, spouse lay statement, Blue Button bundle (412 pages), random clinical notes. Per the manifest the unit test in `doctor-pack.test.ts:139-163` validates that exact case — the pack is 41 pages, 7 documents, sorted high-signal first, Blue Button excluded.

That's an honest skeleton. It is **not yet what a physician opening it for the first time will expect** — and the gap is mostly about *orientation*, not *content*. Below, answers to your six questions, in the order you asked.

### Q1: Would the doctor want anything from the Blue Button bundle?

**Yes — but not by default.** Two patterns that come up in real nexus drafting:

1. **The drafter cites a specific finding from the bulk record.** E.g. the PSG report is in the pack at full fidelity, but the AHI = 47 measurement was actually entered in a sleep-clinic progress note inside the Blue Button bundle on page 47. The doctor wants that page, not the whole bundle.
2. **The denial letter rebuts a finding that lives in the bulk record.** E.g. the rating decision says "VA found no evidence of in-service mental health treatment" — but page 312 of the Blue Button bundle has a 2003 mental hygiene clinic visit note. The doctor needs that page to challenge the decision.

**Recommendation:** add a `cited_bulk_pages` table or JSONB column that the drafter (or the RN doing chart prep) can append to. The manifest builder treats `bulk` documents as "exclude UNLESS they have a non-empty `cited_pages` set, in which case include just those pages." That preserves the "Blue Button is too big to show in full" principle while giving the doctor the surgical carve-out.

Wire this as a **Phase 7C** feature, not Phase 7B. Today, just leave a JSON column on `KeyDoc` like `cited_page_ranges JSONB DEFAULT '[]'` and have the manifest builder honor it. Zero behavior change for cases that don't use it.

### Q2: Sort order — importance vs chronological vs by-type?

**Keep importance-desc, but add a secondary type-group sort.** Here's the failure mode of pure importance: if the case has *two* rating decisions (initial 2021, supplemental 2023), they both sort at importance 100, alphabetically — meaning a doctor reading top-down sees them in filename order, not chronological order, and might miss that the 2023 decision *amended* the 2021 one.

Proposed sort key, in order:

1. `classification` (high_signal > normal > bulk).
2. `docType` group priority — the most-load-bearing types first. Roughly: `rating_decision` > `denial_letter` > `supplemental_decision` > `dd_214` > `dbq` > `c_and_p_exam` > everything else. This is what a doctor actually reads in order: "what does VA already say about this case → what's the service record → what's the clinical evidence."
3. Within the same docType, **chronological descending** (newest first). The 2023 supplemental beats the 2021 initial.
4. Tiebreaker: alphabetical filePath (the current fallback).

The current `selectKeyDocs` sort (high_signal → importance desc → filePath asc) gets you 80% there. The two missing pieces are the docType-group secondary sort and chronological-within-type tertiary sort. The classifier could expose a `docTypeGroupOrder` constant; chronological-within-type requires the document upload date or — better — a `documentDate` field on `Document` that the OCR worker fills in from extracted text. That's a Phase 7A worker artifact, not a 7B blocker.

### Q3: What's missing — should there be a cover sheet?

**Yes. This is the biggest gap.** Open the pack today and you get page 1 of a rating decision. No orientation, no chart summary, no "here's the claim, here's why we're writing the letter."

A physician drafting an OSA-secondary nexus needs to know, on page 1 of the pack:

- **Veteran identification block:** name, last 4 of SSN (for chart-match), branch, service dates, combat-vet flag, PACT-area flag, TERA-conceded flag.
- **Service-connected baseline:** every `ScCondition` row (condition, DC code, rating %, granted date). Without this the doctor can't reason about secondary-to-X framing.
- **Active problem list:** current diagnoses (`ActiveProblem`). This is where the doctor sees "yes, this veteran already has an OSA diagnosis on the books" without scrolling through PSG details.
- **Active medications:** with indications. CPAP / sertraline / trazodone all become evidence in an OSA-secondary case.
- **Prior VA findings on this claim:** the most recent rating decision's *operative paragraph* — what VA actually said about this condition. Pulled from `RatingDecision` doc-type if classified.
- **Framing decision + claim type:** "Secondary to PTSD" + "initial claim" so the doctor knows what regulation framework they're writing under.
- **Manifest table of contents:** "Doc 1: ClaimLetter pages 1-18, Doc 2: DD-214 pages 1-2, ..." so the doctor can jump.
- **Pack metadata:** generated_at, generated_by, engineVersion, page count, aboveTarget flag.

All of that data already exists in the DB. The Phase 7A worker should *generate* this as a synthetic page 1 of the assembled PDF — either a server-rendered HTML-to-PDF or a pdf-lib-built page. It's not a new database schema, just a new rendering step in the worker.

**Recommendation:** add a `coverPageJson` JSONB column to `DoctorPack` that the route computes at `/generate` time (so the data is captured even if the worker dies). The worker then renders it as page 1 of the assembled PDF. Cheap, deterministic, and makes the manifest debuggable from the DB.

### Q4: 80-page normal-tier cap — too aggressive?

**Probably fine for now, but the right default is per-case-tunable.** The cap exists to prevent a single 400-page clinical-notes bundle from drowning the pack. For most cases — where "normal-tier" is a single random clinical note — the cap never bites. For cases where it does bite, the doctor wants the cap *and* a "show me more" affordance.

Two concrete asks:

1. **Surface the cap in the manifest entry.** Right now `pageRanges: [{ from: 1, to: 80 }]` on a 200-page file looks identical to a 80-page file with no cap applied. Add an explicit `truncated: true` + `originalPageCount: 200` on the manifest entry so the cover page can say "Doc 6: clinical notes (showing first 80 of 200 pages — full file available in case docs)."
2. **Let the RN bump the cap per-doc** via the KeyDoc.notes or a new `manualPageRanges JSONB` column. If the RN sees that pages 80-120 contain the actual sleep-clinic visit, they can override.

But **don't drop the cap entirely.** 80 pages is roughly two doctor-attention-units. The discipline is good.

### Q5: What does the doctor do with `manifest_json` today?

**Today: nothing — it's only in the DB row.** The UI doesn't render it. The PDF doesn't include it. The physician would only see it by hitting the API directly.

The cover-page recommendation in Q3 is exactly the answer: render the manifest as a Table of Contents page at the front of the PDF. Format:

```
DOCTOR PACK MANIFEST
Generated 2026-05-25 14:23 by ops_staff_jane@frn.com
7 documents, 41 pages, engine version doctor-pack-1.0.0

1. records/ClaimLetter-2024-3-12.pdf  rating_decision      pp. 1-18  (18 pp)
2. records/DBQ-PTSD-2023.pdf          dbq                  pp. 1-8   (8 pp)
3. records/PSG-Sleep-Study-2024.pdf   sleep_study          pp. 1-4   (4 pp)
4. records/DD-214.pdf                 dd_214               pp. 1-2   (2 pp)
5. records/Audiogram-2024.pdf         audiogram            pp. 1-2   (2 pp)
6. records/Lay_Statement_Spouse.pdf   lay_statement        pp. 1     (1 pp)
7. records/random_old_report.pdf      unspecified          pp. 1-6   (6 pp)

EXCLUDED FROM PACK (below):
- records/Blue_Button_VA_Records.pdf  blue_button          412 pp    (bulk; not included)
```

Putting the **excluded list** in the manifest is just as important as the included list — it tells the doctor what *exists* on the case that they're not seeing, in case they want it.

Sidebar in the EMR UI is fine but secondary. The PDF is the thing the doctor opens; the manifest belongs there.

### Q6: Is "Doctor Pack as the input artifact" the right framing at all?

**Yes — but it shouldn't be the *only* input.** The framing is right because:

- A single PDF the doctor opens is a much better mental model than "browse a case folder of 12 documents and read them in some order."
- Pre-curated selection + ordering does cognitive work the doctor would otherwise do manually each case.
- Concatenated pages preserve the visual integrity (rating decision letterhead, DBQ form layout) — the FRN HARD RULE about "every inch in entirety" is satisfied.

The risks:

- If the classifier mis-classifies a load-bearing doc (e.g. a denial letter named `back_pages.pdf`), it falls to `normal/unspecified`, gets capped at 80 pages, and could miss the page the doctor needs to rebut. The content-hint pathway (Q5 of Lens 1) is the safety net here, but it isn't wired through yet.
- If the doctor needs to *cite* the source pages in the letter, "page 17 of the Doctor Pack" is the wrong citation — it's the Doctor Pack's internal page number, not the source PDF's. The manifest's `originalPageNumber` mapping has to flow through to the letter's citation layer eventually. Out of scope for Phase 7B but worth noting.

So: keep the framing. Layer in the cover sheet (Q3). Build the cited-pages-from-bulk carve-out (Q1) when the drafter starts citing into bulk. Expose the source-PDF page mapping when the citation layer needs it.

### Lens 2 recommendation

Ship the current pack assembly as Phase 7B-α. Add a cover-page renderer + manifest TOC before the first real case opens it. Defer the bulk-carve-out and chronological sort to Phase 7C.

---

## Top 3 changes before the first real case

In priority order:

1. **Fix the route's document query (CRITICAL).** Change `db.veteran.findUnique({...include: { documents: true }})` to `db.case.findUnique({...include: { documents: true }})` and add `pageCount Int?` to the `Document` model so the manifest's per-file cap is actually informed. Without this, the very first `POST /generate` against a real case crashes. — `backend/src/routes/doctor-pack.ts:78-91` + `backend/prisma/schema.prisma:267-286`.

2. **Add a partial unique index on `doctor_packs(case_id, case_version)` filtered to active states + corresponding 409 handling in the route (CRITICAL).** Today, double-clicking Generate creates two queued rows, two worker runs, two PDFs. The partial-unique pattern keeps historical rows for audit while serializing concurrent generation. — `backend/prisma/migrations/20260526050000_key_docs/migration.sql` (new migration) + `backend/src/routes/doctor-pack.ts:130-148`.

3. **Build a cover-page renderer + manifest TOC for the assembled PDF (IMPORTANT — Lens 2).** Compute the cover-page data (veteran block, SC conditions, problem list, medications, framing, manifest TOC, excluded-docs list) at `/generate` time and persist as `DoctorPack.coverPageJson`. The Phase 7A worker renders it as page 1. Without this the doctor opens 41 pages of evidence with no orientation. — `backend/src/services/doctor-pack.ts` (new `buildCoverPage` function) + `backend/prisma/schema.prisma` (`coverPageJson Json?` on DoctorPack) + worker rendering (Phase 7A).

---

**End of review.** Subsequent commits should reference this doc by path when addressing the findings.
