# Doctor Pack + RN Queues — Full Assessment (2026-06-12)

**Ordered by Ryan after the first live pack proved unusable. Process: ground-truth code reads → simulated
PCP (nexus-letter physician) + simulated RN panel → architect root-cause/redesign review. Per item: what
it is, why it's broken, proposal, confidence, alternatives, and the panel verdicts on helpful / necessary
/ AI-reliable. NO fixes shipped from this document without Ryan's go.**

---

## 1. Doctor Pack content — "half of it is boilerplate, no clinical notes"

**PCP panel verdict (verbatim): "Unusable. I would not sign from it, full stop... You optimized for
'pages that mention service connection' and got the VA's marketing enclosures. You hard-excluded the one
format the diagnosis lives in."**

### Why it's broken (three confirmed root causes, file:line)
- **1a. Include rules are trigger-happy, excludes too narrow.** `page-selector.ts:81-82` includes any page
  matching `granted` / `denied` / `service-connect` — the VA "Additional Benefits" enclosures say those
  words on every page. The exclude list covers ONLY appeal-rights phrasing; there is no concept of
  benefits/crisis-line/fraud-box boilerplate. So the enclosures sail in.
- **1b. The diagnosis notes are .txt files and a PDF merger structurally cannot include them.**
  `handler.py` skips non-PDF sources. For Perez (anxiety case) the psych dx note IS the case — and it can
  never reach the pack. The PCP: *"A pack without the diagnosing note is never acceptable. Not ever."*
- **1c. No category budget.** `doctor-pack.ts:236` is a flat prefix-fill: protected docTypes
  (rating decisions, importance 100) fill all 20 pages before any clinical note is reached.

### What the doctor actually reads (PCP, ranked)
dx note 3-4pp (READ FIRST, refuses to sign without) → rating TABLE line 1-2pp (NOT the other 9 pages) →
primary-severity notes 3-4pp → denial "Reasons for Decision" narrative 2-3pp → veteran statement 1-2pp →
DD-214 1pp → lay statements 0-2pp. NEVER: benefits enclosures, appeal instructions, crisis-line pages,
fraud boxes, combined-rating math. Minimum bar to sign: dx note + SC-proof page + current-severity
evidence + timeline statement (~6-7pp floor).

### Proposal (build together behind one golden test)
1. **Boilerplate kill-list** (`BENEFITS_ENCLOSURE_PATTERNS`: additional benefits / mental health
   counseling / home loan / life insurance / crisis line / commissary / enclosure / what-you-should-know)
   that runs BEFORE includes and outranks them; demote bare `granted`/`denied` to a weak tier that only
   counts alongside a strong anchor (reasons-for-decision / entitlement-is / evaluation-assigned).
   *Confidence: medium alone, high paired with the include-tightening.* Deterministic regex — no LLM.
2. **Text→PDF rendering at manifest time, in the backend** using the EXISTING pdf-lib path
   (`memo-render.ts` — already deterministic, already a dependency): non-PDF manifest entries render
   their selected `document_pages.text` to labeled pages ("Rendered verbatim from <filename>, <date>")
   under `_rendered/` keys; the Python assembler stays PDF-only and dumb. PCP accepts rendered notes
   with verbatim + provenance-label conditions. *Confidence: high it works; medium on layout beauty
   (readable, not pixel-faithful — acceptable per PCP).* Alternatives rejected: fpdf2/reportlab vendored
   into the worker (second rendering stack to maintain), weasyprint (the already-fragile optional layer —
   never put load-bearing clinical content behind it).
3. **Category-budgeted selection with a CLINICAL FLOOR**: SC-proof ≤6 / denial rationale ≤4 /
   clinical dx ≥4 (guaranteed floor) / tests ≤3 / DD-214 1 / lay ≤2 — soft caps, priority eviction,
   floors filled first. *Confidence: high.* Note: fix 1a first and re-measure; part of the budget
   pressure is misincluded boilerplate.
