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
> **Last reviewed:** 2026-06-19 (commit 318def1) — route-picker one-brain alignment + Ask-Aegis + SOAP lock-in.

---

## 1. System flow (case lifecycle)

```
Intake (Jotform → webhook Lambda + hourly jotform-sweep backstop)
  → S3 raw docs (PHI bucket)
  → OCR / vision read  (per-page Sonnet vision worker; legacy Textract)  [worker, async]
  → chart-extract      (Anthropic Sonnet → structured facts, SC list, problems)  [Lambda, async]
  → viability route-picker  (deriveAiViability → Sonnet)  ← ONE BRAIN (card + Ask-Aegis + drafter framing)
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
| **Viability route-picker** | card + Ask-Aegis grounding + drafter framing (ONE brain) | Anthropic, `claude-sonnet-4-6` (`AI_ROUTE_PICKER_MODEL`) | `AI_ROUTE_PICKER_ENABLED` = true | FRN `app/services/aiRoutePicker.js` → `backend/src/vendor/aiRoutePicker.cjs` (**sha-pinned** by `ai-route-picker-pin.test.ts`) |
| Drafter | the nexus letter | Anthropic, Opus | drafter image tag (cdk.json) | FRN `app/services/*` → Fargate ECR image |
| Ask-Aegis advisory | RN/physician case Q&A | **Bedrock**, Opus 4.6 | always on | FRN `app/config/advisory/rn_advisory_system_prompt.md` → `backend/src/advisory/systemPrompt.ts` |
| Opus sanity-impression | pre/post-draft gut-check | Anthropic, Opus | (cached per case+stage) | `backend/src/services/sanity-impression.ts` |

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

## 7. 🗄 RETIRED / SUPERSEDED log (append-only — so dropped decisions don't resurface)

| Date | What | Why retired | Replaced by |
|---|---|---|---|
| 2026-06-19 | **Static M/E (mechanism/evidence) anchor ratings on the Overview card** ("M=4,E=2") | brittle static table, didn't match drafter judgment | the **AI route-picker** (`deriveAiViability`) — one brain for card + drafter + Ask-Aegis |
| 2026-06-19 | The `/cases/:id/soap-overview` 2nd-LLM-call endpoint | 29s timeout silent-fail | SOAP card renders deterministically from the shared `viability-card` query (one LLM call) |
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
