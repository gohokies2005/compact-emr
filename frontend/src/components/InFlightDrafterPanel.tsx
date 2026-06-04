import { useEffect, useMemo, useState } from 'react';
import { Card } from './ui/Card';
import type { DraftJob, DraftJobPhase } from '../types/prisma';

export interface InFlightDraftJob extends DraftJob {
  readonly currentPhase?: string | null;
  readonly nextRetryInS?: number | null;
  // manifestSnapshot is already on DraftJob (typed) — don't redeclare it. The panel doesn't use it.
  readonly operatorState?: string | null;
  readonly operatorMessage?: string | null;
}

interface InFlightDrafterPanelProps {
  readonly job: InFlightDraftJob;
}

interface DraftStep {
  readonly index: 1 | 2 | 3 | 4 | 5 | 6;
  readonly label: string;
}

const STEP_LABELS: Record<DraftStep['index'], string> = {
  1: 'Reading the records',
  2: 'Checking the claim',
  3: 'Writing the draft',
  4: 'Reviewing the draft',
  5: 'Revising',
  6: 'Grading and finalizing',
};

const STEP_WIDTH_CLASSES: Record<DraftStep['index'], string> = {
  1: 'w-1/6',
  2: 'w-2/6',
  3: 'w-3/6',
  4: 'w-4/6',
  5: 'w-5/6',
  6: 'w-full',
};

function normalizePhase(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

// Map the drafter's CANONICAL phase ids (DraftJobPhase — the snake_case manifest ids the drafter
// actually posts as currentPhase, NOT human labels) to the 6 friendly buckets. Exhaustive Record:
// if the drafter adds a phase the EMR hasn't bucketed, tsc fails here — a compile error instead of
// a silently-wrong (or backward-jumping) progress bar. (QA C1, 2026-06-03.)
const PHASE_STEP: Record<DraftJobPhase, DraftStep['index']> = {
  // Bucketed by EXECUTION ORDER (run-letter-pipeline.js), NOT semantic name — so the bar never
  // moves backward. framing_gate → cover_memo → source_lock all run BEFORE drafter, so all are
  // step 2 even though source_lock "sounds like" reading/prep. (architect I-1, 2026-06-03.)
  preflight: 1,
  index_consult: 1,
  framing_gate: 2,
  cover_memo: 2,
  source_lock: 2,
  drafter: 3,
  adversary_panel: 4,
  specialist_gate: 4,
  refine_loop: 5,
  surgical_edit: 5,
  citation_scoring: 5, // post-draft verification — NOT "Writing" (it would jump the bar backward)
  pmid_verify: 5,
  linter: 6,
  qa_report: 6,
  grader: 6,
  render: 6,
};

function stepFromPhase(phase: string | null | undefined): DraftStep {
  const id = (phase ?? '').trim() as DraftJobPhase;
  const index = PHASE_STEP[id] ?? 1;
  return { index, label: STEP_LABELS[index] };
}

function elapsedLabel(startedAt: string | null | undefined, enqueuedAt: string): string {
  const start = new Date(startedAt ?? enqueuedAt).getTime();

  if (!Number.isFinite(start)) {
    return 'running';
  }

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;

  if (minutes === 0) {
    return `running ${seconds}s`;
  }

  return `running ${minutes}m ${seconds}s`;
}

function isTakingLonger(job: InFlightDraftJob): boolean {
  if (typeof job.nextRetryInS === 'number' && job.nextRetryInS > 0) return true;

  const state = normalizePhase(job.operatorState);
  return state.includes('hold') || state.includes('retry') || state.includes('paused');
}

export function InFlightDrafterPanel({ job }: InFlightDrafterPanelProps) {
  const step = useMemo(() => stepFromPhase(job.currentPhase), [job.currentPhase]);
  const takingLonger = isTakingLonger(job);
  const operatorMessage = job.operatorMessage?.trim();
  // Sanity cap on the elapsed timer: a run "running" far past the normal window is almost always a
  // stale/backgrounded tab (the client clock keeps ticking without refetching) or a stuck job —
  // either way, stop implying it's healthily in progress. (2026-06-04 — Ryan saw a 413-minute
  // "running" timer that never said complete.)
  const startMs = job.startedAt ? Date.parse(job.startedAt) : job.enqueuedAt ? Date.parse(job.enqueuedAt) : NaN;
  const elapsedMin = Number.isNaN(startMs) ? 0 : (Date.now() - startMs) / 60000;
  // Only "stuck" when NOT actively retrying — a retrying job is legitimately "still working".
  const looksStuck = elapsedMin > 40 && !takingLonger;

  // Tick every second so the elapsed timer counts up LIVE, not only when the poll re-renders the
  // parent (otherwise it sits frozen at "running 0s" between polls). (architect I2, 2026-06-03)
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => (n + 1) % 1_000_000), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <Card className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Drafting the letter</h2>
          <p className="mt-1 text-sm text-slate-600">
            Step {step.index} of 6 — {step.label}
          </p>
        </div>

        <div className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600">
          {elapsedLabel(job.startedAt, job.enqueuedAt)}
        </div>
      </div>

      <div className="mt-5">
        <div
          className="h-3 overflow-hidden rounded-full bg-slate-100"
          role="progressbar"
          aria-valuenow={step.index}
          aria-valuemin={1}
          aria-valuemax={6}
          aria-label={`Step ${step.index} of 6: ${step.label}`}
        >
          <div className={`h-full rounded-full bg-slate-800 ${STEP_WIDTH_CLASSES[step.index]}`} />
        </div>

        <div className="mt-2 flex justify-between text-xs text-slate-500">
          <span>Step {step.index}/6</span>
          <span>This usually takes 10–20 minutes.</span>
        </div>
      </div>

      {looksStuck ? (
        <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          This run has been going far longer than usual ({Math.round(elapsedMin)} min). It may be stuck, or this page may be stale — refresh the page, then check the Draft jobs tab to see if a letter already completed.
        </div>
      ) : takingLonger ? (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Still working — taking a little longer than usual.
        </div>
      ) : null}

      {operatorMessage ? (
        <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
          {operatorMessage}
        </div>
      ) : null}
    </Card>
  );
}
