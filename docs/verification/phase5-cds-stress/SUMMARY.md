# Phase 5 CDS Engine — Stress Verification

**Engine under test:** `backend/src/services/cdsEngine.ts` (CDS_ENGINE_VERSION = `cds-1.0.0`)
**Test files:**
- `backend/src/__tests__/cdsEngine.stress.test.ts` — 252 distinct real-data scenarios
- `backend/src/__tests__/cdsEngine.thresholds.test.ts` — 60 synthetic-pair boundary cases + 1 contract note

**Runner:** vitest, `npm run test -w backend -- --run`
**Date:** 2026-05-25

## Result

**391 / 391 backend tests passing.** No engine modifications. No tests skipped.

Pre-existing baseline: 72 tests passing across 11 files. After this work: 391 tests passing across 13 files (313 new tests added: 252 stress + 61 threshold + 5 fanout from prior `cds-stress.test.ts` aggregate harness that still runs alongside).

## Case bucket counts (cdsEngine.stress.test.ts)

| Bucket | Description | Count | Verdicts asserted |
|--------|-------------|-------|-------------------|
| A | Layer-A hard gates (barred tobacco, no diagnosis, no SC anchor, multi-gate collisions) | 57 | reject + rule pinning |
| B | Layer-B threshold coverage on real pairs (high/moderate/low tier across the imo range) | 54 | accept / caution / reject + exact oddsPct + bvaMatched |
| C | BVA pair coverage — 50 real pairs from the atlas (high-volume + mid + low-tier + outlier rejects) | 50 | accept / caution / reject + exact oddsPct + bvaMatched=true |
| D | No-match / non-secondary (no atlas pair, or direct/initial/presumptive claims with null upstream) | 30 | caution + bvaMatched=false + oddsPct=null |
| E | Edge / malformed input (case, whitespace, unicode, punctuation, very long strings, aliases, stopword-only SC) | 41 | varied; primary assertion is no-crash + correct verdict |
| F | Determinism / idempotency (N=10 runs per seed; bit-for-bit identical verdict/oddsPct/summary/hardGate/bva) | 20 | identity across runs |
| **Total** | | **252** | |

## Synthetic threshold cases (cdsEngine.thresholds.test.ts)

The mocked atlas exercises imo_win_pct at 15 boundary values (89, 80, 71, 70, 69, 65, 60, 55, 51, 50, 49, 40, 30, 10, 0) across 4 synthetic upstreams = **60 cases**, all tier=high so the accept-tier branch fires. Verdict thresholds confirmed exactly as specified:

- `imo_win_pct >= 70 AND tier != 'low'` => accept
- `50 <= imo_win_pct < 70` => caution
- `imo_win_pct < 50` => reject

**The engine treats 70.0 as accept and 69.0 as caution — confirmed bit-exact at the >= boundary.**

The `tier='low' + odds >= 70 => caution` dead branch (engine line 174) is covered separately in the real-data stress suite by PTSD -> Wrist (imo=92.3, tier=low) and 4 sibling PTSD/low pairs in Bucket B / Bucket C.

## Notable boundary findings

**1. Normalization is case-insensitive and whitespace-tolerant.** `normalize()` lowercases, strips non-alphanumerics, collapses whitespace. Confirmed in Bucket E1: "ptsd" / "PTSD" / " Ptsd " / "pTsD" all match. Trailing/leading whitespace on both `claimedCondition` and `upstreamScCondition` is handled.

**2. The matcher uses token-containment in BOTH directions.** "Carpal tunnel syndrome" (input) matches atlas key "Carpal tunnel" because input's significant-token set is a superset of the key's. This is the expected matcher contract.

**3. Aliases resolve before matching.** `mdd`, `htn`, `osa`, `dm2`, `lumbar`, `back`, `migraine`, `traumatic brain injury`, `coronary artery disease`, `a fib`, `irritable bowel syndrome` etc. all resolve to the canonical atlas key. Confirmed in Bucket E6.

