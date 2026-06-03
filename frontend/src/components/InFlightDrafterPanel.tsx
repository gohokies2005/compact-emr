import { useMemo } from 'react';
import { Card } from './ui/Card';
import type { DraftJob } from '../types/prisma';

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

function stepFromPhase(phase: string | null | undefined): DraftStep {
  const p = normalizePhase(phase);

  if (!p) return { index: 1, label: STEP_LABELS[1] };

  if (
    p.includes('phase 0.4') ||
    p.includes('framing gate') ||
    p.includes('viability') ||
    p.includes('completeness')
  ) {
    return { index: 2, label: STEP_LABELS[2] };
  }

  if (
    p.includes('phase 4.6') ||
    p.includes('surgical') ||
    p.includes('convergence') ||
    p.includes('redraft') ||
    p.includes('refine_loop')
  ) {
    return { index: 5, label: STEP_LABELS[5] };
  }

  if (
    p.includes('phase 4') ||
    p.includes('review panel') ||
    p.includes('adversary') ||
    p.includes('specialist') ||
    p.includes('reviewing')
  ) {
    return { index: 4, label: STEP_LABELS[4] };
  }

  if (
    p.includes('phase 1') ||
    p.includes('phase 2') ||
    p.includes('phase 3') ||
    p.includes('draft') ||
    p.includes('citation')
  ) {
    return { index: 3, label: STEP_LABELS[3] };
  }

  if (
    p.includes('grade') ||
    p.includes('grading') ||
    p.includes('qa') ||
    p.includes('render') ||
    p.includes('complete') ||
    p.includes('final')
  ) {
    return { index: 6, label: STEP_LABELS[6] };
  }

  if (
    p.includes('phase 0') ||
    p.includes('index') ||
    p.includes('consult') ||
    p.includes('parsing') ||
    p.includes('chart prep') ||
    p.includes('source_lock') ||
    p.includes('source lock')
  ) {
    return { index: 1, label: STEP_LABELS[1] };
  }

  return { index: 1, label: STEP_LABELS[1] };
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
        <div className="h-3 overflow-hidden rounded-full bg-slate-100">
          <div className={`h-full rounded-full bg-slate-800 ${STEP_WIDTH_CLASSES[step.index]}`} />
        </div>

        <div className="mt-2 flex justify-between text-xs text-slate-500">
          <span>Step {step.index}/6</span>
          <span>This usually takes 10–20 minutes.</span>
        </div>
      </div>

      {takingLonger ? (
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
