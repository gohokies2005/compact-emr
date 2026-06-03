# UI Brief — Pre-Draft Essential-Docs Popup ("no silent deaths")

Audience: ChatGPT (builds the compact-EMR frontend). Backend is built + deployed (flag-guarded).
Goal (Ryan, 2026-06-03): a chart-incomplete draft must NEVER be a silent death or a cryptic code.
Before drafting, confirm the essential documents are on file; if one is missing, show a VERY obvious,
plain-language alert — never AI-vague, never long, never code-like.

## When it fires
On the case page, when the RN clicks **"Send to drafter"**. Do NOT immediately POST the draft.
First call the readiness endpoint and show this popup.

## Backend contract (already live)

### GET `/api/v1/cases/:id/draft-readiness`  (Cognito; admin/ops_staff)
Returns:
```json
{ "data": {
  "ready": false,
  "summary": "Essential documents missing: Service-connected conditions. Please upload and redraft.",
  "items": [
    { "key": "sc_conditions", "label": "Service-connected conditions", "present": false,
      "message": "Essential documents missing: Please upload the VA rating decision (the letter that lists each service-connected condition) and redraft." },
    { "key": "current_diagnosis", "label": "Current diagnosis", "present": true },
    { "key": "in_service_event", "label": "In-service event / service record", "present": true }
  ],
  "missing": [ { "key": "sc_conditions", "label": "...", "message": "..." } ]
} }
```
- `denial_letter` item only appears when the claim is an appeal (supplemental/HLR/BVA).
- `message` is present only on missing items, and is the EXACT text to show. Do not rewrite it.

### POST `/api/v1/cases/:id/draft`  (Cognito; admin/ops_staff)
Body (all optional): `{ "acknowledgeMissingDocs": true, "overrideReason": "..." , "strategyOverride": "...", "parentVersion": N }`
- If essentials are missing AND `acknowledgeMissingDocs` is not true → **409** with
  `error.code === "essential_docs_missing"`, `error.message` = the plain summary, and
  `error.details.missing[]` / `error.details.items[]` (same shape as GET) + `details.canOverride: true`.
- Sending `acknowledgeMissingDocs: true` (+ optional `overrideReason`) proceeds and logs the override.
- (Note: the blocking 409 only activates once ops enables `DRAFT_READINESS_GATE=on`. Until then POST
  /draft never 409s on this. Build the popup against GET now; it works regardless of the flag.)

## The popup — two states

### State A — all present (`ready: true`)
A simple confirmation. List each item with a green check + label. One line at top:
**"Confirm the essential documents are on file:"** Each row has a checkbox (default checked) the RN
can leave checked. Buttons: **[Send to drafter]** (primary) and [Cancel]. On Send → POST /draft.

### State B — something missing (`ready: false`)
A VERY obvious alert. Red/amber banner at top showing each missing item's `message` verbatim, e.g.:

> **Essential documents missing**
> Please upload the VA rating decision (the letter that lists each service-connected condition) and redraft.

Below: the full checklist (green check = present, red X = missing) so the RN sees the whole picture.
Buttons:
- **[Upload documents]** (primary) — routes to the case's document upload. After upload, the RN
  reopens the popup (it re-checks). This is the expected happy path: upload → redraft.
- **[Draft anyway]** (secondary, less prominent) — opens a small required text field
  *"Why are you proceeding without these documents?"*; on submit → POST /draft with
  `acknowledgeMissingDocs: true` + `overrideReason`. Use this for the rare case the RN knows the
  doc isn't needed. (Honors RN self-service; the override is logged.)
- [Cancel].

## Style rules (Ryan, hard)
- Plain English. No codes, no IDs, no "AI"-sounding hedging, no long paragraphs.
- Show the backend `message` strings VERBATIM — they are the approved wording.
- The missing-docs alert must be impossible to miss (color + icon + top of the dialog).
- Never a spinner-that-never-resolves or a generic "something went wrong." This popup IS the
  resolution of what used to be a silent halt.

## Also: handle the 409 on POST /draft
Even outside this popup (e.g. a direct re-draft), if POST /draft returns 409
`essential_docs_missing`, render State B from `error.details` rather than a generic error toast.
