# Viability pre-screen (read the CaseViabilityCard)

**Date:** 2026-06-11 · **Source of truth:** `docs/P4_ANCHOR_VIABILITY_BUILD_PLAN.md` §6 (build-order step 9) · linked from `docs/COMPACT_EMR_RN_WORKFLOW_UI_GAPS_BRIEF.md`.

The **CaseViabilityCard** sits directly under the strategy preview in the **Send to Drafter** panel on the case page. It is the anchor-viability pre-screen: a deterministic, no-LLM read of the curated anchor-mechanism table (513 direction-locked pairs, sha-pinned) against this case's claimed condition + granted service-connected conditions. It ships dark behind `EMR_CASE_VIABILITY_ENABLED`.

## Where it sits in the RN flow

> intake → **viability pre-screen (info-light card)** → records gathering (driven by `missing_fact`) → chart parse → [chart-refined card — FOLLOW-ON] → Gate-1 readiness → Send to Drafter → **Gate-2 SUPERSEDES** on any contradiction → draft.

## How to use it

1. **At intake (info-light):** as soon as the claimed condition + granted SC conditions are known, the card shows an info-light band (`Strong` / `Moderate` / `Conditional` / `Weak` / `Needs RN review` / `Redirect`). Use it to set expectations and spot a `redirect`/`weak`/`abstain` case BEFORE the $50 review work and before drafting.

2. **`missing_fact` is the records-request justification.** A `Conditional` band names the ONE record that raises it (e.g., documented gait alteration for knee→back), rendered as "To strengthen: …". Request exactly that, with the one-line WHY — CLAUDE.md Records-Minimalism #16. Never bulk-request.

3. **The card is ADVISORY, never a gate.** It never blocks the Send-to-Drafter button. **Gate-2 (deep document verification) SUPERSEDES** it on any contradiction — the card is a structured-data preliminary signal; Gate-2 reads the full OCR.

4. **`excluded_traps` ("Why not these anchors") = the expectation-management tool.** When a vet insists "connect my OSA to my tinnitus," the card gives the plain reason it won't fly (no physiologic pathway) and the `best_anchor` line gives the path that will.

5. **NON-promise discipline:** the band is an internal strategy signal. The RN does NOT quote a band/% to the vet as a guarantee. Vet-facing language is the public tool's conservative output. The card never shows a BVA number; the RN never invents one.

## Reading the card

- **Band chip:** Strong/Moderate (green) = a recognized granted anchor exists; Conditional (amber) = the path depends on a record we still need; Weak (red) = no strong granted anchor yet; Needs RN review = the resolver parked the case (umbrella diagnosis, or a dead anchor with no granted redirect target); Redirect = argue a different theory (the card says which).
- **Anchor line:** `<granted condition> → <claimed condition> (M<n> <tier>, E: …)`. `M` is mechanism strength (0–4), `tier` the table's eligibility class. **"E: not yet scored" is the normal state** — it means the per-pair evidence score hasn't been curated yet, NOT "no evidence."
- **`confidence` is a band/mode signal, not a physician-review attestation.** The table's per-row physician review is a separate, ongoing curation pass; the card intentionally carries no "physician reviewed" wording.
- **Info-light limitation (current):** the card does not yet read chart facts (no `service_profile` / `documented_facts` normalization in the EMR), so presumptive redirects render as an ADVISORY "Consider presumptive:" note rather than a hard Redirect band, and conditional pairs stay Conditional even when the chart already documents the required fact. The chart-refined card is a documented follow-on.
