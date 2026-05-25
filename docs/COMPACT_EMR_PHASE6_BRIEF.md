# Compact EMR — Phase 6 Brief: Tailwind UI for the Phase 5 surfaces

**Lane:** ChatGPT (Tailwind / UI). Backend already shipped — all endpoints are live on `main`. Do NOT touch backend. Do NOT alter Prisma. Do NOT add new routes.

You are working in `gohokies2005/compact-emr`. Pull latest `main`.

## Why this brief exists

Phase 5 shipped five backend pieces with no UI yet (the CDS panel and physician self-access already landed in Phase 5 commits — those are NOT in Phase 6). This brief covers what ChatGPT builds for the remaining surfaces:

1. **ICD-10 + Medication typeahead** (separate brief already at `docs/COMPACT_EMR_PHASE5_TYPEAHEAD_BRIEF.md` — that's still your starting point; this Phase 6 brief extends it with the rest).
2. **Sign-off popup** — gates the "Finalize letter" action.
3. **Clarification queue panel** — raise / list / resolve.
4. **Viability gate panel** — surface the four-verdict result.
5. **Physician 3-page view** — focused workflow surface, not just a tab.

You can ship these as 5 separate PRs or one bundled PR; recommend separate so reviews are tractable.

---

## Visual / Tailwind tone — apply across all five surfaces

Reuse existing primitives — `Card`, `Button`, `Spinner`, `EmptyState`, `CaseStatusBadge`, `TabBar`. Do not introduce new component libraries.

- Container: `rounded-lg border border-slate-200 bg-white p-6 shadow-sm` (matches existing `Card`).
- Section heading: `text-base font-semibold text-slate-800`.
- Muted descriptor: `text-sm text-slate-500`.
- Primary action: `Button variant="primary"` (indigo-600).
- Destructive action: `Button variant="destructive"` (rose-600). Confirmation via `window.confirm` before fire.
- Spacing rhythm: `space-y-4` inside cards, `space-y-6` between cards on a page.
- Status badge tones — match the existing palette used by `CaseStatusBadge`:
  - accept / resolved / viable: emerald
  - caution / clarify: amber
  - reject / not_viable: rose
  - pending / dismissed: slate
  - needs_from_vet: blue

### Tailwind for popups / overlays (sign-off + confirmation modals)

- Backdrop: `fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm`.
- Dialog: `fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-2xl`.
- Header: title `text-lg font-semibold text-slate-900` + close-X button (ghost). Body: `mt-4 space-y-3`. Footer: `mt-6 flex justify-end gap-2`.
- Trap focus inside dialog. Esc closes. Backdrop click does NOT close (intentional — too easy to lose state mid-sign-off).

---

## 1. Sign-off popup

### Endpoint contract (already live)
```
POST /api/v1/cases/:id/sign-off          roles: admin, physician
  Body: { answers: { [questionKey: string]: boolean }, notes?: string }
  -> 201 { data: SignOff }
GET  /api/v1/cases/:id/sign-offs         roles: admin, ops_staff, physician (assigned)
  -> 200 { data: SignOff[] }            (latest first; the active one is index 0)
```

`answers` accepts 1–10 entries. The popup MUST show no more than **five** plain-English questions — FRN HARD RULE per `feedback_signoff_popup_clean_filename.md`. If your popup ever exceeds 5, you are doing it wrong.

### Question set (recommended starting list, refine with Ryan)
```ts
const SIGN_OFF_QUESTIONS = [
  { key: 'records_reviewed',     label: 'I reviewed all uploaded records and the chart.' },
  { key: 'diagnosis_documented', label: 'The claimed diagnosis is documented in the records.' },
  { key: 'nexus_supported',      label: 'Medical literature supports a connection at >50% probability.' },
  { key: 'no_phi_in_letter',     label: 'The letter contains no PHI that should not be in it.' },
  { key: 'final_pdf_correct',    label: 'The final PDF preview is correct (name, condition, date).' },
] as const;
```

### UI behavior
- Popup is opened by a "Sign off" button on the Case Detail page, visible only when `case.status === 'physician_review'` AND `case.cdsVerdict !== 'reject'`.
- Each question renders as a single-row Yes/No pill pair. Default unselected.
- Disable submit until every visible question has an explicit answer (NO ambiguity).
- Optional free-text "notes" `<textarea>` below the questions.
- On submit, POST to `/cases/:id/sign-off`. On 201, invalidate `['case', id]` AND `['case', id, 'sign-offs']`. Show a toast "Signed off. The letter is ready to finalize."
- After sign-off, the button label flips to "Finalize letter" — clicking it calls the **existing** `POST /cases/:id/status` to transition `physician_review -> delivered`. That status transition is SEPARATE from sign-off and stays the gate for delivery.
- Filenames stay clean (no `ALERT_` prefix). Sign-off does NOT touch filenames — it is purely an audit + workflow signal.

### Tailwind specifics
- Yes/No pills: `inline-flex rounded-full border border-slate-200 px-3 py-1 text-sm`. Selected Yes: `bg-emerald-100 text-emerald-800 border-emerald-300`. Selected No: `bg-rose-100 text-rose-800 border-rose-300`.

---

## 2. Clarification queue panel

### Endpoint contract (already live)
```
POST  /api/v1/cases/:id/clarifications
  Body: { audience: 'physician'|'ops_staff'|'veteran', question: string }
  -> 201 { data: Clarification }
GET   /api/v1/cases/:id/clarifications?status=open|resolved|dismissed
  -> 200 { data: Clarification[] }   (newest first; filter optional)
PATCH /api/v1/clarifications/:id/resolve
  Body: { status: 'resolved'|'dismissed', resolution?: string }
  -> 200 { data: Clarification }
```

### UI surface

Add a new tab `clarifications` to the existing `TabBar` on Case Detail (`/cases/:id`):
- Tab label: "Clarifications" + a small count badge if there are open ones.
- Tab body: a card with:
  - Header row: filter chips (All / Open / Resolved / Dismissed), default Open.
  - "Raise clarification" button (top-right) → opens a small inline form.
  - Inline form fields: audience radio (physician / ops_staff / veteran), question textarea (max 800 chars, character counter), Cancel / Submit buttons.
  - List of clarifications below the form. Each row:
    - Audience pill (color-coded: physician=indigo, ops_staff=slate, veteran=blue).
    - Question text (multi-line ok, truncate at 3 lines with "show more").
    - Raised by + relative time.
    - If open: "Resolve" + "Dismiss" buttons.
    - If resolved/dismissed: resolution text below + resolver + resolved time.

### Behavior
- TanStack Query key `['case', id, 'clarifications', statusFilter]`. Mutation invalidates on success.
- Resolving prompts a small modal with optional resolution textarea + status pill (resolved / dismissed). The PATCH endpoint accepts either.
- Veteran-audience clarifications display an additional info banner: "This will appear in the records-request the veteran receives." (Hook for a future records-request email; the email itself is not in scope of Phase 6.)
- 409 (already resolved) is handled by refetching and showing toast "This clarification was already resolved."

---

## 3. Viability gate panel

### Endpoint contract (already live)
```
POST /api/v1/cases/:id/viability         roles: admin, ops_staff, physician
  -> 200 { data: ViabilityResult }
```

```ts
interface ViabilityResult {
  verdict: 'go' | 'clarify' | 'needs_from_vet' | 'not_viable';
  cdsVerdict: 'accept' | 'caution' | 'reject' | 'not_yet_run';
  blockers: {
    code: 'no_diagnosis_on_file' | 'cds_not_run' | 'cds_reject'
        | 'no_assigned_physician' | 'no_upstream_for_secondary' | 'chart_records_pending';
    severity: 'block' | 'warn';
    detail: string;
  }[];
  recommendations: string[];
  checkedAt: string;
  gateVersion: string;
}
```

### UI surface

Add a Viability Gate **section** to the Case Detail header area, immediately under the CDS panel:
- Header: "Pre-draft viability" + verdict badge (color per palette above).
- Body when `verdict === 'go'`: emerald check + "Ready to draft. No blockers." + small "Run again" link.
- Body otherwise: blocker list. Each blocker row:
  - Severity icon (block = rose ✕, warn = amber ⚠).
  - `code` rendered as plain language (don't show the snake_case key — provide a friendly label map).
  - `detail` muted text.
- Recommendations list below blockers, bulleted, with a small "→" prefix.
- Footer: "Checked <relative time>" + "Re-run viability" button (calls POST).

### Behavior
- TanStack Query mutation; key `['case', id, 'viability']`.
- The button is disabled when the case status is `delivered`, `paid`, or `rejected`.
- The result is NOT persisted on the case — every call is fresh. If you cache, scope the cache to the page lifetime, not across navigations.

### Friendly-label map
```ts
const VIABILITY_BLOCKER_LABELS = {
  no_diagnosis_on_file:      'No diagnosis recorded',
  cds_not_run:               'CDS has not been run',
  cds_reject:                'CDS rejected this case',
  no_assigned_physician:     'No physician assigned',
  no_upstream_for_secondary: 'Upstream condition missing for secondary framing',
  chart_records_pending:     'Records are still being gathered',
};
```

---

## 4. Physician 3-page view

A focused workflow surface for the physician role. Designed to be the page a physician lives in.

### Pages

Single route `/physician` (only physicians + admins see the link in nav):

- **Page 1: Inbox.** List of cases assigned to the logged-in physician where status is `physician_review` or `correction_requested`. Show: vet name, claimed condition, days since assignment, CDS badge, viability badge. Click → Page 2.
- **Page 2: Case workbench.** Same data as Case Detail but laid out for physician work. Top: header card (vet, condition, status). Middle: CDS panel + Viability gate + Sign-off button (the existing components, reused). Bottom: Drafts list (link to PDF) + Corrections list + Clarifications panel. Sidebar: chart summary (top 5 problems, top 5 meds, SC conditions).
- **Page 3: Sign-off + finalize.** Triggered from Page 2 sign-off button. After successful sign-off, automatically advance to status `delivered` via the existing status transition endpoint. Show a success state with "Back to inbox" CTA.

### Constraints

- Routes: `/physician`, `/physician/cases/:id`, `/physician/cases/:id/sign-off` (the modal is shown on top of `/physician/cases/:id`; the third "page" is conceptual, not a new URL).
- Pages 1 + 2 reuse the same data already on `/cases` and `/cases/:id`. NO new endpoints required for this view.
- Nav gating: only show `/physician` in the AppShell nav when `user.role === 'physician'` or `user.role === 'admin'`.
- Mobile-friendly: page 2 collapses sidebar below the main column on `< lg` breakpoint.

---

## 5. ICD-10 + Medication typeahead

See `docs/COMPACT_EMR_PHASE5_TYPEAHEAD_BRIEF.md` for full spec. Phase 6 inherits that brief unchanged.

---

## Deliverables (across the five surfaces)

For each surface, ship in its own PR:
1. The component(s) + integration.
2. Tests under `frontend/src/__tests__/` (renders + happy-path mutation).
3. A summary doc under `docs/PHASE6_<surface>_UI_SUMMARY.md` + evidence under `docs/verification/phase6-<surface>-evidence/`.

### Per-PR required gates (you must pass before opening the PR)

- `npm run typecheck -w frontend` → exit 0.
- `npm run lint -w frontend` → exit 0 (zero warnings; `--max-warnings=0`).
- `npm run test -w frontend -- --run` → all green.
- TypeScript strict + `exactOptionalPropertyTypes` clean. No `any`.
- Tailwind only — no inline styles, no CSS modules.
- No PHI in `console.log`.
- Additive — extend existing pages; do not rewrite wholesale.

## Out of scope for Phase 6

- Veteran-facing email composition (placeholder hook only; full email-out endpoint is Phase 7+).
- Records-request workflow (clarification audience=veteran is the upstream hook; the email is Phase 7+).
- Letter PDF generator (the "final PDF" the sign-off popup gates is still the existing flow; replacement PDF generator is Phase 7+).
- OCR escape valve (the FRN main project has it shipped at `commit 3ddb9d5`; port comes later, not in Phase 6).

## Open questions ChatGPT should resolve in the PR description, not pre-clarify here

- Final wording for the five sign-off questions (Ryan will edit copy after first render).
- Whether the clarification queue belongs as a Case Detail tab or as a global `/clarifications` page (recommend tab first; can promote later).
- Whether the physician inbox lives at `/physician` or replaces the current `/cases` for the physician role (recommend new path; do not break ops_staff workflow).
