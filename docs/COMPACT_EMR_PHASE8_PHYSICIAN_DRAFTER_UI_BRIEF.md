# Phase 8 brief — Physician Case Detail UI for the drafter integration

**Audience:** ChatGPT (Tailwind UI builder). Claude wrote the backend; this brief covers
the React/Vite frontend surfaces.

**Build split:** Claude does backend + API contract + this brief. ChatGPT delivers the
React components + tests + paste-ready code.

**Hard rules — read these first:**
1. **Doctors NEVER get unfinished or "choose A or B" letters.** The system already made the
   best decision. Any "close-call" disclosure is **read-only** — never a button that asks the
   doctor to choose. The doctor's actions are: open PDF, edit text, approve & sign, or
   (rarely) send the whole letter back to the RN for major rework.
2. **The doctor is never shown linter findings about em-dashes, commas, label lengths, etc.**
   Those are auto-fixed during the linter pass. They never surface.
3. **The doctor sees at most 3 disclosure cards**, drawn from
   `DraftJob.gradeSidecarJson.targeted_revision_hints` (capped server-side at 3 by the
   drafter grader). If there are zero hints, the card section is hidden entirely.

---

## Endpoints already shipped (consume these)

```
GET  /api/v1/cases/:id                       Cognito  -> existing CaseDetail (now includes
                                                         probativeScore, grade,
                                                         shipRecommendation, operatorState,
                                                         runComplete)
GET  /api/v1/cases/:id/draft-jobs            Cognito  -> existing list (now includes
                                                         manifestSnapshot, currentPhase,
                                                         gradeSidecarJson, artifact*S3Key,
                                                         strategyOverride, parentVersion)
POST /api/v1/cases/:id/draft                 admin/ops_staff
       body: { strategyOverride?: string, parentVersion?: number }
       -> 201 { data: { job, publish } }
```

The drafter wrapper running on Fargate hits `/internal/drafter/*` routes; the UI never
calls those directly.

---

## Surface A — In-flight calm panel

**When to render:** Case Detail header area, when there's a DraftJob with
`state in ('queued', 'running')`. Replaces the "Send to drafter" button while in flight.
Poll the case detail (or just `DraftJob`) every 8s via TanStack Query while in flight.

**Visual:**
```
┌───────────────────────────────────────────────────────────┐
│  Drafting the letter…                                      │
│  Reading the records and finding the medical literature.   │
│                                                            │
│  ●○○○○   (subtle progress dots; not a real progress %)    │
│                                                            │
│  Started 4 minutes ago. We'll let you know when it's done. │
└───────────────────────────────────────────────────────────┘
```

**State → message mapping** (derive from `DraftJob.currentPhase` +
`DraftJob.nextRetryInS`):
```
preflight | index_consult | source_lock | framing_gate    → "Reading the records and finding the medical literature."
drafter                                                    → "Drafting the opinion."
adversary_panel | specialist_gate | refine_loop |
  surgical_edit                                            → "Running the medical review."
citation_scoring | pmid_verify                             → "Verifying every citation."
linter | qa_report                                         → "Final polish."
grader | render                                            → "Finishing the document."
(nextRetryInS > 0 on any phase)                            → append: "Taking a bit longer — we're re-running this step automatically."
```

If `currentPhase` is unset (no progress yet), show: "Getting started."

**NO percentage bars. NO phase IDs. NO failure-class jargon.** Calm UI.

---

## Surface B — Letter ready (terminal: runComplete && shipRecommendation='ship')

**When to render:** `Case.runComplete === true && Case.shipRecommendation === 'ship' &&
Case.status === 'physician_review'` and the user is the assigned physician (or admin).

**Visual:**
```
┌──────────────────────────────────────────────────────────────┐
│  Letter is ready for your review                              │
│  Grade: A-   Probative score: 8/10                            │
│                                                                │
│  [ Open PDF ]     [ Edit text ]     [ Approve & sign ]        │
│                                                                │
│  Three things the system chose for you on close calls:        │
│  • Section VI — preferred pediatric-onset framing over        │
│    genetic-predisposition language.                            │
│  • Section VII — kept aggravation as a secondary prong.       │
│  • Section VIII — cited Khurana 2019 over Yang 2021.          │
│                                                                │
│  Need a different overall approach? [ Send back to RN ]       │
└──────────────────────────────────────────────────────────────┘
```

**Component breakdown:**

1. **Header line** — "Letter is ready for your review". Below: `Grade: <grade>` and
   `Probative score: <score>/10` from `Case.grade` + `Case.probativeScore`. Use a subtle
   color for the grade chip (green for A/A-, blue for B+/B, neutral for B-/C+/C). No alarm
   colors anywhere on the happy path.

2. **Action row** (3 buttons):
   - **Open PDF** — opens the artifact at `DraftJob.artifactPdfS3Key` via a signed-URL
     fetch (existing pattern from Doctor Pack download).
   - **Edit text** — navigates to a text editor view (out of scope for this brief — Phase 8.1).
     Until then, button is disabled with tooltip "Coming soon".
   - **Approve & sign** — opens the existing sign-off popup (Phase 6 surface 1, already
     shipped). On success, status transitions to `delivered`.

3. **Disclosure section** — render only if
   `DraftJob.gradeSidecarJson.targeted_revision_hints` is a non-empty array. Header:
   "<N> things the system chose for you on close calls:" where N is 1, 2, or 3 (cap at 3
   even if backend somehow returns more — defensive UI).
   Each card is **plain text, no button, no border, no hover state.** Just a bullet with
   `<section>` and `<issue>` rendered as a single sentence. Do NOT render `suggested_fix`
   from the sidecar — that's drafter-internal reasoning, not for the physician.
   - Card format: `Section <X> — <one-sentence summary of the choice>.`
   - The one-sentence summary is the `issue` field. If `issue` is longer than ~120 chars,
     truncate with ellipsis.

