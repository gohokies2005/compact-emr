# Aegis EMR — Architecture (the LIVE system)

> **This is the single maintained reference for how the live Aegis EMR is wired** (repo `compact-emr-work`,
> app at `emr.flatratenexus.com`). For the FRN drafter *internals* and the public website lane, see
> `flatratenexus-project/ARCHITECTURE.md` — this doc owns the EMR + the seam between them, and points there
> rather than duplicating drafter logic.
>
> **HARD RULE — update this file in the SAME commit** that adds/flips a flag, changes a model ID, adds or
> removes an AI brain, changes the case/data flow, or retires a design decision. A decision is not "done"
> until it's recorded here (especially in the **RETIRED / SUPERSEDED** log). Prose-only memory drifts; this
> file is the antidote. See `MEMORY.md` operating-defaults for the standing rule.
>
> **Last reviewed:** 2026-06-22 — body-quality holds are now advisory/editable AND forwardable: `/halt` preserves the produced draft (persists `artifactTxtS3Key` + advances `currentVersion`), `needs_rn_decision` is editor-editable, the new `needs_rn_decision → physician_review` edge lets the RN forward a hand-fixed letter (never a re-draft-only trap), sign-off still refuses parked cases (gates on answer content) (see §6b).

---

## 1. System flow (case lifecycle)

```
Intake (Jotform → webhook Lambda + hourly jotform-sweep backstop)
  → S3 raw docs (PHI bucket)
  → OCR / vision read  (per-page Sonnet vision worker; legacy Textract)  [worker, async]
  → chart-extract      (Anthropic Sonnet → structured facts, SC list, problems)  [Lambda, async]
  → viability route-picker  (deriveAiViability → Sonnet)  ← ONE BRAIN (card + Ask-Aegis + drafter framing)
                            computed OFF the request path (API Lambda async self-invoke) → persisted → card READS
  → drafter            (Fargate task, SQS FIFO draft-job, Opus)  [worker, async]
  → physician QA / sign-off  (review page, sign-off attestations)
  → render             (DOCX/PDF render Lambda)
  → deliver            (Stripe payment → token mint → Gmail/SES signed-PDF autodelivery)
```

AWS primitive per stage: **API** = monolithic Node/Express Lambda behind API Gateway (HTTP API, **hard 29s
cap** — see §6 latency rule). **Workers** = Lambdas (OCR, chart-extract, jotform-ingest/sweep, doctor-pack)
+ the **Fargate drafter** (scale-to-zero, SQS FIFO). **Store** = RDS Postgres 16 (+ pgvector for Ask-Aegis
corpus), S3 (PHI + artifacts). **Auth** = Cognito (TOTP MFA). **Secrets** = Secrets Manager (read by
FRIENDLY NAME, never partial-ARN — see INCIDENTS). Deploy = GH Actions → CDK (§6).

---

## 2. Data-model invariants (load-bearing)

- `cases.version` — optimistic-lock counter, `+1` on every PATCH / state transition.
- `claimedCondition` (primary) vs `claimedConditions[]` (the clustered set CDS/drafter read when non-empty).
  PATCH keeps them in sync on a single-condition claim (`routes/cases.ts`).
- **`ai_viability_plan_json` + `ai_viability_plan_hash`** (2026-06-19) — the persisted route-picker plan.
  `hash` = sha256 of the picker inputs (claimed, granted-SC, problems, events, guidance, veteran statement).
  Written hash-guarded by `deriveAiViability`; **NULLED on input-affecting PATCH** (`routes/cases.ts`
  `PLAN_INPUT_FIELDS`). The card reads/recomputes; Ask-Aegis narrates it (§4). Plan stamps `schemaVersion`
  + `inputClaimed` so a stale-shape / wrong-condition blob is refused, not mis-rendered.
- `caseViabilityBand` / `caseViabilityAnchor` — the older static viability snapshot (written only-when-null).
  Now superseded on the Overview by the route-picker plan (see §7).
- `framingStampSource` / `viabilityStampSource` / `cdsStampSource` — `'manual'` (staff-set, immutable to
  auto-refresh) vs `'derived'` (machine, restampable).
- DraftJob — SQS FIFO + heartbeat; never deploy the drafter mid-draft (queue must be idle).

---

## 3. The AI brains — which is LIVE, model, prompt canon

