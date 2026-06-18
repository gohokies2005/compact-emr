# Intake / Viability Synthesizer — design spec (2026-06-18)

**Ryan's ask:** "the intake/viability synthesizer next. we need to figure that out in a good way."
Expands worklist line 37: (1) the Overview shows 4–5 chips from independent engines that contradict
each other → an RN can't tell go/no-go; (2) the Overview should accurately **PREDICT the drafter's
LEAD THEORY** before the draft runs, **reusing the drafter's own deterministic logic — NOT a second
brain that can drift.**

## Current state (mapped 2026-06-18, read-only)
Five surfaces on the Overview, four independent engines, one frontend-only synthesizer:
1. **Background & argument** (StrategyPreviewCard) ← `GET /strategy-preview`, `strategy-preview.ts`
   deterministic 5-criterion ladder → Strong / Plausible / Thin / Stop.
2. **Anchor viability** (CaseViabilityCard) ← `GET /viability-card`, vendored resolver → strong /
   moderate / conditional / weak / abstain / redirect.
3. **Chart extraction** (ExtractionCoveragePanel) ← `GET /extraction-coverage` → Complete / N unread / partial.
4. **AI Sanity Check** (SanityImpressionLine) ← Opus → clear / caution / concern.
5. **Recommended Plan** (RecommendedPlanCard, `frontend/src/lib/recommendedPlan.ts`) — the ONLY
   reconciler today. Frontend-only. Reads strategy tier (primary) + viability band (fallback). **Ignores
   extraction + sanity entirely.** Output: Draft / Draft–adjust anchor / Contact veteran / Not
   supportable / Needs review.

### Two confirmed defects
- **No signal reconciliation.** Strategy, viability, extraction, sanity each answer a DIFFERENT
  question with DIFFERENT thresholds and never reconcile. "Complete + Weak + Draft + Caution" all show
  at once. The lone synthesizer ignores 2 of 4 signals.
- **Band-leak (drafter handoff).** CaseViabilityCard headlines green "Strong" purely from
  `viability.viability`, never reading `best_anchor.physician_reviewed`. An UNREVIEWED Doximity
  mechanism (physician_reviewed=false) still reads "Strong / M4". `physician_reviewed` is now in the v1/
  v2/v2.1 JSON schemas (2026-06-18) + emitted by the resolver, but is NOT in the backend TS type, NOT in
  the frontend type, NOT rendered.

### Predict-the-drafter — what's deterministic vs not (drafter source map)
The drafter's lead-theory selection is ~60% deterministic, ~40% LLM:
- **Deterministic & predictable** (in FRN `framingGate.js` + `opinionSentence.js`, none vendored yet):
  `rankAnchorCandidates()` (anchor ordering), `_applyTierFloor()` (tier guardrail), `_stampAtlasWinrate()`
  (BVA pair stats), `_synthesizeAnchorFraming()` (the deterministic fallback the drafter actually uses
  when the LLM bails/blanks), `_deniedUpstreamsFromDenial()`; `opinionSentence.selectVariant()` +
  `assembleOpinionSentence()` (the §VII variant + basis 3.310a/b, given framing); anchorMechanism
  eligibility + aggravation_only/causation_denied (already vendored).
- **LLM-driven, NOT reliably predictable:** the framing DIRECTION (secondary vs direct vs aggravation),
  the exact reg when ambiguous, alternative framings. The drafter has deterministic fallbacks, but the
  happy path is the LLM's call.

## Design principles
1. **One brain, reused — never a second one.** The predictor MUST run the drafter's exact deterministic
   modules, vendored + sha-pinned exactly like anchorMechanism.cjs (the resolver code byte-pin added
   2026-06-18 is the anti-drift mechanism). Extracting them into a pure module is an FRN-source refactor
   = the drafter window's lane; the EMR vendors the result.
