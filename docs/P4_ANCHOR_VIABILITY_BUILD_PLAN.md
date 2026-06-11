# P4 — Anchor-Viability EMR Wiring — MECHANICAL BUILD PLAN

**Status:** BUILD PLAN (architect-authored, code-grounded 2026-06-10). Ryan-ratified for go-live ("im good with it" 2026-06-10). Ships DARK + flag-gated; activate only after smoke + Playwright pass.
**Scope (EMR window):** task (d) producer + stamp + worker copy-through, task (e) `CaseViabilityCard` + the GET endpoint, the `caseViability.v1.schema.json` (build-order step 3), the vendor set + CI hash test, the RN workflow doc section. Tasks (a)/(b)/(c) are the drafter window's; (f) Ask Aegis + (g) website are separate windows but pin the SAME table hash.
**Sources of truth:** `flatratenexus-project/docs/ANCHOR_VIABILITY_INTEGRATION_DESIGN_2026-06-10.md` (§3d, §3e, §4, build-order step 3, §9 BLOCKER-2); `shared/outbox/2026-06-10_PROMPT_emr_window_viability_wiring.md`.

---

## 0. GROUND TRUTH established by reading the real code (do NOT skip — these correct the design sketch)

These are verified facts, not assumptions. Each was confirmed by running the resolver / reading the file.