| Brain | Purpose | Provider / Model | Flag (current) | Prompt canon → vendored into EMR |
|---|---|---|---|---|
| Per-page vision OCR | read scanned/handwritten pages | Anthropic, Sonnet | `CLAUDE_VISION_SCANNED_PAGES` | worker |
| Chart-extract | structured chart facts, SC list, problems | Anthropic **direct**, Sonnet 4-6 | `CHART_AUTOFILL` / `CHART_EXTRACT_FULLREAD` | chart-extract Lambda (shares backend/src) |
| ↳ **Granted-SC authority (deterministic)** | the granted-SC anchor is NOT trusted to the stochastic LLM — `rating-decision-grants.ts` regex-parses every "service connection for X is granted [at N%]" recital and MERGES into the extractor's `raw` before grounding/dedup (Sonnet supplements, can't drop the anchor). 2026-06-20, 3rd recurrence fix; PROVEN 4/4 vs Sonnet 0/4 on Hackworth. | deterministic (no model) | always on | `backend/src/services/rating-decision-grants.ts` → chart-extract Lambda |
| **Viability route-picker** | card + Ask-Aegis grounding + drafter framing (ONE brain) | Anthropic, `claude-sonnet-4-6` (`AI_ROUTE_PICKER_MODEL`) | `AI_ROUTE_PICKER_ENABLED` = true | FRN `app/services/aiRoutePicker.js` → `backend/src/vendor/aiRoutePicker.cjs` (**sha-pinned** by `ai-route-picker-pin.test.ts`) |
| Drafter | the nexus letter | Anthropic, Opus | drafter image tag (cdk.json) | FRN `app/services/*` → Fargate ECR image |
| Ask-Aegis advisory | RN/physician case Q&A | **Bedrock**, Opus 4.6 | always on | FRN `app/config/advisory/rn_advisory_system_prompt.md` → `backend/src/advisory/systemPrompt.ts` |
| Opus sanity-impression | pre/post-draft gut-check | Anthropic, Opus | (cached per case+stage) | `backend/src/services/sanity-impression.ts` |
| **SOAP-note Overview** | the RN's calm AI-synthesized S/O/A/P lead on the Overview | Anthropic **direct**, Sonnet 4-6 (`SOAP_NOTE_MODEL`) | always on | `backend/src/services/soap-overview.ts` (`buildSoapNote`); POST `/cases/:id/soap-overview`. **Context is SERVER-derived** via `soap-context-assembler.ts` (`assembleSoapContextForCase`) for BOTH the async precompute and the sync read (write==read fingerprint, 2026-06-22) — the FE body no longer feeds the fingerprint. Coverage note uses the shared `loadExtractionCoverageForCase` (same % as the chart chip). |
| ↳ **Overview chip (verdict)** | the one go/no-go chip + the deterministic detail card | deterministic (no model) | always on | `frontend/src/lib/caseReadinessVerdict.ts`. The chip is a **PROJECTION of the route-picker band** (`routePickerBandToVerdict`) when a plan is ready; the deterministic engine is **fallback-only** (drives the chip only when `routePickerViability == null`) and can never contradict a ready plan (band-vs-core conflict → visible disagreement, not a flip). |

**⚠️ Auto-vendored prompt trap:** `systemPrompt.ts` and `aiRoutePicker.cjs` are GENERATED from the FRN source
(`vendor-advisory-prompt.cjs` / the anchor vendor copy). **Hand-edits to the vendored files are reverted on
the next vendor run.** Always edit the FRN canonical source, then re-vendor. The api-stack copies the whole
vendor tree to `<task>/anchor-vendor` at deploy.

**One brain, four surfaces (2026-06-19, chip added 2026-06-22):** the route-picker plan drives (a) the
Overview viability/SOAP card (`deriveAiViability`), (b) Ask-Aegis viability answers (narrated from the
PERSISTED plan — no second LLM call on the 29s path; `advisory/aiViabilityPlanBlock.ts`), (c) the drafter
framing gate, and (d) the **Overview verdict CHIP** (projected from the band via `routePickerBandToVerdict`,
so the chip can never contradict the SOAP note it sits above). The picker DECIDES; the card visualizes,
Ask-Aegis explains, the chip summarizes. Confidence is subordinated to confirmed chart gate elements (no
over-sell). Hard excludes (reverse-causation / pyramiding / wrong-direction) carry to all surfaces. The
chip→note agreement is pinned cross-module by `oneBrainChip.agreement.test.ts` (`routePickerBandToVerdict`
go/no-go === `soap-action-map.ts planViabilityToAction` go/no-go).

---

## 4. Flags (current state)

