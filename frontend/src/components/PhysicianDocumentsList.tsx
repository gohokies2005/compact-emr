import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listCaseDocuments } from '../api/veterans';
import { PdfViewerModal, type ViewableDoc } from './PdfViewerModal';
import { documentDisplayName } from '../lib/docName';

// Full read-only document list for the physician review page (Ryan 2026-06-24, Option A): the physician
// wanted to be able to review ALL of the case's records if desired, not just the curated Doctor Pack
// abridgement. Uses the CASE-SCOPED, physician-authorized endpoint (listCaseDocuments) — the server returns
// only THIS case's docs (never the veteran's other-case PHI; QA scope finding) and authorizes the assigned
// physician. READ-ONLY by design — no upload / delete / re-OCR (those are ops-gated server-side). Sits at the
// BOTTOM of the review page, below the SOAP + Doctor Pack + Ask Aegis.

export function PhysicianDocumentsList({ caseId }: { readonly caseId: string }) {
  const q = useQuery({ queryKey: ['case', caseId, 'documents'], queryFn: () => listCaseDocuments(caseId), enabled: caseId.length > 0 });
  const [viewDoc, setViewDoc] = useState<ViewableDoc | null>(null);

  const docs = q.data?.data ?? [];

  return (
    <div className="mb-4 rounded-lg border border-slate-200 bg-white px-5 py-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">All documents on this case</h2>
        {docs.length > 0 ? <span className="text-xs text-slate-400">{docs.length} {docs.length === 1 ? 'file' : 'files'}</span> : null}
      </div>
      <p className="mt-0.5 text-xs text-slate-500">The full record. Click any file to view it in-page. (The Doctor Pack above is a curated abridgement.)</p>

      {q.isLoading ? (
        <div className="mt-3 text-sm text-slate-500">Loading documents…</div>
      ) : q.isError ? (
        <div className="mt-3 text-sm text-slate-500">Couldn’t load the document list — refresh to retry.</div>
      ) : docs.length === 0 ? (
        <div className="mt-3 text-sm text-slate-500">No documents on this case.</div>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {docs.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                onClick={() => setViewDoc({ id: d.id, filename: d.filename, contentType: d.contentType })}
                className="flex w-full items-center gap-2 py-2 text-left text-sm text-slate-700 hover:text-slate-900"
              >
                <span aria-hidden className="text-slate-400">📄</span>
                <span className="underline-offset-2 hover:underline">{documentDisplayName(d)}</span>
                {d.duplicateOfId ? (
                  <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700" title="Byte-identical to an earlier file on this case — likely a duplicate upload">Duplicate</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}

      <PdfViewerModal doc={viewDoc} onClose={() => setViewDoc(null)} />
    </div>
  );
}
