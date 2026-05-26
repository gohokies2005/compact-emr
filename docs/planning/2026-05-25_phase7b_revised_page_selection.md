# Phase 7B revised — Doctor Pack page-selection addendum

**Date:** 2026-05-25
**Author:** code-architect-qa (planning only, no code edits)
**Repo HEAD at planning:** `db58d9c docs(planning): end-to-end plan for cover-page + RN UI + OCR worker`
**Branch:** `main`
**Working dir:** `C:\Users\ryank\compact-emr-work`
**Supersedes:** Doctor Pack page-inclusion behavior described in `2026-05-25_phase7a_phase7b_coverpage_rn_ui_plan.md` (Build 1 §1.4 TOC entries, Build 3 §3.1 worker pdf-lib assembly). The original plan stands for everything else.

---

## Why this addendum exists

The Phase 7B Doctor Pack shipped at `7bb6ee3` / `37025ff` / `feb5f8e` includes **whole documents**, not pages. Concrete example: a typical rating decision is 18 pages; pages 1-5 are the actual decision (granted/denied, reasons & bases, evidence considered); pages 6-18 are appeal-rights boilerplate the physician does not need. The realistic PTSD→OSA pack target is ~12-18 pages, not 41.

The FRN HARD RULE [[feedback_denial_letters_full_text_hard_rule]] (Ricchezza 2026-05-17) applies to **AI context loading** — the chart parser and drafter must see full text so concessions like TERA aren't missed. It does NOT apply to the **physician-facing Doctor Pack**. These two consumers have opposite needs:

| Consumer            | Wants                                  | Why                                                |
|---------------------|----------------------------------------|----------------------------------------------------|
| AI context (parser/drafter) | Every word of every high-signal doc | Concession-miss is unfixable downstream             |
| Doctor Pack (physician)     | Only the meaningful pages           | Physician time is the binding constraint; appeal-rights boilerplate wastes it |

The shipped code conflated these. This addendum re-scopes the Doctor Pack to **page-selected** output. The AI-context HARD RULE is untouched.

---

## Architecture deltas (cross-cutting)

### Data model addition (NEW)

```
-- HYPOTHETICAL — not implemented in this doc
CREATE TABLE IF NOT EXISTS "document_pages" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "document_id"   UUID NOT NULL,
  "page_number"   INTEGER NOT NULL,
  "text"          TEXT NOT NULL,
  "confidence"    REAL,
  "extracted_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "document_pages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "document_pages_doc_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "document_pages_doc_page_uq" ON "document_pages"("document_id", "page_number");
CREATE INDEX "document_pages_doc_id_idx" ON "document_pages"("document_id");
```

Why a table instead of S3 prefix: per-page text is queried at page-selector runtime by `(documentId, pageNumber)` and again by the drafter when it cites pages. RDS join with the existing `Document` row is one SQL hop; S3 fan-out is N GETs per pack. The text is small (median page ≈ 2 KB; worst case 30 KB) and PostgreSQL TOAST compresses it transparently.

Indexed on `document_id` (filter), uniqued on `(document_id, page_number)` (idempotent upsert from worker).

### `KeyDocRecord.pageRanges` shape

Already `JSONB` array of `{ from: int, to: int }`. Multi-range per doc already supported by the schema (`db-types.ts` lines 421-434). No migration needed for the field; it just gets populated with more ranges than before. The doctor-pack manifest entry `pageCount` will be the sum of `(to - from + 1)` across all ranges.

### New service: `page-selector.ts` (Build 1)

```typescript
// hypothetical signature
interface PageSelectorInput {
  filePath: string;
  docType: KeyDocType;
  classification: KeyDocClassification;
  pageCount: number;
  pages: ReadonlyArray<{ pageNumber: number; text: string; confidence: number | null }>;
}
interface PageSelectorResult {
  pageRanges: ReadonlyArray<{ from: number; to: number }>;
  selectorRationale: string;       // for audit log
  needsRnReview: boolean;          // sparse-match fallback
  selectorVersion: string;         // 'page-selector-1.0.0'
}
function selectPages(input: PageSelectorInput): PageSelectorResult;
```