| Flag | Where | Default | OFF behavior |
|---|---|---|---|
| `AI_ROUTE_PICKER_ENABLED` | api + drafter | `true` | card → static viability; drafter → legacy framing gate |
| `EMR_CASE_VIABILITY_ENABLED` | api | `true` | no static viability snapshot stamp |
| `DIRECT_SC_VIABILITY_ENABLED` | api | `true` | secondary-only viability axis |
| `BRIDGE_ANCHOR_ENABLED` | api | `true` | — |
| `DRAFT_READINESS_GATE` | api | (verify in api-stack) | — |
| `DOCTOR_PACK_GROUNDED_PAGES` | api | `on` | ungrounded page select |
| `GUIDED_REVISION_ENABLED` | api | `true` | — |
| `ANCHOR_MECHANISM_GATE` | drafter | `true` | anchor candidates unfiltered |
| `DRAFTER_GATE2_ENABLED` | drafter | `true` | no pre-draft dx/event halt |
| `AEGIS_VIABILITY_GROUNDING` | advisory retrieve | **off** (unset) | legacy static viability facts block (off in prod) |

---

## 5. Latency rule (hard constraint — read before adding any LLM call to the API)

The API Lambda is behind API Gateway with a **hard 29s cap** (Lambda Timeout=29). Any synchronous LLM call
on a request path that runs past 29s **kills the function before its own catch/fail-open runs** → silent
failure (the SOAP "thinks for minutes then nothing" + the original double-call timeout). Rules:
- Never make TWO sequential LLM calls on one request (the SOAP card was fixed by sharing one query).
- Bound any single on-request Anthropic client to **timeout ≤ ~22s, maxRetries 0** so it fails-open LOUDLY
  inside the window (`deriveAiViability`).
- Prefer **compute-once-persist-then-read**: `deriveAiViability` short-circuits to the persisted plan when
  inputs are unchanged (no LLM on a cold Lambda); Ask-Aegis reads the persisted plan rather than recompute.
- **Async self-invoke pattern (the viability picker, 2026-06-19):** a compute that needs >~20s can't run on
  the synchronous request. The API Lambda invokes ITSELF (`InvocationType:'Event'`, event
  `{__recomputeViability,caseId}` handled in `placeholder-lambda.ts` before Express) — the fresh invocation
  owns the whole 29s window alone, so the picker runs at timeout 26s (vs the 22s sync cap) and completes +
  persists. The GET `/viability-card` is READ-ONLY (`deriveAiViability` `compute:false`): persisted plan or
  null, and fires the async compute on a miss. The FE polls until the plan lands. Needs `SELF_FUNCTION_NAME`
  env + `grantInvoke(self)` (api-stack). Reuse this pattern for any future >20s on-request compute.
- **Gap:** no CloudWatch alarm on API Lambda Errors / Duration≥29000 yet (silent-fail backstop — TODO).

---

## 6. Deploy mechanics

- Push to `main` → GH Actions (`deploy-staging.yml` / `deploy-prod.yml`) → `cdk deploy --all` + a dedicated
  **`compact-emr-staging-prisma-migrate-deploy` CodeBuild** (idempotent migrate runner, NOT raw
  `prisma migrate deploy` — tolerates the out-of-order timestamp).
- **Ordering note:** migrate CodeBuild currently runs *after* `cdk deploy` → a brief window of
  code-without-columns. Benign today only because every new-column read/write is fail-open. Reordering
  migrate-before-deploy for additive migrations is an open improvement.
- Drafter image: built from a CLEAN worktree, pushed to ECR, tag pinned in `infra/cdk.json`
  (`drafter_image_tag`); flip a drafter env flag via task-def re-register (runtime, no rebuild) — but a
  later `cdk deploy` converges it back unless baked into `drafter-stack.ts`.
- CI gates: `migrate:check`, `migrate:diff-check`, tsc, vitest.

---

