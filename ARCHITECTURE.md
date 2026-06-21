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
> **Last reviewed:** 2026-06-21 — body-quality park `/halt` reasonCode + RN "Quality hold" card (see §6b).

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
| **SOAP-note Overview** | the RN's calm AI-synthesized S/O/A/P lead on the Overview | Anthropic **direct**, Sonnet 4-6 (`SOAP_NOTE_MODEL`) | always on | `backend/src/services/soap-overview.ts` (`buildSoapNote`); POST `/cases/:id/soap-overview` (FE posts the assembled context) |

**⚠️ Auto-vendored prompt trap:** `systemPrompt.ts` and `aiRoutePicker.cjs` are GENERATED from the FRN source
(`vendor-advisory-prompt.cjs` / the anchor vendor copy). **Hand-edits to the vendored files are reverted on
the next vendor run.** Always edit the FRN canonical source, then re-vendor. The api-stack copies the whole
vendor tree to `<task>/anchor-vendor` at deploy.

**One brain, three surfaces (2026-06-19):** the route-picker plan drives (a) the Overview viability/SOAP
card (`deriveAiViability`), (b) Ask-Aegis viability answers (narrated from the PERSISTED plan — no second LLM
call on the 29s path; `advisory/aiViabilityPlanBlock.ts`), and (c) the drafter framing gate. The picker
DECIDES; the card visualizes and Ask-Aegis explains. Confidence is subordinated to confirmed chart gate
elements (no over-sell). Hard excludes (reverse-causation / pyramiding / wrong-direction) carry to all three.

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
- **Granted-SC = deterministic authority** (see §6 chart-extract row): the load-bearing anchor never depends on the LLM alone. `rating-decision-grants.ts`. History: [[project_chart_extraction_method_history]] — Sonnet STILL reads the whole chart (A/B winner); this is a narrow deterministic FLOOR under one templated field, NOT a revert.
- **Stale-extraction auto-refresh** (`EXTRACTOR_VERSION` in `chart-build-state.ts`): a chart-extract code fix only helps NEW runs, and the reprocess cost-safety gate used to skip re-extraction whenever the DOC set was unchanged (`already_extracted_no_changes`) — so a deployed fix never reached open cases (the Hackworth trap). Now: each run stamps `resultJson.extractorVersion`; the reprocess gate treats a run from an OLDER version as STALE → re-extracts. **BUMP `EXTRACTOR_VERSION` on every chart-extract logic change.** NOT folded into `computeTriggerHash` (that would wedge every case at 'extracting'). Currently v2 = deterministic grant authority.
- **No silent draft failures** (`pipelinePhase.summarizeForOperator`): a paused draft now names the specific failed phase + its recorded reason (PHASE_PLAIN map) as the `operatorMessage`, instead of the generic "we've paused this for a closer look" that hid ~14 distinct failures as one. The manifest already recorded the reason; it was being discarded. (Deploys with the drafter image.)
- **Render glyph-fold** (`foldRenderable.js`): PDFKit can't render non-CP-1252 glyphs (ș, ≥) → corrupt PDF → render_parity_mismatch on an A-grade letter. Fold to ASCII at every PDF sink + persisted txt. Live (drafter + render image `0fa7a8b`).
- **Body-quality park** (2026-06-21, `routes/drafter.ts` `/halt`): the FRN cloud drafter SKIPS the full publish linter (no `claims` table in Fargate), so ~40 body linters never gated → editorial-meta / fabricated-PMID / dual-prong-missing / SSN-PHI / locked-block / Section III list-format leaks reached the physician. The FRN `draftBodyQualityGate` now PARKS such a (fully-drafted) letter via the EMR `/halt` callback. The `/halt` receiver allowlists `body_quality_critical` (maps to case `needs_rn_decision` + draft_decision `pause`/item `body_quality` — mirrors `verify_error` but labeled honestly, so the chart Decisions log doesn't read as a dx hold). **Detection is dual:** `reasonCode === 'body_quality_critical'` OR `haltGate === 'body_quality'` — because the FRN side currently still emits the allowlisted `verify_error` with `haltGate:'body_quality'` until its drafter image redeploys; BOTH are accepted (`isBodyQualityHalt` in `frontend/src/types/prisma.ts`). The full payload (incl. `materialIds[]` / forthcoming `material[{id,section,detail}]`) persists in `DraftJob.haltPayloadJson`. RN sees a distinct **"Quality hold — letter held for re-draft"** card (`Gate2HaltPanel` branch) whose only action is **re-draft** (`rnDecision.proceed`) — NOT the dx switch/override/proceed-records options, which don't apply to a content defect. Cross-repo follow-up owed FRN-side: emit the dedicated `body_quality_critical` code + richer `material` rows once the drafter image redeploys.

## 7. 🗄 RETIRED / SUPERSEDED log (append-only — so dropped decisions don't resurface)

| Date | What | Why retired | Replaced by |
|---|---|---|---|
| 2026-06-19 | **Static M/E (mechanism/evidence) anchor ratings on the Overview card** ("M=4,E=2") | brittle static table, didn't match drafter judgment | the **AI route-picker** (`deriveAiViability`) — one brain for card + drafter + Ask-Aegis |
| 2026-06-19 | The `/cases/:id/soap-overview` 2nd-LLM-call endpoint | 29s timeout silent-fail | SOAP card renders deterministically from the shared `viability-card` query (one LLM call) |
| 2026-06-19 | Synchronous picker compute on GET `/viability-card` | ~22-25s call can't fit the 29s cap → silent fail | async self-invoke compute off the request path + persisted-plan read (see §5) |
| 2026-06-20 | Deterministic string-assembled SOAP "note" on the Overview card | read like a dump (S echoed in A, O = a wall of every SC condition) | AI-synthesized SOAP note (`buildSoapNote`, Sonnet) — smooth S/O/A/P; the deterministic verdict stays the fail-open fallback |

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
