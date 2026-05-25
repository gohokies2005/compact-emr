# Phase 5 — CDS engine (backend) Summary

Built by Claude Code (the backend/algorithm lane). The CDS **UI** is a separate ChatGPT task — brief in the FRN repo at `docs/COMPACT_EMR_PHASE5_BRIEF.md`.

## What it is

A deterministic, reproducible Clinical Decision Support verdict, grounded in BVA outcome data — designed to catch obvious no's and strong yes's **without burning the LLM gate**.

- **Layer A — hard gates (pure logic, "obvious no" → `reject` recommendation):**
  1. `barred_theory` — direct tobacco/nicotine causation (38 U.S.C. § 1103).
  2. `no_diagnosis` — no active problems / diagnoses on file.
  3. `no_sc_anchor` — secondary claim whose upstream condition is not among the veteran's service-connected conditions (the Corbett case).
- **Layer B — BVA odds (deterministic lookup):** matches the upstream→claimed pair in `bva_secondary_pairs.json` (12,183 real pairs / 35,832 BVA cases) and uses **`imo_win_pct`** (FRN provides the IMO; falls back to overall `win_pct` when the IMO sample < 10). Thresholds: **accept ≥ 70 (and tier ≠ low), caution 50–70, reject-flag < 50**; no pair or non-secondary claim → **caution → refer to clinical review**.
- A `reject` is a **recommendation only** — the verdict is surfaced for an RN/physician to confirm; nothing veteran-facing fires automatically.

## Files

- `backend/src/services/cdsEngine.ts` — pure `evaluateCds(input): CdsResult`. Conservative condition-name matcher (normalize + alias map for FRN phrasings like PTSD/OSA/MDD + token containment). Fully unit-testable, no I/O.
- `backend/src/data/bva_secondary_pairs.json` — bundled copy of the BVA pair atlas (esbuild inlines it into the Lambda).
- `backend/src/routes/cds.ts` — `POST /api/v1/cases/:id/cds` (admin, ops_staff): loads the case + veteran `scConditions`/`activeProblems`, runs the engine, persists `cdsVerdict` / `cdsOddsPct` (rounded int) / `cdsRationale` (full result), writes a `cds_evaluated` activity row, returns `{ data: CdsResult }`.
- `backend/src/server.ts` — additive `createCdsRouter(db)` mount.
- `backend/tsconfig.json` — `resolveJsonModule: true` (to import the bundled atlas).
- Tests: `cds-engine.test.ts` (7 — accept, alias-match, the 3 hard gates, no-pair caution, reproducibility) + `cds-routes.test.ts` (4 — 401/403/404/persist+activity).

## Reproducibility & honesty (your requirements)

- Pure function of (chart facts + frozen BVA JSON) → same inputs always give the same verdict/odds.
- `cdsRationale` carries the exact pair, `n`, `tier`, `imo_win_pct`/`win_pct`, and which gate fired — auditable.
- Honest limits by design: the structured odds cover **secondary** claims (the atlas is upstream→claimed); direct/aggravation lean on the hard-gates and otherwise return `caution` (refer to gate). Nuanced no's (onset timing, age-typical progression) still need the gate/physician — Layer A only catches *structural* no's.

## Stress test (Ryan: "prefer rare false-viables over over-screening")

`cds-stress.test.ts` runs **722 cases** (every BVA pair clean + a deliberately messy phrasing variant + hard-no's + fuzz/edge). Initial run exposed **338 false-non-viables** — the strict SC-anchor matcher over-rejected real-world phrasing. Loosened the anchor gate to "shares any meaningful (non-stopword) token ⇒ anchored; hard-reject only on a clear zero-overlap mismatch." Result: **0 crashes, 0 false-non-viables, reject dropped 346 → 9** (the genuine hard-no's + sub-50% odds). Distribution accept 256 / caution 457 / reject 9 — loose, not over-screening. The stress test is a committed regression guard (asserts 0 crashes + 0 false-non-viables).

## Verification (local; evidence under `docs/verification/phase5-cds-evidence/`)

- backend `tsc --noEmit` → 0 · `lint`/`typecheck` (root) → 0 · `migrate:check`/`migrate:diff-check` → 0 (no schema change)
- `npm test` → frontend **18 pass**, backend **61 pass** (incl. 11 new CDS tests)

## Next

- ChatGPT builds the CDS UI panel against the `CdsResult` contract (brief: FRN `docs/COMPACT_EMR_PHASE5_BRIEF.md`).
- Future tuning: thresholds are constants at the top of `cdsEngine.ts`; the alias map is extensible; direct/aggravation odds could later read `bva_condition_atlas.md` if we want odds beyond secondary pairs.
