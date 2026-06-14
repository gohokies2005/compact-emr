import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { PdfViewerModal, type ViewableDoc } from './PdfViewerModal';
import { getExtractionCoverage, type CoverageGap } from '../api/extraction-coverage';

/**
 * Chart Extraction Coverage — per-case TRANSPARENCY report (Ryan 2026-06-14).
 *
 * The owner has low confidence in the extractor and wants VISIBLE, specific coverage: a headline
 * "Chart extraction: 98% of pages extracted (118 of 120)" plus an expandable, hyperlinked list of
 * EXACTLY what was not extracted — file name + page + plain-English reason + a "View file" link, and
 * for image files a "Request AI description" affordance.
 *
 * ADVISORY ONLY — it blocks nothing. Tone is GREEN at 100%, AMBER below 100%, NEVER red: a gap is a
 * heads-up, not a failure. Honest about unknowns: when page counts are unavailable it says
 * "approximate" rather than faking 100%.
 *
 * "View file" reuses the in-EMR PdfViewerModal (the same inline presigned viewer the Documents tab
 * uses) so the RN checks a file in place. The image-describe affordance surfaces the OPTION without
 * building new vision infra here (per scope): it points the RN at re-running OCR / asking a colleague.
 */

interface ExtractionCoveragePanelProps {
  readonly caseId: string;
}

const REASON_TEXT: Record<CoverageGap['reason'], string> = {
  unreadable_image: 'Image couldn’t be read as text',
  unread: 'Couldn’t be read automatically',
  needs_manual_summary: 'Couldn’t be read — needs a manual summary',
  truncated_dense: 'Very dense section — only partly extracted',
  extraction_gap: 'Some pages weren’t folded into the chart',
};

export function ExtractionCoveragePanel({ caseId }: ExtractionCoveragePanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [viewDoc, setViewDoc] = useState<ViewableDoc | null>(null);
  // Which image gap the RN asked to describe — surfaces a plain note (no vision infra built here).
  const [describeKey, setDescribeKey] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['case', caseId, 'extraction-coverage'],
    queryFn: () => getExtractionCoverage(caseId),
    enabled: caseId.length > 0,
  });

  const cov = q.data?.data;
  if (q.isLoading) {
    return <div className="rounded-lg border border-slate-200 bg-white px-5 py-4 text-sm text-slate-500">Checking chart extraction coverage…</div>;
  }
  if (q.isError || cov === undefined) {
    return <div className="rounded-lg border border-slate-200 bg-white px-5 py-4 text-sm text-slate-500">Extraction coverage is unavailable right now.</div>;
  }

  const isComplete = cov.coveragePct >= 100 && cov.gaps.length === 0 && cov.unknownPageFiles === 0;
  // GREEN when truly complete; AMBER otherwise. NEVER red — advisory, not a failure.
  const tone = isComplete
    ? { border: 'border-emerald-300 border-l-4 border-l-emerald-500', bg: 'bg-emerald-50', text: 'text-emerald-900', sub: 'text-emerald-800' }
    : { border: 'border-amber-300 border-l-4 border-l-amber-500', bg: 'bg-amber-50', text: 'text-amber-900', sub: 'text-amber-800' };

  const approximate = cov.unknownPageFiles > 0;
  const headline = cov.status === 'in_progress'
    ? 'Chart extraction is still in progress…'
    : cov.status === 'failed'
      ? 'Chart extraction did not complete'
      : approximate && cov.totalFiles > 0 && cov.totalPages === cov.totalFiles
        ? `Chart extraction: ${cov.totalFiles} ${cov.totalFiles === 1 ? 'file' : 'files'}, page counts unavailable`
        : `Chart extraction: ${cov.coveragePct}% of pages extracted (${cov.extractedPages} of ${cov.totalPages})`;

  function openFile(documentId: string | null, fileName: string, isImage: boolean) {
    if (documentId == null) return;
    // exactOptionalPropertyTypes: only set contentType when we have one (image gaps), never `undefined`.
    setViewDoc(isImage ? { id: documentId, filename: fileName, contentType: 'image/*' } : { id: documentId, filename: fileName });
  }

  return (
    <div className={`rounded-lg border ${tone.border} ${tone.bg} px-5 py-4 text-sm ${tone.text}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <p className="font-semibold">{headline}</p>
          {isComplete ? (
            <p className={`mt-1 ${tone.sub}`}>Every uploaded chart page was successfully read and extracted.</p>
          ) : (
            <p className={`mt-1 ${tone.sub}`}>
              {approximate ? 'Some page counts are unavailable, so this is approximate. ' : ''}
              {cov.gaps.length > 0
                ? `${cov.gaps.length} ${cov.gaps.length === 1 ? 'item was' : 'items were'} not fully extracted — listed below so you can check ${cov.gaps.length === 1 ? 'it' : 'them'}. This does not block drafting.`
                : 'This does not block drafting.'}
            </p>
          )}
        </div>
        {cov.gaps.length > 0 ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Hide details' : `Show ${cov.gaps.length} ${cov.gaps.length === 1 ? 'item' : 'items'}`}
          </Button>
        ) : null}
      </div>

      {expanded && cov.gaps.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {cov.gaps.map((g, i) => {
            const key = `${g.documentId ?? 'run'}-${g.reason}-${i}`;
            return (
              <li key={key} className="rounded-lg border border-amber-200 bg-white p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-800">{g.fileName}</p>
                    <p className="text-xs text-slate-600">
                      {g.pageLabel} · {REASON_TEXT[g.reason]}
                    </p>
                  </div>
                  <div className="flex flex-none items-center gap-2">
                    {g.documentId != null ? (
                      <Button type="button" variant="secondary" size="sm" onClick={() => openFile(g.documentId, g.fileName, g.isImage)}>
                        View file
                      </Button>
                    ) : null}
                    {g.isImage ? (
                      <Button type="button" variant="secondary" size="sm" onClick={() => setDescribeKey((k) => (k === key ? null : key))}>
                        Request AI description
                      </Button>
                    ) : null}
                  </div>
                </div>
                {describeKey === key ? (
                  <p className="mt-2 rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
                    This file is an image with no readable text. To capture what it shows, re-run OCR from the
                    Documents tab, or open it above and have a colleague add a brief summary on the Overview tab.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <PdfViewerModal doc={viewDoc} onClose={() => setViewDoc(null)} />
    </div>
  );
}
