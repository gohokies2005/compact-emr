# Compact-EMR Frontend Brief — Multi-Physician (for the GPT UI window)

Build these three UI areas. The backend is **built, tested, committed, and live-bound** (all endpoints below exist on the API). React + Vite + TS, TanStack Query, the existing `apiGet/apiPost/apiPatch/apiDelete/apiPut` in `frontend/src/api/client.ts`. Match existing pages (VeteranChart, CaseDetailPage) for look/feel.

## Conventions (all endpoints)
- Auth: handled by the existing `apiClient` (Bearer token auto-attached). Don't touch it.
- Success envelope: `{ data: ... }` (lists may add sibling fields, e.g. `unreadCount`).
- Error envelope: `{ error: { code, message, details? } }`. Codes you'll see: `bad_request` (400), `forbidden` (403), `not_found` (404), `conflict` (409), `internal_error` (5xx).
- **Optimistic concurrency**: PATCH/assign endpoints take `version`; on 409 (`ConflictError` is already thrown by the client) reload the row and re-apply. Mirror how CaseDetailPage handles it.
- Roles: `admin`, `ops_staff`, `physician`. Use the existing `ProtectedRoute requiredRole={[...]}` + `useAuth()`.

---

## AREA 1 — Physician Profiles (admin)
A new admin page (route e.g. `/physicians`, `requiredRole={['admin']}`) to manage physician profiles. The `PhysiciansPage` stub exists — replace it.

**Type** `PhysicianPublic`:
```ts
{ id: string; cognitoSub: string | null; fullName: string; npi: string; specialty: string;
  medicalLicense: string; email: string; phone: string | null; hasSignature: boolean;
  active: boolean; createdAt: string; updatedAt: string; version: number }
```

**Endpoints:**
| Method | Path | Body | RBAC | Notes |
|---|---|---|---|---|
| GET | `/api/v1/physicians` | — | admin, ops_staff | `{ data: PhysicianPublic[] }` (also the physician picker for assignment) |
| GET | `/api/v1/physicians/:id` | — | admin, ops_staff | `{ data: PhysicianPublic }` |
| POST | `/api/v1/physicians` | `{ fullName, npi, specialty, medicalLicense, email, phone?, cognitoSub? }` | admin | 201. **409** if npi or cognitoSub already exists (`details.field` = `'npi'` or `'cognitoSub'`). NPI must be 10 digits (else 400). |
| PATCH | `/api/v1/physicians/:id` | `{ version, fields: { fullName?, npi?, specialty?, medicalLicense?, email?, phone?, cognitoSub?, active? } }` | admin | 409 stale version; 409 deactivating with in-flight cases (`details.inFlightCount`). |

**Signature upload (PNG only)** — 3-step, mirror the document upload flow in `VeteranChart.tsx`:
1. `POST /api/v1/physicians/:id/signature/presign` body `{ contentType: 'image/png', sizeBytes }` → `{ data: { uploadUrl, s3Key, expiresInSeconds, requiredHeaders } }`. (admin)
2. `PUT uploadUrl` with the raw PNG bytes + `requiredHeaders` (content-type + x-amz-server-side-encryption). (Same as `uploadToPresignedUrl`.)
3. `POST /api/v1/physicians/:id/signature` body `{ s3Key }` (echo it back) → `{ data: PhysicianPublic }` (now `hasSignature: true`). (admin)
- Preview: `GET /api/v1/physicians/:id/signature/download` → `{ data: { downloadUrl, expiresInSeconds } }`. (admin)
- **Enforce PNG in the file input** (`accept="image/png"`); JPG is rejected by the API (a JPG signature prints a white box on the letter).

**Page:** a table of physicians (name, NPI, specialty, active, ✓signature), a "New physician" form (the create fields), an edit drawer (PATCH with version), a signature upload control + preview, and an active/inactive toggle (show the 409 in-flight message when blocked).

---

## AREA 2 — Case Assignment (admin / ops_staff)
On the case detail / veteran chart, show **assigned physician** + **assigned RN liaison**, each with an "Assign / Reassign" control.

| Method | Path | Body | RBAC |
|---|---|---|---|
| POST | `/api/v1/cases/:id/assign-physician` | `{ physicianId, version }` | admin, ops_staff |
| POST | `/api/v1/cases/:id/assign-rn` | `{ rnUserId, version }` | admin, ops_staff |

- Both return `{ data: <case lite> }` (the case now includes `assignedPhysician {id, fullName, email}` and `assignedRn {id, email}`). 409 on stale version.
- **Physician picker** = `GET /api/v1/physicians` (ready). 
- **RN picker** ⚠️ **dependency**: needs a `GET /api/v1/users?role=ops_staff` endpoint that does **not exist yet** (it pairs with the Cognito user-lifecycle work). For now build the physician assignment fully; for the RN control, leave a placeholder/disabled picker and I'll wire the users-list endpoint next. Don't block on it.
- **Admin triage view**: `GET /api/v1/cases?status=physician_review&assignedPhysicianId=__none__` lists shippable-but-unassigned cases (the `__none__` sentinel also works for `assignedRnId`). Surface this as an "Unassigned" filter so cases never hide.

---

## AREA 3 — In-chart Messaging Panel (RN ↔ physician)
A per-case message thread on the case detail screen, **distinct from chart notes**. Visible only to the assigned RN, the assigned physician, and admin (the API enforces this — a non-participant gets 403; render that as "not available").

**Type** `CaseMessage`:
```ts
{ id: string; caseId: string; senderSub: string; senderRole: 'physician'|'ops_staff'|'admin';
  body: string; readAt: string | null; readBySub: string | null; createdAt: string }
```

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/v1/cases/:id/messages` | — | `{ data: CaseMessage[] (asc by createdAt), unreadCount }` — `unreadCount` = messages not sent by me + unread |
| POST | `/api/v1/cases/:id/messages` | `{ body }` (non-empty, ≤4000) | `201 { data: CaseMessage }` |
| POST | `/api/v1/cases/:id/messages/mark-read` | `{ upToMessageId? }` | `{ data: { markedCount } }` — flips only the *other* party's unread messages |

**Panel:** a chronological thread (sender attribution via `senderRole` + relative time — reuse `formatRelativeTime`), a compose box (Save → POST), an unread badge from `unreadCount`, and call `mark-read` when the panel is opened/viewed. PHI is expected in messages (clinical) — no client-side scrubbing. Poll or refetch on focus (TanStack Query `refetchOnWindowFocus`); no websockets.

---

## AREA 4 — Letter editor entry points (carryover, small)
The editor route `/cases/:id/letter` + `LetterEditorPage` already exist. Still needed:
1. Add an **"Edit text"** button to `PhysicianLetterReadyPanel` (`onEditText?`) and wire `onEditText={() => navigate('/cases/' + encodeURIComponent(c.id) + '/letter')}` in `CaseDetailPage` + `PhysicianReviewPage`.
2. Rewrite `LetterEditorPage.test.tsx` to the shipped `api/letter.ts` contract (structured `proposal` + `preview`, `warnings:[{rule,detail}]`, `costUsd`, `applySurgicalAi(caseId, proposal)`).

---

## What's NOT ready yet (don't build against these)
- `GET /users` (RN picker) — coming with user-lifecycle.
- Per-signer credentials in the rendered letter (D2, backend, in progress) — no UI impact; the editor/PDF just start showing the assigned physician's block once D2 lands.
- The render Lambda + surgical-AI key aren't deployed, so in non-prod the editor's Save/Surgical-AI return a clean 503 — handle that gracefully (toast "not available in this environment").