**4. `barred_theory` only fires when `isDirect=true`** — i.e. NO upstream AND framingChoice does not match `/secondary|aggravat/`. If an upstream is present, even with a "tobacco" claim and `framingChoice='direct'`, barred_theory is skipped and the engine evaluates the lower gates. Documented in Bucket A6.

**5. Hard-gate check order is fixed:** `barred_theory` -> `no_diagnosis` -> `no_sc_anchor`. First match wins. Verified by deliberate two-gate collision cases in Bucket A.

**6. `hasScAnchor` is intentionally loose.** Per the engine's inline comment ("prefer rare false-viables over over-screening viable cases"), ANY shared significant non-stopword token between the upstream condition and ANY SC entry passes the anchor. Stopwords (`chronic`, `disorder`, `secondary`, `residuals`, `mild`, etc.) are excluded. Confirmed in Bucket E13: SC=`['chronic disorder', 'unspecified syndrome']` with real upstream='PTSD' triggers `no_sc_anchor` because none of the SC entries' tokens overlap with `ptsd`.

**7. Empty / whitespace-only `upstreamScCondition` does NOT trigger `no_sc_anchor` when SC list is non-empty.** The `hasScAnchor` `up.size===0` branch returns `scConditions.length > 0`, so an all-stopword or all-whitespace upstream "passes" the anchor and falls through to a no-pair caution (Bucket E3, E14).

**8. Determinism is bit-exact for verdict/oddsPct/summary/hardGate/bva** across N=10 runs of identical input. Only `checkedAt` (Date.now-based) varies between runs. Bucket F runs 20 distinct seeds at N=10 each = 200 internal repeat invocations; zero drift.

## Engine concerns flagged (for Ryan)

These are NOT bugs — they're rough-edge observations Ryan asked to be surfaced. The engine was NOT edited.

**ENG-1 (cosmetic) — `tier` type vs data mismatch.** `cdsEngine.ts:18` declares `tier: 'high' | 'medium' | 'low'`, but `bva_secondary_pairs.json` uses `'high' | 'moderate' | 'low'` ("moderate" not "medium"). At runtime this is fine because the engine only checks `tier !== 'low'` (line 172), but the type lies about the data. Suggest changing the type to `'high' | 'moderate' | 'low'` to match.

**ENG-2 (atlas coverage) — real IMO data only ranges 53.8% to 100%.** The atlas has no IMO-usable pair below the 50% reject threshold. The Layer-B reject branch is only reachable in real data via the fallback `win_pct` path on three low-tier pairs: Hip->Cervical (16.7%), Shoulder->Tinnitus (40%), Peripheral neuropathy->Lumbar (40%). If the verdict logic is ever changed, these three pairs are the only real-world canary for the reject-below-50 branch. The synthetic `cdsEngine.thresholds.test.ts` covers the threshold logic at full resolution; keep that file in sync if the thresholds move.

**ENG-3 (atlas size disparity with handoff claim).** The task brief described the atlas as "12,183 pairs / 35,832 BVA cases". The actual `bva_secondary_pairs.json` ships **355 pairs** across 38 upstreams (83 IMO-usable, 272 fallback-only). Worth confirming whether the brief referred to a different / larger pre-aggregation source.

**ENG-4 (low-tier high-odds is always caution).** Five real pairs (PTSD -> Wrist/Hip/Plantar/Diabetes/Asthma) have imo_win_pct >= 85 but tier=low. Engine correctly returns caution per the "thin data" guard (line 174). This is intentional — flagging it because it's a counter-intuitive verdict for someone reading the panel ("92% but caution?"). The summary string does say "(thin data)" but it's parenthetical.

**ENG-5 (`evaluateCds` has no input-validation throw path).** Engine swallows malformed input (null, whitespace, unicode, 1500-char strings) and returns caution. This is good for defense-in-depth but means a UI bug feeding garbage to the engine won't surface as an error — it'll silently downgrade to caution. Not a defect, just a behavior to know.

## Reproducing

```
cd C:\Users\ryank\compact-emr-work
npm run typecheck -w backend
npm run lint -w backend
npm run test -w backend -- --run
```

Raw output saved to `docs/verification/phase5-cds-stress/test-output.txt`.
