# Phase 8.1 brief — Frontend polish for RN self-service (G2 + G3)

**Audience:** ChatGPT (Tailwind UI builder). Backend changes for these gaps are minimal — the work is almost entirely frontend.

**Build split:** Claude does backend + this brief; ChatGPT delivers the React/Vite components + tests + paste-ready code. Then Claude wires it in.

**Hard rule context:** This brief addresses two gaps from the RN self-service audit ([[rn-self-service-no-ryan-workarounds]]). The bar both gaps must clear:

> "If this fails or hits an edge case at 2pm on a Tuesday with no Ryan around, can the RN handle it through the EMR UI alone?"

---

## G2 — Case Detail page must auto-refresh pre-draft state

### Failure mode being closed

When a veteran uploads records, Textract OCR runs async. If Textract fails on a document (e.g., scanned image-only PDF, corrupted file), the OCR worker POSTs to `/api/v1/internal/documents/:id/read-attempt-failed`, which creates a `FileReadStatus` row with `terminalStatus='manual_summary_required'`. The RN's manual-summary queue picks it up.

**The gap:** if the RN is viewing the Case Detail page when this happens, they don't see the new "manual summary required" flag until they manually refresh. They might click "Send to Drafter" thinking the chart is ready, get a 409 (chart-readiness gate), and not understand why.

### What to build

Add **TanStack Query auto-refetch** to the Case Detail page's main query when the case is in a pre-draft state. The states that need polling:
- `case.status === 'records'`
- `case.status === 'viability'`
- `case.status === 'drafting'`

For all other statuses (`physician_review`, `correction_requested`, `delivered`, `paid`, `rejected`, `intake`, `needs_physician_library_build`), no polling — state changes for those happen via user action, not async worker callbacks.

### Implementation sketch

```ts
// frontend/src/routes/cases/CaseDetailPage.tsx (or wherever the main case query lives)

const POLLING_STATUSES = new Set<CaseStatus>(['records', 'viability', 'drafting']);
const POLL_INTERVAL_MS = 8_000; // 8 seconds — balance freshness with API load

const caseQuery = useQuery({
  queryKey: ['case', caseId],
  queryFn: () => getCase(caseId),
  refetchInterval: (query) => {
    const status = query.state.data?.data?.status;
    return status && POLLING_STATUSES.has(status) ? POLL_INTERVAL_MS : false;
  },
  refetchIntervalInBackground: false, // pause when tab is hidden — be polite
});
```

The existing `GET /api/v1/cases/:id` returns the case with FileReadStatus and Document arrays via Prisma `include`. No backend changes needed — the polling just refetches that query.

### Optional: visual signal that a refresh happened

If a `FileReadStatus.terminalStatus` flipped from `read` (or null) to `manual_summary_required` between two polls, show a brief toast:

> "A new file needs a manual summary — see RN queue."

Detection: keep the previous query data, compare lengths/IDs of `manualSummaryRequired` files. Don't toast on first load.

### Tests

Vitest + Testing Library:
1. **Polling fires on `records` status**: mock the API, render the page with `case.status='records'`, assert the query refetches after 8 seconds (use `vi.useFakeTimers()`).
2. **Polling does NOT fire on `physician_review` status**: same setup, assert no refetch.
3. **Polling pauses when tab hidden**: dispatch `visibilitychange` with `document.hidden=true`, assert no refetch.

---

## G3 — Presigned URL expiry shows "Link expired" instead of "Something went wrong"

### Failure mode being closed

Presigned S3 download URLs are valid for 5 minutes. If the RN opens a Doctor Pack download link, gets distracted, comes back 6 minutes later and clicks Download → S3 returns 403 with `<Code>AccessDenied</Code>` (or sometimes `<Code>Request has expired</Code>`). The frontend's axios error handler shows a generic toast like "Something went wrong" with no indication that simply requesting the link again will work.

### What to build

Axios response interceptor that detects expired-presigned-URL errors and converts them to a recoverable error type the UI can handle gracefully.

### Detection rules

