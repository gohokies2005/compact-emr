import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { viewDocument } from '../api/veterans';
import { Button } from './ui/Button';

export interface ViewableDoc { readonly id: string; readonly filename: string; readonly contentType?: string }

type DocKind = 'pdf' | 'image' | 'text' | 'docx' | 'doc' | 'other';

/** Classify a document for in-page rendering. Extension wins (upload content-types are often a generic
 *  octet-stream); the MIME is a fallback. `.docx` renders inline via mammoth; legacy `.doc` (binary Word,
 *  no browser/JS renderer) falls back to a download with a clear note. */
export function classifyViewableDoc(doc: ViewableDoc): DocKind {
  const name = (doc.filename ?? '').toLowerCase();
  const ct = (doc.contentType ?? '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|tiff?|bmp|heic)$/.test(name) || ct.startsWith('image/')) return 'image';
  if (/\.pdf$/.test(name) || ct === 'application/pdf') return 'pdf';
  if (/\.(txt|md|csv|log|json)$/.test(name) || ct.startsWith('text/')) return 'text';
  if (/\.docx$/.test(name) || ct === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (/\.doc$/.test(name) || ct === 'application/msword') return 'doc';
  return 'other';
}

/**
 * Fetches a text/.docx file from its presigned S3 URL (CORS GET is allowed for the EMR origin) and renders
 * it READ-ONLY, in-page. `.txt` → preformatted text; `.docx` → mammoth converts to HTML in the BROWSER
 * (no server round-trip, nothing leaves the app → PHI-safe) and DOMPurify sanitizes it before render (the
 * file is veteran-uploaded / untrusted). mammoth + DOMPurify are dynamically imported so they only load
 * when a doc is actually opened (main bundle stays lean).
 */
function FetchedDocBody({ url, kind, filename }: { url: string; kind: 'text' | 'docx'; filename: string }) {
  const [state, setState] = useState<{ status: 'loading' | 'error' | 'ready'; html?: string; text?: string }>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (kind === 'text') {
          const text = await res.text();
          if (!cancelled) setState({ status: 'ready', text });
          return;
        }
        const buf = await res.arrayBuffer();
        const [mammoth, dompurifyMod] = await Promise.all([import('mammoth'), import('dompurify')]);
        // dompurify v3 may expose the sanitizer as the module itself or on .default depending on interop.
        const dp = (((dompurifyMod as unknown as { default?: unknown }).default ?? dompurifyMod)) as { sanitize(html: string, opts?: unknown): string };
        const { value } = await mammoth.convertToHtml({ arrayBuffer: buf });
        const clean = dp.sanitize(value, { USE_PROFILES: { html: true } }); // veteran-uploaded → sanitize before render
        if (!cancelled) setState({ status: 'ready', html: clean });
      } catch {
        if (!cancelled) setState({ status: 'error' });
      }
    })();
    return () => { cancelled = true; };
  }, [url, kind]);

  if (state.status === 'loading') return <div className="p-6 text-sm text-slate-500">Rendering {filename}…</div>;
  if (state.status === 'error') return <div className="p-6 text-sm text-rose-600">Could not display this file inline. Use “Open in new tab” or download it.</div>;
  if (kind === 'text') return <pre className="whitespace-pre-wrap break-words p-6 font-mono text-[13px] leading-relaxed text-slate-800">{state.text}</pre>;
  return (
    <div className="mx-auto my-4 max-w-3xl rounded bg-white p-8 shadow-sm">
      <div className="docx-render text-[14px] leading-relaxed text-slate-800 [&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-lg [&_h2]:font-semibold [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_table]:my-3 [&_table]:border-collapse [&_td]:border [&_td]:border-slate-300 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-slate-300 [&_th]:px-2 [&_th]:py-1 [&_a]:text-indigo-600 [&_a]:underline"
        dangerouslySetInnerHTML={{ __html: state.html ?? '' }} />
    </div>
  );
}

/**
 * In-page document viewer — opens a PDF / image / .txt / .docx INSIDE the EMR (full-screen modal), not a
 * Chrome download and not a new tab. RNs can't manage downloaded files, so files must be viewable in-place.
 * PDFs + images use the inline-disposition presigned URL directly; .txt + .docx are fetched and rendered
 * read-only (mammoth in the browser for .docx). Legacy binary .doc has no in-browser renderer → a clear
 * download fallback (rare — nearly everything is .docx).
 */
export function PdfViewerModal({ doc, onClose }: { readonly doc: ViewableDoc | null; readonly onClose: () => void }) {
  const q = useQuery({ queryKey: ['doc-view', doc?.id], queryFn: () => viewDocument(doc!.id), enabled: doc !== null });
  if (doc === null) return null;
  const url = q.data?.data.downloadUrl;
  const kind = classifyViewableDoc(doc);
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
          ) : kind === 'image' ? (
            <img src={url} alt={doc.filename} className="mx-auto block max-h-full" />
          ) : kind === 'text' || kind === 'docx' ? (
            <FetchedDocBody url={url} kind={kind} filename={doc.filename} />
          ) : kind === 'pdf' ? (
            <iframe title={doc.filename} src={url} className="h-full w-full border-0" />
          ) : (
            // Legacy .doc / unknown: no in-browser renderer. Offer a clear download instead of a silent save.
            <div className="mx-auto mt-16 max-w-md rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-600">
              <p className="mb-1 font-medium text-slate-800">This file can’t be shown in the browser</p>
              <p className="mb-4">“{doc.filename}” is an older Word (.doc) or unsupported format. Modern .docx, PDFs, images and text files display in-page.</p>
              <a href={url} target="_blank" rel="noreferrer" download className="inline-block rounded bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-500">Download to view</a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