## 6b. 🛡 DRAFT RELIABILITY MECHANISMS (2026-06-20 hardening — the "stop failing silently" pass)
- **BVA TURNED OFF FOR REAL + grounded citation fallback (2026-06-25, FRN drafter image `44b5d07-routepicker`).** Two drafter fixes in one cutover. (1) **BVA off in the framing brain:** the 739184f "BVA removal" only neutered the prose (`getBVAContext→''`); `framingGate.js` — the gate that actually PICKS the theory — was still loading `bva_secondary_pairs.json`, stamping a "BVA PAIR-LEVEL PRIORS" table into the prompt, defaulting to "secondary per atlas +20pt vs direct", and ranking anchors by Board grant rate. Proven on Wickel (CLM-EB5ABA7D79): a strong DIRECT in-service MDD case was drafted SECONDARY-to-tinnitus, its framing.json rejecting direct on "atlas-best 62% / shrunk_grant 65.4%". Now framingGate loads NO atlas, stamps NO Board stats, has NO secondary default; theory follows clinical evidence + the route-picker's prior; anchors ranked by real mechanism then rated_pct. `claude.js` `bvaLine` win-rate numbers neutered. (2) **Citation fallback fires on thin coverage:** `assessCoverage` fires the grounded NCBI retrieval when matched folders lack a mechanism anchor / <4 on-topic PMIDs (not only zero candidates — a loose broad-folder match no longer suppresses it); relaxed on-topic gate + per-mechanism A3 cascade; advisory §VIII PMID floor (fail-open). c0 record-mode grade **A** ($7.78). MORNING DECISION owed to Ryan: flip `AI_ROUTE_PICKER_ENABLED=true` (task-def env, no rebuild) to make framing DEFER to the route-picker = one brain (task #72) + deterministic Wickel fix.
- **NO HARD FAILS — fixable body-quality residuals COMPLETE as editable advisories, not parks (2026-06-24, FRN drafter image `30e1a43-routepicker`; Ryan "no hard fails unless wrong-vet-obvious; lean advisory").** Supersedes the blanket body-quality park below. The FRN `draftBodyQualityGate.terminalDispositionFor()` now splits a residual material finding (one that survived self-heal) 3 ways: a true **HARD-STOP** — ONLY `letter_self_undercut` or a load-bearing fabricated PMID — keeps the `/halt` park (reasonCode stays `verify_error`) with an explicit *"do NOT send; re-run once; if it recurs contact Dr. Kasky"* script; **everything else COMPLETES** via a normal `/complete` (`operatorState:'ready_with_notes'`, `runComplete:true`) with the findings folded into `gradeSidecar.targeted_revision_hints` and `ship_recommendation:'revise'` (real grade kept — a non-empty hints list already forces `shipAsIs=false` in the UI). The case lands in `rn_review` (editable + forwardable via `PhysicianLetterReadyPanel`, which renders the grade chip + top-3 hints) — never a dead park. `render_parity`: a COSMETIC divergence (whitespace/punct/ligature only, similarity≥0.995, `renderParity.isCosmeticDivergence`) is no longer `fail(7)` — it completes with a no-penalty PDF-formatting advisory; a real content divergence still fails closed. No EMR-side change was needed (the rn_review surface already reads `gradeSidecarJson.targeted_revision_hints`). c0 record-mode grade A- (no content change). The `/halt` `body_quality_critical` path below is retained for the rare hard-stop but is now seldom hit.
- **Granted-SC = deterministic authority** (see §6 chart-extract row): the load-bearing anchor never depends on the LLM alone. `rating-decision-grants.ts`. History: [[project_chart_extraction_method_history]] — Sonnet STILL reads the whole chart (A/B winner); this is a narrow deterministic FLOOR under one templated field, NOT a revert.
- **Stale-extraction auto-refresh** (`EXTRACTOR_VERSION` in `chart-build-state.ts`): a chart-extract code fix only helps NEW runs, and the reprocess cost-safety gate used to skip re-extraction whenever the DOC set was unchanged (`already_extracted_no_changes`) — so a deployed fix never reached open cases (the Hackworth trap). Now: each run stamps `resultJson.extractorVersion`; the reprocess gate treats a run from an OLDER version as STALE → re-extracts. **BUMP `EXTRACTOR_VERSION` on every chart-extract logic change.** NOT folded into `computeTriggerHash` (that would wedge every case at 'extracting'). Currently v2 = deterministic grant authority.
- **No silent draft failures** (`pipelinePhase.summarizeForOperator`): a paused draft now names the specific failed phase + its recorded reason (PHASE_PLAIN map) as the `operatorMessage`, instead of the generic "we've paused this for a closer look" that hid ~14 distinct failures as one. The manifest already recorded the reason; it was being discarded. (Deploys with the drafter image.)
- **Render glyph-fold** (`foldRenderable.js`): PDFKit can't render non-CP-1252 glyphs (ș, ≥) → corrupt PDF → render_parity_mismatch on an A-grade letter. Fold to ASCII at every PDF sink + persisted txt. Live (drafter + render image `0fa7a8b`).
- **Body-quality park** (2026-06-21, `routes/drafter.ts` `/halt`): the FRN cloud drafter SKIPS the full publish linter (no `claims` table in Fargate), so ~40 body linters never gated → editorial-meta / fabricated-PMID / dual-prong-missing / SSN-PHI / locked-block / Section III list-format leaks reached the physician. The FRN `draftBodyQualityGate` now PARKS such a (fully-drafted) letter via the EMR `/halt` callback. The `/halt` receiver allowlists `body_quality_critical` (maps to case `needs_rn_decision` + draft_decision `pause`/item `body_quality` — mirrors `verify_error` but labeled honestly, so the chart Decisions log doesn't read as a dx hold). **Detection is dual:** `reasonCode === 'body_quality_critical'` OR `haltGate === 'body_quality'` — because the FRN side currently still emits the allowlisted `verify_error` with `haltGate:'body_quality'` until its drafter image redeploys; BOTH are accepted (`isBodyQualityHalt` in `frontend/src/types/prisma.ts`). The full payload (incl. `materialIds[]` / forthcoming `material[{id,section,detail}]`) persists in `DraftJob.haltPayloadJson`. Cross-repo follow-up owed FRN-side: emit the dedicated `body_quality_critical` code + richer `material` rows once the drafter image redeploys.
  - **HOLDS ARE ADVISORY + EDITABLE, not re-draft-only (2026-06-22, option A — no FRN change):** a body-quality park is the ONE halt class where a FULL letter WAS produced. The FRN drafter does not POST an artifact key on `/halt`, so the `/halt` receiver (`routes/drafter.ts`) RECONSTRUCTS the canonical key `drafter-artifacts/<caseId>/v<N>/v<N>.txt`, validates it (`isDrafterArtifactS3Key`), and **HeadObject-checks it via the injected S3 client**. ONLY when the object actually exists does it (a) persist `DraftJob.artifactTxtS3Key` and (b) **advance `Case.currentVersion` to the halted version** — so `resolveCurrentTxtKey` (DraftJob fallback) + `getLetter` reach the held letter, and the RN can open + fix it in the full editor. When the object is ABSENT — every dx/event verification hold, OR S3/bucket unconfigured — NOTHING about version/key changes: the case stays no-draft so the dx-halt confirm/halt panel is untouched. **Fail-SAFE default: never advance `currentVersion` onto a draft we cannot prove exists.** Gated by the pure classifier `haltShouldCarryDraft(reasonCode, haltGate)` (= `isBodyQualityHalt`'s server twin). Pinned by `backend .../halt-preserves-draft.test.ts` (5 cells) + `halt-classifier.test.ts`.
  - **`needs_rn_decision` is in `EDITABLE_STATUSES`** (`routes/letter.ts`) so the held letter opens + saves in the editor (a hand-fix is cheaper than a ~$15 re-draft). `needs_records` stays OUT (no draft by definition).
  - **§VII OPINION EDITING — physician-only, narrowed holding lock (2026-06-24, Puller; `routes/letter.ts` + `services/letter-opinion-excerpt.ts`).** The old lock froze the ENTIRE Section VII opinion sentence, so a physician couldn't even rephrase causation→aggravation (it 422'd `holding_changed`). Now: (a) the AI-edit lock (`holdingConclusionWeakened`, replaces `holdingChanged` at the surgical-APPLY + guided-PROPOSE call sites) blocks ONLY a weakening/removal of the probability conclusion — a 3-tier strength ordinal STRONG("more likely than not"/>50%) > EQUIPOISE("at least as likely as not") > BELOW; ANY downgrade or removal → 422, but a causal-verb change at equal strength is ALLOWED; (b) a **physician-only role gate** (`sectionViiChanged` → 403 `section_vii_physician_only`, "Section VII can only be edited by a physician; pass edits in a message when submitting for review") fires on ALL THREE edit paths (PUT save, surgical apply, guided propose) and ONLY when §VII content actually changed — `ops_staff`/RN edits to other sections are untouched; (c) the AI proposer prompt (`letter-surgical-propose.ts`) now permits a causation↔aggravation / primary↔secondary rephrase on instruction while keeping the ">50%" conclusion + CFR cite word-for-word. A true theory swap (primary↔secondary across §III/§VI) is still a re-draft, not a surgical edit. Pinned by `letter-holding-lock.test.ts` + `letter-routes.test.ts`. EMR-only (no drafter rebuild).
  - **SAFETY companion — sign-off refuses a parked case:** advancing `currentVersion` onto a held-for-defect letter makes it byte-bindable, and `routes/sign-offs.ts` had NO case-status guard. It now **409s any sign-off while `status ∈ {needs_rn_decision, needs_records}`** (reason `case_parked`) so a physician can never sign a parked-for-defect letter; resolve the hold (fix → `physician_review`) first. Pinned by `sign-offs-routes.test.ts`. (Delivery/approve were already status-gated to `{delivered, paid}` / valid transitions; the status CHIP is driven by `case.status` not `currentVersion`, so a parked case still reads "Needs RN decision".)
  - **FORWARD DOOR — a hold is a SOFT caution, never a trap (2026-06-22, Ryan "see, edit, FORWARDED"):** a held letter the RN fixes by hand must be able to move RN → physician → sign → deliver. Editing via `PUT /letter` creates a new version but does NOT change status, so the park needed an explicit forward edge. `case-status-transitions.ts` now allows **`needs_rn_decision → physician_review`** (role: the default admin/ops_staff — identical to the canonical `rn_review → physician_review` "send to doctor" hop), and `routes/cases.ts` mirrors the **assigned-physician guard** onto it (no unassigned doctor's queue). `needs_records` gets NO such edge (it never produced a draft). The `BodyQualityHoldCard` surfaces a **"Send to doctor for review"** action (shown only when a produced draft exists) that drives this edge. This is the human path the sign-off `case_parked` 409 already instructed ("fix → physician_review") — now wired end-to-end. The truthful-attestation safety is untouched: sign-off still demands honest answers (it gates on ANSWER CONTENT at the doctor, never on blocking forward progress). Pinned by `case-status-transitions.test.ts` + `cases-routes.test.ts` (200 + no-physician 409) + `BodyQualityHoldCard.test.tsx`.
  - **RN UI:** the `BodyQualityHoldCard` (`Gate2HaltPanel` branch) is now **three actions** when a draft exists — **"Open letter editor"** (advisory amber lead) + **"Send to doctor for review"** (the forward door) + re-draft (secondary); with no draft it is re-draft only. The `drafting`-status interrupted card (`OpsHeldPanel`) drops the misleading hardcoded "Drafting was interrupted" headline for honest copy, and its produced-letter affordance routes to the **editor**, not the read-only PDF (the real reason still renders from `summarizeForOperator`'s `operatorMessage`). Both wired from `CaseDetailPage` via `onOpenEditor → navigate('/cases/:id/letter')`.
  - **PLAIN-LANGUAGE HALT SUMMARY (2026-06-24, Ryan "no codish errors — give me a checklist + a conditional grade + the specific fix"):** the pure helper `frontend/src/lib/draftHaltSummary.ts` (`buildDraftHaltSummary`) turns the already-persisted `DraftJob.manifestSnapshot.phases` + `gradeSidecarJson` into an RN-readable block rendered by `OpsHeldPanel`: a **conditional grade chip** (`Grade: B+ — ready to ship` vs `fix N first`, `(provisional)` when the grade is a synthesized floor), a **6-stage checklist** (17 pipeline phases collapsed to *Wrote the draft / Specialist review panel / Automatic fixes / Quality checks / Graded the letter / Final formatting check* with ✓/✗/○ and the stage where it stopped), a **plain reason** per stopped stage (`plainPhaseReason` — NEVER surfaces a rule_id/stack/`{}`/`threw`/`request_id`; falls back to a per-phase sentence), a **"Fix before sending"** list (normalized `targeted_revision_hints`), and a **single next-action** line. grade/ship are read from `gradeSidecarJson` at runtime (the whole qa_grade object persists there even though its narrow DB type only declares the hints; loose `GradeSidecarLike` makes it assignable). **SAFETY GATE — `summary.shipAsIs`** is the ONE flag the UI keys "ready to ship" on: true ONLY when the halt is purely cosmetic on a ship-grade letter (`crashedPhase ∈ {render,render_parity} && ship==='ship'`) **OR** the run finished clean (no stopped stage) AND the grade is real (not a synthesized floor) AND ship-recommended AND zero fixes. A substantive crash or a floor grade is ALWAYS `shipAsIs:false` — it can never wear the all-good face even if an earlier grader stamped `ship` before a later crash (the leak a 2-agent QA pass caught: door must not trust `ship` in isolation). Pinned by `frontend/src/__tests__/draftHaltSummary.test.ts` (incl. 3 SAFETY cases: floor-grade-with-ship, substantive-crash-with-empty-fixlist, cosmetic-is-the-one-allowed). Pure/presentation-only — no pipeline, gate, or data-flow change.

## 7. 🗄 RETIRED / SUPERSEDED log (append-only — so dropped decisions don't resurface)

| Date | What | Why retired | Replaced by |
|---|---|---|---|
| 2026-06-19 | **Static M/E (mechanism/evidence) anchor ratings on the Overview card** ("M=4,E=2") | brittle static table, didn't match drafter judgment | the **AI route-picker** (`deriveAiViability`) — one brain for card + drafter + Ask-Aegis |
| 2026-06-19 | The `/cases/:id/soap-overview` 2nd-LLM-call endpoint | 29s timeout silent-fail | SOAP card renders deterministically from the shared `viability-card` query (one LLM call) |
| 2026-06-19 | Synchronous picker compute on GET `/viability-card` | ~22-25s call can't fit the 29s cap → silent fail | async self-invoke compute off the request path + persisted-plan read (see §5) |
| 2026-06-20 | Deterministic string-assembled SOAP "note" on the Overview card | read like a dump (S echoed in A, O = a wall of every SC condition) | AI-synthesized SOAP note (`buildSoapNote`, Sonnet) — smooth S/O/A/P; the deterministic verdict stays the fail-open fallback |
| 2026-06-22 | **`caseReadinessVerdict` (deterministic engine) OWNING the Overview chip** | the chip ("Not supportable") could CONTRADICT the SOAP note's Assessment/Plan ("supportable / proceed to draft") — two brains on one card | **the chip is now a PROJECTION of the AI route-picker viability band** (`routePickerBandToVerdict`, ONE brain — same plan the SOAP renders + the drafter pleads). The deterministic engine is DEMOTED to **fallback-only**: it drives the chip ONLY when there is no ready route-picker plan (flag off / cold / error, i.e. `routePickerViability == null`) and can never contradict a ready plan. When the band says supportable but the deterministic core would Stop, the band WINS the headline and the core's concern is surfaced as a VISIBLE `band_vs_deterministic` disagreement (no silent flip). `routePickerBandToVerdict` must agree band-for-band on go/no-go with `soap-action-map.ts planViabilityToAction` (pinned by `frontend .../oneBrainChip.agreement.test.ts`). |
| 2026-06-22 | SOAP sync read building its `SoapContext` from the FE-POSTed body on the ungrounded branch | the sync-read fingerprint then differed from the async precompute's (which uses the assembler) → the precomputed note was NEVER found → permanent fallback note on every open (incl. hard refresh) | **BOTH sync branches build ctx via `assembleSoapContextForCase` (server-derived only; FE body no longer feeds the fingerprint)**, so write==read and the precomputed note serves for $0. `precomputeSoapNoteForCase` now also persists an UNGROUNDED note (framing=null) so cold cases have a served note. `SOAP_NOTE_SCHEMA_VERSION` 25→26 (pre-fix stored notes invalidate). |
| 2026-06-22 | SOAP coverage note computing coverage with EMPTY file-read-statuses | every page counted as unread → SOAP Objective said "0% of pages read" while the chart chip read 100% (two readers of one report disagreed) | **one shared `loadExtractionCoverageForCase(db, caseId)`** (in `extraction-coverage.ts`) used by BOTH GET `/cases/:id/extraction-coverage` AND the SOAP assembler — identical inputs (real `file_read_status` rows via `isEffectivelyRead` + latest run + per-page provenance), so coverage can never drift. |
| 2026-06-23 | The chart-extraction card's single "Chart extraction: 100% Complete" headline | it CONFLATED two phases — OCR ("pages read") and the SEMANTIC extract ("chart analysis") — so a chart whose pages were all OCR'd but whose analysis FAILED/was-interrupted read as "100% Complete", hiding a failed analysis that the SOAP verdict was then built on | **TWO-STAGE coverage SSOT** in `extraction-coverage.ts` (`ExtractionCoverage.pagesRead` + `.chartAnalysis`, both derived from the same fields): the card renders two plain-English lines ("Pages read: 100% (28 of 28)" / "Chart analysis: ✓ Complete (N findings)" \| "⚠ didn't finish — retry"), and the SOAP Overview reads `chartAnalysis.state` — when not `complete` it shows a PROMINENT top banner (names the likely-cause large file) and renders the verdict as **provisional**, never a confident conclusion on an empty/partial chart. One object feeds card + banner so they can't disagree. The FE card is DEFENSIVE (derives the two stages from `status`/`coveragePct` when an older payload lacks them). |
| 2026-06-23 | Editor `WarningList` surfacing all save-time sanity findings + `meta_canonical` bare-word `/\bcanonical\b/` leak rule | the RN saw cosmetic style lines (em-dash/jargon/sentence-variance/banned-word) on every save → trained to ignore the panel; `meta_canonical` false-positived on legit "canonical mechanism/pathway" medical prose | **WarningList keeps only meaningful rules** (`placeholder_token_introduced`, `locked_block_corrupted`; editorial/meta leaks stay surfaced via the separate non-blocking `letter.leaks` block). **`meta_canonical` tightened** to fire only when "canonical" modifies an editing object (`canonical (Section <roman> )?(format\|template\|language\|structure\|…)`) — the directive shape of the real Apolito/Zodrow leaks, which the conditional/locked-template/restructure rules independently still catch. |
| 2026-06-23 | The two-stage honesty layer above was COSMETIC-only: the SOAP banner + "(provisional)" label changed, but the VERDICT itself stayed confident on a failed/incomplete analysis, and a brand-new/empty case (no run yet) cry-wolfed "didn't finish" | a physician could still read a confident "Not supportable" built on an empty chart (the Herman harm), and new cases falsely alarmed | **(1)** `ChartAnalysisState` gains **`not_analyzed`** — runStatus `null` or zero chart inputs → resting state, NOT `incomplete`; never fires the banner/provisional/cause-file. `likelyCauseFile` gated to `failed`/`incomplete` only. SSOT invariant enforced (a `status==='complete'` object may carry only `complete`/`not_analyzed`; the builder throws otherwise). **(2)** `caseReadinessVerdict` now feeds `chartAnalysisState` into the VERDICT: `failed` → suppresses the directional text, renders the new `analysis_failed` verdict ("re-run to assess"); `incomplete`/`in_progress` → downgrades a directional/negative verdict to `read_chart_first` + lowers confidence; **FAIL-SAFE** — when the coverage query is loading/errored (state unknown, parent sets `chartAnalysisUnknown`) the verdict goes provisional, never confident. A found bridge route is never clobbered. **(3)** whole-file gaps (`unread`/`needs_manual_summary`) also raise the provisional banner. **(4)** banner restyled LOUDER than ambient amber (red/orange 6px rule + ring + filled "!" chip). **(5)** `meta_canonical` widened to allow ≤2 (incl. hyphenated/comma'd) intervening words so "canonical letter format"/"canonical, well-recognized format" are caught while mechanism/pathway/presentation still pass. |

### OWED (Ryan-approved, 2026-06-20 — see handoff `20260620_soap_note_ai_synthesis_and_deploy_blocker.md`)
- **Precompute the SOAP note on chart-extract FINISH** so it's ready when the chart opens (no 10-15s wait) —
  fire at the tail of the internal-worker merge handler via the async self-invoke pattern; persist; chart-open
  POST stays the backstop.
- **Anti-confabulation guards**: a deterministic number/measurement/date verifier (every value in the note
  must trace to the source facts) + a cheap short second LLM grounding pass (async, fail-open). These GATE
  collapsing the dense panels.
- **Collapse the dense panels** (Background & argument / Anchor viability / Recommended plan) behind a
  "View details ▾" toggle once the guards are in; keep them as the API-down fallback.
| 2026-06-16 | Textract-only OCR as the primary scanned-page reader | dropped combo-page handwriting (false "100% read") | per-page Sonnet vision worker + honest per-page coverage |
| (legacy) | Local Node/SQLite dashboard as production EMR | moved to AWS | this EMR (`compact-emr-work`); localhost retains only the inbound Gmail poller |

> When you retire a design, ADD A ROW here in the same commit. Include any dead code still in the tree.

---

## 8. Maintenance

- **Same-commit rule** (above) — enforced socially now; a pre-commit/END linter that fails when a diff
  touches `_ENABLED|_MODEL|claude-|new Anthropic|schemaVersion` without staging this file is a TODO.
- **Staleness:** re-review when a brain/flag/flow changes; refresh the "Last reviewed" line + commit.
- Cross-links: FRN `ARCHITECTURE.md` (drafter internals, website, Stripe/Gmail/R2 chains), `DEPLOY.md`
  (CDK stacks + deploy commands), `INCIDENTS.md` (postmortems — Secrets partial-ARN, Jotform TZ, NUL-byte).
