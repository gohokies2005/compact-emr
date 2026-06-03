# UI Brief — Draft progress indicator (Step N/6) + remove the CDS panel

Audience: ChatGPT (compact-EMR frontend). Two changes Ryan asked for 2026-06-03.

---

## 1. Replace the indeterminate "Drafting the letter…" dots with a real Step N/6 progress indicator

**Why:** the bouncing dots ("Started 1 second ago") give no sense of progress — Ryan can't tell if it's working or hung. He wants **"Step 3/6: Reviewing…"** style, strongly preferred over a timer or a vague bar.

**The data already exists.** While a draft runs, the drafter posts progress to the EMR, which stores on the **DraftJob**:
- `currentPhase` (string, the live pipeline phase, e.g. "PHASE 4: REVIEW PANEL")
- `manifestSnapshot` (the pipeline_manifest — an array/object of named phases, each with a status like pending/running/done/failed)
- plus, on finish: `operatorState` + `operatorMessage` (RN-facing), `grade`, `shipRecommendation`, `runComplete`

The "Drafting…" panel is already polling the draft-job status (that's how it shows "Started N seconds ago"). Keep polling (every ~3–5s) and render from these fields.

**Render:**
- A **determinate bar + "Step N of 6"** label. Derive N from the manifest: map the drafter's ~15 internal phases into **6 friendly buckets** (table below); N = the bucket the `currentPhase` falls in; the bar fills N/6.
- A **friendly label** per bucket (not the raw phase name): e.g. "Step 3 of 6 — Reviewing the draft".
- Keep a small **elapsed timer** ("running 4m 12s") as secondary text — typical run is ~10–20 min, so show "this usually takes 10–20 minutes" under the bar.
- If `operatorMessage` is present, show it verbatim (it's the RN-facing status/explanation).

**Phase → bucket map** (the drafter window will confirm/extend the canonical phase names; until then, match on the phase-name prefix, default to the nearest earlier bucket):
| Bucket (N/6) | Label | Matches drafter phases like |
|---|---|---|
| 1/6 | Reading the records | PHASE 0 (INDEX CONSULTATION), parsing, chart prep |
| 2/6 | Checking the claim | PHASE 0.4 (FRAMING GATE), viability, completeness |
| 3/6 | Writing the draft | PHASE 1–3 (drafting, citations) |
| 4/6 | Reviewing the draft | PHASE 4 (REVIEW PANEL / adversary / specialist) |
| 5/6 | Revising | PHASE 4.6 / surgical edit / convergence redraft |
| 6/6 | Grading & finalizing | grading, QA, render, complete |

**Robustness note (pass to the drafter window):** the cleanest long-term fix is for the drafter to send `stepIndex`/`stepTotal` (and a friendly `stepLabel`) in its `/progress` payload, so the UI shows it directly instead of name-matching. Until then, the manifest + the bucket map above is the source.

**Stuck handling (no false "hung"):** if `currentPhase` hasn't changed in ~3 min, OR `operatorState` indicates a hold/retry, show "still working — taking a little longer than usual" rather than implying failure. On finish, the panel resolves to the grade / the result (or, if it halted, the `operatorMessage`).

---

## 2. Remove the Clinical Decision Support (CDS) panel

**Why:** Ryan is retiring CDS from the workflow — the "Likely not supportable / no_diagnosis" verdict (often stale) confused more than it helped and was another error surface.

**Backend is already done:** the CDS route is flag-guarded off (`CDS_ENABLED` unset = off). The "Re-run CDS" button now returns `{ disabled: true, verdict: 'disabled', message: 'Clinical Decision Support is turned off.' }` and runs nothing. The engine code is kept intact — flipping `CDS_ENABLED=on` restores it.

**Frontend change:** **remove the entire "Clinical Decision Support" card** from the case page (the one with the verdict chip, "Re-run CDS" button, and the no_diagnosis box). Don't render it at all. (If you'd rather gate than delete: hide it whenever the CDS response is `{disabled:true}` or the case's `cdsVerdict` is `disabled`/`not_yet_run`.) It can be restored later alongside the backend flag if Ryan re-enables it.
