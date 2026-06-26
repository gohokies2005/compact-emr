import { useQuery } from '@tanstack/react-query';
import { getLetter } from '../api/letter';
import { Button } from './ui/Button';

/**
 * In-page viewer for the rendered NEXUS LETTER PDF (full-screen modal + iframe), NOT a new tab.
 *
 * Why this exists (Dr. Kasky 2026-06-26 — "the doctor app does not open a PDF when clicked unless in
 * edit mode"): the physician pages opened the letter via `window.open(url)` AFTER an `await getLetter()`.
 * A `window.open` that runs in a later microtask (post-await) is no longer inside the user-gesture, so
 * mobile browsers + the installed PWA silently block it — nothing happens. The desktop editor "worked"
 * because it renders the PDF INLINE (iframe), never a popup. This modal makes the review surfaces behave
 * the same way: fetch a fresh inline-disposition presigned URL, render it in an iframe, no popup at all.
 *
 * Mounts only when `caseId` is non-null (parent toggles it), and re-fetches a fresh presigned URL each
 * open so an expired URL never bites.
 */
export function LetterPdfModal({ caseId, onClose }: { readonly caseId: string | null; readonly onClose: () => void }) {
  const q = useQuery({
    queryKey: ['letter-pdf', caseId],
    queryFn: () => getLetter(caseId!),
    enabled: caseId !== null,
    // Presigned PDF URLs expire (~5 min). Always refetch a fresh one on open so a reopen of the
    // same case never iframes a stale/expired URL from cache.
    staleTime: 0,
  });
  if (caseId === null) return null;
  const url = q.data?.data.rendered?.pdfUrl;
  return (
    <div role="dialog" aria-modal="true">
      <div className="fixed inset-0 z-40 bg-slate-900/60" onClick={onClose} />
      <div className="fixed inset-2 z-50 flex flex-col overflow-hidden rounded-lg bg-white shadow-2xl sm:inset-4">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2">
          <span className="truncate text-sm font-medium text-slate-800">Nexus letter (PDF)</span>
          <div className="flex shrink-0 items-center gap-3">
            {url ? (
              <a className="text-xs text-indigo-600 hover:underline" href={url} target="_blank" rel="noreferrer">Open in new tab</a>
            ) : null}
            <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
          </div>
        </div>
        <div className="flex-1 overflow-auto bg-slate-100">
          {q.isError ? (
            <div className="p-6 text-sm text-rose-600">Could not load the letter PDF. Try again, or flag this case to Dr. Ryan.</div>
          ) : q.isLoading || !q.data ? (
            <div className="p-6 text-sm text-slate-500">Loading the letter…</div>
          ) : !url ? (
            <div className="p-6 text-sm text-amber-700">The letter PDF is not ready yet. If it persists, flag this case to Dr. Ryan.</div>
          ) : (
            <iframe title="Nexus letter" src={url} className="h-full w-full border-0" />
          )}
        </div>
      </div>
    </div>
  );
}
