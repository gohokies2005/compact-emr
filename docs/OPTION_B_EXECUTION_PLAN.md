# Option B — execution plan (architect-traced 2026-06-03, NOT yet built)

Frontend-only bundle (B1 + B2 + B3a-frontend) → ONE frontend deploy, NO drafter image. Verified file:line; ready to execute. Ryan's bar: never regress.

## ⚠️ Correction that changes B2
`synthesized_floor` is **NOT in the compact-emr-work repo** — not in `prisma.ts` `DraftGradeSidecarJson` (only has `targeted_revision_hints`/`template_gate_findings`/`detail_phase`), not in backend, not in schema. (Earlier I said "the flag is already on the sidecar" — WRONG.) The backend `/complete` persists the whole `gradeSidecar` wholesale (drafter.ts:687/727), so IF the **drafter worker** starts emitting `synthesized_floor` inside it, it lands untouched. **B2's amber chip is therefore DORMANT until the worker emits the field** (cross-window dependency — the producer is the drafter window, see shared/outbox 2026-06-03 P1-b). Build it additive so it's a no-op until then = zero regression.

## B1 — sortable headers + CSV export (frontend-only)
- New `frontend/src/lib/csv.ts`: pure `escapeCsvField` + `rowsToCsv(headers, rows)` (quote on `/[",\r\n]/`, `"`→`""`, CRLF, prepend `﻿` BOM for Excel UTF-8) + `exportRowsToCsv(filename, headers, rows)` (Blob + temp `<a download>`). CSV only — do NOT add jszip.
- New `frontend/src/lib/useColumnSort.ts`: 3-state (asc→desc→null=server order), `aria-sort`, ▲/▼. **`sortRows` MUST copy (`[...rows].sort`) — sorting `cases.data.data` in place corrupts the TanStack cache (R1, highest risk).** Comparators: text=case-insensitive localeCompare; date=Date.parse ms, null=oldest; number, null=-Inf.
- `CasesPage.tsx`: SERVER-PAGINATED → sort/export = **current page only**. thead@84 → `<button>`+aria-sort; `cases.data.data.map`@86 → `rows.map`; Export button in header@58-61. Cols: Case/id, Veteran/veteran(composed string), Condition/condition, Type/type(label), Status/status(label), Updated/updated(date, export raw ISO), v/version. **Visible note + `console.warn` when `total > pageRows.length`** (no silent truncation, R10).
- `VeteransPage.tsx`: client-side, all loaded rows. thead@26 → buttons; `.map`@27 → `rows.map`; Export near search@24-25. Cols: Veteran/veteran, DOB/dob(date), Branch/branch, Active cases/activeCases(num), Last activity/updatedAt(date); **MRN (v.id) in CSV export only** (not a visible column).
- Tests: `frontend/src/__tests__/csv.test.ts` (escaping/BOM/header round-trip); extend `CasesPage.test.tsx` with a 2-row sort 3-state + indicator/aria test (bump the `listCases` mock to 2 rows). Existing badge-by-`bg-purple-100` test must still pass — only touch `<thead>`, not row `<td>` (R3).

## B2 — grade chip (additive, dormant until worker emits synthesized_floor)
- Widen `prisma.ts:68-72` `DraftGradeSidecarJson` additively: `synthesized_floor?: boolean|null` + `synthesized_floor_reason?: string|null`.
- New `frontend/src/components/ui/GradeChip.tsx`: single source for grade rendering. `synthesizedFloor===true` (coerce strictly, untrusted payload R5) → amber `bg-amber-100 text-amber-800` "Grade unavailable — needs review" (hides the letter, no silent C). Else = move the existing `gradeClassName` logic from PhysicianLetterReadyPanel in (A*=emerald, B+/B=blue, else slate).
- Wire: `PhysicianLetterReadyPanel.tsx:82-84` (replace inline span; delete local gradeClassName); `OpsHeldPanel.tsx:154` (+ widen its local `GradeSidecarJson`@20-22 to add `synthesized_floor?`). Read-only/additive, no state-machine change.
- Tests: `GradeChip.test.tsx` (amber when true hides letter; normal pill when false/absent) + one amber case in each panel test.

## B3a — redraft guard (the 36-row pileup)
- In-flight is ALREADY guarded (409, drafter.ts:374-377). Pileup = repeated re-runs AFTER completion. `postDraft(caseId, input={})` accepts a body (verified).
- **Tonight (frontend, ships in the bundle):** in `OpsHeldPanel.rerunMutation`, before `postDraft`, if a `done` job exists show a confirm dialog (reuse the `confirmOpenAsIs` modal pattern@171-204) → on confirm call `postDraft(c.id, {acknowledgeRedraft:true})`. Add `acknowledgeRedraft?` to `DraftRequestInput`.
- **Fast-follow (backend deploy, NOT tonight):** authoritative gate in `POST /cases/:id/draft` after the in-flight check@382: if a `done` job exists and `!acknowledgeRedraft` → 409 `redraft_confirm_required` (+ `canOverride:true`); add `acknowledgeRedraft` to `parseDraftCreateBody` (mirror `acknowledgeMissingDocs`@409). Backend-enforced = RN-self-service-safe (frontend-only is bypassable).

## B3b — hollow-done — NOT frontend; DEFER to drafter/backend window
Frontend already degrades safely (`viewableLetterJob` skips no-PDF jobs; "View letter" gated on `hasLetter`). Real fix = `/complete` rejects/reclassifies a `done` payload with no `artifactPdfS3Key`. Cross-window — file it, don't half-build from the frontend.

## Verify + deploy
1. `cd frontend && npx tsc --noEmit` (real verify for .tsx) + `npx vitest run` (new tests pass, nothing regresses).
2. Frontend deploy (footgun): `Move-Item .env.local .env.local.bak` → `npm run build` (vite.config hard-fails if VITE_DEMO_MODE/bypass set) → **grep dist/assets/*.js: `us-east-1_z8OFZyBiS` PRESENT + `VITE_DEMO_MODE|DEV_BYPASS|localhost` ABSENT** → `aws s3 sync frontend/dist/ s3://compact-emr-staging-fronten-frontendbucketefe2e19c-gnzby4mq7nac --delete` → `aws cloudfront create-invalidation --distribution-id ET4XMMK4EKSW6 --paths "/*"` → restore `.env.local`.
3. Backend deploy ONLY if B3a backend gate landed (separate runbook). B3b = drafter window.

## Execution order
1. Read `api/drafter.ts`/`cases.ts`/`veterans.ts` shapes (mostly confirmed). 2. csv.ts + useColumnSort.ts. 3. CasesPage. 4. VeteransPage. 5. B1 tests. 6. prisma.ts widen. 7. GradeChip. 8. wire 2 panels. 9. B2 tests. 10. B3a frontend-confirm. 11. tsc + vitest. 12. bundled frontend deploy.