Pure function. Caller (the route handler or worker) loads the per-page text and passes it in. Per-doc-type rule set lives inside this module as a `Record<KeyDocType, RuleSpec>`.

Default rules (regex-only, deterministic):

| docType                       | Include pages where                                                  | Exclude pages where                                                                                  | Small-doc shortcut |
|-------------------------------|----------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|--------------------|
| rating_decision / denial_letter / supplemental_decision | `/decision/i`, `/reasons and bases/i`, `/service.connect(ion|ed)/i`, `/is (granted|denied|continued)/i`, `/evidence considered/i` | Pages dominated by `/how to (appeal|file)/i`, `/your rights/i`, `/notice of disagreement/i`, `/VA Form 9/i`, `/appellate review/i` | none — always select |
| dbq                           | Lines with `[X]`/`☒` (checked boxes), `/^signature/i`, `/diagnosis:/i`, `/findings:/i` | Pages with `<10` characters of non-form text (blank form pages)                                       | ≤2 pages → include all |
| c_and_p_exam                  | `/diagnosis/i`, `/medical opinion/i`, `/rationale/i`, `/medical history/i`, `/at least as likely as not/i` | `/claim(s|ant) information/i` headers, identifier-only pages                                          | ≤2 pages → include all |
| audiogram                     | all                                                                  | —                                                                                                    | always include all |
| sleep_study                   | `/impression/i`, `/AHI/i`, `/ODI/i`, `/summary/i`                    | raw waveform-only pages (heuristic: < 50 alpha chars)                                                | ≤2 pages → include all |
| pulmonary_function_test       | all                                                                  | —                                                                                                    | always include all |
| dd_214 / lay_statement / buddy_statement / statement_in_support | all                                                                  | —                                                                                                    | always include all |
| personnel_record / service_treatment_record_summary | Pages with MOS / deployment / decoration / in-service injury keywords (`/back|knee|head|exposure|blast|trauma|concuss/i`) | —                                                                                                    | ≤4 pages → include all |
| nexus_letter_prior / medical_opinion | all (already curated)                                                | —                                                                                                    | always include all |
| benefit_summary               | first 3 pages (these are summary-shaped; rest is noise)              | —                                                                                                    | n/a |
| tera_memo / individual_exposure_summary | all (high-signal narrow doc)                                         | —                                                                                                    | always include all |
| entrance_exam / separation_exam | all                                                                  | —                                                                                                    | always include all |
| progress_notes                | NONE by default (forward hook: drafter-cited pages only)             | —                                                                                                    | n/a |
| blue_button                   | NONE by default (forward hook: drafter-cited pages only)             | —                                                                                                    | n/a |
| unspecified                   | all if pageCount ≤ 8; first 8 pages otherwise; flag `needsRnReview=true` | —                                                                                                    | n/a |

`selectorRationale` records the matched/excluded keywords per page for audit replay; written into `KeyDocRecord.notes` (currently free-text) and surfaced on the cover-page TOC.

### Confidence-fallback rule (resolves open question)

When a high-signal doc (rating_decision, denial_letter, dbq, c_and_p_exam) gets **<2 page matches** across its entire body, fall back to **include all pages + set `needsRnReview=true`**. The selector cannot be wrong about "the decision is in here somewhere" for a doc the classifier marked high-signal; the risk model is: better to over-include 18 pages than to ship a pack missing the actual decision. The RN-review flag puts it in the queue for a human to read once and either narrow the range or confirm "all pages stay".

Synonyms list to widen matches before triggering fallback:
- "is granted" / "we have granted" / "we granted" / "service connection is established" / "service-connected" / "granted at" / "with an evaluation of"
- "is denied" / "we have denied" / "we are denying" / "service connection is denied" / "is not granted" / "we cannot grant"

### LLM-assisted page classification (resolves open question)

**No.** Page selection stays deterministic. Three reasons:

1. INGEST_OCR_SPEC §6 (CONTENT classification) already allows an LLM for **document-level** classification — that lane stays open. **Page-level** is a different bar: it runs per-page on every doc on every regenerate, ~50-100× more calls. Cost + latency unacceptable for what is fundamentally a keyword problem.
2. The `needsRnReview` fallback is the escape hatch. When deterministic rules can't find the decision page, the RN clears it — and once the RN clears one veteran's case, the pattern is teachable into the regex set (treat new failure modes as linter rules, not LLM fallback) [[feedback-every-decision-becomes-a-linter]].
3. Replayability: the same input must always produce the same page selection. LLMs at default temperature drift; that breaks the "regenerate produces identical output if chart is identical" property the assembler relies on for idempotency.

### Physician override (resolves open question)

YES — add `physicianIncludeAllPages BOOLEAN DEFAULT false` to `KeyDocRecord` as part of the Build 1 migration. UI surface (Build 2 RN/physician tooling, deferred): a checkbox on the per-file row in the Doctor Pack preview that flips the flag. When set, the page-selector returns `[{ from: 1, to: pageCount }]` regardless of rules and stamps `selectorRationale = 'physician_override'`.

Schema change is minor (one column, default false) so the existing key_docs migration class still applies — add a small follow-up migration `20260528000000_key_docs_physician_override`.

---

# Build 1 — REVISED

## Same as `db58d9c`
- Cover-page metadata stays nested under `DoctorPack.manifestJson.coverPage` (FFC-1 still applies).
- `engineVersion: 'cover-page-1.0.0'` stamping.
- Regenerate-on-every-`/generate` policy.
- New service `chart-summary-aggregator.ts` for the cover page itself.
- The 8 unit tests + integration test from the original plan remain.

## What changed
1. **New service `page-selector.ts`** (described above). Loaded by the assembler in Build 3 AND by Build 1's `assembleDoctorPackManifest()` once per-page text exists. Until Build 3 ships, page-selector receives empty `pages: []` for docs that haven't been OCR'd yet → falls back to the existing whole-document behavior (`{from:1, to:pageCount}`) AND stamps `needsRnReview=true`. This is the bridge that keeps Build 1 shippable without waiting on Build 3.
2. **`doctor-pack.ts` rework.** `selectKeyDocs()` no longer hard-codes `{ from: 1, to: includePages }`. It calls `selectPages()` with whatever per-page text is available (empty array is valid input). The `MAX_PAGES_PER_FILE = 80` cap is replaced by per-doc-type rule output; the cap moves into the rule set for the `unspecified` docType only (first 8 pages).
3. **Cover-page TOC entries** carry the rationale per file:
   ```json
   {
     "filename": "ClaimLetter_2023.pdf",
     "docType": "rating_decision",
     "pages": "1-3, 7-8",
     "totalIncluded": 5,
     "totalInDoc": 18,
     "rationale": "decision text on p1-3; granted-conditions table on p7-8; appeal-rights p4-6/9-18 excluded",
     "needsRnReview": false
   }
   ```
4. **`PACK_PAGE_TARGET = 250`** stays as a soft flag. With page-selection the realistic warm-target drops to **~50-80 pages** for a typical case — keep the 250 number for safety-net pathology cases (lots of small high-signal docs).

## Data model deltas (Build 1 ships with these)
- New migration `20260527000000_document_pages` — the `document_pages` table above.
- New migration `20260527010000_key_docs_physician_override` — adds `physician_include_all_pages BOOLEAN DEFAULT false NOT NULL` to `key_docs`.
- `KeyDocRecord` interface in `db-types.ts` extended with `physicianIncludeAllPages: boolean`.

## Service deltas
- NEW `page-selector.ts` with `selectPages()` + per-docType rule table + `SELECTOR_VERSION = 'page-selector-1.0.0'`.
- MOD `doctor-pack.ts`: `selectKeyDocs()` consumes optional `pagesByPath: Map<filePath, Page[]>`; defaults to empty map. Passes pages to `selectPages()`. Manifest entries carry `pageRanges[]` (already JSON array; just more entries).
- MOD `chart-summary-aggregator.ts`: the TOC builder reads `selectorRationale` + `needsRnReview` from each `SelectedKeyDoc` and emits them on the TOC.

