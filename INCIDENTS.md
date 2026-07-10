# INCIDENTS — compact-emr-work (Aegis EMR)

Postmortem log for the EMR/backend. One entry per incident: **symptom → root cause → fix → lesson**. Append
newest-first. Design/mechanism records that aren't a production failure stay in `ARCHITECTURE.md` (§6b live
mechanisms, §7 RETIRED/SUPERSEDED). Drafter-pipeline incidents live in the FRN repo's `INCIDENTS.md`.

---

## 2026-07-10 — Physician letter edit silently lost on a save-conflict (Conyers, CLM-44742B4040)

- **Symptom.** A physician typed a new line into the letter editor, clicked Save, could not sign (an unrelated modal scroll bug forced a refresh), and the edit was gone on reload. DB/S3 evidence: the case sat at `currentVersion=5` with NO v6 revision and the added phrase absent — the Save created no revision at all (and no orphaned v6 S3 artifact, so it was rejected BEFORE render, not a timeout).
- **Root cause — the editor's load-effect clobbers a DIRTY buffer, and `saveMutation.onError` deliberately triggers it on a 409.** `LetterEditorPage` loaded the editor on v4; a concurrent `surgical_ai` edit advanced the case to v5 (16:50) while the physician typed; his Save carried `base_version=4` → backend `stale_version` 409 (`letter.ts:531`, never reached the write). The FE `onError` set "Reloaded the latest version" and called `letterQuery.refetch()` → the `useEffect([letter])` unconditionally reset `txt`/`editedTextRef`/`baseVersion` → the typed text was destroyed, unrecoverable (a rejected save stores nothing server-side). Pre-existing since `3232909` (2026-06-24): the author documented the exact clobber in a comment but patched ONLY the RN-lock sub-case; every other 409 fell through. Second vector: `refetchOnWindowFocus` (react-query default true) could clobber a dirty buffer on alt-tab / modal-open before Save. NOT the 07-08 auto-regrade (`c6328a8`) — its grade write is best-effort outside the txn and cannot roll back a save.
- **Fix.** Never overwrite unsaved editor text. (1) The load-effect now dirty-guards (compares the buffer to the last-loaded text); a divergent buffer surfaces a conflict instead of clobbering. (2) `saveMutation.onError` on a conflict does a RAW `getLetter` (does NOT touch the query cache/effect) and opens a BLOCKING modal preserving the text with: **Save my changes as version N+1** (`resaveOntoLatestMutation` re-saves the preserved text with `base_version = latest`), **View latest** (read-only compare), **Discard** (only on explicit consent). (3) `letterQuery` gets `refetchOnWindowFocus:false`; (4) a `beforeunload` guard warns before a hard refresh drops unsaved text. RED→GREEN: the old "reloads on stale save" test now asserts preserve-and-conflict. FE tsc 0, full suite 711/711.
- **Lesson.** A `useEffect` that mirrors server data into an editable buffer MUST dirty-guard — any refetch (a 409 handler's, a focus-refetch, an invalidate) otherwise silently destroys unsaved input. Optimistic-concurrency 409s need a PRESERVE-and-merge-forward UX ("save onto latest"), never reload-and-clobber. When a comment says "must NOT be clobbered" but guards only one sub-case, the general case is a live bug.

## 2026-07-01 — Physician review showed "Letter ready · Grade A" AND "No current letter to approve" at once; sign-off null-bound (Hildreth, CLM-8EC828F1D7)

- **Symptom.** On `/p/review/CLM-8EC828F1D7` (Hildreth, OSA) the page rendered BOTH a hard amber blocker "Approve will be blocked — No current letter to approve" AND, below it, "Letter is ready for your review · Grade A" with a live Approve-and-sign — over a real letter (the automated draft crashed on `render_parity_mismatch` exit 7, was hand-edited, and forwarded). A physician would balk at signing.
- **Root cause — a guard/binding keyed on the PRE-recovery `Case.currentVersion` is silently broken by stranded-pointer recovery.** The review card reads the RECOVERY-capable `GET /letter` (`resolveCurrentForRead`: strict → DESC-walk → S3-truth) and found the forwarded letter; the `no_letter` blocker AND the approve route AND the sign-off byte-binding read the STRICT resolver pinned to `currentVersion`, which pointed at the dead halted version → null. So the blocker was truthfully predicting the approve 409 — approve was actually broken on a present letter (no-block-draft violation). This is the **2nd/3rd instance of the class** (cf. the Puller `resolveCurrentForEdit` self-heal and the `resolveViewableLetterJob` affordance fix): any existence GATE or byte-BINDING keyed on `currentVersion` before recovery is silently wrong on a stranded pointer — it must key on the RECOVERED base.
- **Fix.** One shared recovery resolver `resolveViewableCurrentTxtKey` is now the single existence signal for the read path, the `no_letter` blocker advisory, and the approve route (via `resolveCurrentForEdit`, which recovers + re-pins `currentVersion` and builds the signed final over the recovered base). The forward path (`POST /cases/:id/status → physician_review`) re-pins + materializes a `LetterRevision` at the source so no new strand forms. Two legal-safety must-fixes: (1) the external-import 409 guard re-checks against the RECOVERED version (else approve re-renders a placeholder-txt import → mangles the signed PDF); (2) the sign-off content hash binds via the recovery resolver (`resolveViewableCurrentTxtWithHash`) so a stranded-shown letter records a real `signedVersion`+`signedContentSha256` — otherwise the delivery `signed_bytes_changed` tamper tripwire is absent and egress fails open. The honest "Unverified — the automated draft did not finish" caution is kept; only the hard blocker/broken-approve/null-bind changed. Normal letters byte-identical.
- **Lesson.** When a read path learns stranded/recovery resolution, EVERY mutating gate and byte-binding that answers "which letter is current?" must be migrated to the same recovery resolver in lockstep — a strict `currentVersion`-pinned resolver left behind becomes a silent legal-safety hole (false "no letter" block, or a null-bound sign-off that disables tamper detection). Retire strict `resolveCurrentTxtKey` as an EXISTENCE/BINDING gate; keep it only for in-hash byte comparison where the version already resolves.

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
