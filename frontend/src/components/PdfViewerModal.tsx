import { useQuery } from '@tanstack/react-query';
import { viewDocument } from '../api/veterans';
import { Button } from './ui/Button';

export interface ViewableDoc { readonly id: string; readonly filename: string; readonly contentType?: string }

/**
 * In-page document viewer — opens a PDF/image INSIDE the EMR (full-screen modal with an iframe),
 * not a Chrome download and not a new tab. RNs can't manage downloaded files, so files must be
 * viewable in-place. Uses an inline-disposition presigned URL (disposition=inline) so the browser
 * renders the PDF instead of saving it.
 */
export function PdfViewerModal({ doc, onClose }: { readonly doc: ViewableDoc | null; readonly onClose: () => void }) {
  const q = useQuery({ queryKey: ['doc-view', doc?.id], queryFn: () => viewDocument(doc!.id), enabled: doc !== null });
  if (doc === null) return null;
  const url = q.data?.data.downloadUrl;
  const isImage = (doc.contentType ?? '').startsWith('image/');
  return (
    <div role="dialog" aria-modal="true">
      <div className="fixed inset-0 z-40 bg-slate-900/60" onClick={onClose} />
      <div className="fixed inset-4 z-50 flex flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2">
          <span className="truncate text-sm font-medium text-slate-800">{doc.filename}</span>
          <div className="flex shrink-0 items-center gap-3">
            {url ? <a className="text-xs text-indigo-600 hover:underline" href={url} target="_blank" rel="noreferrer">Open in new tab</a> : null}
            <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
          </div>
        </div>
        <div className="flex-1 overflow-auto bg-slate-100">
          {q.isError ? (
            <div className="p-6 text-sm text-rose-600">Could not load this file. Try again.</div>
          ) : !url ? (
            <div className="p-6 text-sm text-slate-500">Loading…</div>
          ) : isImage ? (
            <img src={url} alt={doc.filename} className="mx-auto block max-h-full" />
          ) : (
            <iframe title={doc.filename} src={url} className="h-full w-full border-0" />
          )}
        </div>
      </div>
    </div>
  );
}