2. **Honest about uncertainty.** Where the drafter is LLM-driven, the Overview says "the doctor/model
   finalizes this" — it never fabricates a confident framing prediction. (Mirrors the recent
   abstain-hardening + the Woodley "confidently wrong on contaminated data" lesson.)
3. **Provenance-aware.** A prediction built on a non-authoritative SC list (Woodley) is garbage. The
   verdict must degrade/flag when the SC anchors lack authoritative provenance (ties to the P1
   SC-provenance flaw — at minimum, surface it; do not silently trust).
4. **Reconcile, don't add a 6th chip.** Collapse to ONE top-line verdict + the single next action, and
   surface DISAGREEMENT explicitly ("engine says X, AI flags Y — confirm") rather than parallel chips.
5. **Advisory, never a gate.** Same contract as today — does not block drafting; Gate-2 supersedes.

## Proposed build (phased, smallest-safe-first)

### Phase 0 — EMR-only, safe, ships now (no drafter dependency)
- **0a. Fix the band-leak.** Add `physician_reviewed?: boolean` to the backend + frontend
  ViabilityBestAnchor types (already in the schema + emitted). In CaseViabilityCard: when
  `best_anchor.physician_reviewed === false`, do NOT render a green "Strong/Moderate" headline — render
  the band as a *candidate* + an amber "mechanism not physician-reviewed — confirm the medicine" badge.
  Mirror Ask-Aegis's loud grounding warning. + a frontend test that a false flag suppresses the green
  headline.
- **0b. Backend reconciliation verdict.** New `caseReadinessVerdict(signals)` — a PURE, deterministic
  reconciler (its own unit-tested module) that takes the four existing signals (strategy tier, viability
  band+physician_reviewed, extraction coverage, sanity impression) and returns ONE verdict +
  next-action + an explicit `disagreements[]` list. Precedence (draft, to be pressure-tested by QA):
  hard-stop (no anchor / redirect / Stop / not-supportable) → chart-not-read (extraction gates
  confidence) → unreviewed-anchor downgrade → theory strength (strategy×viability reconciled) → sanity
  overlay as a disagreement flag, never silently overriding. Replace recommendedPlan.ts's narrow logic
  with a thin client of this backend verdict so the RN sees the SAME verdict the backend computes.

### Phase 1 — Predict-the-drafter (needs drafter-window coordination)
- **1a. (DRAFTER LANE) Extract the deterministic core** of framingGate (`rankAnchorCandidates`,
  `_applyTierFloor`, `_stampAtlasWinrate`, `_synthesizeAnchorFraming`, `_deniedUpstreamsFromDenial`)
  into a pure, dependency-free FRN module (no better-sqlite3 / no llm/client), + vendor `opinionSentence.js`
  (already pure) and the BVA pair-atlas + routing.json as sha-pinned data tables.
- **1b. (EMR LANE) Vendor those** alongside anchorMechanism.cjs (same vendor script, same pin discipline,
  same resolver-code byte-pin). Build `predictLeadTheory(case)` backend service that runs the SAME ranker
  the drafter uses → predicted anchor, basis (3.310a/b), §VII opinion variant, killer-stat/mechanism,
  strong/weak, RN-confirm list. Mark every LLM-dependent field "doctor/model finalizes."
- **1c. Surface** in the Overview: "Predicted lead theory" block. Confidence-tagged; honest where LLM-led.

## Open decisions for QA / Ryan
- Phase-0 precedence weights (esp. how hard extraction-incompleteness should gate the theory verdict).
- Whether Phase 1's predictor extraction is worth the drafter-coordination cost now (RNs live in a week)
  vs shipping Phase 0 (the reconciled verdict + band-leak fix) first and predicting-the-theory as a
  fast-follow. Recommendation: ship Phase 0 now; Phase 1 right after, gated on the drafter extracting the
  pure module.

---

## QA VERDICT + REVISED PLAN (2026-06-18 — code-architect-qa + anthropic-ai-sme, both SHIP-WITH-FIXES)