4. **Send back to RN** — small, neutral, bottom-right. Opens a modal with a single
   textarea: "Tell the RN what to change about the overall approach (optional):". On
   submit, calls `POST /api/v1/cases/:id/status` to transition status to
   `correction_requested`, with the textarea content saved to a new chart note (use the
   existing chart-notes endpoint). The RN then has the option to redraft via
   `POST /api/v1/cases/:id/draft` with `strategyOverride` set to that note.
   - The modal headline: "Send back for major rework".
   - Modal copy: "Choose this only if you want a different overall strategy, not for
     small edits. If you want to tweak the letter directly, use Edit text instead."

---

## Surface C — Held in ops queue (terminal: anything other than ship + complete)

**When to render:** `Case.runComplete === false` OR `Case.shipRecommendation === 'revise'`
OR `Case.operatorState !== 'ready' && Case.operatorState !== 'ready_with_notes'`. And the
user is admin/ops_staff (this case does NOT appear in physician views at all).

This surface lives on the Case Detail page for ops_staff/admin only. It is **never seen
by the physician.**

**Visual:**
```
┌──────────────────────────────────────────────────────────────┐
│  ⚠ Held in the ops queue                                       │
│  <operator_message from manifest>                               │
│                                                                  │
│  [ Re-run drafter ]    [ Open as-is (skip ops review) ]       │
│                                                                  │
│  Details ▾                                                     │
└──────────────────────────────────────────────────────────────┘
```

**Operator message:** `Case.operatorState === 'paused'` →
"We've paused this one for a closer look. Nothing's lost — your work is saved and we've
flagged it for the team."
`operatorState === 'needs_one_thing'` → use the `operator_message` stored on the manifest's
needs-human phase row (look it up from `DraftJob.manifestSnapshot.phases.<phaseId>` where
phaseId === `Case.operatorState === 'needs_one_thing' ? <detail_phase from sidecar>`).
For 'paused' or anything else: fall back to "Drafter completed with concerns."

**Details ▾** expands to show grade + ship_recommendation + a one-line per-phase summary
from the manifest (operator-facing only).

**Re-run drafter** calls `POST /api/v1/cases/:id/draft` (no strategyOverride). It will
409 if there's already an in-flight job for this case.

**Open as-is** — admin-only override that flips status to `physician_review` despite the
gate. Audit-logged. Used for edge cases the operator judges as acceptable. Confirms in a
modal first.

---

## TanStack Query shape

```ts
// query keys
['case', id]                    // GET /api/v1/cases/:id
['case', id, 'draft-jobs']      // GET /api/v1/cases/:id/draft-jobs

// when an in-flight job exists, poll every 8s:
useQuery({
  queryKey: ['case', id],
  refetchInterval: (data) => {
    const job = data?.draftJobs?.[0];
    return (job?.state === 'queued' || job?.state === 'running') ? 8000 : false;
  },
});

// mutations
useMutation({ mutationFn: () => postDraft(id) })   // Send to drafter
useMutation({ mutationFn: (body) => postDraft(id, body) })   // Send back to RN -> redraft with strategy
```

On mutation success: invalidate `['case', id]` and `['case', id, 'draft-jobs']`.

---

## Tests required

For each surface, one Vitest + Testing-Library test that mocks the API client and asserts:

1. **In-flight panel** — given a DraftJob with `state='running'` and `currentPhase='drafter'`,
   the panel renders "Drafting the opinion." (the exact mapped message).
2. **Letter ready** — given `runComplete=true`, `shipRecommendation='ship'`,
   `grade='A-'`, `probativeScore=8`, and 3 hints, the panel renders the header + 3 cards.
   Cards have NO `<button>` element inside them.
3. **Held in ops queue (non-physician view)** — given `runComplete=false`, the panel
   renders "Held in the ops queue" and shows the [Re-run drafter] button.
4. **Send back to RN** — clicking the button opens a modal; submitting calls the status
   transition mutation with the textarea content saved as a chart note.

---

## What NOT to build

- The "Edit text" rich-text editor (deferred to Phase 8.1).
- An admin-side manifest viewer (the Details ▾ accordion in Surface C is enough for now).
- Any UI that asks the physician to choose between drafter alternatives.
- Any UI that surfaces linter findings, rule IDs, phase IDs, failure classes, or other
  internal taxonomy to the physician.
- A real-time WebSocket / SSE feed — 8-second polling is good enough.

---

## Files to create / modify

```
frontend/src/components/PhysicianLetterReadyPanel.tsx       (NEW — Surface B)
frontend/src/components/InFlightDrafterPanel.tsx            (NEW — Surface A)
frontend/src/components/OpsHeldPanel.tsx                    (NEW — Surface C)
frontend/src/components/SendBackToRnModal.tsx               (NEW — modal opened from Surface B)
frontend/src/api/drafter.ts                                 (NEW — postDraft, sendBackToRn)
frontend/src/routes/cases/CaseDetail.tsx                    (modify — mount the three panels
                                                              conditionally based on case state)
frontend/src/__tests__/PhysicianLetterReadyPanel.test.tsx   (NEW)
frontend/src/__tests__/InFlightDrafterPanel.test.tsx        (NEW)
frontend/src/__tests__/OpsHeldPanel.test.tsx                (NEW)
```

Existing Tailwind tokens, colors, and component patterns (see Phase 6 surfaces 1 + 2
already shipped) — match those.
