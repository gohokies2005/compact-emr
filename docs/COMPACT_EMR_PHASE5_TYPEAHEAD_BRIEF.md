# Compact EMR — Phase 5 UI Brief: ICD-10 + Medication Typeahead

**Lane:** ChatGPT (UI / Tailwind). Backend already shipped — endpoints + create/delete routes are live on `main` (commits `807db32` + `3270b75` + `e3d4249`).

You are working in the private repo `gohokies2005/compact-emr`. Pull latest `main`. UI-only — do not touch backend.

## What you're building

A typeahead control for chart entry on the Veteran Chart page (`/veterans/:id`, `frontend/src/routes/veterans/VeteranChart.tsx`). Two panels need it:

- **Active problems panel** — typeahead returns ICD-10 codes. Picking a row writes both `problem` (display text) AND `icd10` (the code). Free-text fallback is allowed (icd10 stays null).
- **Active medications panel** — typeahead returns medications. The result list mixes a bare-no-dose row with dose-variant rows for the same drug. Picking a dose-variant row pre-fills the `dose` field; picking the bare row leaves dose empty. Free-text drug name is allowed if the typeahead doesn't match.

## Live API contract

```
GET /api/v1/lookup/icd10?q=<query>&limit=<1-50>
  -> 200 { data: { query, count, results: Icd10Entry[] } }

GET /api/v1/lookup/medications?q=<query>&limit=<1-50>
  -> 200 { data: { query, count, results: MedicationEntry[] } }
```

```ts
interface Icd10Entry {
  code: string;          // e.g. "I10", "G47.33", "F43.10"
  display: string;       // e.g. "Essential (primary) hypertension"
  synonyms: string[];    // e.g. ["HTN","hypertension","high blood pressure"]
}

interface MedicationEntry {
  drugName: string;      // e.g. "Amlodipine", "Amlodipine 5 mg"
  genericName: string;   // e.g. "amlodipine"
  dose: string | null;   // e.g. "5 mg" — null on bare rows
  form: string | null;   // e.g. "tablet", "injection", "MDI"
  class: string;         // e.g. "antihypertensive (CCB)"
  synonyms: string[];    // brand names — e.g. ["Norvasc"]
}
```

Sub-millisecond response. Roles allowed: admin, ops_staff, physician.

## Create / delete contract (already wired)

```
POST   /api/v1/veterans/:id/problems
       Body: { problem: string, icd10?: string, notes?: string }
       -> 201 { data: ActiveProblem }
DELETE /api/v1/veterans/:vid/problems/:pid -> 204

POST   /api/v1/veterans/:id/medications
       Body: { drugName: string, dose?: string, frequency?: string, indication?: string }
       -> 201 { data: ActiveMedication }
DELETE /api/v1/veterans/:vid/medications/:mid -> 204
```

`icd10` must match `^[A-Z][0-9]{2}(\.[A-Z0-9]{1,4})?[A-Z0-9]?$` if present; backend uppercases it. `dose`, `frequency`, `indication` are all optional — empty strings are stored as null. Roles: admin + ops_staff.

## UI requirements

### Problems typeahead

- Input: as the user types, debounce 200ms then `GET /lookup/icd10?q=...&limit=10`.
- Dropdown list: each row shows `code · display`. If `synonyms` would have matched the query, show the matched synonym in a small italic suffix.
- Selecting a row populates the form with `{ problem: result.display, icd10: result.code }`.
- A "Use as free text" affordance below the list — clicking it (or pressing Enter when no row is highlighted) submits the user's raw query as `problem` with `icd10: null`.
- Validation: backend rejects malformed icd10 with 400. Surface the error message inline next to the field.
- Submit POSTs to `/api/v1/veterans/:id/problems`; on success invalidate `['veteran', id]` query and reset the form.

### Medications typeahead

- Input: same debounce + endpoint (`/lookup/medications`).
- Dropdown list: each row shows `drugName` (which already includes the dose for variant rows) + `class` muted on the right + brand-name synonyms italic.
- The bare-no-dose row is intentionally first in the result set when scores tie — present it as such (do not re-sort).
- Selecting a bare row (where `dose === null`) opens the form with `drugName` filled and dose empty.
- Selecting a variant row (e.g. "Amlodipine 5 mg") fills `drugName: "Amlodipine 5 mg"` AND `dose: "5 mg"`.
- Two optional fields stay visible regardless of which row was picked: **Frequency** (e.g. "PO daily") and **Indication** (e.g. "HTN"). User can leave them empty.
- A "Use as free text" affordance for unmatched drugs — submits whatever the user typed as `drugName`.
- Submit POSTs to `/api/v1/veterans/:id/medications`; invalidate `['veteran', id]` on success.

### Existing panels

Both panels render existing problem/medication rows below the add form. Add a small delete button (trash icon, `Button variant="ghost" size="sm"`). Confirm via `window.confirm` then DELETE the row.

## Visual / Tailwind

- Reuse `Card`, `Button`, `Spinner`, `EmptyState`. Match the existing `ChartNotesPanel.tsx` styling tone.
- Typeahead dropdown: `absolute z-10 mt-1 w-full max-h-72 overflow-auto rounded-md border border-slate-200 bg-white shadow-lg`. Hover row `bg-slate-100`. Selected row `bg-indigo-50 text-indigo-800`.
- ICD-10 code: muted slate (`text-slate-500 font-mono text-xs mr-2`).
- Drug class on the right: `text-xs text-slate-400 ml-auto`.

## Constraints

- TypeScript strict + `exactOptionalPropertyTypes` clean. No `any`.
- Tailwind only.
- TanStack Query for the lookup fetches (key `['lookup', 'icd10', q]`). Mutations for create/delete.
- Additive — extend `frontend/src/routes/veterans/VeteranChart.tsx` ProblemsPanel + MedicationsPanel; don't rewrite.
- Add a typeahead-test for each panel (renders dropdown on typing; picking a row populates the form; "use as free text" works).
- No PHI in `console.log`.

## Deliverables

1. ProblemTypeahead + MedicationTypeahead components.
2. ProblemsPanel + MedicationsPanel extended with typeahead + add form + delete button.
3. `frontend/src/api/lookup.ts` (new) + `frontend/src/api/chart.ts` (new) with helpers + types.
4. Tests for typeahead picking behavior.
5. `docs/PHASE5_TYPEAHEAD_UI_SUMMARY.md` + evidence under `docs/verification/phase5-typeahead-ui-evidence/`.

Run: `npm run typecheck -w frontend && npm run lint -w frontend && npm run test -w frontend`. Stop and ask only if the data shapes above differ from what you find on `main`.
