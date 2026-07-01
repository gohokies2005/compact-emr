# INCIDENTS — compact-emr-work (Aegis EMR)

Postmortem log for the EMR/backend. One entry per incident: **symptom → root cause → fix → lesson**. Append
newest-first. Design/mechanism records that aren't a production failure stay in `ARCHITECTURE.md` (§6b live
mechanisms, §7 RETIRED/SUPERSEDED). Drafter-pipeline incidents live in the FRN repo's `INCIDENTS.md`.

---

## 2026-07-01 — SOAP Objective collapsed to BMI-only on a complete OSA chart (Foster)

- **Symptom.** Robert Foster (CLM-2E42C7CE67) has `Foster_OSA_Misc_4.pdf` = 1608 pages / ~2.46M chars
  containing verbatim `Sleep Study AHI:  36.3 (2023)` and `Sleep study 5/2018 - OSA, AHI 14.7/hr`, yet the
  SOAP note's Objective surfaced only BMI — the diagnostic severity index (AHI/RDI) the physician needs for an
  OSA nexus never appeared. Running the actual `buildDocumentDigest` on his 10 docs yielded `AHI present in
  digest? false`: the 1608-page bundle contributed only ONE floor page, not the AHI page.
- **Root cause — a data drop UPSTREAM of every fix that tried to catch it.** `buildDocumentDigest`
  (`backend/src/advisory/documentDigest.ts`) ranks pages by signal and caps spans at `TOTAL_DIGEST_CHARS`
  (8000) with a `PER_DOC_DIGEST_CHARS` (1200) per-doc ceiling. A 1608-page doc therefore contributes only its
  single highest-signal floor page; the AHI line, buried on a low-signal page deep in the bundle, never wins a
  span and never reaches the digest. The v29 severity fixes both live at the SOAP **consumer** layer
  (`soap-overview.ts`): `boundChartDigest` floats key study lines to the front *of the digest*, and
  `ensureSeverityMeasurements` re-injects AHI/RDI it finds *in the rendered context*. Both operate AFTER the
  drop, so they were starved by the same cap — they cannot recover a number that isn't in the digest.
- **Fix — at the layer that still holds the full page text (two-tier selection, round 2).** New opt-in
  `preserveSeverity` flag (default OFF → byte-identical) on `buildDocumentDigest`: a pre-pass scans ALL pages'
  full text and harvests a tagged/deduped/bounded block (`SEVERITY_RESERVE_CHARS`=600,
  `SEVERITY_LINE_MAX_CHARS`=220, `MAX_SEVERITY_LINES`=8), carves `severityUsed` off the total
  (`spanBudget = totalCap − severityUsed`), and renders it at the FRONT of the extracted-content section.
  **TIER 1 = a diagnostic READING** — a severity index ADJACENT to its numeric value (`SEVERITY_VALUE_RE`),
  deduped by value and sorted value-DESC (untreated readings beat low on-CPAP residuals). **TIER 2 = value-less
  study MENTIONS** (`SEVERITY_LINE_RE`, the broad exported SSOT: AHI/apnea-hypopnea/RDI/CPAP/SpO2/oxygen-desat/
  PSG/sleep-study + a digit) fill only if budget remains. Tier-1 is placed AHEAD of tier-2 before the caps, so
  a reading can never be starved by a mention. (Round 1 harvested first-come in page order with the broad gate
  alone → six value-less CPAP/date/sleep-hours mentions on early pages filled the reserve and rejected the real
  "AHI: 36.3" (p724) / "AHI 14.7" (p1150) diagnostic readings — the two-tier split is the correction.) Threaded
  via `buildDigestForCase(db, caseId,
  {preserveSeverity})` (`advisory/chartSlice.ts`); the ONLY opt-in caller is `assembleSoapContextForCase`
  (`services/soap-context-assembler.ts`) — Ask-Aegis / draft-readiness / case-viability omit it → unchanged.
  `soap-overview.ts` bumps `SOAP_NOTE_SCHEMA_VERSION` 29→30 (BMI-only cached notes recompute) and adds the
  `SOAP_OBJECTIVE_AHI_DROPPED` structured-warn canary (fires when ctx carries a severity index but neither
  `measurements[]` nor the Objective surfaced any severity token; never blocks; shares `SEVERITY_LINE_RE`).
  Anti-fabrication holds by construction — only VERBATIM label+number lines surface. Tests: documentDigest +3
  (>1M-char buried-AHI recover / no-severity byte-identical / tiny-budget still-surfaces) with all pre-existing
  byte-exact tests unchanged-green (documentDigest +4: >1M-char buried-AHI recover / no-severity byte-identical
  / tiny-budget still-surfaces / **value-reading-beats-value-less-mentions-on-earlier-pages** — the round-2
  regression that would have caught this); soap-* 103 green; tsc 0. The v29 consumer-layer fixes are moved to
  ARCHITECTURE.md §7 SUPERSEDED (`boundChartDigest` float now redundant; `ensureSeverityMeasurements` re-armed
  as the measurement-layer backstop now that the reading reaches ctx).
- **Lesson.** Fix a data drop at the layer that still holds the data, not at a consumer starved by the same
  cap. When a value goes missing, trace to the FIRST layer that discards it — a recovery bolted onto a
  downstream consumer will silently no-op whenever the upstream never handed the value down.