## Worker deltas (preview of Build 3 impact, no code here)
Build 3's OCR worker MUST produce **per-page output** rather than whole-document `extractedText`. The Textract `StartDocumentTextDetection` job already returns per-page blocks; the worker just has to write a row to `document_pages` per page rather than concatenating into `Document.extractedText`. (The whole-document `Document.extractedText` field stays — it's still used by chart-parse-prompt for the AI-context HARD RULE. Both write paths fire in parallel.)

## Migration strategy for already-classified docs
Already-shipped Phase 7B is forward-compatible because:
- `pageRanges` schema is unchanged.
- `selectKeyDocs()` receiving an empty `pagesByPath` map yields the old whole-document behavior. Existing rows do not need to be deleted or re-classified.
- After Build 3 lands, the admin reprocess endpoint (`POST /api/v1/cases/:id/files/reprocess`, already in the original plan) re-runs the worker; on completion, `document_pages` rows exist; the next `POST /doctor-pack/generate` will produce page-selected output.

Recommendation: **do not roll back** `7bb6ee3` / `37025ff` / `feb5f8e`. They are forward-compatible. The Build 1 migration adds new tables/columns; the existing whole-document fallback prevents a regression in the gap between Build 1 shipping and Build 3 OCR'ing the first doc.

## Updated estimated time (Build 1)
- chart-summary-aggregator + tests: 2 h (unchanged)
- page-selector.ts service + per-docType rules + 24 unit tests (one per docType + edge cases): **3 h** (NEW)
- doctor-pack.ts rework + tests: 1 h (NEW)
- Two migrations + Prisma re-gen: 0.5 h (NEW)
- Architect QA: 1 h (up from 30 min — more surface)
- **Total: ~7.5 h, up from 2.5-3 h in the original plan.**

---

# Build 2 — UNCHANGED in scope

The RN UI is orthogonal to page selection. The RN reads the PDF as-is from S3, writes a manual_summary, and the chart-readiness gate clears. Page-selection is downstream of manual_summary (the worker reads the manual_summary text into `document_pages` as a single synthetic "page 1"). No change to Build 2 endpoints, contract, or UI brief.

Only delta: when Build 3 ships, the RN file-detail page should add a small "Page selection preview" panel (read-only) showing which pages of this file will land in the Doctor Pack. Document this as a Build 3-companion enhancement, not part of Build 2 itself.

Estimated time: unchanged (~4-5 h wall-clock).

---

# Build 3 — REVISED

## Same as `db58d9c`
- Python Lambda runtime decision.
- SQS + DLQ + retry semantics.
- Service-principal auth for worker → API write-back.
- WorkersStack CDK shape.
- IAM least-privilege.
- ECS Fargate fallback (FFC-3) for oversized packs.

## What changed
1. **OCR worker outputs per-page rows.** Instead of one `POST /internal/cases/:id/files/read-attempts` write with the whole-document `extractedText`, the worker does ONE call that batches the per-page extracts:
   ```
   POST /internal/cases/:id/files/document-pages
   { documentId, pages: [{ pageNumber, text, confidence }, ...] }
   ```
   API handler upserts on `(document_id, page_number)` inside a transaction; idempotent on retry. Existing `Document.extractedText` is set to `pages.map(p => p.text).join('\n\n')` in the same transaction so the AI-context HARD RULE consumer is unaffected.
2. **Assembler Lambda reads `document_pages` to choose pages.** The worker calls `GET /internal/cases/:id/doctor-pack/manifest` which now returns the page-selected manifest (computed server-side using `page-selector.ts`). The Python assembler iterates `manifest.entries`, extracts the page ranges via pypdf, concatenates, prepends the rendered cover page, uploads. **No page-selection logic lives in Python** — keep the deterministic selector in TypeScript where it ships with the schema and is unit-tested.
3. **`needsRnReview` propagation.** When the page-selector flags a doc, the assembler still includes the (whole-document fallback) pages but stamps the cover-page TOC entry with `⚠ RN review pending — full doc included as safety fallback`. Physician sees the flag; RN gets a queue item.