4. **HARD GATE (PCP spec line 2): a pack without dx documentation for the claimed condition does not
   ship** — parks for RN with the reason, same fail-to-halt philosophy as Gate 2.
5. **Cover sheet lists omissions**: the `budgetTrim.trimNotes` data already exists and is persisted —
   render an "Excluded/trimmed: X because Y" section so the doctor knows what he is NOT seeing.
   *Confidence: high; near-free.*
6. **TOC bug found in passing**: the TOC prints raw S3 keys (`handler.py:178`) — switch to display names.

### How it got this broken (honest)
Selector + classifier were validated against synthetic filenames; the assembler that produces the actual
PDF had ZERO tests and had never executed until yesterday; nothing ever assembled an end-to-end pack from
a realistic document set. **First build step (architect): a $0 golden-pack fixture test** (realistic
bundle: enclosure-laden rating decision, .txt dx note, prior-nexus file, intake summary, blue button)
asserting: enclosures out, clinical floor met, nexus≠STR, no category eats the budget. Red→green proof
before any fix ships; the failure class stops regressing.

---

## 2. The "Doc selection review" queue — misclassified / shouldn't-exist rows

**RN panel: "If the same file shape lands in my queue twice in a week, that's not a queue item, that's a
bug report."**

### Why our OWN Intake_Summary.pdf shows as "unspecified"
**Stale rows.** The classifier DOES know it (`key-docs-classifier.ts:94`) — but that pattern + all content
classification shipped yesterday 06:06 (`21a5930`). Hatfield's rows were classified BEFORE that, persist
in the DB, and **nothing re-classifies stored rows when the classifier improves**. Fresh generations
classify correctly (Perez's rating decisions prove it). The queue is showing yesterday's debt.

### Other misfires, explained
- `Jr_AAD_Nexus.pdf → "Service treatment records"`: no `nexus_letter_prior` content pattern exists, and a
  nexus letter's body cites STRs, so the STR pattern wins. Two-line pattern fix + ordering.
- Blue Button: patterns exist (filename + "My HealtheVet" content) — clean ones in the queue = stale rows.
- DD-214 photo: image-only PDF + meaningless filename → correct fallback today; add the OCR-text pattern.

### Proposal
1. **Classifier-version stamp on KeyDoc rows + a backfill job**: re-run the (cheap, regex) classifier over
   every row with a stale version; update docType/needsRnReview in place; replicate the existing
   docTypeChanged ack-clearing so stale RN acknowledgements don't stick. *Confidence: high.* Rejected
   alternative: re-classify on queue read (surprising read-path mutation; backfill is auditable).
2. **Add the missing patterns** (nexus/IMO before STR in evaluation order; DD-214 certificate text).
3. **Never queue our own artifacts**: system-generated docs (intake summary) get their docType stamped at
   creation — no classification step at all (RN panel: "a system asking a human to review its own output
   is the purest waste in the building").

### Is the queue necessary at all? (panel answer)
Yes — but only for genuinely-ambiguous files (veteran-named miscellany where content classification ALSO
came up empty), at **single-digit volume per week**. Ask the cheap question first (6-button "what is
this?" type picker), the expensive page-picking question only after both classifiers fail.

---

## 3. File renaming — "Misc_5" should say what it is

**Proposal:** add a display label set post-classification — `Rating decision — 2024-03-12
(Jr_AAD_Misc_5.pdf)` — original filename kept in parens/tooltip for the audit trail. Rendered everywhere
(queues, doctor pack panel, the pack TOC). **S3 key rename rejected** (referenced by 5+ tables/paths;
churn with zero gain — display rename achieves the ask). *Confidence: high for the type label; medium for
the date* (VA letters carry multiple dates; anchored regex `date of this decision/notification` first,
flag as approximate). Deterministic.

---

## 4. Invoiced display — acknowledged miss, exact fix

Tonight's green chip was the wrong shape. **Fix per Ryan's words:** when a delivered case has been
invoiced, the STATUS LABEL ITSELF reads **"Invoiced"** in the same neutral slate format — no chip — on
BOTH the Cases list and the RN "Invoice + release" tab (which today shows no invoiced signal at all; its
badge source is `CaseStatusBadge`/`STATUS_TONES`). Centralized in one `caseDisplayLabel(status,
{invoiced})` helper so the two surfaces can't drift. *Confidence: high — trivial, seams fully mapped.*

---

## 5. Queue tabs — naming + existence

**RN panel:** keep the WORK separate (typing summaries = 5-15 min production work; confirming pages =
30-second QA) but at target single-digit volumes one merged "Files needing attention" inbox with reason
chips is fine. Names must describe the NURSE'S VERB, not the system's state:
- "Manual summary" → **"Can't read — type it"**
- "Doc selection review" → **"Confirm pack pages"**
Card redesign: first-page thumbnail, plain-English reason ("We couldn't tell what this document is. It's
short, so we put all of it in the doctor's pack. OK?"), one-click [That's fine] / [Tell us what it is →],
plus [Mark junk] on the unreadable queue. Internal codes never reach the screen. Merge vs rename = Ryan's
call (changes RN muscle memory); migration cost is low either way (frontend-only normalization).

---

## 6. Sign/edit lifecycle (RATIFIED by Ryan 2026-06-12 — build ticket)

Rules: redraft locks at send-to-doctor · "send back to RN" reopens · only the signed copy ships ·
post-review redraft/surgical edit ⇒ NEW version ⇒ doctor re-signs before ship · the signed PDF itself is
send-only forever.

**~80% already enforced** by existing machinery: the byte-hash delivery gate (`signed_bytes_changed`,
delivery.ts:222) + sign-off byte binding + version-on-every-edit + `delivered` not being editable +
tonight's `locked_physician_review` guard. **Gaps to build:**
- G1: lock REDRAFT (POST /draft) for ops_staff in physician_review (today it bypasses — was a deliberate
  2026-06-04 affordance, now reversed) and decide whether the physician's own edits stay open pre-sign
  (recommend: yes — they sign what they edited).
- G4 (the real gap): a post-sign surgical edit today leaves the case sitting in `delivered` with changed
  bytes until a delivery attempt 409s — it should TRANSITION the case back to physician review
  immediately, so the re-sign demand is proactive, not a delivery-time surprise.
- G2: make "signed" an explicit door-level guard (not only end-of-pipe), with tests.
Deterministic state-machine work; no LLM. *Confidence: high — the gaps are decisions, not unknowns.*

---

## 7. "Why are we still finding this near production" (honest, 3 bullets)

1. Filename heuristics shipped and were unit-tested against synthetic names; real veterans upload
   `Jr_AAD_Misc_5.pdf`. The content-classification path that handles reality landed yesterday.
2. The Python assembler — the thing that produces the actual artifact — had zero tests and had never
   executed end-to-end until a human opened a live pack.
3. Classifier upgrades never retrofit stored rows, so the installed base stayed wrong after the fix
   shipped.

**Standing fix: the golden-pack fixture harness (selection-layer in Vitest + assembly-layer test_handler.py
with a non-PDF entry + a stale-row/version-bump guard). $0, no AWS, would have caught every item above.**

---

## Build order (proposed, pending Ryan's go)
1. Golden-pack fixture test (red on today's behavior — the proof harness). 
2. Item 4 Invoiced label (trivial, Ryan-specified verbatim).
3. Item 2 classifier backfill + missing patterns + never-queue-own-artifacts.
4. Item 1: kill-list + include-tightening → text→PDF rendering → category budget + clinical floor +
   no-dx-no-ship gate → cover-sheet omissions + TOC names. Regenerate Perez + Hatfield packs as the live
   acceptance (PCP minimum bar: dx note + SC-proof + severity + timeline present).
5. Item 3 display labels; Item 5 queue rename/merge (after Ryan picks merge vs rename).
6. Item 6 lifecycle build (G1/G4/G2) — separate ticket, architect-planned.
