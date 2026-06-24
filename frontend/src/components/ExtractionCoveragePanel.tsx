import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { SectionCard } from './ui/SectionCard';
import { PdfViewerModal, type ViewableDoc } from './PdfViewerModal';
import { getExtractionCoverage, type CoverageGap, type ChartAnalysisStage, type PageReviewRef } from '../api/extraction-coverage';

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
  extraction_incomplete: 'Chart analysis didn’t finish — re-run it',
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
  // TWO-STAGE honesty model (Ryan 2026-06-23): the two stages come straight off the coverage SSOT so this
  // card and the SOAP banner can never disagree. Stage 1 = Pages read (OCR). Stage 2 = Chart analysis.
  // DEFENSIVE: an older/partial API payload (e.g. a backend not yet redeployed) may not carry the two stage
  // fields — fall back to deriving them from the numbers we always have, so the card never crashes and reads
  // exactly as it did before the two-stage SSOT shipped.
  const pagesRead = cov.pagesRead ?? {
    pct: cov.coveragePct, readUnits: cov.extractedPages, totalUnits: cov.totalPages,
    approximate: cov.unknownPageFiles > 0,
    label: `${cov.coveragePct}% (${cov.extractedPages} of ${cov.totalPages})`,
  };
  const chartAnalysis: ChartAnalysisStage = cov.chartAnalysis ?? {
    state: cov.status === 'failed' ? 'failed' : cov.status === 'in_progress' ? 'in_progress' : 'complete',
    label: cov.status === 'failed' ? '✗ Chart analysis failed — re-run extraction' : cov.status === 'in_progress' ? 'Analyzing the chart…' : '✓ Complete',
    reason: null, likelyCauseFile: null, findings: null,
  };
  const analysisComplete = chartAnalysis.state === 'complete';
  // 'not_analyzed' (new/empty case, Ryan 2026-06-23) is a NEUTRAL resting state — not a problem to flag. It must
  // not render amber or scream "Partial"; it reads as a quiet "Not analyzed yet" with no alarming reason line.
  const analysisNotAnalyzed = chartAnalysis.state === 'not_analyzed';
  // Complete requires BOTH stages clean AND no per-page review items (a file can read "100%" at file level
  // while the SEMANTIC analysis never finished, OR while individual pages are handwriting-uncertain — neither
  // may show as Complete). This is the core honesty fix: the chip can never say Complete over a failed analysis.
  const isComplete = analysisComplete && cov.coveragePct >= 100 && cov.gaps.length === 0 && cov.unknownPageFiles === 0 && reviewPages.length === 0;
  // CALM/NEUTRAL (Ryan 2026-06-16): the container is a quiet neutral SectionCard; status is conveyed by a
  // SMALL chip only, never a filled banner. Advisory, never red.
  const unreadable = pb?.unreadable ?? 0;
  const handwritingUncertain = pb?.handwritingUncertain ?? 0;
  // Chart-analysis trouble takes precedence in the chip (it's the load-bearing stage the verdict is built on).
  const chip: { label: string; complete: boolean } = isComplete
    ? { label: 'Complete', complete: true }
    : analysisNotAnalyzed
      ? { label: 'Not analyzed yet', complete: false } // neutral; styled separately below (not amber-alarming)
      : chartAnalysis.state === 'failed'
      ? { label: 'Analysis failed', complete: false }
      : chartAnalysis.state === 'in_progress'
        ? { label: 'Analyzing…', complete: false }
        : chartAnalysis.state === 'incomplete'
          ? { label: 'Analysis incomplete', complete: false }
          : unreadable > 0
            ? { label: `${unreadable} unread`, complete: false }
            : handwritingUncertain > 0
              ? { label: `Review ${handwritingUncertain} ${handwritingUncertain === 1 ? 'page' : 'pages'}`, complete: false }
              : { label: 'Partial', complete: false };
  const tone = { sub: 'text-slate-500' };
  const totalItems = cov.gaps.length + reviewPages.length;
  const approximate = cov.unknownPageFiles > 0;

  function openFile(documentId: string | null, fileName: string, isImage: boolean) {
    if (documentId == null) return;
    // exactOptionalPropertyTypes: only set contentType when we have one (image gaps), never `undefined`.
    setViewDoc(isImage ? { id: documentId, filename: fileName, contentType: 'image/*' } : { id: documentId, filename: fileName });
  }

  return (
    <SectionCard
      title="Chart extraction"
      status={
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${chip.complete ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : analysisNotAnalyzed ? 'border-slate-200 bg-slate-50 text-slate-500' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
          {chip.label}
        </span>
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3 text-sm text-slate-800">
        <div className="max-w-2xl">
          {/* TWO clearly-labeled, plain-English stages (Ryan 2026-06-23). Never one "100% Complete" that
              hides a failed analysis. Stage 1 = Pages read (OCR). Stage 2 = Chart analysis (the structured
              chart the SOAP/verdict is built on). */}
          <dl className="space-y-1.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <dt className="text-[13px] font-semibold text-slate-800">Pages read</dt>
              <dd className="text-[13px] text-slate-700">{pagesRead.label}</dd>
              <span className="text-xs text-slate-400">(documents scanned to text)</span>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <dt className="text-[13px] font-semibold text-slate-800">Chart analysis</dt>
              <dd className={`text-[13px] ${analysisComplete ? 'text-emerald-700' : analysisNotAnalyzed ? 'text-slate-500' : 'text-amber-700'}`}>{chartAnalysis.label}</dd>
              <span className="text-xs text-slate-400">(builds the chart the assessment uses)</span>
            </div>
          </dl>
          {/* Plain reason + likely-cause file when the analysis stage is not clean. */}
          {!analysisComplete && chartAnalysis.reason ? (
            <p className="mt-1.5 text-[13px] text-amber-800">
              {chartAnalysis.reason}
              {chartAnalysis.likelyCauseFile ? ` The likely cause is a large records file (${chartAnalysis.likelyCauseFile}).` : ''}
            </p>
          ) : null}
          {isComplete ? (
            <p className={`mt-1 ${tone.sub}`}>Every uploaded chart page was read and analyzed.</p>
          ) : analysisComplete ? (
            // OCR/per-page-only caveats (analysis itself finished cleanly).
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
          ) : null}
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