| # | Fact | Evidence | Consequence for the build |
|---|---|---|---|
| G1 | The sha-pin `58f9c315…` is the JSON **`content_hash` FIELD**, = `sha256(JSON.stringify({ rows, preference_rank }))`. It is NOT the file's raw sha256 (that's `f58c3077…`) and NOT a hash of the whole artifact. | `build-anchor-mechanism-pairs.js:406-409`; recompute matched exactly. | The CI hash test reads the `.content_hash` field and asserts `=== 58f9c315…`. A belt-and-suspenders integrity check ALSO recomputes `sha256(JSON.stringify({rows,preference_rank}))` so a tampered field can't pass. Do NOT hash the file bytes. |
| G2 | Table = **513 rows**, `row_count: 513`, `version: "2026-06-10.2"`, `content_hash: 58f9c315…`. | `Get-FileHash` + `ConvertFrom-Json` + resolver `table_version` output. | Schema's `table_content_hash` const-pins `58f9c315…`. `_MIN_TABLE_ROWS = 500` guard already in the resolver. |
| G3 | The resolver's **real output has 14 top-level keys**, STABLE across every band: `version, claimed_canonical, viability, best_anchor, alternatives, why, missing_fact, presumptive_redirect, graveyard_redirect, excluded_traps, confidence, mode, table_version, table_content_hash`. NO `derivedAt`. | Ran `assessClaimViability` across strong/weak/conditional/redirect/abstain/umbrella/empty. | Schema `required` = those 14. `derivedAt` is an OPTIONAL 15th the EMR producer adds; schema must allow it (`additionalProperties:false` + `derivedAt` in `properties`, NOT in `required`). |
| G4 | `best_anchor.E` emits **`null`** (not 0) when unscored — true for all 513 rows today. `best_anchor.requires` IS emitted (string or null). `best_anchor.basis` is `"3.310a"` (NO parens — the design sketch's `"3.310(a)"` is wrong). | OSA+PTSD output. | Card renders E null → "not yet scored". Schema `E: ["integer","null"]`, `basis: ["string","null"]`, `requires: ["string","null"]`. Do NOT pattern-constrain basis to `3.310(a)`. |
| G5 | `presumptive_redirect` carries an **`advisory` boolean** (`true` info-light, `false` hard redirect) — NOT in the design sketch. `graveyard_redirect` carries `redirect_blocked` boolean + `dead_anchor`/`redirect_to`/`rationale`. | IBS+PTSD (both modes), HTN+PTSD outputs. | Schema must include `advisory` in `presumptive_redirect` and `redirect_blocked` in `graveyard_redirect`, else valid output fails the contract. |
| G6 | `best_anchor` includes a **conditional `mechanism_member`** field after a 4.130 psych collapse (`shell.best_anchor.mechanism_member` set only when psych collapse fired). | `anchorMechanism.js:467`. | Schema `best_anchor` allows optional `mechanism_member: string`. With `additionalProperties:false` on `best_anchor`, omitting it = contract fail on Hatfield. |
| G7 | **`anchorMechanism.js` requires only `conditionCanon` + `fs`/`path`.** `conditionCanon.js` has ZERO `require()` calls (pure). | Read both files. | EMR vendor set = `anchorMechanism.js` + `conditionCanon.js` + the table JSON + the schema. Both JS files are PHI-free, DB-free, LLM-free → safe in the Lambda bundle. |
| G8 | **`framingGate.js` requires `better-sqlite3` (line 55) + `./llm/client` (line 58).** It is IMPURE. | Read framingGate.js. | **DO NOT vendor framingGate into the EMR.** The spec's "framingGate? per the spec" resolves to NO for the EMR — only the DRAFTER consumes framingGate (in-repo). The EMR producer calls `assessClaimViability` directly. Vendoring framingGate would drag the DB + LLM client into the Lambda. This is a hard correction to the prompt's vendor-set line. |
| G9 | The EMR has **no chart-fact normalization** (`documented_facts`, `service_profile`, `sleep_study_ahi` tags do not exist in `backend/src`). | grep returned nothing. | The producer + card ship **info-light only** initially (claimed + grantedScAnchors, no `chartFactsPresent`). Chart-refined is a documented FOLLOW-ON once a `chart/index.json → documented_facts` normalizer lands. Info-light is the correct, conservative default per design §1.4. |
| G10 | The EMR's actual SSOT read pattern is **request-time live derivation**, not S3-bundle reads: `strategy-preview.ts` + `viability.ts` call `deriveCaseFramingForCase(db, caseId)` live. `deriveCaseFramingForCase` is the shared row→input mapping that builds `grantedScAnchors`. | `case-framing-stamp.ts:74`, `strategy-preview.ts:57`, `viability.ts:48`. | The CaseViabilityCard's GET endpoint calls a NEW `deriveCaseViabilityForCase(db, caseId)` that internally calls `deriveCaseFramingForCase` to REUSE `grantedScAnchors` (one derivation feeds both — the design's explicit requirement). The S3-stamp (`bundle.caseViability`) is for the drafter + the debug export read; the CARD reads live. |
| G11 | The contract test uses a **hand-rolled minimal schema walker** (no ajv in the repo) — `case-framing.test.ts:40-92`. | Read it. | Reuse that exact `validate()` walker for `case-viability.test.ts`. Copy it; do not add ajv. |
| G12 | Both stamp sites are in `drafter.ts`: line **356** (`persist:false`, GET drafter-export) and line **529** (`persist:true`, POST /draft). The pattern is `const stamped = await stampCaseFraming(db, caseId, bundle, {persist})`. | Read drafter.ts. | `stampCaseViability` is called at BOTH sites immediately after `stampCaseFraming`, threading the already-stamped bundle so both blocks land: `bundle → stampCaseFraming → stampCaseViability`. |

---

## 1. caseViability.v1.schema.json — authored against the REAL resolver bytes

**Authoring rule:** the schema is JSON-Schema'd from the ACTUAL output of `assessClaimViability` (G3), NOT from the design §1.1 sketch (which §9/BLOCKER-2 reconciled but still shows a few fields wrong — see G4/G5). The verbatim resolver return shape (the strong OSA+PTSD case, the canonical full shape) is:

```jsonc
// VERBATIM from: node -e "assessClaimViability('Obstructive sleep apnea',['PTSD'])"
{
  "version": 1,
  "claimed_canonical": "Obstructive sleep apnea",
  "viability": "strong",
  "best_anchor": {
    "upstream_canonical": "PTSD",
    "upstream_verbatim": "PTSD",
    "M_static": 4,
    "M_eff": 4,
    "E": null,                                  // null = not-yet-scored across all 513 rows
    "tier": "blessed",
    "basis": "3.310a",                          // NO parens — '3.310a', not '3.310(a)'
    "is_granted_sc": true,
    "mechanism_class": "neuropsych_sleep_architecture",
    "requires": null
    // "mechanism_member": "<canonical>"        // PRESENT only after a 4.130 psych collapse (Hatfield)
  },
  "alternatives": [],                            // each: {upstream_canonical, M_eff, tier, is_granted_sc}
  "why": "Strong: service-connected PTSD is a dominant recognized cause of Obstructive sleep apnea.",
  "missing_fact": null,
  "presumptive_redirect": null,                  // {path, note, advisory:bool} when set
  "graveyard_redirect": null,                    // {dead_anchor, redirect_to, rationale, redirect_blocked:bool} when set
  "excluded_traps": [                            // each: {upstream_canonical, reason}
    { "upstream_canonical": "Tinnitus", "reason": "No physiologic pathway from an auditory percept..." }
  ],
  "confidence": "high",                          // high | low
  "mode": "info_light",                          // info_light | chart_refined
  "table_version": "2026-06-10.2",
  "table_content_hash": "58f9c315340214c27867995ddaf0bf0f9dcc9e08b48d8178ae111023e21b401f"
  // "derivedAt": "<ISO-8601>"                   // OPTIONAL — EMR producer adds; resolver/website omit
}
```

**File:** `backend/src/config/caseViability.v1.schema.json` (canonical authored in `flatratenexus-project/app/config/caseViability.v1.schema.json`, vendored byte-identical here). Draft-07, `additionalProperties:false` at every object level (mirrors caseFraming):

```jsonc
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://flatratenexus.local/schemas/caseViability.v1.schema.json",
  "title": "bundle.caseViability (SSOT v1)",
  "description": "Per-claimed-condition viability assessment, SIBLING block to caseFraming (NOT a v2 extension — different cardinality). Stamped by deriveCaseViability in the same POST /draft pass; read READ-ONLY by the RN panel, Ask Aegis, the drafter, and the public tool. ABSENCE/unknown-version = fail-open (card shows 'viability read unavailable', producer stamps nothing). derivedAt is OPTIONAL+route-stamped (resolver is pure/deterministic; website omits it). NEVER carries a BVA %, IMO rate, or pair-atlas tier in any vet/RN-facing string (CLAUDE.md #17). See docs/ANCHOR_VIABILITY_INTEGRATION_DESIGN_2026-06-10.md §1.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "version", "claimed_canonical", "viability", "best_anchor", "alternatives",
    "why", "missing_fact", "presumptive_redirect", "graveyard_redirect",
    "excluded_traps", "confidence", "mode", "table_version", "table_content_hash"
  ],
  "properties": {
    "version": { "type": "integer", "const": 1 },
    "claimed_canonical": { "type": ["string", "null"] },
    "viability": { "type": "string", "enum": ["strong", "moderate", "conditional", "weak", "abstain", "redirect"] },
    "best_anchor": {
      "type": ["object", "null"],
      "additionalProperties": false,
      "required": ["upstream_canonical","upstream_verbatim","M_static","M_eff","E","tier","basis","is_granted_sc","mechanism_class","requires"],
      "properties": {
        "upstream_canonical": { "type": "string", "minLength": 1 },
        "upstream_verbatim":  { "type": "string" },
        "M_static": { "type": ["integer", "null"], "minimum": 0, "maximum": 4 },
        "M_eff":    { "type": ["integer", "null"], "minimum": 0, "maximum": 4 },
        "E":        { "type": ["integer", "null"], "minimum": 0, "maximum": 4 },
        "tier": { "type": "string", "enum": ["blessed","conditional","chain","plausible","excluded"] },
        "basis": { "type": ["string", "null"] },
        "is_granted_sc": { "type": "boolean" },
        "mechanism_class": { "type": ["string", "null"] },
        "requires": { "type": ["string", "null"] },
        "mechanism_member": { "type": "string" }
      }
    },
    "alternatives": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["upstream_canonical","M_eff","tier","is_granted_sc"],
        "properties": {
          "upstream_canonical": { "type": "string", "minLength": 1 },
          "M_eff": { "type": ["integer", "null"], "minimum": 0, "maximum": 4 },
          "tier": { "type": "string", "enum": ["blessed","conditional","chain","plausible","excluded"] },
          "is_granted_sc": { "type": "boolean" }
        }
      }
    },
    "why": { "type": "string" },
    "missing_fact": { "type": ["string", "null"] },
    "presumptive_redirect": {
      "type": ["object", "null"],
      "additionalProperties": false,
      "required": ["path","note","advisory"],
      "properties": {
        "path": { "type": "string" },
        "note": { "type": "string" },
        "advisory": { "type": "boolean" }
      }
    },
    "graveyard_redirect": {
      "type": ["object", "null"],
      "additionalProperties": false,
      "required": ["dead_anchor","redirect_to","rationale","redirect_blocked"],
      "properties": {
        "dead_anchor": { "type": "string" },
        "redirect_to": { "type": "string" },
        "rationale": { "type": "string" },
        "redirect_blocked": { "type": "boolean" }
      }
    },
    "excluded_traps": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["upstream_canonical","reason"],
        "properties": {
          "upstream_canonical": { "type": "string", "minLength": 1 },
          "reason": { "type": "string" }
        }
      }
    },
    "confidence": { "type": "string", "enum": ["high", "low"] },
    "mode": { "type": "string", "enum": ["info_light", "chart_refined"] },
    "table_version": { "type": ["string", "null"] },
    "table_content_hash": { "type": ["string", "null"], "const": "58f9c315340214c27867995ddaf0bf0f9dcc9e08b48d8178ae111023e21b401f" },
    "derivedAt": { "type": "string", "format": "date-time" }
  }
}
```

**Schema-authoring gotchas (each one is a real-bytes trap that would red-build a valid output):**
- `mechanism_member` is in `best_anchor.properties` but NOT in its `required` (it's conditional on psych collapse). With `additionalProperties:false`, omitting it from `properties` would FAIL Hatfield. (G6)
- `presumptive_redirect.advisory` and `graveyard_redirect.redirect_blocked` MUST be present (G5) or IBS/HTN cases fail.
- `derivedAt` is in `properties` but NOT in `required` (G3) — so the website's no-derivedAt output AND the EMR's with-derivedAt output both validate.
- `table_content_hash` is `const`-pinned to `58f9c315…` — this is a SECOND drift tripwire on top of the table file hash test: if a vendored table with a different hash is stamped, the stamped block fails its own schema. **Verification gate:** when the table is recurated and the pin rotates, this `const` + every `PINNED_*` literal in §2 must change in the same commit, or the contract tests red-build (intended).
- The `table_content_hash` const string is a literal — if Ryan's curation pass changes the table, EVERYORDER of these literals updates together (one commit). This is the intended drift alarm.

---

## 2. Vendor set + CI hash test (byte-identical, sha-pinned)

**Vendor set into compact-emr-work (4 files):**
| Canonical (drafter repo) | Vendored copy (EMR) |
|---|---|
| `app/services/anchorMechanism.js` | `backend/src/vendor/anchorMechanism.cjs` |
| `app/services/conditionCanon.js` | `backend/src/vendor/conditionCanon.cjs` |
| `references/anchor_mechanism_pairs.json` | `backend/src/vendor/anchor_mechanism_pairs.json` |
| `app/config/caseViability.v1.schema.json` | `backend/src/config/caseViability.v1.schema.json` |

NOT vendored: `framingGate.js` (G8 — impure, drafter-only). The resolver's `ARTIFACT_PATH` (`anchorMechanism.js:29`) resolves the table via `path.join(__dirname,'..','..','references','anchor_mechanism_pairs.json')`. In the EMR the vendored copies sit together, so the vendored `anchorMechanism.cjs` needs a one-line path tweak OR (cleaner) the vendor script rewrites that single constant to `path.join(__dirname, 'anchor_mechanism_pairs.json')`. **Decision: the vendor script applies a pinned, asserted path-rewrite** (it asserts the exact source line exists before replacing — fails loud if the source moved). `.cjs` extension because the EMR backend is ESM (`"type":"module"` implied by `.js` imports with `.js` suffixes); the vendored CommonJS resolver loads via `createRequire`.

**`scripts/vendor-anchor-table.mjs`** (new; the ONLY way to update the vendored copies — never hand-edit):
1. Read the 4 canonical files from a configurable `--from <flatratenexus-project path>` (default the sibling checkout).
2. Copy `conditionCanon.js`→`.cjs` and the table JSON byte-identical.
3. Copy `anchorMechanism.js`→`.cjs` with EXACTLY ONE asserted rewrite: the `ARTIFACT_PATH` line. Assert the pre-image line is present verbatim; if not, abort ("source resolver changed shape — re-author the vendor rewrite").
4. Copy the schema byte-identical.
5. Recompute `sha256(JSON.stringify({rows,preference_rank}))` of the copied table; assert `=== 58f9c315…`; abort on mismatch.
6. Print the 4 destination paths + the hash. Post the vendor commit SHA to `shared/outbox` so the Ask-Aegis + website windows pull the identical copy (GOTCHA: all three lanes pin the SAME `58f9c315…`).

**CI hash test** `backend/src/__tests__/anchor-table-pin.test.ts` (vitest, red build on drift):
```ts
const PINNED_TABLE_HASH = '58f9c315340214c27867995ddaf0bf0f9dcc9e08b48d8178ae111023e21b401f';
const PINNED_SCHEMA_SHA256 = '<sha256 of caseViability.v1.schema.json bytes — fill at author time>';
// 1. field check: vendored table.content_hash === pin
expect(table.content_hash).toBe(PINNED_TABLE_HASH);
expect(table.row_count).toBeGreaterThanOrEqual(500);     // §6 risk-1 stub guard
// 2. integrity check: recompute, so a tampered content_hash field can't pass
const recomputed = createHash('sha256').update(JSON.stringify({ rows: table.rows, preference_rank: table.preference_rank })).digest('hex');
expect(recomputed).toBe(PINNED_TABLE_HASH);
// 3. schema byte-pin (mirrors case-framing.test.ts:23,31)
expect(createHash('sha256').update(readFileSync(schemaUrl)).digest('hex')).toBe(PINNED_SCHEMA_SHA256);
// 4. resolver-reads-vendored-table smoke: assessClaimViability('Obstructive sleep apnea',['PTSD']).viability === 'strong'
//    AND .table_content_hash === pin (proves the vendored resolver loads the vendored table, not a stray copy)
```

---

## 3. (d) deriveCaseViability producer + stamp + worker copy-through + flag gate

### 3.1 Pure producer — `backend/src/services/case-viability.ts`
```ts
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const anchorMechanism = require('./vendor/anchorMechanism.cjs') as {
  assessClaimViability(claimed: string, grantedScConditions: string[], chartFacts?: unknown): CaseViability;
};

export const CASE_VIABILITY_VERSION = 1 as const;
export type ViabilityBand = 'strong'|'moderate'|'conditional'|'weak'|'abstain'|'redirect';
// ... interfaces mirroring the 14-key shape (G3) + optional derivedAt + optional best_anchor.mechanism_member

/**
 * PURE. Reuses the grantedScAnchors the framing producer already built (one derivation feeds both —
 * design §3d). chartFacts omitted in v1 (G9: EMR has no chart-fact normalization yet → info_light).
 * derivedAt is NOT added here (kept out of the pure fn for determinism, exactly like caseFraming) —
 * the route adapter stamps it.
 */
export function deriveCaseViability(
  claimedCondition: string,
  grantedScAnchors: ReadonlyArray<{ condition: string }>,
  chartFacts?: unknown,
): CaseViability {
  const grantedNames = grantedScAnchors.map((a) => a.condition);
  // assessClaimViability is fail-open by construction (returns abstain on a bad/stub table) — never throws.
  return anchorMechanism.assessClaimViability(claimedCondition, grantedNames, chartFacts) as CaseViability;
}
```
Key: `grantedScAnchors` comes from `deriveCaseFraming(...).grantedScAnchors` — the SAME strict-filtered, deduped, granted-only list. No second SC re-filter (the bug class the SSOT eliminates).

### 3.2 Impure adapter — `backend/src/services/case-viability-stamp.ts` (mirrors case-framing-stamp.ts)
```ts
export async function deriveCaseViabilityForCase(db: AppDb, caseId: string): Promise<CaseViability | null> {
  const cf = await deriveCaseFramingForCase(db, caseId);   // REUSE — one derivation
  if (cf === null) return null;                            // fail open
  const c = await fetchClaimedCondition(db, caseId);       // claimedCondition only
  if (c === null) return null;
  return deriveCaseViability(c.claimedCondition, cf.grantedScAnchors);
}

export async function stampCaseViability(
  db: AppDb, caseId: string, bundle: DrafterBundle, opts: { readonly persist: boolean },
): Promise<DrafterBundle> {
  const cv = await deriveCaseViabilityForCase(db, caseId);
  if (cv === null) return bundle;                          // fail open: bundle returned UNSTAMPED
  const stamped = { ...cv, derivedAt: new Date().toISOString() };  // route-stamp derivedAt (G3)
  if (opts.persist) await persistViabilityWhenNull(db, caseId, cv);
  return { ...bundle, caseViability: stamped };
}
```
**Only-when-null persist:** add `caseViabilityBand` (nullable string) + `caseViabilityAnchor` (nullable string) columns to the Case row via a Prisma migration; `persistViabilityWhenNull` writes them ONLY when both are currently null (never clobbers an RN override — same contract as `persistFramingWhenNull`). Persist `cv.viability` and `cv.best_anchor?.upstream_canonical ?? null`. Do NOT persist `redirect`/`abstain` anchor (no best_anchor). **Migration discipline:** Prisma migration committed (the repo's `check-migrations-committed.cjs` gate enforces it); column defaults null.

### 3.3 Stamp sites — `backend/src/routes/drafter.ts` (G12)
Thread AFTER the existing caseFraming stamp at BOTH sites:
- Line ~356 (GET drafter-export, `persist:false`):
  `const stamped = await stampCaseViability(db, caseId, await stampCaseFraming(db, caseId, bundle, { persist: false }), { persist: false });`
- Line ~529 (POST /draft, `persist:true`):
  `const stamped = await stampCaseViability(db, caseId, await stampCaseFraming(db, caseId, bundle, { persist: true }), { persist: true });`
(Or two statements for readability — same effect. The CRITICAL invariant: both blocks land on the same `stamped` bundle written to S3.)

### 3.4 Worker copy-through (P1.5)
The drafter bundle is written to S3 and read by the Fargate wrapper; `DrafterBundle` gains `readonly caseViability?: CaseViability` (mirrors `caseFraming?` at `drafter-bundle.ts:75`). The drafter window's resolver/grounding reads `bundle.caseViability` if present; absence = legacy. No EMR-side worker re-write is needed for the CARD (the card reads live, G10) — the copy-through is the bundle field for the DRAFTER's consumption. **If** a `chart.caseViability` mirror is later wanted for chart-extract parity, it follows the same `caseFraming?` field pattern; not required for (d)/(e) go-live.

### 3.5 Flag gate — ships DARK
**Flag name: `EMR_CASE_VIABILITY_ENABLED`** (env, default OFF). Wiring:
- The STAMP is harmless even when on (additive bundle field) BUT gate it anyway for clean dark-ship: `if (process.env.EMR_CASE_VIABILITY_ENABLED === 'true') { stamped = await stampCaseViability(...) }` — off ⇒ byte-identical legacy bundle (no `caseViability` key).
- The CARD's GET endpoint: when the flag is off, return `{ data: null }` (card renders nothing). When on, return the live derivation.
- The frontend card reads the endpoint; `null` data ⇒ `return null` (renders nothing) — so the flag controls the whole surface.
- This flag is SEPARATE from the drafter's `ANCHOR_MECHANISM_GATE` (G8 note: the producer + panel activate on their own smoke+Playwright; they do NOT wait on the drafter flag).
- **Activation sequence:** ship dark → smoke + Playwright pass on staging with the flag ON for that environment → flip prod. Revert = flag→false (no redeploy of image needed if read at request time).

### 3.6 Node smoke (vitest) — `backend/src/__tests__/case-viability.test.ts`
- Schema byte-pin + table hash pin (cross-refs §2 test).
- Every golden output (the §5 table) validates against the vendored schema via the copied `validate()` walker (G11).
- **Hatfield golden (REQUIRED):** `deriveCaseViability('Obstructive sleep apnea', [{condition:'Anxiety'},{condition:'Major depressive disorder'},{condition:'Tinnitus'},{condition:'Hypertension'}])` → `viability ∈ {moderate, strong}` AND `best_anchor.upstream_canonical === 'Anxiety / GAD'` AND `best_anchor !== null` (the false-halt class cannot recur). VERIFIED LIVE: returns `moderate`, best `Anxiety / GAD`, confidence `high`.
- Determinism: same input twice → deep-equal sans `derivedAt`.
- Fail-open: a producer fed an empty granted list → `weak`, `best_anchor:null`, no throw.

### 3.7 Playwright — `e2e/viability-stamp.spec.ts`
Drive a staging case through "Send to Drafter"; read the debug/admin export (the same drafter-export GET that stamps `caseFraming`) and assert the exported bundle JSON carries `caseViability` with `version:1` and a `viability` band. (The export endpoint at drafter.ts:356 already returns a presigned bundle URL — fetch + assert the key exists.) If a debug bundle read isn't reachable in e2e, fall back to asserting the GET viability-card endpoint returns a band for that case (proves the same derivation path).

---

## 4. (e) CaseViabilityCard — RN viability panel

### 4.1 Backend GET endpoint — `backend/src/routes/case-viability.ts` (mirrors strategy-preview.ts)
```
GET /api/v1/cases/:id/viability-card   requireRole(['admin','ops_staff','physician'])
→ flag off  → { data: null }
→ case 404  → 404
→ else      → { data: deriveCaseViabilityForCase(db, caseId) }   // live, info-light (G9)
```
Read-only; never mutates. `deriveCaseViabilityForCase` returns null when the case row vanished → `{ data: null }` (card renders nothing — fail open, design §5.3 "viability read unavailable").

### 4.2 Frontend API client — `frontend/src/api/case-viability.ts` (mirrors strategy-preview.ts)
Export the `CaseViability` TS interface (the 14-key shape) + `getCaseViability(caseId): Promise<{ data: CaseViability | null }>` hitting the endpoint above. **The vet-facing-leak guard is structural in the resolver** (design §9 SF-3 blocks BVA/win rate/grant rate/%/IMO/pair-atlas across `why`+`excluded_traps.reason`+`missing_fact`) — the card does NOT need its own scrubber, but the e2e asserts no BVA % renders as a belt-and-suspenders check.

### 4.3 Component — `frontend/src/components/CaseViabilityCard.tsx`
Pattern-mirror `StrategyPreviewCard.tsx`: `useQuery(['case', caseId, 'viability-card'], () => getCaseViability(caseId))`; `const v = q.data?.data; if (!v) return null;`. Render (RN-internal audience — `M_eff`/`tier` allowed, BVA NEVER):
- **Band chip** via the shared `StatusChip`: strong→`good`, moderate→`good`, conditional→`warn`, weak→`bad`, abstain→`neutral` ("Needs RN review"), redirect→`info` ("Redirect").
- **best_anchor line:** `<upstream_verbatim> → <claimed_canonical>` + `(M<M_eff> <tier>)`. When `best_anchor.E === null` render "E: not yet scored" (NEVER "0"/"no evidence" — design §9 SF-4). When `best_anchor === null`, omit the line (weak/abstain/redirect).
- **why:** plain-language line verbatim from `v.why`.
- **missing_fact:** when non-null, render as "To strengthen: <missing_fact>" (this string IS the records-request justification — §4 RN doc / CLAUDE.md #16).
- **excluded_traps:** a collapsed "Why not these anchors" list — each `<upstream_canonical>: <reason>` (the "why not the knee/tinnitus" expectation-management tool).
- **alternatives:** "Other eligible anchors: <upstream_canonical> (M<M_eff>)" list.
- **presumptive_redirect / graveyard_redirect:** when set, a one-line callout ("Consider presumptive: <note>" / "Redirect: argue <redirect_to> instead of <dead_anchor>").
- **NEVER** a BVA %, IMO rate, pair-atlas tier number, or the word "pair-atlas" (CLAUDE.md #17). `M_eff`/`tier`/`E` are fine for this RN/physician audience.
- Mount in `SendToDrafterPanel.tsx` immediately after `<StrategyPreviewCard ... />` (line 113): `<CaseViabilityCard caseId={caseId} />`. Pre-draft, advisory, never gates the button (like StrategyPreviewCard).

### 4.4 Playwright — `e2e/rn-viability-panel.spec.ts` (AC-1..AC-5, the "actually wired" proof)
Runs against staging (`E2E_BASE_URL` / `emr.flatratenexus.com`), `login(page)`, `page.goto('/cases/<id>')`, assert on rendered body text (mirrors `predraft-verify.spec.ts`). **REQUIRES 5 seeded staging cases** (see Risk R1):
- **AC-1 strong:** case claims OSA, granted PTSD → body contains "Strong" AND "PTSD" AND ("Obstructive sleep apnea" or "OSA"); body does NOT match `/\b\d{1,3}%/` near the anchor / no "BVA" / no "pair-atlas".
- **AC-2 weak/trap:** claims OSA, only granted Tinnitus → body contains "Weak"; the excluded-traps list contains "Tinnitus" + a "no credible mechanism"/"No physiologic pathway" reason. (Verified resolver: tinnitus is excluded → `weak`, best_anchor null, tinnitus in excluded_traps.)
- **AC-3 conditional:** claims lumbar back, granted Knee, gait NOT documented → body contains "Conditional" AND the `missing_fact` substring (e.g., "gait"/"altered weight-bearing"/"varus"). (Verified: info-light knee→back = conditional, missing_fact = the gait string.)
- **AC-4 Hatfield:** supplemental + Anxiety-70% + OSA → body contains a sound anchor ("Anxiety" or "PTSD") and does NOT contain "no service-connected condition"/"no SC condition". (Verified: best `Anxiety / GAD`, moderate.)
- **AC-5 presumptive redirect:** Gulf-War-theater vet claiming IBS → body contains "Redirect" AND "presumptive"/"3.317". NOTE (G9): info-light has NO service_profile, so info-light IBS+PTSD = `conditional` with an ADVISORY presumptive note, NOT a hard `redirect`. To get a hard "Redirect" band the card needs chart-refined service_profile — which the EMR does not yet have (G9). **AC-5 disposition:** assert the ADVISORY presumptive note renders ("a presumptive path may apply"/"3.317") on the info-light card; the hard-redirect band is deferred to the chart-refined follow-on. Flag this to Ryan — AC-5's verbatim "Redirect" band is a chart-refined behavior, advisory in info-light.

---

## 5. Golden / correctness suite (the determinism + band table)

Each row is a vitest fixture in `case-viability.test.ts` (mirrored from the drafter's `anchorViability.test.js`). Inputs are `(claimedCondition, grantedScConditions[])` info-light unless noted. **All bands below were VERIFIED by running the live resolver during planning.**

| Case | Input | Expected (VERIFIED) | Asserts |
|---|---|---|---|
| Strong | OSA, [PTSD] | `strong`, best=PTSD M4 blessed, conf=high | headline; info-light strong only for blessed M4 |
| Weak/trap | OSA, [Tinnitus] | `weak`, best_anchor=null, Tinnitus in excluded_traps | excluded never ranks; honest no-anchor |
| Conditional | Lumbar / back, [Knee] | `conditional`, missing_fact=gait string, M_eff 3 | §C1 contingency, info-light |
| Hatfield | OSA, [Anxiety,MDD,Tinnitus,HTN] | `moderate`, best=`Anxiety / GAD`, conf=high | psych collapse picks Anxiety; false-halt can't recur |
| Presumptive advisory | IBS, [PTSD] (info-light) | `conditional`, presumptive_redirect.advisory=true, path GW_3317 | §3.0 advisory in info-light |
| Empty granted | OSA, [] | `weak`, best_anchor=null | no anchor honest |
| Umbrella | "sleep-wake disorder", [PTSD] | `abstain`, missing_fact="a specific diagnosis…" | §3.5 phenotype split |
| Graveyard (blocked) | Hypertension, [PTSD] | `abstain`, graveyard_redirect.redirect_blocked=true | §3.2; dead anchor + no granted target → park |
| Determinism | any, run twice | deep-equal sans derivedAt | no LLM/clock branch |

Cross-repo determinism (§5.2): the same inputs run against the VENDORED resolver in the EMR test must produce the same band as the drafter canonical — the table hash pin + this golden table prove the three copies agree.

---

## 6. RN workflow doc section (build-order step 9)

Add to `docs/COMPACT_EMR_RN_WORKFLOW_UI_GAPS_BRIEF.md` (or a new `docs/RN_VIABILITY_PRESCREEN.md` linked from it) a **"Viability pre-screen (read the CaseViabilityCard)"** step, inserted in the flow:

> intake → **viability pre-screen (info-light card)** → records gathering (driven by `missing_fact`) → chart parse → [chart-refined card — FOLLOW-ON] → Gate-1 readiness → Send to Drafter → **Gate-2 SUPERSEDES** on any contradiction → draft.

Content (verbatim guidance for the doc):
1. **At intake (info-light):** as soon as claimed condition + granted SC conditions are known, the card shows an info-light band. Use it to set expectations and spot a `redirect`/`weak`/`abstain` case BEFORE the $50 review work and before drafting.
2. **`missing_fact` is the records-request justification.** A `conditional` band names the ONE record that raises it (e.g., documented gait alteration for knee→back). Request exactly that, with the one-line WHY — CLAUDE.md Records-Minimalism #16. Never bulk-request.
3. **The card is ADVISORY, never a gate.** It never blocks the button. **Gate-2 (deep document verification) SUPERSEDES** it on any contradiction — the card is a structured-data preliminary signal; Gate-2 reads the full OCR.
4. **`excluded_traps` = the expectation-management tool.** When a vet insists "connect my OSA to my tinnitus," the card gives the plain reason it won't fly and the `best_anchor` gives the path that will.
5. **NON-promise discipline:** the band is an internal strategy signal. The RN does NOT quote a band/% to the vet as a guarantee. Vet-facing language is the public tool's conservative output. The card never shows a BVA number; the RN never invents one.

---

## 7. Build order (EMR window)

1. Vendor set + `vendor-anchor-table.mjs` + `anchor-table-pin.test.ts` (§2). Red-build on drift FIRST — nothing wires to an unpinned table.
2. Author + vendor `caseViability.v1.schema.json`; compute + pin its sha256 in the test (§1, §2).
3. `case-viability.ts` pure producer + `case-viability.test.ts` golden/schema/Hatfield/determinism (§3.1, §3.6, §5).
4. Prisma migration: `caseViabilityBand` + `caseViabilityAnchor` nullable columns; commit (migration gate).
5. `case-viability-stamp.ts` adapter + thread both drafter.ts stamp sites behind `EMR_CASE_VIABILITY_ENABLED` (§3.2-3.5).
6. `DrafterBundle.caseViability?` field (§3.4).
7. `e2e/viability-stamp.spec.ts` (§3.7).
8. GET `/api/v1/cases/:id/viability-card` route + client + `CaseViabilityCard.tsx` + mount (§4).
9. `e2e/rn-viability-panel.spec.ts` AC-1..AC-5 (§4.4) — requires the 5 seeded staging cases.
10. RN workflow doc section (§6).
11. tsc-gate every commit (`ERRS=$(tsc --noEmit | grep -c error); if [ "$ERRS" = 0 ]; then commit; fi` — never `echo "$(tsc)"`).
12. Activate: flag ON in staging → smoke + Playwright green → flip prod.

---

## 8. Test plan summary (the "actually wired" bar)

| Layer | Test | Proves |
|---|---|---|
| Pin | `anchor-table-pin.test.ts` | vendored table+schema byte-identical to canonical; row_count≥500; resolver loads vendored table |
| Producer | `case-viability.test.ts` | every golden validates against schema; Hatfield band correct; determinism; fail-open |
| Stamp | `e2e/viability-stamp.spec.ts` | a real "Send to Drafter" run carries `caseViability` in the bundle/card |
| Panel | `e2e/rn-viability-panel.spec.ts` AC-1..AC-5 | the RN UI renders the right band on a live path, no BVA % |

---

## 9. Risks + §9 BLOCKER-2 implications

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| R1 | **AC-1..AC-5 need 5 seeded staging cases** with exact granted-SC profiles (OSA+PTSD, OSA+only-Tinnitus, lumbar+Knee no-gait, OSA+Anxiety70%+others, GW-IBS). Without them the Playwright proof can't run. | HIGH | Before step 9, seed/identify 5 staging cases (reuse the predraft-verify.spec pattern of real `CLM-…` ids). List the case ids in the spec. If staging seeding is blocked, add a backend-unit equivalent (call `deriveCaseViabilityForCase` against a seeded test DB) as the interim proof and mark the Playwright AC as pending until cases exist. |
| R2 | **§9 BLOCKER-2 (schema authored from sketch, not bytes).** If the schema were hand-authored from design §1.1 it would MISS `presumptive_redirect.advisory`, `graveyard_redirect.redirect_blocked`, `best_anchor.mechanism_member`, and would wrongly require `derivedAt` / constrain `basis` to `3.310(a)`. | HIGH | §1 of THIS plan authors the schema from the VERIFIED real bytes (G3-G6). The `case-viability.test.ts` validates EVERY golden output against it — a sketch-derived schema fails that test immediately. This is the BLOCKER-2 reconciliation made mechanical. |
| R3 | **AC-5 hard-redirect needs chart-refined service_profile the EMR lacks (G9).** | MED | AC-5 asserts the ADVISORY presumptive note in info-light; hard `redirect` band deferred to the chart-refined follow-on. Flagged to Ryan in §4.4. |
| R4 | **Table re-curation rotates the `58f9c315…` pin.** Every literal (schema `const`, vendor script assert, 2 test pins) must move together or red-build. | MED | Intended drift alarm. Document the 4 literal sites in the vendor script header so a recuration updates all in one commit. The website + Ask-Aegis windows pin the same hash — coordinate via shared/outbox. |
| R5 | **Vendored impure module leak.** Accidentally vendoring framingGate (G8) would drag better-sqlite3 + llm/client into the Lambda. | MED | Vendor set is the 4 files in §2 ONLY; the vendor script copies exactly those. A grep-guard in the pin test asserts `backend/src/vendor/` contains no `better-sqlite3`/`llm` import. |
| R6 | **Confidence semantics surprise:** Hatfield returns `confidence:high` on a `physician_reviewed:false` row (the band-confidence rule keys on tier+mode, not the row flag for the info-light-blessed branch). | LOW | Document in the card: `confidence` is a band/mode signal, not a physician-review attestation. The `physician_reviewed:false` data-level state is separate (Ryan's curation pass). Do not surface "physician reviewed" wording on the card. |
| R7 | **ESM/CJS interop** loading the vendored `.cjs` resolver in the ESM backend. | LOW | `createRequire(import.meta.url)` (shown in §3.1) is the standard interop; the resolver is plain CommonJS with no ESM-only deps. |

---

## 10. The §9 BLOCKER-2 implication, stated plainly

BLOCKER-2 changed how the schema is authored: it must match the resolver's ACTUAL emitted bytes, not the design §1.1 sketch, because the schema is sha-pinned across THREE repos BEFORE any of them validate against it — so a wrong schema is a cross-repo red build that blocks all three windows. This plan authors §1's schema from the verified live output (G3-G6), and the producer test (§3.6) validates every golden against it, so the schema-vs-bytes reconciliation is enforced mechanically, not by inspection. The four bytes-vs-sketch deltas that BLOCKER-2 implies and this plan bakes in: (1) `derivedAt` optional+route-stamped, (2) `best_anchor.requires` emitted, (3) `best_anchor.E` nullable, (4) `presumptive_redirect.advisory` + `graveyard_redirect.redirect_blocked` + `best_anchor.mechanism_member` present, `basis` un-constrained (`3.310a` not `3.310(a)`).

---

**NEXT ACTION:** Execute step 1 (vendor set + `vendor-anchor-table.mjs` + `anchor-table-pin.test.ts`) — establish the red-build-on-drift pin BEFORE any consumer wires; in the same pass author + sha-pin `caseViability.v1.schema.json` from the verified bytes in §1, and seed/identify the 5 AC staging cases (R1) so step 9's Playwright proof is unblocked.
