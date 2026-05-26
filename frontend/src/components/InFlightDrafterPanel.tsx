import { Card } from './ui/Card';
import { formatRelativeTime } from '../lib/date';
import type { DraftJob } from '../types/prisma';

export interface InFlightDraftJob extends DraftJob {
  readonly currentPhase?: string | null;
  readonly nextRetryInS?: number | null;
}

interface InFlightDrafterPanelProps {
  readonly job: InFlightDraftJob;
}

const RECORDS_PHASES = new Set(['preflight', 'index_consult', 'source_lock', 'framing_gate']);
const REVIEW_PHASES = new Set([
  'adversary_panel',
  'specialist_gate',
  'refine_loop',
  'surgical_edit',
]);
const CITATION_PHASES = new Set(['citation_scoring', 'pmid_verify']);
const POLISH_PHASES = new Set(['linter', 'qa_report']);
const FINISH_PHASES = new Set(['grader', 'render']);

function phaseMessage(phase: string | null | undefined): string {
  if (!phase) return 'Getting started.';
  if (RECORDS_PHASES.has(phase)) return 'Reading the records and finding the medical literature.';
  if (phase === 'drafter') return 'Drafting the opinion.';
  if (REVIEW_PHASES.has(phase)) return 'Running the medical review.';
  if (CITATION_PHASES.has(phase)) return 'Verifying every citation.';
  if (POLISH_PHASES.has(phase)) return 'Final polish.';
  if (FINISH_PHASES.has(phase)) return 'Finishing the document.';
  return 'Getting started.';
}

export function InFlightDrafterPanel({ job }: InFlightDrafterPanelProps) {
  const retrying = typeof job.nextRetryInS === 'number' && job.nextRetryInS > 0;
  const message = retrying
    ? `${phaseMessage(job.currentPhase)} Taking a bit longer - we're re-running this step automatically.`
    : phaseMessage(job.currentPhase);

  return (
    <Card className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div>
        <h2 className="text-base font-semibold text-slate-900">Drafting the letter...</h2>
        <p className="mt-1 text-sm text-slate-600">{message}</p>
      </div>

      <div className="mt-5 flex items-center gap-2" aria-label="Drafting progress">
        <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
        <span className="h-2.5 w-2.5 rounded-full bg-slate-200" />
        <span className="h-2.5 w-2.5 rounded-full bg-slate-200" />
        <span className="h-2.5 w-2.5 rounded-full bg-slate-200" />
        <span className="h-2.5 w-2.5 rounded-full bg-slate-200" />
      </div>

      <p className="mt-5 text-sm text-slate-500">
        Started {formatRelativeTime(job.startedAt ?? job.enqueuedAt)}. We'll let you know when it's
        done.
      </p>
    </Card>
  );
}
