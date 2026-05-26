# Phase 8 UI notes

## What landed

- In-flight drafter panel for queued/running DraftJob states.
- Physician letter-ready panel for `runComplete=true`, `shipRecommendation='ship'`, and `status='physician_review'`.
- Ops-held panel for admin/ops review when the drafter completes with concerns.
- Send-back-to-RN modal for major rework requests.
- Drafter API helper for `POST /api/v1/cases/:id/draft`.
- Phase 8.1 polling on the case-detail query for pre-draft case statuses.
- Presigned URL expiry wrapper and reusable `DownloadButton`.

## Integration notes

- Do not expose linter findings, failure classes, phase IDs, or internal drafter taxonomy to physicians.
- Disclosure cards must remain read-only and must never show `suggested_fix`.
- The `Open PDF` action is wired to the new backend endpoint `GET /api/v1/cases/:id/draft-jobs/:jobId/artifact-pdf-url` (returns a 5-min presigned GET URL for the DraftJob's `artifactPdfS3Key`). Do not hardcode any other signed-URL endpoint inside the panel; use the API helper `getArtifactPdfUrl()`.
- The `Edit text` action is intentionally disabled until the Phase 8.1 editor surface ships.
- `CaseDetailPage.tsx` mounts these panels additively below the CDS/viability area and above the tab bar.

## Type notes

The Phase 8 fields are in `frontend/src/types/prisma.ts`:

- `Case.grade` / `probativeScore` / `shipRecommendation` / `operatorState` / `runComplete` / `operatorMessage`
- `DraftJob.currentPhase` / `gradeSidecarJson` / `artifactPdfS3Key` / `manifestSnapshot` / `nextRetryInS` / `failureClass` / `strategyOverride` / `parentVersion` / `bundleS3Key` / `lastHeartbeatAt` / `workerId` / `artifactTxtS3Key` / `artifactDocxS3Key`

Add new fields to the existing interfaces rather than casting in the UI.

## Tests

11 component tests + 2 client tests + 3 CaseDetailPage polling tests cover the Phase 8 surface. The `PhysicianLetterReadyPanel` test specifically asserts that the disclosure region contains zero `<button>` elements — locks in Ryan's hard rule (doctors never get choose-A-or-B prompts).

## Followups (not yet shipped)

- Wire `DownloadButton` into the existing Doctor Pack / document download surfaces if the current pattern fails to handle 5-min expiry gracefully.
- Optional toast when polling detects a new `manual_summary_required` file mid-view (G2 enhancement).