## Data model deltas (Build 3 adds)
- `Document.ocrCompletedAt` (already in original plan).
- `Document.textractJobId` (already in original plan).
- `KeyDoc.contentClassificationJson` (already in original plan).
- The `document_pages` table is created in Build 1's migration so the API endpoint exists before the worker writes to it.

## Service deltas
- NEW `POST /internal/cases/:id/files/document-pages` (worker writes per-page text).
- MOD `GET /api/v1/cases/:id/doctor-pack/manifest` returns page-selected manifest by loading `document_pages` and calling `selectPages()` per file.

## Worker deltas
- OCR worker: switch from `extractedText: string` to `pages: PageRow[]`. The Textract response already has `Page` blocks → group blocks by page number → concatenate per-page text → emit array.
- Tesseract fallback path: pdftoppm → per-page image → Tesseract → emit per-page text. (Worker spec INGEST_OCR_SPEC already does this per-page; just persist them that way.)
- Bedrock Data Automation (forward-spec): page-level invocation is native to BDA; no change.

## Migration strategy
1. Build 1 ships → `document_pages` table exists, `physician_include_all_pages` column exists, page-selector exists with empty-pages fallback. Doctor Pack output is unchanged for live cases.
2. Build 3 ships → worker writes `document_pages`. Existing cases reprocessed via admin endpoint. New `/generate` calls return page-selected output.
3. **Backfill window:** between Build 1 ship and "every active case reprocessed," some packs will be whole-document + `needsRnReview` flags everywhere. This is acceptable — it's strictly the same output as today.

## Updated estimated time (Build 3)
Add per-page output rework: +2 h (worker code + integration test). Total ~13 h, up from ~11 h.

---

# Revised sequencing decision tree

```
[Start]
   │
   ├─→ Build 1 (REVISED): cover-page + page-selector + document_pages table
   │     │
   │     ├─→ Architect QA — page-selector unit tests cover all 20 docType rules
   │     │   FFC-1 (cover-page payload size) still applies
   │     │   NEW FFC-4: if page-selector regex catalog grows past ~30 patterns or hit-rate
   │     │   on real-data slips below 90%, switch the high-signal docTypes to BDA-classification
   │     │   for page-level scoring (not the full LLM-fallback path — just the high-signal subset).
   │     │
   ├─→ Build 2 (UNCHANGED): RN UI
   │     │
   │     ├─→ Architect QA (cache invalidation, role gates) — same as original plan
   │     │
   ├─→ Build 3 (REVISED): OCR worker + assembler — per-page output
   │     │
   │     ├─→ Architect QA — verify per-page upsert is idempotent on retry
   │     │   FFC-2 (Textract latency) + FFC-3 (assembler 60s) still apply
   │     │
   └─→ Final pass — full pipeline run + memory updates
```

**Hard sequencing edges (REVISED):**
- Build 3 BLOCKED until Build 1 (because `document_pages` schema must exist before worker writes to it).
- Build 3 BLOCKED until Build 1's page-selector lands (the manifest endpoint depends on it).
- Build 1 ↔ Build 2 are still independent.

**No, Build 3 does NOT have to ship before Build 1 just because of per-page extraction.** Build 1's empty-pages fallback (deterministic whole-document selection with `needsRnReview=true` on every doc) is shippable on day one and gracefully upgrades to page-selected output once the worker fills `document_pages`. Build order is unchanged from the original plan.

---

# Memory persistence (additions to original plan)

Post-Build-3, anchor:
- **feedback_doctor_pack_page_selected_not_doc_selected.md** — Doctor Pack is page-selected (physician-facing). The "every inch" HARD RULE applies to AI context, not to the physician PDF. The two have opposite needs.
- **feedback_page_selector_deterministic_only.md** — Page selection is regex + per-docType rules, no LLM. Sparse-match falls back to whole-document + RN review queue, not to LLM scoring.
- **feedback_document_pages_table_canonical.md** — `document_pages` is the source of truth for per-page text. `Document.extractedText` is the concatenated mirror, kept in sync for AI-context consumers only.

If FFC-4 fires (regex catalog too large or hit-rate too low), write an INCIDENTS.md entry + switch high-signal subset to BDA page-level classification.