A response is an expired-presigned-URL error if ALL of:
1. The response status is **403**.
2. The request URL hostname looks like S3 (`*.s3.*.amazonaws.com` or `*.amazonaws.com/X-Amz-Signature=`).
3. The response body (if XML) contains `<Code>AccessDenied</Code>` or `<Code>Request has expired</Code>`.

Confidence boost (not required): the request URL contains `X-Amz-Signature=` AND `X-Amz-Date=` (presence of presigned-URL query params).

### Implementation sketch

```ts
// frontend/src/api/client.ts (axios interceptor)

const PRESIGNED_URL_HOST_PATTERN = /\.amazonaws\.com$/i;
const PRESIGNED_URL_PARAM_PATTERN = /X-Amz-Signature=/;

interface PresignedUrlExpiredError extends Error {
  isPresignedUrlExpired: true;
}

axios.interceptors.response.use(
  (response) => response,
  (error) => {
    if (axios.isAxiosError(error) && error.response?.status === 403) {
      const url = new URL(error.config?.url ?? '', window.location.origin);
      const hostnameMatches = PRESIGNED_URL_HOST_PATTERN.test(url.hostname);
      const paramsMatch = PRESIGNED_URL_PARAM_PATTERN.test(url.search);
      if (hostnameMatches && paramsMatch) {
        const wrapped: PresignedUrlExpiredError = Object.assign(
          new Error('Download link expired'),
          { isPresignedUrlExpired: true as const, cause: error },
        );
        return Promise.reject(wrapped);
      }
    }
    return Promise.reject(error);
  },
);
```

### UI handling

Any component that triggers an S3 download (Doctor Pack PDF, document download) should catch the wrapped error and show:

> "Download link expired — click Download again."

with a Retry button that re-fetches a fresh presigned URL via the appropriate backend endpoint (e.g., `GET /api/v1/cases/:id/doctor-pack/latest` returns a new signed URL each call; `GET /api/v1/documents/:id/download` returns a new one each call). NO Ryan involvement needed.

### Tests

1. **Expired URL response → wrapped error**: mock axios to return 403 from an S3 URL with `X-Amz-Signature=`, assert the rejected error has `isPresignedUrlExpired: true`.
2. **Non-S3 403 → original error**: mock axios to return 403 from `/api/v1/cases/X`, assert the error is NOT wrapped.
3. **UI shows friendly message**: render a download component, trigger the wrapped error, assert "Download link expired" + Retry button render.

---

## Files to create / modify (estimates)

| File | Action |
|---|---|
| `frontend/src/routes/cases/CaseDetailPage.tsx` | Add `refetchInterval` logic to the main case query |
| `frontend/src/api/client.ts` | Add the axios response interceptor for presigned-URL detection |
| `frontend/src/components/DownloadButton.tsx` (NEW or existing) | Handle wrapped error → show friendly message + Retry |
| `frontend/src/__tests__/CaseDetailPage.test.tsx` | Polling tests |
| `frontend/src/__tests__/client.test.ts` | Interceptor tests |
| `frontend/src/__tests__/DownloadButton.test.tsx` | UI tests |

---

## What NOT to build

- Server-Sent Events / WebSockets — 8-second polling is good enough and simpler. Save SSE for when poll volume becomes a measurable cost.
- A general retry-all-403s mechanism — many 403s should fail loud (auth issues, role-gate violations). Only S3-signed-URL 403s get the recovery path.
- A "refresh page" prompt — the polling makes this automatic. Don't add a button the RN has to remember to click.
- Any RN-facing display of `FileReadStatus.attemptsJson` — that's a debug field with Textract internals; surface only `terminalStatus` and `manualSummary`.

---

## Done criteria

- Case Detail page auto-updates within 8 seconds when a file flips to `manual_summary_required` mid-view.
- Tab-hidden polling correctly pauses.
- Stale presigned-URL clicks show "Download link expired — click Download again" with a working Retry button.
- 6 new Vitest tests pass.
- The RN never sees "Something went wrong" for these two failure modes.
