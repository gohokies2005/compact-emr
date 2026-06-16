import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { SectionCard } from './ui/SectionCard';
import { PdfViewerModal, type ViewableDoc } from './PdfViewerModal';
import { getExtractionCoverage, type CoverageGap, type PageReviewRef } from '../api/extraction-coverage';

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

// Per-page review-row copy (vision rebuild). Calm + honest: a handwriting page usually DID capture the
// printed text — we're unsure about the cursive/margins, so "may not have read in full," never "failed."
const REVIEW_REASON_TEXT: Record<PageReviewRef['reason'], string> = {
  handwriting_uncertain: 'Handwriting — read with low confidence',
  unreadable: 'Couldn’t be read — needs a look',
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
  // While extraction is still running, the Send-to-Drafter "Reading the documents…" banner already says
  // so — don't show a second, redundant "still in progress" bubble (Ryan 2026-06-14). The coverage report
  // is only meaningful once extraction has SETTLED, so render nothing until then.
  if (q.isLoading || (cov !== undefined && cov.status === 'in_progress')) return null;
  if (q.isError || cov === undefined) {
    return <SectionCard title="Chart extraction"><p className="text-sm text-slate-500">Extraction coverage is unavailable right now.</p></SectionCard>;
  }

  // Per-page vision breakdown (null for non-vision charts → behaves exactly as before).
  const pb = cov.pageBreakdown;
  const reviewPages = pb?.reviewPages ?? [];
  // Complete requires BOTH: no file-level gaps AND no per-page review items (a file can read "100%" at
  // file level while individual pages are handwriting-uncertain — that must NOT show as Complete).
  const isComplete = cov.coveragePct >= 100 && cov.gaps.length === 0 && cov.unknownPageFiles === 0 && reviewPages.length === 0;
  // CALM/NEUTRAL (Ryan 2026-06-16): the container is a quiet neutral SectionCard; status is conveyed by a
  // SMALL chip only, never a filled banner. Advisory, never red.
  // 3-STATE chip (RN UX 2026-06-16): Complete (green) / "N unread" (amber, real content missing) /
  // "Review N pages" (amber, handwriting low-confidence) / "Partial" (amber, file-level gaps only).
  const unreadable = pb?.unreadable ?? 0;
  const handwritingUncertain = pb?.handwritingUncertain ?? 0;
  const chip: { label: string; complete: boolean } = isComplete
    ? { label: 'Complete', complete: true }
    : unreadable > 0
      ? { label: `${unreadable} unread`, complete: false }
      : handwritingUncertain > 0
        ? { label: `Review ${handwritingUncertain} ${handwritingUncertain === 1 ? 'page' : 'pages'}`, complete: false }
        : { label: 'Partial', complete: false };
  const tone = { sub: 'text-slate-500' };
  const totalItems = cov.gaps.length + reviewPages.length;

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
    <SectionCard
      title="Chart extraction"
      status={
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${chip.complete ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
          {chip.label}
        </span>
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3 text-sm text-slate-800">
        <div className="max-w-2xl">
          {/* headline carries the % + page count (e.g. "100% of pages extracted (40 of 40)") */}
          <p className="font-semibold">{headline}</p>
          {isComplete ? (
            <p className={`mt-1 ${tone.sub}`}>Every uploaded chart page was successfully read and extracted.</p>
          ) : (
            <p className={`mt-1 ${tone.sub}`}>
              {approximate ? 'Some page counts are unavailable, so this is approximate. ' : ''}
              {unreadable > 0
                ? `${unreadable} ${unreadable === 1 ? 'page' : 'pages'} couldn’t be read and ${unreadable === 1 ? 'needs' : 'need'} a quick look before this chart is relied on. `
                : handwritingUncertain > 0
                  ? `${handwritingUncertain} ${handwritingUncertain === 1 ? 'page contains' : 'pages contain'} handwriting we may not have read in full — open ${handwritingUncertain === 1 ? 'it' : 'them'} below to confirm we captured what matters. `
                  : cov.gaps.length > 0
                    ? `${cov.gaps.length} ${cov.gaps.length === 1 ? 'item was' : 'items were'} not fully extracted — listed below so you can check ${cov.gaps.length === 1 ? 'it' : 'them'}. `
                    : ''}
              This does not block drafting.
            </p>
          )}
          {/* Capture breakdown — only when the vision path stamped per-page signals. Blanks shown as a
              calm reassurance, never as items to chase. */}
          {pb && pb.pagesWithSignal > 0 ? (
            <p className="mt-1 text-xs text-slate-500">
              Scanned pages read by vision: {pb.clean} clear
              {handwritingUncertain > 0 ? `, ${handwritingUncertain} handwriting to confirm` : ''}
              {unreadable > 0 ? `, ${unreadable} couldn’t read` : ''}
              {pb.blank > 0 ? `, ${pb.blank} blank` : ''}.
            </p>
          ) : null}
        </div>
        {totalItems > 0 ? (
          <div className="flex flex-none items-center gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Hide details' : `Show ${totalItems} ${totalItems === 1 ? 'item' : 'items'}`}
            </Button>
          </div>
        ) : null}
      </div>

      {expanded && totalItems > 0 ? (
        <div className="mt-3 space-y-2">
          {/* Per-page review rows (handwriting-uncertain + unreadable). Blanks are never here. The FILE
              NAME itself opens the document inline (Ryan 2026-06-16 — no separate button to hunt for). */}
          {reviewPages.length > 0 ? (
            <ul className="space-y-2">
              {reviewPages.map((rp, i) => (
                <li key={`rp-${rp.documentId}-${rp.pageNumber}-${i}`} className="rounded-lg border border-slate-200 bg-white p-3">
                  <div className="min-w-0">
                    <button type="button" onClick={() => openFile(rp.documentId, rp.fileName, false)} className="block max-w-full truncate text-left font-medium text-slate-800 hover:text-sky-700 hover:underline">
                      {rp.fileName}
                    </button>
                    <p className="text-xs text-slate-600">p.{rp.pageNumber} · {REVIEW_REASON_TEXT[rp.reason]}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {cov.gaps.length > 0 ? (
          <ul className="space-y-2">
          {cov.gaps.map((g, i) => {
            const key = `${g.documentId ?? 'run'}-${g.reason}-${i}`;
            return (
              <li key={key} className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    {/* File name opens the document inline (no separate button). Run-level gaps
                        (documentId null) are not a file, so they render as plain text. */}
                    {g.documentId != null ? (
                      <button type="button" onClick={() => openFile(g.documentId, g.fileName, g.isImage)} className="block max-w-full truncate text-left font-medium text-slate-800 hover:text-sky-700 hover:underline">
                        {g.fileName}
                      </button>
                    ) : (
                      <p className="truncate font-medium text-slate-800">{g.fileName}</p>
                    )}
                    <p className="text-xs text-slate-600">
                      {g.pageLabel} · {REASON_TEXT[g.reason]}
                    </p>
                  </div>
                  {g.isImage ? (
                    <div className="flex flex-none items-center gap-2">
                      <Button type="button" variant="secondary" size="sm" onClick={() => setDescribeKey((k) => (k === key ? null : key))}>
                        Request AI description
                      </Button>
                    </div>
                  ) : null}
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
        </div>
      ) : null}

      <PdfViewerModal doc={viewDoc} onClose={() => setViewDoc(null)} />
    </SectionCard>
  );
}