### The finding that reshapes Phase 0 (architect)
The vendored resolver **already contains the SSOT band→action reconciler** — `recommendedAction()`
(`anchorMechanism.cjs:1285`) — **and it already implements the physician_reviewed over-call guard**
(:1287–1298). It is sha-pinned in the one-brain module and its own comment says the RN card + Ask Aegis
"both consume THIS" — but it had **zero EMR consumers**. So Phase 0a as first written (re-implement the
guard in React) would have built the exact second brain Principle 1 forbids. **Corrected: consume
`recommendedAction`, don't reimplement.** ✅ DONE — shipped `67568b3` (band-leak fix: backend surfaces
`physician_reviewed` + a `recommended_action` block via a fail-open `recommendedActionFor()` wrapper;
the card downgrades a green headline to "Candidate — physician review" + a verbatim-reason badge when
the policy says escalate→physician on an unreviewed anchor).

### Phase 0b must-fixes (the cross-engine reconciler — NOT yet built)
- New **pure `case-readiness-verdict.ts`** (own unit tests); **ride the existing `/strategy-preview`
  payload**, not a new endpoint; make `recommendedPlan.ts` a **thin client** of it so the RN sees the
  same verdict the backend computes (watch FE/BE divergence during rollout).
- **Sanity signal = add-caution-only, asymmetric (AI-SME, hard rule):** a `concern` raises an explicit
  disagreement ("engine: supportable; AI flags X — confirm") and can force a confirm-step, but **never
  silently moves the deterministic band**; a `clear` has **zero authority to relax** any deterministic
  caution/stop; **`unavailable` ≠ `clear`** (Opus timeout must render "sanity unavailable", never
  all-clear). The LLM may ADD caution, never REMOVE it.
- **Every signal needs an explicit "unavailable" state** distinct from its negative; a missing input
  **degrades toward "Needs review", never toward "Draft".** Both new services output **closed enums /
  typed states + a structured `disagreements[]`**, never free prose implying unsupported certainty.
- **Re-check the chart-not-read rung** against the real `extraction-coverage.ts` behavior — incomplete
  extraction should lower CONFIDENCE + add a "read the chart" action, not by itself flip a supportable
  theory to not-supportable (a thin parse that still captured the rating decision is fine).
- **Descope Principle 3 to what exists:** there is no SC-source-provenance field yet. Use
  `physician_reviewed` (now consumed) as the available provenance proxy; full SC-source-tiering is the
  separate P1 flaw and a prerequisite for the predictor's provenance gate.

### Phase 1 must-fixes (predict-the-drafter — needs drafter coordination)
- **Split the prediction into COMMITTED (deterministic) vs OPEN (LLM-direction) at the data-contract
  level** — separate typed fields, never one merged sentence. The anchor/tier/basis/§VII-variant are
  committed (will match the draft *given the direction*); the framing DIRECTION (secondary/direct/
  aggravation) is the Opus call and must render as a hedged candidate ("the doctor + model finalize the
  framing").
- **Byte-pinning is necessary but NOT sufficient.** Identical deterministic code still diverges from the
  real draft when the LLM takes the happy path and overrides the deterministic fallback direction. So:
  pin the **data tables** (BVA atlas, routing.json) with their own shas too (routing.json silent-wipe
  scar); add a **committed-fields-only drift smoke test** (predictor vs real drafter); track
  direction-match as an **observability metric, not a gate**.
- **Provenance GATES the prediction, not just annotates it:** a low-provenance / physician_reviewed:false
  winning anchor → demote to "candidate, unverified" + abstain on a committed headline. Enforce as a
  wrapper gate AROUND the provenance-blind ranker (don't fork the vendored module).
- **Cross-lane question for the drafter:** does the drafter itself gate on anchor provenance before
  ranking? If not, the predictor would be more honest than the drafter and they diverge — fix on the
  drafter side so one brain stays one brain.
