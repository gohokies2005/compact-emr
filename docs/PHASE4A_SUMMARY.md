# Phase 4A Summary — Case Backend Routes

## Files touched

12 files in backend and docs scope only:

1. `backend/src/routes/cases.ts` — new Express case routes.
2. `backend/src/services/case-validation.ts` — new request validators.
3. `backend/src/services/case-status-transitions.ts` — new transition table and role gate helpers.
4. `backend/src/services/db-types.ts` — extended structural database types for case work.
5. `backend/src/server.ts` — mounted `createCasesRouter(defaultPrisma)` under `/api/v1`.
6. `backend/src/__tests__/cases-routes.test.ts` — new route tests with mock DB.
7. `backend/src/__tests__/case-status-transitions.test.ts` — new pure transition tests.
8. `docs/PHASE4A_SUMMARY.md` — this summary.
9. `docs/verification/phase4A-evidence/typecheck.txt` — typecheck evidence note.
10. `docs/verification/phase4A-evidence/test-output.txt` — test evidence note.
11. `docs/verification/phase4A-evidence/phase4A.patch` — generated patch bundle.
12. `docs/verification/phase4A-evidence/server-registration-note.patch` — server registration patch.

## Implemented

- Case list, detail, create, patch, soft-delete routes.
- Status transition endpoint with explicit transition matrix.
- Transition role gates:
  - `physician_review -> delivered`: physician or admin.
  - `physician_review -> correction_requested`: physician or admin.
  - `delivered -> paid`: admin only.
  - all other transitions: admin or ops_staff.
- `transitionReason` replaces `note`.
- `transitionReason` max length is 200 characters.
- `transitionReason` rejects SSN-shaped, phone-shaped, and email-shaped values with `400 bad_request`.
- DELETE keeps existing soft-delete behavior by setting `status = rejected`.
- DELETE writes distinct activity action `case_soft_deleted`.
- Soft-delete activity details include `previousStatus`.
- Status transition activity action remains `case_status_changed`.
- Activity details use IDs, field names, status values, and validated operational audit metadata only.
- `GET /cases/:id/corrections` is admin + ops_staff only.
- Physician own-assigned access is intentionally deferred.

## Explicitly skipped

- No frontend files touched; Phase 4A backend-only scope.
- No schema migration; DELETE uses `status = rejected` per brief.
- No AppUser ↔ Physician mapping; deferred to Phase 5.
- No `deleted_at`; activity log timestamp is the deletion timestamp.
- No CDS, Stripe, draft viewer, email send, refund processing, or UI work.

## Assumptions made

- `CaseStatus` remains a literal union in `services/db-types.ts`; no generated Prisma enum import.
- Prisma relation names are camelCase: `documents`, `draftJobs`, `corrections`, `emails`, `payments`, `assignedPhysician`, `veteran`.
- Optimistic lock field is `case.version`.
- `currentVersion` is not modified by routine case PATCH/status updates.
- Activity log delegate is `db.activityLog`.
- Soft-deleted cases remain visible in `/cases` as ordinary rejected cases.

## Test results

The artifact was generated in a sandbox without the full private repository, package workspace, or installed project dependencies. I could not truthfully run `npm run typecheck -w backend` or `npm run test -w backend` against the real repo here.

Evidence files explicitly state this limitation and list the commands that should be run after applying the patch in the repo.

## Known caveats

- `backend/src/services/db-types.ts` is supplied as a modified structural type file. If the current repo already contains additional exported types, merge the added Case-related types into the existing file rather than replacing unrelated existing exports.
- `backend/src/server.ts` is supplied as a direct modified file and a small registration patch. If current main has additional middleware or route mounts, apply only the import and `app.use('/api/v1', createCasesRouter(defaultPrisma));` registration.
